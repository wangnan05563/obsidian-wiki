import { API_BASE } from '../utils/apiBase';
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  CompileStep,
  DoneData,
  IngestPayload,
  ProgressData,
  TimelineItem,
  RunSummary,
  RunLogEntry,
  BatchFileGroup,
  DraftBatchItem
} from '../types';

// §优化方案3：编译状态持久化 localStorage key
// 为什么单独抽常量：便于统一管理与未来重命名，避免散落字符串字面量
const COMPILE_STATE_STORAGE_KEY = 'wiki:compile:state';

// 草稿批量发布状态持久化 key
// 为什么独立 key：与编译状态分离，避免互相覆盖；草稿发布是 Browse.vue 业务
// 切换页面又切回后从 localStorage 恢复进度信息
const DRAFT_PUBLISH_STATE_STORAGE_KEY = 'wiki:draft:publish:state';

// §优化方案3：可持久化的状态子集
// 为什么不用全部 store 字段：pendingPayload 可能含 FormData 不可序列化，需独立处理
interface PersistableCompileState {
  timeline: TimelineItem[];
  isCompiling: boolean;
  isDone: boolean;
  isCancelled: boolean;
  errorMessage: string;
  doneMessage: string;
  currentRunId: string;
  stageTimings: Record<string, number>;
  compileStartedAt: number;
  // 单文件模式才需要持久化 payload 元信息（FormData 不可直接序列化，只存类型标识）
  pendingPayloadType: 'url' | 'text' | null;
  pendingPayloadContent: string | null;
}

// 草稿发布可持久化状态子集
// 为什么不含 AbortController：AbortController 是运行时句柄，不可序列化；只持久化 UI 可见状态
interface PersistableDraftPublishState {
  batchItems: DraftBatchItem[];
  isPublishing: boolean;
  progressMessage: string;
}

// 步骤展示名映射：后端用英文 step 标识，前端需要友好中文
const STEP_LABEL: Record<CompileStep, string> = {
  archive: '存档原始资料',
  read_schema: '读取 SCHEMA',
  extract: '提取要点',
  generate_page: '生成页面',
  finalize: '收尾'
};

// 从 ProgressData.data 提取 page 信息：仅当 path 和 title 都存在时返回
// 为什么入参类型只取 path/title：调用方传入的可能是 ProgressData 与批量扩展的交叉类型，
//   TS 对交叉类型的字段 narrow 不够智能，会导致返回类型推断失败。只取需要的字段更稳健。
function extractPage(data: { path?: string; title?: string } | undefined): { path: string; title: string } | undefined {
  if (data?.path && data?.title) {
    return { path: data.path, title: data.title };
  }
  return undefined;
}

export const useCompileStore = defineStore('compile', () => {
  // SSE 推送的时间线项
  const timeline = ref<TimelineItem[]>([]);
  // 当前正在运行的步骤，用于驱动机器人动画
  const currentStep = ref<CompileStep | null>(null);
  const isCompiling = ref(false);
  const isDone = ref(false);
  const errorMessage = ref<string>('');
  const result = ref<DoneData | null>(null);
  // §11.2 done 事件的 message，用于展示"编译完成"或"缓存命中"等提示
  const doneMessage = ref<string>('');
  // 保存本次投递的载荷，进度页需要据此发起请求
  const pendingPayload = ref<IngestPayload | null>(null);
  // §11.2 历史编译任务列表（空状态时展示）
  const runs = ref<RunSummary[]>([]);
  const loadingRuns = ref(false);
  // §12.3-8 日志查看
  const logEntries = ref<RunLogEntry[]>([]);
  const loadingLog = ref(false);
  // 批量编译模式：true 时 Progress.vue 调用 /api/compile/batch
  const isBatchMode = ref(false);
  // 批量编译的待发 FormData（与单文件 pendingPayload 分离，避免类型混淆）
  const pendingBatchPayload = ref<FormData | null>(null);
  // 批量编译的文件分组：按 fileIndex 路由 SSE 事件
  const batchGroups = ref<BatchFileGroup[]>([]);
  // 批量编译的拒绝列表（来自 batch_start 事件）
  const batchRejected = ref<Array<{ name: string; reason: string }>>([]);
  // 用户主动取消标识：与 errorMessage 区分，让进度条组件能识别"取消态"而非"错误态"
  // 为什么独立字段：errorMessage 用于后端推送的错误事件，cancelCompile 是用户主动行为，
  //   两者视觉提示不同（取消是中性粉色，错误是红色），且文案语义不同
  const isCancelled = ref(false);

  // ===== 草稿批量发布状态（Browse.vue 业务）=====
  // 为什么放在 store 而非 Browse.vue 局部 ref：App.vue 用 v-if 切换视图，
  //   切走时 Browse.vue 会被卸载，导致 batchItems/compiling/progressMessage 全部丢失
  //   切回后用户看不到已经进行中的进度信息。提升到 store 后跨组件生命周期保留
  // SSE 流是浏览器全局任务，组件被 v-if 卸载时不会自动 abort；handler 闭包仍能
  //   持续修改这些 store 字段，所以切回时用户能看到完整的进度面板
  const draftBatchItems = ref<DraftBatchItem[]>([]);
  const draftIsPublishing = ref(false);
  const draftProgressMessage = ref<string>('');
  // AbortController 放在 store 非响应式字段（plain）中
  // 为什么非响应式：AbortController 是运行时句柄，不触发 UI 更新；放 ref 内会被 Pinia 深度代理
  // 为什么放 store：Browse.vue 卸载后仍能调用 abort() 取消后台 SSE 任务
  let draftAbortController: AbortController | null = null;

  // §优化方案2：各阶段耗时统计（ms）
  // 为什么用 Record 而非 Map：响应式追踪更稳定，且 JSON.stringify 友好便于持久化
  const stageTimings = ref<Record<string, number>>({});
  // 当前阶段开始时间戳（ms），step 变化时累计上一阶段耗时并重置
  const currentStepStartedAt = ref<number>(0);
  // §优化方案1：编译整体开始时间戳，用于展示总耗时
  const compileStartedAt = ref<number>(0);

  // §优化方案3：当前编译运行的 runId，用于切回页面时调用 /api/compile/resume/:runId
  // 为什么独立字段：后端 SSE 事件 ProgressEvent 不带 runId，需要从 runs 列表反向查找
  //   或在 onMounted 时通过 GET /api/compile/runs 查找 status=running 的最新任务
  const currentRunId = ref<string>('');

  // §优化方案1：单文件编译模式的步骤总数估算
  // 为什么需要估算：harness 是 LLM 驱动的循环，步骤数动态，无固定上限
  //   估算策略：基于历史日志（如 SHCPE 7 步）+ 4 个核心阶段（archive/read_schema/extract/generate_page）
  //   保守取 8 步作为进度条分母，避免百分比卡在 100% 后还有后续步骤
  const ESTIMATED_TOTAL_STEPS = 8;

  // §优化方案1：已完成步骤数（基于 timeline 去重统计）
  // 为什么用 set 而非 timeline.length：单步可能推送多条事件（如多次 read_file），
  //   按去重的 step 名统计更接近"阶段数"
  const completedStepCount = computed(() => {
    const steps = new Set<string>();
    for (const item of timeline.value) {
      // running 态不算完成，done 才算
      if (item.status === 'done') {
        steps.add(item.step);
      }
    }
    return steps.size;
  });

  // §优化方案1：当前进度百分比（0-100）
  // 为什么用 Math.min 防止超 100：实际步骤可能超过估算值，进度条溢出视觉异常
  const progressPercentage = computed(() => {
    if (!isCompiling.value && !isDone.value) return 0;
    // §done 态强制 100%：实际阶段数可能少于 ESTIMATED_TOTAL_STEPS（如缓存命中跳过部分阶段），
    //   但对用户而言"已完成"就是 100%，避免显示 63% 等令人困惑的数字
    if (isDone.value) return 100;
    return Math.min(100, Math.round((completedStepCount.value / ESTIMATED_TOTAL_STEPS) * 100));
  });

  // §优化方案2：总耗时（ms），编译中实时累加，完成后固定
  // 为什么用 computed 而非 ref：派生自 compileStartedAt + 当前时间，避免手动维护
  const totalElapsedMs = computed(() => {
    if (compileStartedAt.value === 0) return 0;
    if (!isCompiling.value) {
      // 完成或出错时，取最后一个 timeline 项的时间戳作为结束时间
      const lastTs = timeline.value.length > 0
        ? timeline.value[timeline.value.length - 1].timestamp
        : compileStartedAt.value;
      return lastTs - compileStartedAt.value;
    }
    return Date.now() - compileStartedAt.value;
  });

  // 步骤中文名
  const stepLabel = computed(() => (s: CompileStep | null) =>
    s ? STEP_LABEL[s] : ''
  );

  // 已生成页面数（来自 generate_page 事件）
  const generatedPages = computed(() =>
    timeline.value
      .filter((t) => t.step === 'generate_page' && t.page)
      .map((t) => t.page!)
  );

  // 重置状态，用于"再投一篇"
  function reset() {
    timeline.value = [];
    currentStep.value = null;
    isCompiling.value = false;
    isDone.value = false;
    errorMessage.value = '';
    result.value = null;
    doneMessage.value = '';
    pendingPayload.value = null;
    isBatchMode.value = false;
    pendingBatchPayload.value = null;
    batchGroups.value = [];
    batchRejected.value = [];
    isCancelled.value = false;
    // §优化方案2/3：同步清空新增字段
    stageTimings.value = {};
    currentStepStartedAt.value = 0;
    compileStartedAt.value = 0;
    currentRunId.value = '';
    // 重置时同步清除持久化状态，避免切回时误恢复已主动重置的编译
    clearPersistedState();
  }

  // ===== 草稿发布方法集 =====
  // 启动草稿批量发布：初始化 batchItems 列表 + publishing 状态
  // 为什么 items 列表创建用 drafts.value.map(d => ({...}))：拷贝时只保留必要字段，
  //   避免直接引用导致外部修改穿透到 store
  function startDraftPublish(items: DraftBatchItem[]): void {
    draftBatchItems.value = items.map((d) => ({ ...d }));
    draftIsPublishing.value = true;
    draftProgressMessage.value = '开始批量编译…';
    persistDraftPublishState();
  }

  // 启动单条草稿发布：单 draft 模式，items 列表只有一项
  function startSingleDraftPublish(item: DraftBatchItem): void {
    draftBatchItems.value = [{ ...item }];
    draftIsPublishing.value = true;
    draftProgressMessage.value = '准备编译…';
    persistDraftPublishState();
  }

  // 更新某条草稿的状态/消息/页面
  // 为什么返回新对象：Vue ref 数组项变更需要重新赋值才能触发响应式
  //   数组项本身是 ref 元素，直接修改 .status 是非响应式的（对象整体 ref 才追踪）
  function updateDraftItem(index: number, patch: Partial<DraftBatchItem>): void {
    const item = draftBatchItems.value[index];
    if (!item) return;
    draftBatchItems.value[index] = { ...item, ...patch };
    persistDraftPublishState();
  }

  // 追加某条草稿生成的页面
  // 为什么用 index 定位：SSE 事件携带 fileIndex，与 batchItems 数组下标对齐
  function appendDraftItemPage(index: number, page: { path: string; title: string }): void {
    const item = draftBatchItems.value[index];
    if (!item) return;
    draftBatchItems.value[index] = {
      ...item,
      pages: [...item.pages, page],
    };
    persistDraftPublishState();
  }

  // 设置顶部进度文本
  function setDraftProgress(message: string): void {
    draftProgressMessage.value = message;
    persistDraftPublishState();
  }

  // 设置 AbortController：Browse.vue 启动 SSE 时调用，让 store 持有取消句柄
  function setDraftAbortController(controller: AbortController | null): void {
    draftAbortController = controller;
  }

  // 取消草稿发布：调用 AbortController 终止 SSE
  // 与 abortCompile 的区别：本函数专用于草稿发布，区分 publish / compile 两种业务
  function abortDraftPublish(): void {
    if (draftAbortController) {
      draftAbortController.abort();
      draftAbortController = null;
    }
    draftIsPublishing.value = false;
    if (draftProgressMessage.value !== '已取消') {
      draftProgressMessage.value = '已取消';
    }
    persistDraftPublishState();
  }

  // 标记草稿发布完成（成功/失败后调用，保留 items 列表供查看）
  function finalizeDraftPublish(): void {
    draftIsPublishing.value = false;
    persistDraftPublishState();
  }

  // 主动清空草稿发布面板（用户点击关闭按钮）
  function clearDraftPublish(): void {
    if (draftAbortController) {
      draftAbortController.abort();
      draftAbortController = null;
    }
    draftBatchItems.value = [];
    draftIsPublishing.value = false;
    draftProgressMessage.value = '';
    clearDraftPublishPersistedState();
  }

  // 草稿发布状态持久化：与编译持久化分离，互不影响
  // 为什么用 localStorage 而非 IndexedDB：状态体量小（几十到几百条记录），
  //   localStorage 同步 API 简单可靠；IndexedDB 异步 API 复杂度更高但收益不大
  function persistDraftPublishState(): void {
    try {
      const state: PersistableDraftPublishState = {
        batchItems: draftBatchItems.value,
        isPublishing: draftIsPublishing.value,
        progressMessage: draftProgressMessage.value,
      };
      localStorage.setItem(DRAFT_PUBLISH_STATE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // localStorage 满或禁用时静默失败
    }
  }

  // 从 localStorage 恢复草稿发布状态
  // 为什么要恢复：用户刷新页面或长时间切走后，store 内存状态会丢失
  //   恢复后切回 Browse.vue 能继续看到之前的工作
  function loadDraftPublishState(): boolean {
    try {
      const raw = localStorage.getItem(DRAFT_PUBLISH_STATE_STORAGE_KEY);
      if (!raw) return false;
      const state = JSON.parse(raw) as PersistableDraftPublishState;
      if (!Array.isArray(state.batchItems) || state.batchItems.length === 0) {
        return false;
      }
      draftBatchItems.value = state.batchItems;
      // 切回时强制为 false：避免误判为"正在发布"导致 UI 一直显示加载动画
      // 后端 SSE 流已经在独立 task 中运行，无法再关联；正确做法是显示当前快照
      draftIsPublishing.value = false;
      draftProgressMessage.value = state.progressMessage ?? '';
      return true;
    } catch {
      return false;
    }
  }

  // 清除草稿发布持久化状态
  function clearDraftPublishPersistedState(): void {
    try {
      localStorage.removeItem(DRAFT_PUBLISH_STATE_STORAGE_KEY);
    } catch {
      // 静默失败
    }
  }

  // §优化方案2：开始新阶段——记录开始时间，累计上一阶段耗时
  // 为什么在 step 变化时调用：检测到 step 切换意味着上一阶段已结束
  function startStage(step: string): void {
    const now = Date.now();
    if (currentStepStartedAt.value > 0 && currentStep.value) {
      // 累计上一阶段耗时：同一 step 可能多次推送事件，时间累加
      const prevStep = currentStep.value as string;
      const elapsed = now - currentStepStartedAt.value;
      stageTimings.value = {
        ...stageTimings.value,
        [prevStep]: (stageTimings.value[prevStep] ?? 0) + elapsed,
      };
    }
    currentStep.value = step as CompileStep;
    currentStepStartedAt.value = now;
    // §优化方案1：首次进入编译态时记录整体开始时间
    if (compileStartedAt.value === 0) {
      compileStartedAt.value = now;
    }
  }

  // §优化方案2：完成所有阶段——done 事件触发时累计最后一阶段耗时
  function finishAllStages(): void {
    if (currentStepStartedAt.value > 0 && currentStep.value) {
      const lastStep = currentStep.value as string;
      const elapsed = Date.now() - currentStepStartedAt.value;
      stageTimings.value = {
        ...stageTimings.value,
        [lastStep]: (stageTimings.value[lastStep] ?? 0) + elapsed,
      };
    }
    currentStepStartedAt.value = 0;
    currentStep.value = null;
  }

  // §优化方案3：持久化当前编译状态到 localStorage
  // 为什么需要：用户切换页面时 SSE 流会断开，切回时需重建上下文（timeline/进度/耗时）
  //   配合后端 /api/compile/resume/:runId 可恢复未完成的编译
  function persistState(): void {
    if (isBatchMode.value) return; // 批量模式 FormData 不可序列化，跳过
    const payloadType = pendingPayload.value && !(pendingPayload.value instanceof FormData)
      ? (pendingPayload.value as { type: 'url' | 'text'; content: string }).type
      : null;
    const payloadContent = pendingPayload.value && !(pendingPayload.value instanceof FormData)
      ? (pendingPayload.value as { type: 'url' | 'text'; content: string }).content
      : null;
    const state: PersistableCompileState = {
      timeline: timeline.value,
      isCompiling: isCompiling.value,
      isDone: isDone.value,
      isCancelled: isCancelled.value,
      errorMessage: errorMessage.value,
      doneMessage: doneMessage.value,
      currentRunId: currentRunId.value,
      stageTimings: stageTimings.value,
      compileStartedAt: compileStartedAt.value,
      pendingPayloadType: payloadType,
      pendingPayloadContent: payloadContent,
    };
    try {
      localStorage.setItem(COMPILE_STATE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // localStorage 满或禁用时静默失败，不阻断主流程
    }
  }

  // §优化方案3：从 localStorage 恢复编译状态
  // 返回值表示是否恢复了"进行中"的编译（调用方据此决定是否触发 resume）
  function loadPersistedState(): boolean {
    try {
      const raw = localStorage.getItem(COMPILE_STATE_STORAGE_KEY);
      if (!raw) return false;
      const state = JSON.parse(raw) as PersistableCompileState;
      // 仅恢复有意义的状态：进行中/已完成/已取消/出错，空状态不恢复
      if (!state.isCompiling && !state.isDone && !state.isCancelled && !state.errorMessage) {
        return false;
      }
      timeline.value = state.timeline ?? [];
      isCompiling.value = false; // 切回时强制设为 false，避免误触发 startCompile
      isDone.value = state.isDone ?? false;
      isCancelled.value = state.isCancelled ?? false;
      errorMessage.value = state.errorMessage ?? '';
      doneMessage.value = state.doneMessage ?? '';
      currentRunId.value = state.currentRunId ?? '';
      stageTimings.value = state.stageTimings ?? {};
      compileStartedAt.value = state.compileStartedAt ?? 0;
      // 恢复 pendingPayload（仅 url/text 类型，FormData 不可恢复）
      if (state.pendingPayloadType && state.pendingPayloadContent) {
        pendingPayload.value = {
          type: state.pendingPayloadType,
          content: state.pendingPayloadContent,
        };
      }
      // 返回是否需要恢复：仅"切走时正在编译"的场景需要 resume
      return state.isCompiling === true && !state.isDone && !state.isCancelled;
    } catch {
      return false;
    }
  }

  // §优化方案3：清除 localStorage 中的持久化状态
  // 为什么需要：编译完成后清除避免下次进入时误恢复
  function clearPersistedState(): void {
    try {
      localStorage.removeItem(COMPILE_STATE_STORAGE_KEY);
    } catch {
      // 静默失败
    }
  }

  // §优化方案3：设置当前 runId（从 runs 列表查询后填充）
  function setCurrentRunId(runId: string): void {
    currentRunId.value = runId;
  }

  // 中止当前编译：仅复位 isCompiling，保留 pendingPayload/isDone/errorMessage
  // 为什么需要：Progress.vue 在 onBeforeUnmount 或 fetch AbortError 时调用，
  //   让 store 状态与实际编译流保持一致。否则 prepareCompile 设置的 isCompiling=true
  //   会在切走后持续为 true，切回时 onMounted 误判为"正在编译"导致进度条卡死
  function abortCompile() {
    if (isCompiling.value) {
      isCompiling.value = false;
    }
  }

  // 用户主动取消编译：标记 isCancelled 让进度条组件切换到"取消态"视觉
  // 与 abortCompile 的区别：abortCompile 是切走页面时的隐式中止，不设置取消标识；
  //   cancelCompile 是用户显式点击"取消编译"按钮，需要在 UI 上展示取消态
  // 为什么不复位 batchGroups：保留已完成进度供用户查看（"已完成 3/10"）
  function cancelCompile() {
    isCancelled.value = true;
    isCompiling.value = false;
  }

  // 投递前预存载荷并进入编译态
  function prepareCompile(payload: IngestPayload) {
    reset();
    pendingPayload.value = payload;
    isCompiling.value = true;
    // §优化方案1：记录编译开始时间，便于总耗时展示
    compileStartedAt.value = Date.now();
  }

  // 批量编译预存：FormData 包含多个 files 字段
  // 为什么独立 action：批量模式需要切换 isBatchMode 并初始化分组容器
  function prepareBatchCompile(payload: FormData) {
    reset();
    pendingBatchPayload.value = payload;
    isBatchMode.value = true;
    isCompiling.value = true;
  }

  // 处理单条 SSE 事件，按事件类型分发
  // 批量模式事件：batch_start / file_start / progress(带 fileIndex) / page(带 fileIndex) /
  //              file_done(带 fileIndex) / file_error(带 fileIndex) / file_complete(带 fileIndex) /
  //              batch_done / error
  function handleEvent(eventType: string, data: unknown) {
    // 批量模式事件路由
    if (isBatchMode.value) {
      handleBatchEvent(eventType, data);
      return;
    }
    if (eventType === 'progress') {
      const p = data as ProgressData;
      // §优化方案2：检测 step 变化时累计上一阶段耗时
      // 为什么用 currentStep.value !== p.step 判断：同一 step 多次推送事件时不累计
      if (currentStep.value !== p.step) {
        startStage(p.step);
      }
      timeline.value.push({
        step: p.step,
        status: p.status,
        message: p.message,
        page: extractPage(p.data),
        timestamp: Date.now()
      });
    } else if (eventType === 'page') {
      // page 事件是 generate_page 的子类，需同步计入 stage 计时
      const p = data as ProgressData;
      if (currentStep.value !== p.step) {
        startStage(p.step);
      }
      timeline.value.push({
        step: p.step,
        status: p.status,
        message: p.message,
        page: extractPage(p.data),
        timestamp: Date.now()
      });
    } else if (eventType === 'done') {
      // 后端 done 事件发送的是完整 ProgressEvent：{ step, status, message, data: { path, cached? } }
      // 从中提取 cached 标识和 message 供前端展示
      const d = data as { message?: string; data?: { cached?: boolean; path?: string } };
      result.value = {
        pages: [],
        indexUpdated: false,
        cached: d.data?.cached,
      };
      // 缓存命中时 message 存在 errorMessage 上会误导，单独存到 doneMessage
      doneMessage.value = d.message ?? '';
      isCompiling.value = false;
      isDone.value = true;
      // §优化方案2：done 事件触发最后一阶段耗时累计
      finishAllStages();
      // §优化方案3：编译完成清除持久化状态
      clearPersistedState();
    } else if (eventType === 'error') {
      // 后端可能在流中推送 error 事件
      const e = data as { message?: string };
      errorMessage.value = e?.message || '编译过程出错';
      isCompiling.value = false;
      // §优化方案2：错误时同样累计最后一阶段耗时
      finishAllStages();
      // §优化方案3：出错时清除持久化状态，避免下次进入误恢复
      clearPersistedState();
    }
  }

  // 批量模式事件载荷类型
  type BatchEventData = ProgressData & {
    data?: {
      fileIndex?: number;
      fileCount?: number;
      fileName?: string;
      rejected?: Array<{ name: string; reason: string }>;
    };
  };

  // 处理 batch_start 事件：初始化分组容器
  function handleBatchStart(d: BatchEventData): void {
    const count = d.data?.fileCount ?? 0;
    batchRejected.value = d.data?.rejected ?? [];
    batchGroups.value = Array.from({ length: count }, (_, i) => ({
      fileIndex: i,
      fileName: '',
      status: 'pending' as const,
      timeline: [],
      pages: [],
    }));
  }

  // 处理 page 事件：同时推送到分组 timeline 与 pages 列表
  function handleBatchPage(group: BatchFileGroup, d: BatchEventData): void {
    group.timeline.push({
      step: d.step,
      status: d.status,
      message: d.message,
      page: extractPage(d.data),
      timestamp: Date.now(),
    });
    if (d.data?.path && d.data?.title) {
      group.pages.push({ path: d.data.path, title: d.data.title });
    }
  }

  // 处理 file_complete 事件：仅在 file_error 未触发时标记为完成
  function handleFileComplete(group: BatchFileGroup): void {
    if (group.status !== 'error') {
      group.status = 'done';
    }
  }

  // 批量模式事件分发：先处理整体事件，再按 fileIndex 路由到分组
  function handleBatchEvent(eventType: string, data: unknown) {
    const d = data as BatchEventData;

    // 整体事件：无需 fileIndex 定位分组
    if (eventType === 'batch_start') {
      handleBatchStart(d);
      return;
    }

    if (eventType === 'batch_done') {
      isCompiling.value = false;
      isDone.value = true;
      doneMessage.value = d.message ?? '';
      currentStep.value = null;
      return;
    }

    if (eventType === 'error') {
      // 整体错误（如 multipart 解析失败）
      errorMessage.value = d.message || '批量编译过程出错';
      isCompiling.value = false;
      return;
    }

    // 分组事件：需 fileIndex 定位分组
    const idx = d.data?.fileIndex;
    if (idx === undefined) return;
    const group = batchGroups.value[idx];
    if (!group) return;

    if (eventType === 'file_start') {
      group.fileName = d.data?.fileName ?? '';
      group.status = 'running';
      currentStep.value = 'archive';
      return;
    }

    if (eventType === 'progress') {
      group.timeline.push({
        step: d.step,
        status: d.status,
        message: d.message,
        page: extractPage(d.data),
        timestamp: Date.now(),
      });
      return;
    }

    if (eventType === 'page') {
      // page 事件同时推送到全局 timeline 与分组，便于在统一视图查看
      handleBatchPage(group, d);
      return;
    }

    if (eventType === 'file_done') {
      // 单文件完成（成功）
      group.status = 'done';
      return;
    }

    if (eventType === 'file_error') {
      group.status = 'error';
      group.errorMessage = d.message;
      return;
    }

    if (eventType === 'file_complete') {
      // file_complete 是成功路径的终结事件，仅在 file_error 未触发时后端推送
      handleFileComplete(group);
    }
  }

  // §11.2 加载历史编译任务列表
  async function loadRuns() {
    loadingRuns.value = true;
    try {
      const res = await fetch(`${API_BASE}/compile/runs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      runs.value = data.runs ?? [];
    } catch {
      runs.value = [];
    } finally {
      loadingRuns.value = false;
    }
  }

  // §12.3-8 加载某个 run 的技术日志
  async function loadLog(runId: string) {
    loadingLog.value = true;
    try {
      const res = await fetch(`${API_BASE}/compile/runs/${runId}/log`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      logEntries.value = data.entries ?? [];
    } catch {
      logEntries.value = [];
    } finally {
      loadingLog.value = false;
    }
  }

  return {
    timeline,
    currentStep,
    isCompiling,
    isDone,
    errorMessage,
    result,
    doneMessage,
    pendingPayload,
    generatedPages,
    stepLabel,
    runs,
    loadingRuns,
    logEntries,
    loadingLog,
    isBatchMode,
    pendingBatchPayload,
    batchGroups,
    batchRejected,
    isCancelled,
    // 草稿批量发布状态（Browse.vue 业务，跨组件生命周期保留）
    draftBatchItems,
    draftIsPublishing,
    draftProgressMessage,
    // §优化方案1/2/3 新增字段
    stageTimings,
    currentStepStartedAt,
    compileStartedAt,
    currentRunId,
    completedStepCount,
    progressPercentage,
    totalElapsedMs,
    // §优化方案1/2/3 新增方法
    startStage,
    finishAllStages,
    persistState,
    loadPersistedState,
    clearPersistedState,
    setCurrentRunId,
    reset,
    abortCompile,
    cancelCompile,
    prepareCompile,
    prepareBatchCompile,
    handleEvent,
    loadRuns,
    loadLog,
    // 草稿发布方法集
    startDraftPublish,
    startSingleDraftPublish,
    updateDraftItem,
    appendDraftItemPage,
    setDraftProgress,
    setDraftAbortController,
    abortDraftPublish,
    finalizeDraftPublish,
    clearDraftPublish,
    persistDraftPublishState,
    loadDraftPublishState,
    clearDraftPublishPersistedState,
  };
});

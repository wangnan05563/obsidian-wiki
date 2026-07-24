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
  BatchFileGroup
} from '../types';

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
      currentStep.value = p.step;
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
      currentStep.value = null;
    } else if (eventType === 'error') {
      // 后端可能在流中推送 error 事件
      const e = data as { message?: string };
      errorMessage.value = e?.message || '编译过程出错';
      isCompiling.value = false;
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
      const res = await fetch('/api/compile/runs');
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
      const res = await fetch(`/api/compile/runs/${runId}/log`);
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
    reset,
    abortCompile,
    cancelCompile,
    prepareCompile,
    prepareBatchCompile,
    handleEvent,
    loadRuns,
    loadLog
  };
});

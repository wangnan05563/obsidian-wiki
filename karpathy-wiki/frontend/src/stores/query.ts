import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { ChatMessage, Reference, ThinkingStep, MultimodalOutput, Clarification, RefAuthority, KnowledgeStatus } from '../types';
import { STORAGE_KEYS } from '../constants/storageKeys';

// v2: 多输出模式多选类型，与后端 outputModes 对齐
// 4 个独立模式：思考过程 / 工具调用请求返回 / 主答案 / 多模态结构
export type OutputMode = 'thinking' | 'tool_call' | 'answer' | 'multimodal';
export const ALL_OUTPUT_MODES: OutputMode[] = ['thinking', 'tool_call', 'answer', 'multimodal'];

// 模式显示标签：用于 UI 多选控件的 label
export const OUTPUT_MODE_LABELS: Record<OutputMode, string> = {
  thinking: '思考过程',
  tool_call: '工具调用',
  answer: '主答案',
  multimodal: '多模态',
};

// 中间件多选类型：控制 query workflow 各功能模块的启用/禁用
// 为什么用字面量联合而非 enum：tree-shaking 友好且避免运行时对象冲突
// 与后端 QueryInput.middlewares 对齐（type-sync-rule CODING-015）
// - 'web_search' 联网搜索（覆盖 webSearch=false）
// - 'deep_thinking' 深度思考（覆盖 mode !== 'deep'）
// - 'extended_tools' 启用 MCP/CLI 扩展工具
// - 'followups' 启用追问建议生成
// - 'stream' 启用真流式（覆盖 stream=false）
// - 'clarify' 启用意图澄清（问题有歧义时主动中断提问，列出解读选项供确认）
export type Middleware = 'web_search' | 'deep_thinking' | 'extended_tools' | 'followups' | 'stream' | 'clarify';
export const ALL_MIDDLEWARES: Middleware[] = ['web_search', 'deep_thinking', 'extended_tools', 'followups', 'stream', 'clarify'];
export const MIDDLEWARE_LABELS: Record<Middleware, string> = {
  web_search: '联网搜索',
  deep_thinking: '深度思考',
  extended_tools: '扩展工具',
  followups: '追问建议',
  stream: '真流式输出',
  clarify: '歧义澄清',
};

// §按会话隔离缓冲（v4）：每个会话拥有独立的消息/流式/线程状态，
// 实现移动端「多会话并行流式」——切走某会话不打断其后台流，回来继续接收。
// 桌面端（Query.vue / FloatingChat.vue）始终使用默认 __active__ 缓冲，行为不变（向后兼容）。
// activeId 指向「当前展示/正在操作」的会话缓冲；其余缓冲在后台并行演进。
export const DEFAULT_ACTIVE = '__active__';

// 单会话缓冲：原本的扁平 ref 全部收拢到这里
export interface SessionBuffer {
  messages: ChatMessage[];
  streamingAnswer: string;
  currentRefs: Reference[];
  currentFollowups: string[];
  currentThinking: ThinkingStep[];
  searchProgress: { step: string; count?: number } | null;
  isLoading: boolean;
  errorMessage: string;
  // FR-09-2 多模态输出：在 done 之前到达的 multimodal 暂存到此，finalizeAnswer 时附加到消息
  currentMultimodal: MultimodalOutput | null;
  // v3 图像/PPT 生成结果：在 done 之前到达的 image/ppt 事件暂存，finalizeAnswer 时附加到消息
  currentImage: ChatMessage['image'] | null;
  currentPpt: ChatMessage['ppt'] | null;
  // 当前问答线程隔离键：本轮会话所属的 threadId。
  // 后端据此从本地记忆注入历史上下文并持久化会话/记忆；null 表示新会话（后端自动建线程）。
  currentThreadId: string | null;
  // §X-1 步骤级追踪：本轮问答 harness runId 暂存，finalizeAnswer 时附加到 assistant 消息，
  // 供前端 QueryTracePanel 调 /api/query/runs/:runId 拉取每步耗时分解。null 表示无（降级链兜底）。
  currentRunId: string | null;
  // X-2 可恢复流式：本轮问答 manager runId 暂存（后端 StreamRunManager 分配），由 open 事件写入。
  // 断线重连时凭此调 resume。null 表示后端未开启可恢复流式（旧服务端/开关关闭）。
  currentManagerRunId: string | null;
  // X-2 流式生命周期：本轮 SSE 是否已收到 done 事件。用于重连逻辑判定"流异常结束 vs 正常完成"。
  currentDidDone: boolean;
  // 意图澄清：后端检测到歧义时下发的澄清卡片（中断提问）。非空且 isLoading=true 表示
  // 等待用户选择；用户选择后由消费方用 clarifyId+choiceIndex 重发同一问题。
  currentClarification: Clarification | null;
  // T00265：上下文占用统计 —— done 事件携带的 governor 治理前 token 总量与上下文预算上限。
  // 消息气泡右下角徽章据此展示当前上下文使用百分比；随每次问答刷新。
  contextInputTokens: number;
  contextMaxTokens: number;
}

function createEmptyBuffer(): SessionBuffer {
  return {
    messages: [],
    streamingAnswer: '',
    currentRefs: [],
    currentFollowups: [],
    currentThinking: [],
    searchProgress: null,
    isLoading: false,
    errorMessage: '',
    currentMultimodal: null,
    currentImage: null,
    currentPpt: null,
    currentThreadId: null,
    currentRunId: null,
    currentManagerRunId: null,
    currentDidDone: false,
    currentClarification: null,
    contextInputTokens: 0,
    contextMaxTokens: 0,
  };
}

// 从 localStorage 加载用户偏好的多输出模式，解析失败或缺失时回退到全开
// 为什么需要防御：localStorage 可能是旧版本数据（数组格式/字符串），用 try-catch 兜底
function loadOutputModes(): OutputMode[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.OUTPUT_MODES);
    if (!raw) return [...ALL_OUTPUT_MODES];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // 仅保留 ALL_OUTPUT_MODES 中仍存在的模式，避免历史脏数据导致类型错乱
      const valid = parsed.filter(
        (m): m is OutputMode => typeof m === 'string' && (ALL_OUTPUT_MODES as string[]).includes(m),
      );
      return valid.length > 0 ? valid : [...ALL_OUTPUT_MODES];
    }
  } catch {
    // 解析失败视为未设置
  }
  return [...ALL_OUTPUT_MODES];
}

// §真流式偏好：从 localStorage 加载，未设置时默认 true（用户需求"改为流式输出"）
// 为什么默认 true：用户需求明确要求流式输出体验，未配置时优先启用流式
// 为什么用 try-catch：localStorage 可能存历史脏数据（非 'true'/'false' 字符串），需兜底
function loadStreamMode(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.STREAM_MODE);
    if (raw === null) return true;
    return raw === 'true';
  } catch {
    return true;
  }
}

// 中间件多选偏好：从 localStorage 加载，未设置时默认全开（向后兼容旧行为）
// 为什么默认全开：middlewares 是"功能开关集合"，老用户未配置时应保持所有功能可用，
// 避免升级后用户感知不到原已启用的功能（与 outputModes 一致的回退策略）
// 新增中间件在升级时的默认迁移名单：老用户 localStorage 存的数组不含这些新中间件，
// 若不做补充，升级后新功能会被旧数组静默关闭。这些中间件为增量能力，默认开启（与全开回退一致）。
const MIDDLEWARE_MIGRATION_ADD: Middleware[] = ['clarify'];

function loadMiddlewares(): Middleware[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.MIDDLEWARES);
    if (!raw) return [...ALL_MIDDLEWARES];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // 仅保留 ALL_MIDDLEWARES 中仍存在的项，过滤历史脏数据
      const valid = parsed.filter(
        (m): m is Middleware => typeof m === 'string' && (ALL_MIDDLEWARES as string[]).includes(m),
      );
      // 全部过滤掉时回退到全开，避免空数组导致所有功能被禁用
      const base = valid.length > 0 ? valid : [...ALL_MIDDLEWARES];
      // 升级迁移：补齐新增中间件（默认开启）
      for (const m of MIDDLEWARE_MIGRATION_ADD) {
        if (!base.includes(m)) base.push(m);
      }
      return base;
    }
  } catch {
    // 解析失败视为未设置
  }
  return [...ALL_MIDDLEWARES];
}

// ===== 缓冲级（buffer-scoped）纯函数：所有写操作都作用在传入的 SessionBuffer 上 =====
// 为什么独立且 buf 前缀：消费方（UI/桌面）默认作用 active 缓冲；SSE writer 按 conversationId
// 路由到特定缓冲。buf 前缀避免与 store 内同名对外方法发生作用域遮蔽。
function bufClearCurrentRound(b: SessionBuffer) {
  b.streamingAnswer = '';
  b.currentRefs = [];
  b.currentFollowups = [];
  b.currentThinking = [];
  b.searchProgress = null;
  // FR-09-2 清理多模态输出暂存，避免下一轮问答残留上一轮的 mindmap/faq/timeline
  b.currentMultimodal = null;
  // v3 清理图像/PPT 暂存，避免下一轮问答残留上一轮的生成结果
  b.currentImage = null;
  b.currentPpt = null;
  // §X-1 清理 runId 暂存，避免下一轮问答残留上一轮的 harness runId
  b.currentRunId = null;
  // X-2 清理可恢复流式态，避免下一轮问答误用上一轮的 managerRunId / didDone
  b.currentManagerRunId = null;
  b.currentDidDone = false;
}

// X-2 断线重连：清掉"已收到但未 finalize"的部分内容，等待后端回放完整响应。
// 与 bufClearCurrentRound 的区别：保留 currentManagerRunId / currentThreadId / currentRunId
// （重连仍需它们定位 run），仅清空本轮流式产物，避免回放时重复追加。
function bufResetForResume(b: SessionBuffer) {
  b.streamingAnswer = '';
  b.currentRefs = [];
  b.currentFollowups = [];
  b.currentThinking = [];
  b.searchProgress = null;
  b.currentMultimodal = null;
  b.currentImage = null;
  b.currentPpt = null;
  b.currentDidDone = false;
}

function bufFinalizeAnswer(
  b: SessionBuffer,
  sessionId?: string,
  messageIndex?: number,
  threadId?: string,
  followups?: string[],
) {
  // 记录本轮问答归属的线程（与 sessionId 同源，1 线程 1 会话），供后续续接记忆与归档
  if (threadId) b.currentThreadId = threadId;
  if (b.streamingAnswer) {
    const finalFollowups = followups?.length ? followups : b.currentFollowups;
    b.messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: b.streamingAnswer,
      refs: b.currentRefs.length ? [...b.currentRefs] : undefined,
      followups: finalFollowups.length ? [...finalFollowups] : undefined,
      thinking: b.currentThinking.length ? [...b.currentThinking] : undefined,
      createdAt: new Date().toISOString(),
      sessionId,
      messageIndex,
      threadId,
      // FR-RM-09：正常完成标记为 complete（缺省亦视为 complete），供续答判定区分中间态
      status: 'complete',
      // FR-09-2 多模态输出：附加 mindmap/faq/timeline 到消息，前端渲染为独立卡片
      multimodal: b.currentMultimodal ?? undefined,
      // v3 图像/PPT 生成结果附加到消息
      image: b.currentImage ?? undefined,
      ppt: b.currentPpt ?? undefined,
      // §X-1 步骤级追踪：附加 harness runId，前端凭此拉取每步耗时分解
      runId: b.currentRunId ?? undefined,
      // X-2 可恢复流式：附加 manager runId（后端开启时存在），供断线重连续接
      managerRunId: b.currentManagerRunId ?? undefined,
    });
  }
  // 答案完成（done）：澄清流程结束，清掉遗留的澄清卡片（若有）
  b.currentClarification = null;
  bufClearCurrentRound(b);
  b.isLoading = false;
}

function bufHandleError(b: SessionBuffer, message: string) {
  b.errorMessage = message;
  if (b.streamingAnswer) {
    b.messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `${b.streamingAnswer}\n\n[出错: ${message}]`,
      refs: b.currentRefs.length ? [...b.currentRefs] : undefined,
      createdAt: new Date().toISOString(),
      // FR-RM-09：生成出错 → error，重载后不自动续答
      status: 'error',
    });
  }
  // 出错时澄清卡片一并失效（流已断，选择已无意义），解除等待态
  b.currentClarification = null;
  bufClearCurrentRound(b);
  b.isLoading = false;
}

// 用户主动停止或超时停止：保留已收到的部分答案，不显示错误样式
// 为什么独立于 handleError：停止是用户主动行为或保护性兜底，非错误，
// 不应污染 errorMessage，消息尾部追加"[已停止]"让用户感知中断点
// 'edit'：编辑重发场景下终止当前回复——仅清空本轮 + 解除 loading，不追加 [已停止]、
// 不弹提示，因为调用方（handleConfirmEdit）随后会丢弃该 user 消息及其后续并重发
function bufStopLoading(b: SessionBuffer, reason: 'user' | 'timeout' | 'edit') {
  // 停止即放弃当前流程：澄清等待态一并解除（卡片失效，用户可重新提问）
  b.currentClarification = null;
  if (reason === 'edit') {
    bufClearCurrentRound(b);
    b.isLoading = false;
    return;
  }
  const suffix = reason === 'user' ? '[已停止]' : '[已超时]';
  if (b.streamingAnswer) {
    b.messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `${b.streamingAnswer}\n\n${suffix}`,
      refs: b.currentRefs.length ? [...b.currentRefs] : undefined,
      thinking: b.currentThinking.length ? [...b.currentThinking] : undefined,
      createdAt: new Date().toISOString(),
      // FR-RM-09：用户/超时主动停止 → interrupted，重载后不自动续答
      status: 'interrupted',
      // 超时中断：打 timedOut 标记，供前端在消息下方渲染常驻"确认重发"按钮
      timedOut: reason === 'timeout',
    });
  } else if (reason === 'timeout') {
    // S2 修复：首字节前即超时（弱网/模型挂死，连续 120s 零数据）时没有任何部分答案可保留，
    // 但仍生成一条 timedOut 占位消息承载"确认重发"按钮，兑现"超时后点击确认重发"的诉求——
    // 否则纯挂死场景下用户只看到超时 toast、原问题无答案且无重发入口。
    // 注意：仅 timeout 落占位；user 主动停止且零字节时不生成（避免凭空出现重发入口）。
    b.messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `${suffix} 请求超时，未收到任何响应，请检查网络或模型配置后点击下方按钮重发。`,
      createdAt: new Date().toISOString(),
      status: 'interrupted',
      timedOut: true,
    });
  }
  bufClearCurrentRound(b);
  b.isLoading = false;
}

function bufBeginStreaming(b: SessionBuffer) {
  bufClearCurrentRound(b);
  b.errorMessage = '';
  b.isLoading = true;
}

function bufSubmitQuestion(b: SessionBuffer, question: string) {
  b.messages.push({
    id: crypto.randomUUID(),
    role: 'user',
    content: question,
    createdAt: new Date().toISOString(),
  });
  bufBeginStreaming(b);
}

function bufAppendAnswer(b: SessionBuffer, text: string) {
  b.streamingAnswer += text;
}

function bufSetMultimodal(b: SessionBuffer, payload: MultimodalOutput) {
  b.currentMultimodal = payload;
}

function bufSetImage(b: SessionBuffer, payload: NonNullable<ChatMessage['image']>) {
  b.currentImage = payload;
}

function bufSetPpt(b: SessionBuffer, payload: NonNullable<ChatMessage['ppt']>) {
  b.currentPpt = payload;
}

function bufSetRefs(
  b: SessionBuffer,
  refs: string[] | Reference[],
  webRefs?: Array<{ title: string; url: string; snippet: string }>,
) {
  // §5.2 合并本地引用 + 联网搜索引用为统一 Reference[]。
  // 本地引用 citeIndex 1..N，联网引用 N+1..M，两类在 RefsList 中差异化渲染
  const localRefs: Reference[] = refs.map((ref, index) => {
    // 兼容三形态（DRY 统一入口）：
    //   v1 string（旧路径）→ 组装无信号 Reference
    //   v2 Reference（旧对象，可能无 signals）→ 透传
    //   V4.0 RefSignal（path + authority/confidence/review/knowledgeStatus）→ 组装 signals
    if (typeof ref === 'string') {
      return {
        path: ref,
        title: ref.split('/').pop() || ref,
        snippet: '',
        source: 'vault' as const,
        citeIndex: index + 1,
      };
    }
    if (!ref.signals) {
      // 后端 RefSignal 顶层字段组装 signals；若已带 signals 则以此为准
      const sig = ref as { authority?: RefAuthority; confidence?: boolean; review?: boolean; knowledgeStatus?: KnowledgeStatus };
      ref.signals = {
        authority: sig.authority ?? 'unknown',
        confidence: sig.confidence ?? false,
        review: sig.review ?? false,
        knowledgeStatus: sig.knowledgeStatus ?? 'unknown',
      };
    }
    return ref;
  });
  const webRefList: Reference[] = (webRefs ?? []).map((r, i) => ({
    url: r.url,
    title: r.title || r.url,
    snippet: r.snippet,
    source: 'web' as const,
    citeIndex: localRefs.length + i + 1,
  }));
  b.currentRefs = [...localRefs, ...webRefList];
}

function bufSetFollowups(b: SessionBuffer, followups: string[]) {
  b.currentFollowups = followups;
}

function bufAppendThinking(b: SessionBuffer, step: ThinkingStep) {
  b.currentThinking.push(step);
}

function bufSetProgress(b: SessionBuffer, step: string, count?: number) {
  b.searchProgress = { step, count };
}

// 意图澄清：后端 SSE clarify 事件写入澄清卡片（覆盖旧卡）。
// 为什么不动 isLoading：收到 clarify 即中断本轮，isLoading 保持 true 让 UI 停留在
// 「等待用户选择」态（卡片处于可交互状态），同时阻止新提问/重新生成（与流式中一致）。
function bufSetClarification(b: SessionBuffer, payload: Clarification) {
  b.currentClarification = payload;
}

// 用户放弃澄清（换个问法）：清卡片并解除 isLoading，允许重新输入/提问。
function bufClearClarification(b: SessionBuffer) {
  b.currentClarification = null;
  b.isLoading = false;
}

function bufSetThreadId(b: SessionBuffer, id: string | null) {
  b.currentThreadId = id;
}

function bufSetRunId(b: SessionBuffer, id: string | null) {
  b.currentRunId = id;
}

// T00265：记录本轮问答的上下文占用统计（governor 治理前 token 总量 + 预算上限）
function bufSetContextUsage(b: SessionBuffer, governor: { inputTokens?: number } | null | undefined, maxTokens?: number) {
  b.contextInputTokens = governor?.inputTokens ?? b.contextInputTokens;
  b.contextMaxTokens = maxTokens ?? b.contextMaxTokens;
}

function bufSetErrorMessage(b: SessionBuffer, message: string) {
  b.errorMessage = message;
}

function bufLoadMessages(b: SessionBuffer, loadedMessages: ChatMessage[]) {
  b.messages = loadedMessages;
  bufClearCurrentRound(b);
  b.errorMessage = '';
  b.isLoading = false;
}

function bufRemoveMessagesFrom(b: SessionBuffer, index: number) {
  // 防御：夹紧到合法范围，避免传入过期/越界 idx 时 slice 产生非预期结果（负值回退到 0 即保留全部，
  // 超长回退到末尾即不删）。模板始终传有效 idx 且 isLoading 守卫阻断并发变更，此兜底仅防未然。
  const safe = Math.min(Math.max(index, 0), b.messages.length);
  b.messages = b.messages.slice(0, safe);
}

function bufRemoveMessage(b: SessionBuffer, index: number) {
  if (index >= 0 && index < b.messages.length) {
    b.messages.splice(index, 1);
  }
}

function bufMarkArchived(b: SessionBuffer, index: number) {
  if (b.messages[index]) b.messages[index].archived = true;
}

function bufSetFeedback(b: SessionBuffer, index: number, feedback: 'up' | 'down') {
  if (b.messages[index]) b.messages[index].feedback = feedback;
}

// FR-RM-09 断点续答：返回「可持久化」的消息快照（缓冲级）。
function bufMessagesWithStreaming(b: SessionBuffer): ChatMessage[] {
  const arr: ChatMessage[] = [...b.messages];
  if (b.isLoading && b.streamingAnswer) {
    arr.push({
      id: undefined,
      role: 'assistant',
      content: b.streamingAnswer,
      createdAt: new Date().toISOString(),
      status: 'streaming',
    });
  }
  return arr;
}

export const useQueryStore = defineStore('query', () => {
  // §按会话隔离：所有会话级状态收进 sessions Map，activeId 选定当前缓冲
  const sessions = ref<Map<string, SessionBuffer>>(new Map([[DEFAULT_ACTIVE, createEmptyBuffer()]]));
  const activeId = ref<string>(DEFAULT_ACTIVE);

  // 当前激活缓冲（UI/桌面默认作用对象）。缺失时惰性创建，保证读取永远有对象。
  function activeBuffer(): SessionBuffer {
    let b = sessions.value.get(activeId.value);
    if (!b) {
      b = createEmptyBuffer();
      sessions.value.set(activeId.value, b);
    }
    return b;
  }

  // ===== 偏好（全局，非会话级）=====
  const outputModes = ref<OutputMode[]>(loadOutputModes());
  const streamMode = ref<boolean>(loadStreamMode());
  const middlewares = ref<Middleware[]>(loadMiddlewares());

  watch(
    outputModes,
    (modes) => {
      try {
        localStorage.setItem(STORAGE_KEYS.OUTPUT_MODES, JSON.stringify(modes));
      } catch {
        // 写入失败（如存储满）静默降级，仅内存态生效
      }
    },
    { deep: true },
  );
  watch(streamMode, (mode) => {
    try {
      localStorage.setItem(STORAGE_KEYS.STREAM_MODE, String(mode));
    } catch {
      // 写入失败静默降级
    }
  });
  watch(
    middlewares,
    (list) => {
      try {
        localStorage.setItem(STORAGE_KEYS.MIDDLEWARES, JSON.stringify(list));
      } catch {
        // 写入失败静默降级
      }
    },
    { deep: true },
  );

  // ===== 会话级状态：computed 代理到 active 缓冲 =====
  // 为什么用 computed：缓冲内容随 activeId 切换/后台写入变化，computed 让所有消费方
  // （桌面 Query/FloatingChat、移动端）零改动地读到「当前会话」的正确状态。
  const messages = computed(() => sessions.value.get(activeId.value)?.messages ?? []);
  const streamingAnswer = computed(() => sessions.value.get(activeId.value)?.streamingAnswer ?? '');
  const currentRefs = computed(() => sessions.value.get(activeId.value)?.currentRefs ?? []);
  const currentFollowups = computed(() => sessions.value.get(activeId.value)?.currentFollowups ?? []);
  const currentThinking = computed(() => sessions.value.get(activeId.value)?.currentThinking ?? []);
  const searchProgress = computed(() => sessions.value.get(activeId.value)?.searchProgress ?? null);
  const isLoading = computed(() => sessions.value.get(activeId.value)?.isLoading ?? false);
  const errorMessage = computed(() => sessions.value.get(activeId.value)?.errorMessage ?? '');
  const currentMultimodal = computed(() => sessions.value.get(activeId.value)?.currentMultimodal ?? null);
  const currentImage = computed(() => sessions.value.get(activeId.value)?.currentImage ?? null);
  const currentPpt = computed(() => sessions.value.get(activeId.value)?.currentPpt ?? null);
  const currentThreadId = computed(() => sessions.value.get(activeId.value)?.currentThreadId ?? null);
  const currentClarification = computed(() => sessions.value.get(activeId.value)?.currentClarification ?? null);

  // T00265：上下文占用统计（读 active buffer）——必须用 computed 而非对象 getter，
  // 否则 Pinia setup store 会把普通 getter 快照为初始值，导致徽章读不到动态数据
  const contextInputTokens = computed(() => activeBuffer().contextInputTokens);
  const contextMaxTokens = computed(() => activeBuffer().contextMaxTokens);

  // ===== 多会话路由 / 查询 =====
  // 读取指定会话缓冲（不创建）。移动端用于判断后台会话是否仍在流式、持久化离开的会话。
  function getSessionBuffer(id: string): SessionBuffer | undefined {
    return sessions.value.get(id);
  }

  // 切换到某会话缓冲：确保缓冲存在；若提供 messages 且该会话未在流式，则载入（用于打开历史会话）；
  // threadId 显式传入时一并恢复（用于续接本地记忆）。设置 activeId 使后续读写落到该会话。
  function swapSession(id: string, opts?: { messages?: ChatMessage[]; threadId?: string | null }) {
    if (!sessions.value.has(id)) sessions.value.set(id, createEmptyBuffer());
    const buf = sessions.value.get(id)!;
    if (opts?.messages && !buf.isLoading) {
      buf.messages = opts.messages;
      bufClearCurrentRound(buf);
      buf.errorMessage = '';
      buf.isLoading = false;
    }
    if (opts?.threadId !== undefined) buf.currentThreadId = opts.threadId;
    activeId.value = id;
  }

  // 删除某会话缓冲（移动端删除会话时调用）。若删除的是当前激活缓冲，回落到默认空缓冲。
  function removeSession(id: string) {
    sessions.value.delete(id);
    if (activeId.value === id) {
      sessions.value.set(DEFAULT_ACTIVE, createEmptyBuffer());
      activeId.value = DEFAULT_ACTIVE;
    }
  }

  // 指定会话是否正在流式（active 或后台皆可）。列表动画 / 头部动画据此判断。
  function isSessionStreaming(id: string): boolean {
    return sessions.value.get(id)?.isLoading ?? false;
  }

  // 是否存在任意会话在流式（驱动头部动画）。
  const anySessionStreaming = computed(() => {
    for (const b of sessions.value.values()) {
      if (b.isLoading) return true;
    }
    return false;
  });

  // 生成按 conversationId 路由的 SSEWriter：每次写入都据「当前 activeId」动态解析目标缓冲，
  // 因此「切走时后台流写 sessions[convId]、切回时同一 writer 自动改写 active 缓冲」无缝衔接。
  function getSessionWriter(conversationId?: string | null) {
    const resolve = (): SessionBuffer => {
      const useActive = !conversationId || conversationId === activeId.value;
      if (useActive) return activeBuffer();
      if (!sessions.value.has(conversationId)) sessions.value.set(conversationId, createEmptyBuffer());
      return sessions.value.get(conversationId)!;
    };
    const b = () => resolve();
    return {
      get isLoading() {
        return b().isLoading;
      },
      get streamingAnswer() {
        return b().streamingAnswer;
      },
      appendAnswer: (text: string) => bufAppendAnswer(b(), text),
      setRefs: (refs: string[] | Reference[], webRefs?: Array<{ title: string; url: string; snippet: string }>) =>
        bufSetRefs(b(), refs, webRefs),
      setFollowups: (followups: string[]) => bufSetFollowups(b(), followups),
      appendThinking: (step: ThinkingStep) => bufAppendThinking(b(), step),
      setProgress: (step: string, count?: number) => bufSetProgress(b(), step, count),
      setMultimodal: (payload: MultimodalOutput) => bufSetMultimodal(b(), payload),
      setImage: (payload: NonNullable<ChatMessage['image']>) => bufSetImage(b(), payload),
      setPpt: (payload: NonNullable<ChatMessage['ppt']>) => bufSetPpt(b(), payload),
      setThreadId: (id: string | null) => bufSetThreadId(b(), id),
      // §X-1 步骤级追踪：done 事件携带的 harness runId 暂存到缓冲，finalizeAnswer 时附加到消息
      setRunId: (id?: string) => bufSetRunId(b(), id ?? null),
      // T00265：done 事件携带的上下文占用统计暂存到缓冲，徽章据此展示
      setContextUsage: (governor: { inputTokens?: number } | null | undefined, maxTokens?: number) =>
        bufSetContextUsage(b(), governor, maxTokens),
      // X-2 可恢复流式：open 事件携带的 manager runId 暂存到缓冲，断线重连时凭此 resume
      setManagerRunId: (id?: string) => {
        b().currentManagerRunId = id ?? null;
      },
      get managerRunId() {
        return b().currentManagerRunId;
      },
      get threadId() {
        return b().currentThreadId;
      },
      get didDone() {
        return b().currentDidDone;
      },
      // X-2 断线重连：清掉已收到但未 finalize 的部分内容，等待后端回放完整响应（避免重复追加）
      resetForResume: () => bufResetForResume(b()),
      // 意图澄清：SSE clarify 事件写入澄清卡片（不改变 isLoading，保持等待用户选择态）
      setClarification: (payload: Clarification) => bufSetClarification(b(), payload),
      // 用户放弃澄清（换个问法）：清卡片并解除 isLoading
      clearClarification: () => bufClearClarification(b()),
      get clarification() {
        return b().currentClarification;
      },
      finalizeAnswer: (
        sessionId?: string,
        messageIndex?: number,
        threadId?: string,
        followups?: string[],
      ) => {
        b().currentDidDone = true;
        bufFinalizeAnswer(b(), sessionId, messageIndex, threadId, followups);
      },
      handleError: (message: string) => bufHandleError(b(), message),
    };
  }

  // ===== 对外方法（默认作用 active 缓冲，与旧扁平 API 行为一致）=====
  function toggleOutputMode(mode: OutputMode) {
    const idx = outputModes.value.indexOf(mode);
    if (idx >= 0) {
      outputModes.value.splice(idx, 1);
    } else {
      outputModes.value.push(mode);
    }
  }

  function toggleStreamMode() {
    streamMode.value = !streamMode.value;
  }

  function toggleMiddleware(mw: Middleware) {
    const idx = middlewares.value.indexOf(mw);
    if (idx >= 0) {
      middlewares.value.splice(idx, 1);
    } else {
      middlewares.value.push(mw);
    }
  }

  function submitQuestion(q: string) {
    bufSubmitQuestion(activeBuffer(), q);
  }

  function beginStreaming() {
    bufBeginStreaming(activeBuffer());
  }

  function handleError(message: string) {
    bufHandleError(activeBuffer(), message);
  }

  function stopLoading(reason: 'user' | 'timeout' | 'edit') {
    bufStopLoading(activeBuffer(), reason);
  }

  function setErrorMessage(message: string) {
    bufSetErrorMessage(activeBuffer(), message);
  }

  // 清空全部缓冲（账户切换 / 登出隔离用）。比旧 reset 更彻底：连后台并行会话一并清除，杜绝串台。
  function reset() {
    sessions.value = new Map([[DEFAULT_ACTIVE, createEmptyBuffer()]]);
    activeId.value = DEFAULT_ACTIVE;
  }

  function setThreadId(id: string | null) {
    bufSetThreadId(activeBuffer(), id);
  }

  function markArchived(index: number) {
    bufMarkArchived(activeBuffer(), index);
  }

  function loadMessages(loadedMessages: ChatMessage[]) {
    bufLoadMessages(activeBuffer(), loadedMessages);
  }

  function removeMessagesFrom(index: number) {
    bufRemoveMessagesFrom(activeBuffer(), index);
  }

  function removeMessage(index: number) {
    bufRemoveMessage(activeBuffer(), index);
  }

  function setFeedback(index: number, feedback: 'up' | 'down') {
    bufSetFeedback(activeBuffer(), index, feedback);
  }

  function messagesWithStreaming(): ChatMessage[] {
    return bufMessagesWithStreaming(activeBuffer());
  }

  // 指定会话的可持久化快照（含流式中间态），用于离开后台会话时落盘。
  function messagesWithStreamingFor(id: string): ChatMessage[] {
    const b = sessions.value.get(id);
    return b ? bufMessagesWithStreaming(b) : [];
  }

  return {
    // 会话级状态（computed 代理 active 缓冲）
    messages,
    streamingAnswer,
    currentRefs,
    currentFollowups,
    currentThinking,
    searchProgress,
    isLoading,
    errorMessage,
    currentMultimodal,
    currentImage,
    currentPpt,
    currentThreadId,
    currentClarification,
    // 多会话路由
    activeId,
    getSessionBuffer,
    swapSession,
    removeSession,
    isSessionStreaming,
    anySessionStreaming,
    getSessionWriter,
    messagesWithStreamingFor,
    // 偏好（全局）
    outputModes,
    streamMode,
    middlewares,
    // 缓冲级写方法（默认 active）
    appendAnswer: (text: string) => bufAppendAnswer(activeBuffer(), text),
    setRefs: (refs: string[] | Reference[], webRefs?: Array<{ title: string; url: string; snippet: string }>) =>
      bufSetRefs(activeBuffer(), refs, webRefs),
    setFollowups: (followups: string[]) => bufSetFollowups(activeBuffer(), followups),
    appendThinking: (step: ThinkingStep) => bufAppendThinking(activeBuffer(), step),
    setProgress: (step: string, count?: number) => bufSetProgress(activeBuffer(), step, count),
    setMultimodal: (payload: MultimodalOutput) => bufSetMultimodal(activeBuffer(), payload),
    setImage: (payload: NonNullable<ChatMessage['image']>) => bufSetImage(activeBuffer(), payload),
    setPpt: (payload: NonNullable<ChatMessage['ppt']>) => bufSetPpt(activeBuffer(), payload),
    finalizeAnswer: (
      sessionId?: string,
      messageIndex?: number,
      threadId?: string,
      followups?: string[],
    ) => bufFinalizeAnswer(activeBuffer(), sessionId, messageIndex, threadId, followups),
    submitQuestion,
    beginStreaming,
    handleError,
    stopLoading,
    setErrorMessage,
    reset,
    markArchived,
    loadMessages,
    removeMessagesFrom,
    removeMessage,
    setFeedback,
    setThreadId,
    messagesWithStreaming,
    toggleOutputMode,
    toggleStreamMode,
    toggleMiddleware,
    // 意图澄清：对外方法（默认 active 缓冲）
    setClarification: (payload: Clarification) => bufSetClarification(activeBuffer(), payload),
    clearClarification: () => bufClearClarification(activeBuffer()),
    // T00265：上下文占用统计（computed，响应式），消息气泡徽章据此展示
    contextInputTokens,
    contextMaxTokens,
  };
});

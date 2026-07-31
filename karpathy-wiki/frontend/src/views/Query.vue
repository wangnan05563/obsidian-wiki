<script setup lang="ts">
import { API_BASE } from '../utils/apiBase';
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { Promotion, VideoPause, Menu, Loading } from '@element-plus/icons-vue';
import ConversationSidebar from '../components/ConversationSidebar.vue';
import AttachmentUploader from '../components/AttachmentUploader.vue';
import InputToolbar from '../components/InputToolbar.vue';
import ThinkingBlock from '../components/ThinkingBlock.vue';
import ModelSelector from '../components/ModelSelector.vue';
import RefsList from '../components/RefsList.vue';
import MessageToolbar from '../components/MessageToolbar.vue';
// FR-09-2 多模态输出卡片：渲染 mindmap/faq/timeline 结构化输出
import MultimodalOutputCard from '../components/MultimodalOutputCard.vue';
import { useQueryStore, ALL_OUTPUT_MODES, OUTPUT_MODE_LABELS, type OutputMode, ALL_MIDDLEWARES, MIDDLEWARE_LABELS, type Middleware } from '../stores/query';
import { useAuthStore } from '../stores/auth';
import { useConversationsStore } from '../stores/conversations';
import { useModelStore } from '../stores/model';
import { useAttachmentsStore } from '../stores/attachments';
import { dbGet, CHAT_STORES } from '../services/chatDb';
import { apiErrorMessage } from '../utils/apiError';
import { renderMarkdown } from '../utils/markdown';
import { consumeQuerySSE } from '../utils/sse';
import type { Attachment, Reference } from '../types';
import { STORAGE_KEYS } from '../constants/storageKeys';

// F-3.2 图片点击放大预览：v-html 内容不经过 Vue 编译，无法绑定 Vue 事件，需事件委托
// 参考 MarkdownRenderer.vue 同款实现模式：监听根元素 click，target.tagName === 'IMG' 触发预览
const previewSrc = ref('');
const previewVisible = ref(false);
const handleImgClick = (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  if (target.tagName === 'IMG') {
    e.preventDefault();
    previewSrc.value = (target as HTMLImageElement).src;
    previewVisible.value = true;
  }
};

// F-3.7 代码块复制：事件委托捕获 .code-copy-btn 点击，从兄弟 pre > code 取 textContent
// 为什么从 DOM 取而非 data 属性：避免长代码 HTML 转义/属性大小限制
async function copyCodeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
const handleCodeCopyClick = async (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  // 命中复制按钮或其子节点
  const btn = target.closest('[data-action="copy-code"]') as HTMLElement | null;
  if (!btn) return;
  e.preventDefault();
  // 从兄弟 pre > code 取原始代码
  const wrapper = btn.closest('.code-block-wrapper');
  const codeEl = wrapper?.querySelector('pre code');
  if (!codeEl) return;
  const code = codeEl.textContent || '';
  const ok = await copyCodeToClipboard(code);
  ElMessage[ok ? 'success' : 'warning'](ok ? '已复制代码' : '复制失败，请手动选择');
};

// F-3.8 [1] 引用编号锚点点击：事件委托捕获 .ref-anchor 点击，阻止默认导航，改为平滑滚动到 ref 卡片
// 为什么阻止默认：默认 #ref-N 会跳到 id=ref-N 元素但无滚动动画，体验突兀
// 为什么需要展开折叠：ref 卡片可能折叠隐藏，需先展开 RefsList 再滚动
const handleRefAnchorClick = (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  const anchor = target.closest('.ref-anchor') as HTMLElement | null;
  if (!anchor) return;
  e.preventDefault();
  const refNum = anchor.dataset.ref;
  if (!refNum) return;
  // 找到本条 assistant 消息对应的 refs-list（位于同一消息容器内）
  const msgContainer = anchor.closest('.msg-bubble, .message');
  if (!msgContainer) return;
  const refsList = msgContainer.querySelector('.refs-list');
  if (!refsList) return;
  // 若 refs-list 已折叠，先展开（点击 toggleExpanded 等价行为）
  // 为什么用属性检查：Vue 渲染的 .refs-body v-if="expanded" 不在 DOM 时需触发展开
  let refsBody = refsList.querySelector('.refs-body');
  if (!refsBody) {
    // 折叠态：点击 header 触发 toggleExpanded
    const header = refsList.querySelector('.refs-header') as HTMLElement | null;
    header?.click();
  }
  // 等 Vue 重新渲染 refs-body 后再滚动（nextTick 等价）
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const targetEl = msgContainer.querySelector(`#ref-${refNum}`) as HTMLElement | null;
      targetEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 闪烁高亮目标卡片，让用户感知跳转位置
      if (targetEl) {
        targetEl.classList.add('ref-flash');
        setTimeout(() => targetEl.classList.remove('ref-flash'), 1500);
      }
    });
  });
};

// §2.1 Query.vue 完整重构：集成侧栏/模型选择/附件/工具栏/思考块/引用列表/追问。
// 设计参考：知识库问答AI对话流详细设计说明书 §2.1.2 / §2.1.3
const store = useQueryStore();
const authStore = useAuthStore();
const conversationsStore = useConversationsStore();
const modelStore = useModelStore();
const attachmentsStore = useAttachmentsStore();

// FR-12 AI 伙伴预设：从 /api/ai/config 加载 skills 列表与当前 activeSkill
const skills = ref<Array<{ id: string; name: string; description?: string; enabled?: boolean }>>([]);
const activeSkillId = ref('');

async function loadSkills() {
  try {
    const res = await fetch(`${API_BASE}/ai/config`);
    if (!res.ok) return;
    const cfg = await res.json() as { skills?: typeof skills.value; activeSkill?: string };
    skills.value = cfg.skills?.filter((s) => s.enabled) ?? [];
    activeSkillId.value = cfg.activeSkill ?? '';
  } catch { /* skills 加载失败不阻断主流程 */ }
}

async function handleSkillChange(skillId: string) {
  try {
    await fetch(`${API_BASE}/ai/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeSkill: skillId }),
    });
    const preset = skills.value.find((s) => s.id === skillId);
    if (preset) {
      ElMessage.success(`AI 伙伴：${preset.name}`);
    } else {
      ElMessage.success('已切换到默认模式');
    }
  } catch (err) {
    ElMessage.error('伙伴切换失败：' + (err as Error).message);
    // 回滚 UI
    activeSkillId.value = '';
  }
}

// F-3.10 progress 事件展示文案：后端 step 英文枚举 → 前端中文友好提示
const searchProgressLabel = computed(() => {
  const step = store.searchProgress?.step;
  if (step === 'searching') return '正在联网搜索...';
  if (step === 'fetching') return '正在抓取网页...';
  if (step === 'done') return '联网搜索完成';
  return step || '';
});

const inputQuestion = ref('');
const chatBodyRef = ref<HTMLDivElement | null>(null);
let abortController: AbortController | null = null;

// 问答超时机制：LLM 长时间无响应时自动中断，避免用户卡在"正在思考"
// 为什么 120 秒：覆盖 MCP 扩展工具加载（最多 30s，已并行优化）+ LLM 首字节延迟（5-15s）
//   + 深度思考模式推理时间（30-60s），同时避免无限等待。
// 历史：原 60s 阈值在 MCP 服务器串行加载时（2×30s=60s）刚好被触发，
//   导致 AI 实际有回复但前端已超时中断，用户感知"AI 未回复信息"。
const QUESTION_TIMEOUT_MS = 120_000;
let questionTimeoutId: ReturnType<typeof setTimeout> | null = null;
// 标记本次中断的原因，供 finally 分支区分用户停止 / 超时 / 正常完成
let abortReason: 'user' | 'timeout' | null = null;

// F-3.11 二态侧栏：expanded(280px) / hidden(0,完全隐藏，仅浮动展开按钮)
// 为什么改二态：原三态 expanded→collapsed→hidden 需点两次才能完全折叠，
//   用户需求"折叠一步到位"——一次点击直接从展开到完全隐藏，释放全部水平空间给聊天区
// 状态持久化到 localStorage，刷新后保留
type SidebarState = 'expanded' | 'hidden';
const sidebarState = ref<SidebarState>(
  (localStorage.getItem(STORAGE_KEYS.SIDEBAR_STATE) as SidebarState) || 'expanded'
);
function setSidebarState(state: SidebarState) {
  sidebarState.value = state;
  localStorage.setItem(STORAGE_KEYS.SIDEBAR_STATE, state);
}
// 二态循环：expanded ↔ hidden，一次点击即折叠到位
function toggleSidebar() {
  setSidebarState(sidebarState.value === 'expanded' ? 'hidden' : 'expanded');
}
// F-3.11 Ctrl+B 快捷键：全局监听，二态切换（expanded ↔ hidden）
// 为什么用 keydown 而非 keystroke：Ctrl+B 是浏览器默认"加粗"快捷键，需 preventDefault 屏蔽
function handleGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
    e.preventDefault();
    toggleSidebar();
  }
}

// F-3.4 工具栏模式（SRS F-3.4 工具清单）
// v3.2 移除 web/deep 独立按钮：与中间件多选 web_search/deep_thinking 重复，统一由中间件配置
// v3.1 调整：移除"更多"下拉（more 工具与 secondaryTools 整体删去）。
//   AI 伙伴选择器挪到高级设置面板，避免"点开工具再下拉"的二次操作。工具栏视觉更清爽。
// v3.0.0 范围：
//   - fast/write/translate：mode 字段传递，后端按需处理
//   - ppt/image：设置 outputMode 为 ppt/image，走 query SSE 流生成
//   - video：打开独立视频生成对话框（异步任务，不走 SSE 流）
const activeMode = ref('');
const toolbarTools = [
  { key: 'fast', label: '快速' },
  { key: 'write', label: '帮我写作' },
  { key: 'ppt', label: 'PPT 生成' },
  { key: 'image', label: '图像生成' },
  { key: 'video', label: '视频生成' },
  { key: 'translate', label: '翻译' },
];
// FR-09-2 多模态输出模式：默认 'normal'，可选 'mindmap' / 'faq' / 'timeline' / 'image' / 'ppt'
// 为什么独立于 activeMode：activeMode 控制 LLM 行为（web/deep），outputMode 控制输出结构化格式
// 两者正交：用户可同时选 'deep' + 'mindmap' 深度思考并输出思维导图
// v3 扩展：image 走 Agnes Image API 生成图像，ppt 走 LLM 生成 Marp Markdown
const outputMode = ref<'normal' | 'mindmap' | 'faq' | 'timeline' | 'image' | 'ppt'>('normal');
const outputModeOptions = [
  { value: 'normal', label: '普通' },
  { value: 'mindmap', label: '思维导图' },
  { value: 'faq', label: 'FAQ' },
  { value: 'timeline', label: '时间线' },
  { value: 'image', label: '图像' },
  { value: 'ppt', label: 'PPT' },
] as const;
function handleOutputModeChange(val: 'normal' | 'mindmap' | 'faq' | 'timeline' | 'image' | 'ppt') {
  outputMode.value = val;
}
// v2: 多输出模式多选切换。点击复选框/下拉项时切换模式。
// 为什么用 stopPropagation：避免 el-dropdown-item 默认行为与 checkbox 冲突（重复触发）
function handleToggleOutputMode(mode: OutputMode) {
  store.toggleOutputMode(mode);
}
// v2: 提示用户当前开启了哪些模式，鼠标 hover trigger 按钮时显示
const outputModesTooltip = computed(() => {
  const enabled = store.outputModes
    .map((m) => OUTPUT_MODE_LABELS[m])
    .join('、');
  return `已开启：${enabled || '（无）'}`;
});
// 中间件多选切换：与 handleToggleOutputMode 模式一致，委托 store.toggleMiddleware
function handleToggleMiddleware(mw: Middleware) {
  store.toggleMiddleware(mw);
}
// 中间件 tooltip：提示用户当前启用了哪些中间件
const middlewaresTooltip = computed(() => {
  const enabled = store.middlewares
    .map((m) => MIDDLEWARE_LABELS[m])
    .join('、');
  return `已启用：${enabled || '（无）'}`;
});
// 点击同一工具切换为关闭；点击不同工具切换为该模式
// v3 扩展：ppt/image 工具联动 outputMode（设置后发送问答时透传到后端），
//          video 工具打开独立对话框（不走 SSE 流，异步轮询任务状态）
function handleSelectMode(mode: string) {
  // video 走独立对话框，不切换 activeMode
  if (mode === 'video') {
    videoDialogVisible.value = true;
    return;
  }
  // ppt/image 工具：联动 outputMode，再次点击关闭时恢复 normal
  if (mode === 'ppt' || mode === 'image') {
    if (activeMode.value === mode) {
      // 再次点击关闭：恢复 normal
      activeMode.value = '';
      outputMode.value = 'normal';
    } else {
      activeMode.value = mode;
      outputMode.value = mode;
    }
    return;
  }
  activeMode.value = activeMode.value === mode ? '' : mode;
}

// v3 视频生成对话框：独立于 query SSE 流，走 POST /api/media/video + 轮询 GET /api/media/video/:taskId
// 为什么独立：视频生成需数分钟，超出 query SSE 60 秒超时，走异步任务 + 前端轮询
const videoDialogVisible = ref(false);
const videoPrompt = ref('');
const videoTaskId = ref('');
const videoStatus = ref<'idle' | 'queued' | 'processing' | 'completed' | 'failed'>('idle');
const videoProgress = ref(0);
const videoUrl = ref('');
const videoError = ref('');
let videoPollTimer: ReturnType<typeof setInterval> | null = null;

// 提交视频生成任务：POST /api/media/video 创建任务，成功后启动轮询
async function submitVideoTask() {
  const prompt = videoPrompt.value.trim();
  if (!prompt) {
    ElMessage.warning('请输入视频描述');
    return;
  }
  videoStatus.value = 'queued';
  videoProgress.value = 0;
  videoError.value = '';
  videoUrl.value = '';
  videoTaskId.value = '';

  try {
    const resp = await fetch(`${API_BASE}/media/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    videoTaskId.value = data.taskId;
    videoStatus.value = data.status || 'processing';
    // 启动轮询（5 秒间隔，与后端 60/min 限流匹配）
    startVideoPolling();
  } catch (err) {
    videoStatus.value = 'failed';
    videoError.value = err instanceof Error ? err.message : String(err);
    ElMessage.warning(apiErrorMessage('视频生成任务创建失败', err));
  }
}

// 轮询视频任务状态：GET /api/media/video/:taskId
// 为什么用 setInterval 而非递归 setTimeout：轮询间隔固定，setInterval 语义更清晰
function startVideoPolling() {
  stopVideoPolling();
  videoPollTimer = setInterval(async () => {
    if (!videoTaskId.value) return;
    try {
      const resp = await fetch(`${API_BASE}/media/video/${videoTaskId.value}`);
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      videoStatus.value = data.status;
      videoProgress.value = data.progress ?? 0;
      if (data.status === 'completed' && data.url) {
        videoUrl.value = data.url;
        stopVideoPolling();
      } else if (data.status === 'failed') {
        videoError.value = data.error || '视频生成失败';
        stopVideoPolling();
      }
    } catch (err) {
      // 轮询单次失败不终止，继续重试（网络抖动场景）
      videoError.value = err instanceof Error ? err.message : String(err);
    }
  }, 5000);
}

function stopVideoPolling() {
  if (videoPollTimer) {
    clearInterval(videoPollTimer);
    videoPollTimer = null;
  }
}

// 关闭视频对话框：停止轮询并重置状态
function closeVideoDialog() {
  stopVideoPolling();
  videoDialogVisible.value = false;
  videoPrompt.value = '';
  videoTaskId.value = '';
  videoStatus.value = 'idle';
  videoProgress.value = 0;
  videoUrl.value = '';
  videoError.value = '';
}

// 重置视频对话框状态但保持对话框打开：允许用户在完成后点击"重新生成"
// 为什么独立于 closeVideoDialog：closeVideoDialog 会关闭对话框，而重新生成需保持打开
function resetVideoDialog() {
  stopVideoPolling();
  videoTaskId.value = '';
  videoStatus.value = 'idle';
  videoProgress.value = 0;
  videoUrl.value = '';
  videoError.value = '';
}

// 附件 id 列表（绑定 AttachmentUploader，提交后清空）
const pendingAttachmentIds = ref<string[]>([]);
function handleAddAttachment(id: string) {
  pendingAttachmentIds.value.push(id);
}
function handleRemoveAttachment(id: string) {
  pendingAttachmentIds.value = pendingAttachmentIds.value.filter(i => i !== id);
}

function scrollToBottom() {
  nextTick(() => {
    if (chatBodyRef.value) {
      chatBodyRef.value.scrollTop = chatBodyRef.value.scrollHeight;
    }
  });
}

watch(
  () => [store.messages.length, store.streamingAnswer, store.currentThinking.length],
  scrollToBottom,
);

// Blob 转 dataURL（base64）：用于把附件内嵌到 SSE 请求体
// 为什么用 dataURL 而非裸 base64：后端可直接识别 mimeType 并落盘或转发
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// §5.2 收集附件：从 IndexedDB 读取 blob，转 base64，返回后端期望格式
async function collectAttachments(): Promise<Array<{ data: string; mimeType: string; filename: string }>> {
  const result: Array<{ data: string; mimeType: string; filename: string }> = [];
  for (const id of pendingAttachmentIds.value) {
    const record = await dbGet<Attachment>(CHAT_STORES.attachments, id);
    if (record) {
      const dataUrl = await blobToDataUrl(record.blob);
      result.push({
        data: dataUrl,
        mimeType: record.mimeType,
        filename: record.filename,
      });
    }
  }
  return result;
}

// 统一 msg.refs 为 Reference[]，兼容 v1 string[] 与 v2 Reference[]
// 后端 refs 已解析为文件相对路径（如 concepts/llm-wiki.md），title 取 basename 去 .md 后缀展示
function normalizeRefs(refs: string[] | Reference[] | undefined): Reference[] {
  if (!refs || refs.length === 0) return [];
  if (typeof refs[0] === 'string') {
    return (refs as string[]).map((path, i) => ({
      path,
      // 路径形式（带 .md）取 basename 去后缀作 title；裸页面名原样使用
      title: (path.split('/').pop() || path).replace(/\.md$/, ''),
      snippet: '',
      source: 'vault' as const,
      citeIndex: i + 1,
    }));
  }
  return refs as Reference[];
}

async function sendQuestion(question: string) {
  abortController = new AbortController();
  abortReason = null;
  const history = store.messages.map((m) => ({ role: m.role, content: m.content }));

  // 启动超时定时器：到达阈值后自动 abort 并标记为 timeout
  // 为什么用 setTimeout 而非 AbortSignal.timeout：需要同时设置 abortReason 标记
  questionTimeoutId = setTimeout(() => {
    if (abortController && !abortController.signal.aborted) {
      abortReason = 'timeout';
      abortController.abort();
    }
  }, QUESTION_TIMEOUT_MS);

  // 先收集附件 base64，再 flush（清空 pendingIds）
  const attachments = await collectAttachments();
  attachmentsStore.flush();
  pendingAttachmentIds.value = [];

  // 构造请求体：F-3.4 工具栏 mode 字段统一传递到 SSE
  // 模型切换由 PUT /api/ai/config 统一处理，不在此处传 model
  const body: Record<string, unknown> = { question, history };
  if (activeMode.value) {
    body.mode = activeMode.value;
    // 联网搜索需要同时打开 webSearch 标志（向后端 query-workflow 传递）
    if (activeMode.value === 'web') {
      body.webSearch = true;
    }
  }
  if (attachments.length > 0) {
    body.attachments = attachments;
  }
  // FR-09-2 多模态输出：仅当非 normal 时透传，避免后端无意义调用
  if (outputMode.value !== 'normal') {
    body.outputMode = outputMode.value;
  }
  // v2: 多输出模式多选透传到后端。后端按 outputModes 决定哪些 SSE 事件下发，
  // 前端关闭的模式不会被发送，减少不必要的网络/渲染开销
  if (store.outputModes.length > 0 && store.outputModes.length < ALL_OUTPUT_MODES.length) {
    body.outputModes = [...store.outputModes];
  }
  // §真流式开关透传：前端偏好覆盖后端 config.llm.stream 默认值
  // 为什么显式发送而非依赖后端默认：用户可在 Query 页面即时切换，无需改后端配置
  body.stream = store.streamMode;
  // 中间件多选透传：仅在非全开时发送，全开时省略以减少请求体大小
  // 与 outputModes 一致的策略：后端收到 undefined 时按各功能默认行为执行
  if (store.middlewares.length > 0 && store.middlewares.length < ALL_MIDDLEWARES.length) {
    body.middlewares = [...store.middlewares];
  }

  try {
    const response = await fetch(`${API_BASE}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    // SSE 流消费统一委托给 utils/sse.ts，降低本函数认知复杂度（S3776）
    // 同时传入 signal 以便主动取消时释放 reader
    // consumeQuerySSE 在 AbortError 时正常返回，不抛错，由 finally 处理停止态
    await consumeQuerySSE(response, store, abortController.signal);
    // 持久化对话到 IndexedDB（支持侧栏历史列表）
    await conversationsStore.persistConversation(store.messages);
  } catch (err: unknown) {
    // AbortError 已在 consumeQuerySSE 内吞掉，此处只会是真实网络/API 错误
    const msg = (err as Error).message;
    store.handleError(msg);
    ElMessage.warning(apiErrorMessage('问答失败', err));
  } finally {
    // 清理超时定时器（无论正常完成、用户停止、超时、错误都要清）
    if (questionTimeoutId) {
      clearTimeout(questionTimeoutId);
      questionTimeoutId = null;
    }
    // 处理主动停止/超时：store 此时仍为 isLoading=true 且未收到 done 事件
    // 调用 stopLoading 保留已收到的部分答案，追加 [已停止]/[已超时] 标记
    if (abortReason && store.isLoading) {
      store.stopLoading(abortReason);
      if (abortReason === 'user') {
        ElMessage.info('已停止回答');
      } else {
        ElMessage.warning(`问答超时（${QUESTION_TIMEOUT_MS / 1000}秒无响应），请检查网络或模型配置`);
      }
      // 持久化停止后的部分答案到 IndexedDB
      await conversationsStore.persistConversation(store.messages);
    }
    abortReason = null;
    abortController = null;
  }
}

// 手动停止：用户点击停止按钮时调用
// 为什么独立于 sendQuestion 的 finally：用户停止是异步触发的事件，
// 通过 abortController.abort() 中断 fetch/SSE，让 sendQuestion 的 finally 接管状态清理
function handleStop() {
  if (!abortController || !store.isLoading) return;
  abortReason = 'user';
  abortController.abort();
}

function handleSubmit() {
  const q = inputQuestion.value.trim();
  if (!q || store.isLoading) return;
  store.submitQuestion(q);
  inputQuestion.value = '';
  void sendQuestion(q);
}

function handleKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    handleSubmit();
  }
}

function handleNewSession() {
  store.reset();
  inputQuestion.value = '';
  conversationsStore.startNewConversation();
}

async function handleSelectConversation(id: string) {
  await conversationsStore.selectConversation(id);
}

async function archiveMessage(idx: number) {
  const msg = store.messages[idx];
  if (!msg || !msg.sessionId || msg.messageIndex === undefined || msg.archived) return;
  // 为什么用 authFetch 而非裸 fetch：归档接口受认证保护，需带 Authorization 头
  // 否则 401 会被前端统一提示"归档失败，请检查后端服务"，掩盖真实原因
  try {
    const res = await authStore.authFetch(`${API_BASE}/query/archive`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: msg.sessionId, messageIndex: msg.messageIndex }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    ElMessage.success(`已归档到 ${data.path}`);
    store.markArchived(idx);
  } catch (err: unknown) {
    // 区分错误类型给出准确提示，避免一律"请检查后端服务"误导用户
    const msg = (err as Error).message || '';
    if (msg.includes('不存在') || msg.includes('过期')) {
      ElMessage.warning('该问答已过期（后端会话已清理），无法归档');
    } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      ElMessage.error('网络错误，请检查后端服务是否运行');
    } else {
      ElMessage.warning(`归档失败：${msg}`);
    }
  }
}

// F-3.13 重新生成：复用该消息对应的 user 问题，丢弃原 assistant 回答，触发新问答
// 为什么不直接重发：SRS 要求"重新生成产生新 sessionId"，所以必须重新走完整 SSE 流程
// 策略：找到 idx-1 的 user 消息内容 → removeMessagesFrom(idx) 丢弃 assistant 回答 → sendQuestion
function handleRegenerate(idx: number) {
  if (store.isLoading) {
    ElMessage.warning('回答生成中，请稍后');
    return;
  }
  // 找到当前 assistant 消息对应的 user 问题（按 idx-1 回溯）
  // 兼容 user 消息可能不在 idx-1 的场景（如归档消息），向下回溯到第一个 user 消息
  let userIdx = -1;
  for (let i = idx - 1; i >= 0; i--) {
    if (store.messages[i].role === 'user') {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) {
    ElMessage.warning('未找到原始问题，无法重新生成');
    return;
  }
  const question = store.messages[userIdx].content;
  // 丢弃从 idx 开始的所有消息（assistant 回答 + 可能的后续追问）
  // 保留 user 问题，让用户看到"重新生成"的上下文
  store.removeMessagesFrom(idx);
  void sendQuestion(question);
}

// 删除单条消息：用户点击工具栏删除按钮时调用
// 为什么独立于 handleRegenerate：删除是手动清理单条内容，不影响其他消息；重新生成是批量丢弃+重发
// 持久化由后续 conversationsStore.persistConversation 统一处理（避免每次删除都写盘）
function handleRemoveMessage(idx: number) {
  store.removeMessage(idx);
  ElMessage.success('已删除消息');
  // 异步持久化：不阻塞 UI 反馈
  void conversationsStore.persistConversation(store.messages);
}

// 工具栏高级设置面板：齿轮按钮点击展开/收起，集中展示输出相关非高频设置
// 为什么用 mousedown 而非 click 关闭：click 事件在 element-plus 内部触发顺序不稳定，
// mousedown 触发早于下拉/选择等组件内部的 click 监听，避免面板内点击被先关闭再打开
const advancedOpen = ref(false);
const advancedPanelRef = ref<HTMLDivElement | null>(null);
// 多选下拉可见性：用 el-popover + trigger="manual" 完全手动控制
// 为什么不用 el-dropdown：el-dropdown 内置 outside-click 检测（基于 pointerdown + contains），
//   即使设 :hide-on-click="false" 与 @pointerdown.stop 仍会在某些边缘场景关闭菜单；
//   el-popover 的 trigger="manual" 把可见性完全交给外部 ref，从机制上根除自动关闭问题
const outputModesOpen = ref(false);
const middlewaresOpen = ref(false);
// 两个 popover 互斥：同时只允许一个打开，避免视觉重叠与交互混乱
function toggleOutputModes() {
  outputModesOpen.value = !outputModesOpen.value;
  if (outputModesOpen.value) middlewaresOpen.value = false;
}
function toggleMiddlewares() {
  middlewaresOpen.value = !middlewaresOpen.value;
  if (middlewaresOpen.value) outputModesOpen.value = false;
}
// el-popover 容器样式：teleport 到 body 后 scoped 样式无法选中，
// 用 :popper-style 属性内联传递，确保主题适配背景与圆角
const multiSelectPopperStyle = {
  padding: '8px 4px',
  background: 'var(--bg-card, #fff)',
  border: '1px solid var(--border-soft, rgba(0, 0, 0, 0.08))',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
  borderRadius: '10px',
};
// 列表容器样式：垂直排列 checkbox，留出足够点击区域
const multiSelectListStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '4px',
  padding: '4px 8px',
};
function handleToggleAdvanced() {
  advancedOpen.value = !advancedOpen.value;
}
// §click outside 关闭：点击面板外部任意位置收起高级设置
// 为什么用 capture: true 捕获阶段监听：避免被 element-plus 内部 stopPropagation 吞掉
function handleAdvancedOutsideClick(e: MouseEvent) {
  if (!advancedOpen.value) return;
  const target = e.target as Node | null;
  const targetEl = target as HTMLElement | null;
  // el-popover 内容 teleport 到 body，先检查是否点击在 popover 内
  // 为什么优先检查 popover：popover 内点击不关闭任何东西，让 checkbox 正常切换
  if (targetEl?.closest('.multi-select-popover')) return;
  // 面板内点击：不关闭面板，但需要关闭已打开的 popover（点击 trigger 按钮除外，由 trigger 自己 toggle）
  if (advancedPanelRef.value?.contains(target)) {
    // 点击 trigger 按钮时让 @click 自己处理切换，不在此处关闭
    if (targetEl?.closest('.output-modes-trigger') || targetEl?.closest('.middlewares-trigger')) return;
    outputModesOpen.value = false;
    middlewaresOpen.value = false;
    return;
  }
  // 齿轮按钮自身点击不关闭（否则 toggle 会被两个监听器抵消）
  if (targetEl?.closest('.advanced-toggle')) return;
  // 面板外点击：关闭面板与两个 popover
  advancedOpen.value = false;
  outputModesOpen.value = false;
  middlewaresOpen.value = false;
}

onMounted(async () => {
  // FR-12 加载 AI 伙伴列表
  loadSkills();
  try {
    await conversationsStore.loadConversations();
  } catch {
    // IndexedDB 不可用时静默降级，仅内存态
  }
  // F-3.2 注册图片点击事件委托：监听聊天区，捕获 v-html 中 img 的点击
  chatBodyRef.value?.addEventListener('click', handleImgClick);
  // F-3.7 注册代码块复制事件委托：捕获 .code-copy-btn 点击
  chatBodyRef.value?.addEventListener('click', handleCodeCopyClick);
  // F-3.8 注册引用编号锚点点击事件委托：捕获 .ref-anchor 点击
  chatBodyRef.value?.addEventListener('click', handleRefAnchorClick);
  // F-3.11 注册全局 Ctrl+B 快捷键：globalThis 监听，三态循环切换
  globalThis.addEventListener('keydown', handleGlobalKeydown);
  // §高级设置面板：全局 mousedown 捕获阶段监听，外部点击关闭
  globalThis.addEventListener('mousedown', handleAdvancedOutsideClick, true);
});

onBeforeUnmount(() => {
  abortController?.abort();
  // F-3.2 / F-3.7 / F-3.8 卸载事件委托，避免内存泄漏
  chatBodyRef.value?.removeEventListener('click', handleImgClick);
  chatBodyRef.value?.removeEventListener('click', handleCodeCopyClick);
  chatBodyRef.value?.removeEventListener('click', handleRefAnchorClick);
  // F-3.11 卸载 Ctrl+B 监听
  globalThis.removeEventListener('keydown', handleGlobalKeydown);
  // §高级设置面板：卸载全局监听
  globalThis.removeEventListener('mousedown', handleAdvancedOutsideClick, true);
});
</script>

<template>
  <div class="query-page">
    <!-- 隐藏态浮动展开按钮，hidden 状态下显示在左上角 -->
    <button
      v-if="sidebarState === 'hidden'"
      class="sidebar-show-btn"
      title="展开侧栏（Ctrl+B）"
      @click="setSidebarState('expanded')"
    >
      <el-icon><Menu /></el-icon>
    </button>
    <ConversationSidebar
      :state="sidebarState"
      @toggle="toggleSidebar"
      @new-session="handleNewSession"
      @select="handleSelectConversation"
    />
    <div class="glass-card query-card fade-up">
      <div class="card-deco"></div>
      <!-- 移除 query-head 顶部行（标题/ModelSelector），最大化问答框视野；ModelSelector 移到下方按钮行 -->

      <div ref="chatBodyRef" class="chat-body">
        <div v-if="store.messages.length === 0 && !store.streamingAnswer" class="chat-empty">
<p class="empty-tip">还没有对话，试试问个问题吧</p>
          <div class="empty-suggestions">
            <span class="suggestion-chip" @click="inputQuestion = '什么是 LLM Wiki？'">
              什么是 LLM Wiki？
            </span>
            <span class="suggestion-chip" @click="inputQuestion = '知识库中有哪些页面？'">
              知识库中有哪些页面？
            </span>
          </div>
        </div>

        <template v-for="(msg, idx) in store.messages" :key="msg.id || idx">
          <div class="msg-row" :class="msg.role">
            <!-- 仅 user 消息保留"ME"头像；assistant 消息靠左对齐已足够区分双方，去除图标保持简洁 -->
            <div v-if="msg.role === 'user'" class="msg-avatar">
              <div class="user-avatar">ME</div>
            </div>
            <div class="msg-content-wrapper" :class="msg.role">
      <div class="msg-bubble" :class="msg.role">
              <ThinkingBlock v-if="msg.thinking && msg.thinking.length > 0" :steps="msg.thinking" />
              <div class="msg-content markdown-body" v-html="renderMarkdown(msg.content)"></div>
              <!-- FR-09-2 多模态输出卡片：在主答案之后、追问之前渲染 mindmap/faq/timeline -->
              <MultimodalOutputCard v-if="msg.multimodal" :output="msg.multimodal" />
              <!-- v3 图像生成卡片：通过 SSE image 事件推送，独立于 multimodal -->
              <MultimodalOutputCard
                v-if="msg.image"
                :output="{ type: 'image', content: msg.image.alt, imageUrl: msg.image.url }"
              />
              <!-- v3 PPT 生成卡片：通过 SSE ppt 事件推送，Marp Markdown 渲染为幻灯片 -->
              <MultimodalOutputCard
                v-if="msg.ppt"
                :output="{ type: 'ppt', content: msg.ppt.title, pptMarkdown: msg.ppt.markdown }"
              />
              <!-- F-3.12 联想提问位置迁移：从 refs 下方移到 refs 上方，紧贴答案末尾，符合阅读流 -->
              <div v-if="msg.followups && msg.followups.length > 0" class="msg-followups">
                <span class="followups-label">追问：</span>
                <div class="followups-track">
                  <span
                    v-for="(f, i) in msg.followups"
                    :key="i"
                    class="followup-chip"
                    @click="inputQuestion = f"
                  >
                    {{ f }}
                    <!-- F-3.12 CSS tooltip：hover 200ms 内淡入，无需 JS 库 -->
                    <span class="chip-tooltip">点击继续追问</span>
                  </span>
                </div>
              </div>
              <RefsList v-if="normalizeRefs(msg.refs).length > 0" :refs="normalizeRefs(msg.refs)" />
      <div v-if="msg.role === 'assistant' && msg.sessionId" class="msg-actions">
                <el-button
                  size="small"
                  text
                  :disabled="msg.archived"
                  @click="archiveMessage(idx)"
                >
                  {{ msg.archived ? '已归档' : '归档' }}
                </el-button>
              </div>
            </div>
              <!-- F-3.7 / F-3.13 工具栏：气泡外部下方显示，hover 气泡时淡入，避免挡住气泡内文字 -->
              <MessageToolbar
                :role="msg.role"
                :content="msg.content"
                :msg-id="msg.id"
                :created-at="msg.createdAt"
                :can-regenerate="!store.isLoading"
                @regenerate="handleRegenerate(idx)"
                @remove="handleRemoveMessage(idx)"
              />
            </div>
          </div>
        </template>

        <!-- 流式输出中的 assistant 答案 -->
        <div v-if="store.streamingAnswer || store.isLoading" class="msg-row assistant">
          <div class="msg-bubble assistant" :class="{ streaming: !!store.streamingAnswer, loading: store.isLoading && !store.streamingAnswer }">
            <ThinkingBlock v-if="store.currentThinking.length > 0" :steps="store.currentThinking" />
            <div v-if="store.searchProgress" class="search-progress">
              {{ searchProgressLabel }}
              <span v-if="store.searchProgress.count">（{{ store.searchProgress.count }} 条）</span>
            </div>
            <!-- F-3.1 加载态：首字节前显示 3 圆点脉动 + "正在思考…" 文案；首字节后切换为流式答案 -->
            <div v-if="store.isLoading && !store.streamingAnswer && store.currentThinking.length === 0" class="loading-dots">
              <span class="dot"></span>
              <span class="dot"></span>
              <span class="dot"></span>
              <span class="loading-text">正在思考…</span>
            </div>
            <div v-else class="msg-content markdown-body" v-html="renderMarkdown(store.streamingAnswer || '')"></div>
            <!-- FR-09-2 流式阶段预览 multimodal：done 之前到达的结构化输出 -->
            <MultimodalOutputCard v-if="store.currentMultimodal" :output="store.currentMultimodal" />
            <RefsList v-if="store.currentRefs.length > 0" :refs="store.currentRefs" />
          </div>
        </div>
      </div>

      <!-- 输入区：单行 textarea + 按钮行同行，缩小垂直间距 -->
      <div class="input-area">
        <el-input
          v-model="inputQuestion"
          type="textarea"
          :rows="1"
          :autosize="{ minRows: 1, maxRows: 6 }"
          placeholder="输入问题，Ctrl+Enter 发送…"
          resize="none"
          :disabled="store.isLoading"
          @keydown="handleKeydown"
        />
        <!-- 按钮行：左侧附件+工具栏+高级设置，右侧模型选择+发送，全部同行紧凑布局
             v3.1：v3.0 中"更多"下拉的联网/深度思考与 AI 伙伴选择器已统一挪到高级设置面板
             只保留高频操作（附件 / 工具 / 设置 / 模型 / 发送）以减少视觉负担 -->
        <div class="button-bar">
          <div class="left-buttons">
            <AttachmentUploader
              :attachments="pendingAttachmentIds"
              :icon-only="true"
              @add="handleAddAttachment"
              @remove="handleRemoveAttachment"
            />
            <InputToolbar
              :tools="toolbarTools"
              :active-mode="activeMode"
              :icon-only="true"
              @select="handleSelectMode"
            />
            <!-- 高级设置入口齿轮按钮：点击展开/收起下方面板，承载输出相关非高频设置
                 为什么用齿轮图标：通用"设置"语义，用户无需文字提示即可识别
                 为什么 active 旋转 90°：视觉反馈，区分展开/收起状态 -->
            <button
              type="button"
              class="advanced-toggle"
              :class="{ active: advancedOpen }"
              title="高级设置"
              aria-label="高级设置"
              @click="handleToggleAdvanced"
            >
              <svg class="advanced-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/>
                <path
                  d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
                  stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"
                />
              </svg>
            </button>
          </div>
          <!-- 模型选择下拉条：紧贴发送按钮左侧，与工具栏同行，避免占据独立行放大输入区视野
               v3.1：移除此处的 AI 伙伴选择器，挪到高级设置面板（避免输入栏视觉过载） -->
          <div class="right-buttons">
            <ModelSelector />
            <!-- 加载态按钮复用发送按钮位置：避免新增独立按钮造成布局抖动
                 默认：发送（蓝色 Promotion）；加载中：停止（红色 VideoPause）
                 为什么不用独立停止按钮：会破坏 .right-buttons 的 flex 节奏并导致视觉跳动
                 v3.1 缩小尺寸：size="default" + 自定义 send-btn 类，替代原 large 让按钮更克制 -->
            <el-button
              v-if="!store.isLoading"
              type="primary"
              class="send-btn"
              :disabled="!inputQuestion.trim()"
              title="发送"
              @click="handleSubmit"
            >
              <el-icon><Promotion /></el-icon>
            </el-button>
            <el-button
              v-else
              type="danger"
              class="send-btn"
              title="停止回答"
              @click="handleStop"
            >
              <el-icon><VideoPause /></el-icon>
            </el-button>
          </div>
        </div>
        <!-- 高级设置面板：可折叠下方面板，集中展示输出相关非高频设置
             v3.2 移除联网搜索/深度思考独立按钮：与中间件多选 web_search/deep_thinking 重复
             v3.1 扩充：AI 伙伴 + 输出模式 + 中间件 + 流式开关，集中收纳避免输入栏视觉过载
             为什么用 Vue Transition：内建高度过渡，零额外依赖，平滑展开收起
             为什么绑定 mousedown.stop：避免点击面板内控件时冒泡触发外层 click outside 关闭 -->
        <Transition name="advanced-panel">
          <div v-if="advancedOpen" ref="advancedPanelRef" class="advanced-panel" @mousedown.stop>
            <!-- FR-12 AI 伙伴选择器：从 .right-buttons 移入
                 v3.1 用 el-select + el-option 渲染 skills 列表（与原 right-buttons 实现一致），
                 保留默认（无预设）选项 + 全部 enabled 技能 -->
            <el-select
              v-model="activeSkillId"
              size="small"
              class="advanced-skill-select"
              placeholder="AI 伙伴"
              :disabled="store.isLoading"
              @change="handleSkillChange"
            >
              <el-option label="默认（无预设）" value="" />
              <el-option
                v-for="s in skills"
                :key="s.id"
                :label="s.name"
                :value="s.id"
              />
            </el-select>
            <!-- 联网搜索/深度思考按钮已移除：功能与中间件多选中的 web_search/deep_thinking 重复
                 后端 query-workflow.ts 中 middlewareSet 优先级高于 input.webSearch/input.mode，
                 中间件配置完全覆盖独立按钮，保留两套入口会造成用户认知负担与状态不一致 -->
            <!-- FR-09-2 多模态输出模式选择器：思维导图/FAQ/时间线/图像/PPT -->
            <el-select
              v-model="outputMode"
              size="small"
              class="output-mode-select"
              @change="handleOutputModeChange"
            >
              <el-option
                v-for="opt in outputModeOptions"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
            <!-- v2: 多输出模式多选：复选框组，用户可独立开关 思考过程/工具调用/主答案/多模态 -->
            <!-- 为什么用 el-popover + trigger="manual"：el-dropdown 的 outside-click 检测
                 在 teleport 到 body 后仍会误判 checkbox 点击为外部点击关闭菜单；
                 el-popover manual 模式把可见性完全交给 v-model:visible，从机制上根除此问题 -->
            <el-popover
              :visible="outputModesOpen"
              placement="bottom"
              :width="200"
              trigger="manual"
              popper-class="multi-select-popover"
              :popper-style="multiSelectPopperStyle"
              :show-arrow="false"
            >
              <template #reference>
                <el-button
                  size="small"
                  class="output-modes-trigger"
                  :title="outputModesTooltip"
                  @click="toggleOutputModes"
                >
                  <span class="output-modes-label">输出模式</span>
                  <span class="output-modes-count">{{ store.outputModes.length }}/{{ ALL_OUTPUT_MODES.length }}</span>
                </el-button>
              </template>
              <div class="multi-select-list" :style="multiSelectListStyle">
                <el-checkbox
                  v-for="mode in ALL_OUTPUT_MODES"
                  :key="mode"
                  :model-value="store.outputModes.includes(mode)"
                  @change="handleToggleOutputMode(mode)"
                >
                  {{ OUTPUT_MODE_LABELS[mode] }}
                </el-checkbox>
              </div>
            </el-popover>
            <!-- 中间件多选下拉：控制 query workflow 各功能模块的启用/禁用
                 为什么放在输出模式之后、流式开关之前：中间件是更高层的功能开关，
                 涵盖联网搜索/深度思考/扩展工具/追问建议/真流式，与输出模式正交
                 为什么用 popover+checkbox 组合：与 output-modes-trigger 风格一致，
                 且 trigger="manual" 完全规避 outside-click 自动关闭 -->
            <el-popover
              :visible="middlewaresOpen"
              placement="bottom"
              :width="200"
              trigger="manual"
              popper-class="multi-select-popover"
              :popper-style="multiSelectPopperStyle"
              :show-arrow="false"
            >
              <template #reference>
                <el-button
                  size="small"
                  class="middlewares-trigger"
                  :title="middlewaresTooltip"
                  @click="toggleMiddlewares"
                >
                  <span class="middlewares-label">中间件</span>
                  <span class="middlewares-count">{{ store.middlewares.length }}/{{ ALL_MIDDLEWARES.length }}</span>
                </el-button>
              </template>
              <div class="multi-select-list" :style="multiSelectListStyle">
                <el-checkbox
                  v-for="mw in ALL_MIDDLEWARES"
                  :key="mw"
                  :model-value="store.middlewares.includes(mw)"
                  @change="handleToggleMiddleware(mw)"
                >
                  {{ MIDDLEWARE_LABELS[mw] }}
                </el-checkbox>
              </div>
            </el-popover>
            <!-- §真流式输出开关：开=LLM 逐 token 推送（减少等待），关=按句切分假流式 -->
            <el-tooltip
              :content="store.streamMode ? '真流式输出（点击关闭）' : '假流式输出（点击开启真流式）'"
              placement="top"
            >
              <div class="stream-mode-toggle">
                <span class="stream-mode-label">流式</span>
                <el-switch
                  :model-value="store.streamMode"
                  size="small"
                  @change="store.toggleStreamMode()"
                />
              </div>
            </el-tooltip>
          </div>
        </Transition>
      </div>
    </div>
    <!-- F-3.2 图片点击放大预览：通过事件委托捕获 v-html 中的 img 点击触发 -->
    <el-image-viewer
      v-if="previewVisible"
      :url-list="[previewSrc]"
      @close="previewVisible = false"
    />
    <!-- v3 视频生成对话框：独立于 query SSE 流，走 POST /api/media/video + 轮询 -->
    <!-- 为什么独立对话框：视频生成需数分钟，走 SSE 流会触发 60s 超时，独立对话框 + 轮询更稳定 -->
    <el-dialog
      v-model="videoDialogVisible"
      title="视频生成"
      width="560px"
      :close-on-click-modal="false"
      @close="closeVideoDialog"
    >
      <div class="video-dialog-body">
        <!-- 输入区：仅在 idle 或 failed 状态显示，允许用户（重新）提交 -->
        <div v-if="videoStatus === 'idle' || videoStatus === 'failed'" class="video-input-section">
          <el-input
            v-model="videoPrompt"
            type="textarea"
            :rows="3"
            placeholder="描述你想生成的视频内容，例如：一只猫在草地上奔跑"
            maxlength="500"
            show-word-limit
          />
          <el-button
            type="primary"
            class="video-submit-btn"
            @click="submitVideoTask"
          >
            生成视频
          </el-button>
          <div v-if="videoError" class="video-error-tip">{{ videoError }}</div>
        </div>
        <!-- 进行中状态：显示进度条与状态文案 -->
        <div v-else-if="videoStatus === 'queued' || videoStatus === 'processing'" class="video-progress-section">
          <div class="video-status-text">
            <el-icon class="is-loading"><Loading /></el-icon>
            <span>{{ videoStatus === 'queued' ? '任务排队中…' : '视频生成中…' }}</span>
          </div>
          <el-progress :percentage="videoProgress" :stroke-width="10" :duration="1" />
          <div class="video-tip">视频生成通常需要 1-5 分钟，请耐心等待</div>
        </div>
        <!-- 完成状态：显示视频播放器与下载链接 -->
        <div v-else-if="videoStatus === 'completed'" class="video-result-section">
          <video
            v-if="videoUrl"
            :src="videoUrl"
            controls
            class="video-player"
          />
          <div class="video-actions">
            <a v-if="videoUrl" :href="videoUrl" target="_blank" rel="noopener" class="video-download-link">
              下载视频
            </a>
            <el-button size="small" @click="resetVideoDialog">重新生成</el-button>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="closeVideoDialog">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 自适应全屏：撑满父容器（App.vue 的 .content 是 flex:1 + min-height:0），让聊天区获得最大可视高度
   关键：每个 flex 子项都要 min-height: 0，否则会被内容撑大导致滚动失效 */
.query-page {
  display: flex;
  flex-direction: row;
  flex: 1;
  min-height: 0;
  height: 100%;
  position: relative;
}

/* F-3.11 隐藏态浮动展开按钮：fixed 在左上角，hidden 态时可见
   为什么用 fixed 而非 absolute：sidebar 宽度 0 后按钮需脱离布局流，避免挤压主区 */
.sidebar-show-btn {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 20;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  background: var(--accent-cyan-a10, rgba(0, 245, 255, 0.1));
  color: var(--neon-cyan, #00f5ff);
  cursor: pointer;
  font-size: 16px;
  backdrop-filter: var(--blur);
  transition: all 0.2s ease;
}
.sidebar-show-btn:hover {
  background: var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  border-color: var(--neon-cyan, #00f5ff);
}

.query-card {
  flex: 1;
  min-height: 0;
  padding: 20px 28px;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

.card-deco {
  position: absolute;
  bottom: -60px;
  left: -60px;
  width: 260px;
  height: 260px;
  background: var(--grad-aurora);
  opacity: 0.08;
  transform: rotate(-20deg);
  border-radius: 40px;
  pointer-events: none;
}

/* 顶部 head 行已移除（ModelSelector 下沉到按钮行），最大化聊天区域视野 */
/* min-height: 0 是关键：flex 子项默认 min-height: auto = 内容最小高度，
   会让 chat-body 即使设了 overflow:auto + flex:1 也无法滚动（被内容撑大） */
.chat-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 4px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: relative;
  z-index: 1;
  /* 滚动条样式：让滚动条更明显，用户能直观看到可滚动 */
  scrollbar-width: thin;
  scrollbar-color: var(--accent-purple-a30) transparent;
}
.chat-body::-webkit-scrollbar {
  width: 6px;
}
.chat-body::-webkit-scrollbar-track {
  background: transparent;
}
.chat-body::-webkit-scrollbar-thumb {
  background: var(--accent-purple-a30);
  border-radius: 3px;
}
.chat-body::-webkit-scrollbar-thumb:hover {
  background: var(--neon-purple);
}

.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
}

.empty-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 14px;
  font-family: var(--font-mono);
}

.empty-suggestions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
}

.suggestion-chip {
  padding: 8px 16px;
  background: var(--accent-purple-a08, rgba(176, 38, 255, 0.08));
  border: 1px solid var(--accent-purple-a30, rgba(176, 38, 255, 0.3));
  border-radius: var(--radius-pill);
  font-size: 13px;
  color: var(--text-base);
  cursor: pointer;
  transition: all 0.3s ease;
  font-family: var(--font-body);
}

.suggestion-chip:hover {
  background: var(--accent-purple-a18, rgba(176, 38, 255, 0.18));
  border-color: var(--neon-purple);
  color: var(--neon-cyan);
  transform: translateY(-2px);
  box-shadow: var(--glow-purple);
}

.msg-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.msg-row.user {
  flex-direction: row-reverse;
}

.msg-avatar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 内容包装器：气泡 + 工具栏垂直排列，让工具栏显示在气泡外部下方
   为什么需要 wrapper：msg-row 是 flex 横向布局（avatar + bubble），
   不用 wrapper 的话工具栏会被当作 flex 第三项横向排列
   用户气泡单独收窄到 55%：用户消息通常简短，沿用 75% 会显得气泡空旷、
   文字稀疏，55% 与输入框 820px 视觉节奏更协调 */
.msg-content-wrapper {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 75%;
}
.msg-content-wrapper.user {
  align-items: flex-end;
  /* §用户气泡宽度恢复 100%：撑满可用宽度，高度通过 padding/line-height 收窄减少占用空间 */
  max-width: 100%;
}
.msg-content-wrapper.assistant {
  /* §AI 气泡撑满可用宽度：避免长内容（代码/表格/长段）在 75% 宽度内被迫横向滚动
     覆盖父级 .msg-content-wrapper 的 max-width: 75%，让 LLM 回复自适应屏幕宽度 */
  align-items: flex-start;
  max-width: 100%;
}

.user-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--grad-fire);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  box-shadow: var(--glow-magenta);
}

/* 消息气泡：不对称圆角 + 渐变；紧凑 padding 减少行间留白，让同屏看到更多内容
   max-width 由父级 .msg-content-wrapper 控制，气泡自身撑满父级即可
   v2 优化：padding 从 10px 14px 收紧到 8px 12px；font-size 14 → 13.5px，
   让用户消息在屏幕中更紧凑，留出更多空间展示 AI 回复 */
.msg-bubble {
  padding: 8px 12px;
  border-radius: 14px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text-base);
  position: relative;
}

.msg-bubble.assistant {
  /* §AI 气泡撑满 wrapper：避免内容在 75% 父级宽度内被迫横向滚动，width: 100% 让气泡跟随 wrapper 宽度自适应屏幕 */
  width: 100%;
  background: var(--accent-cyan-a06, rgba(0, 245, 255, 0.06));
  border: 1px solid var(--accent-cyan-a25, rgba(0, 245, 255, 0.25));
  border-top-left-radius: 4px;
  backdrop-filter: var(--blur);
}

.msg-bubble.assistant::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, var(--neon-cyan), transparent);
}

.msg-bubble.user {
  background: var(--grad-fire);
  border-top-right-radius: 4px;
  /* 跨主题可读：--text-bright 在 portfolio 等深色渐变主题下是 #1a1a1a，与渐变背景严重冲突
     强制白色 + 强阴影确保任意主题下用户文字清晰可读，覆盖主题级与 scoped 属性的差异 */
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
  box-shadow: 0 4px 20px var(--accent-pink-a30, rgba(255, 0, 110, 0.3));
  /* §高度收窄：进一步减小 padding/line-height/font-size，让用户气泡更紧凑，减少垂直占用 */
  padding: 2px 12px;
  line-height: 1.2;
  font-size: 13px;
}

/* §修复：用户气泡内的 .msg-content.markdown-body 会被全局 style.css 中
   .markdown-body { color: var(--text-base) } 覆盖（特异性 0,1,0 vs 颜色继承优先级），
   必须在 .msg-bubble.user 下用 :deep 提高特异性，强制白色覆盖主题文字色。
   为什么不用 !important：scoped + :deep 已经把特异性提升到 0,3,0 足以压过全局规则 */
.msg-bubble.user :deep(.msg-content),
.msg-bubble.user :deep(.markdown-body),
.msg-bubble.user :deep(.markdown-body p),
.msg-bubble.user :deep(.markdown-body strong) {
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
}

/* 流式输出时的脉动效果 */
.msg-bubble.streaming {
  animation: neon-pulse 1.5s ease-in-out infinite;
}

.msg-content {
  /* 关键：去掉 white-space: pre-wrap，避免 LLM 输出中的 \n\n 被保留为视觉空行
     markdown-it 已经用 <p> 标签处理段落分隔，配合 normal 空白让段落紧凑 */
  white-space: normal;
  word-break: break-word;
}

/* 用户纯文本消息需要保留原始换行（用户可能输入多行问题）
   用 pre-wrap 让换行符成为 <br> 等效，避免 markdown 解析影响用户内容 */
.msg-bubble.user .msg-content {
  white-space: pre-wrap;
}

.search-progress {
  margin: 4px 0 8px;
  padding: 4px 10px;
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
  border-left: 2px solid var(--neon-cyan);
  border-radius: 0 4px 4px 0;
  font-size: 12px;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
}

/* F-3.12 联想提问：横向 chip 布局，超出横向滚动，不换行
   位置已迁移到 refs 上方，紧贴答案末尾 */
.msg-followups {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--accent-purple-a20, rgba(176, 38, 255, 0.2));
  display: flex;
  align-items: center;
  gap: 8px;
  /* 横向滚动：track 负责滚动区，label 固定不滚 */
  flex-wrap: nowrap;
  overflow: hidden;
}

.followups-label {
  font-size: 10px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  letter-spacing: 1px;
  flex-shrink: 0;
}

/* F-3.12 track：横向 chip 容器，超出可横向滚动 */
.followups-track {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--accent-cyan-a30, rgba(0, 245, 255, 0.3)) transparent;
  /* 隐藏横向滚动条视觉，保持纯净 */
  -ms-overflow-style: none;
}
.followups-track::-webkit-scrollbar {
  height: 4px;
}
.followups-track::-webkit-scrollbar-thumb {
  background: var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  border-radius: 2px;
}

/* F-3.12 chip：nowrap 保证 chip 内文字不换行，track 才能横向滚动 */
.followup-chip {
  position: relative;
  flex-shrink: 0;
  white-space: nowrap;
  padding: 4px 12px;
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
  border: 1px solid var(--accent-cyan-a25, rgba(0, 245, 255, 0.25));
  border-radius: var(--radius-pill);
  font-size: 11px;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
  cursor: pointer;
  transition: all 0.25s;
}

.followup-chip:hover {
  background: var(--accent-cyan-a18, rgba(0, 245, 255, 0.18));
  border-color: var(--neon-cyan);
  transform: translateY(-1px);
}

/* F-3.12 CSS tooltip：hover 200ms 内淡入，无需 JS 库
   为什么用 CSS 而非 el-tooltip：轻量零依赖，transition-duration 精确控制 200ms */
.chip-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 8px;
  background: var(--bg-card-solid, rgba(0, 0, 0, 0.75));
  color: #fff;
  font-size: 10px;
  font-family: var(--font-body);
  border-radius: 4px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 200ms ease;
  z-index: 10;
}
.followup-chip:hover .chip-tooltip {
  opacity: 1;
}

.msg-actions {
  margin-top: 8px;
  text-align: right;
}

/* 输入区：居中显示 + 主题适配浅色背景 + 毛玻璃
   为什么用 --bg-card 而非 --bg-glass：输入区需要更强的不透明度让文字清晰，--bg-card 已是主题感知变量 */
.input-area {
  margin: 6px auto 0;
  max-width: 820px;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: relative;
  z-index: 2;
  padding: 10px 14px;
  background: var(--bg-card);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--border-glass, var(--accent-cyan-a20, rgba(0, 245, 255, 0.2)));
  border-radius: 14px;
  box-shadow: 0 4px 18px var(--accent-purple-a15, rgba(176, 38, 255, 0.15));
}

/* 让 textarea 内部行高与字号紧凑，避免文字下方出现空行
   el-textarea 默认 min-height: 33px 会撑出空行；强制 min-height: 0 让高度由 rows/autosize 决定 */
.input-area :deep(.el-textarea) {
  --el-textarea-min-height: 0;
}
.input-area :deep(.el-textarea__inner) {
  padding: 4px 8px;
  line-height: 1.5;
  min-height: 0 !important;
  box-shadow: none;
  /* 主题适配背景：el-textarea 默认白底，深色主题下会刺眼；用透明让父容器背景透出 */
  background: transparent;
  color: var(--text-base);
  border: none;
}
.input-area :deep(.el-textarea__inner)::placeholder {
  color: var(--text-dim);
}
/* textarea 选区高亮：el-textarea 内部 ::selection 不会被全局 ::selection 覆盖
   用主题变量让各主题自动适配，避免深色主题下高亮不明显 */
.input-area :deep(.el-textarea__inner)::selection {
  background: var(--accent-pink-a50, rgba(255, 0, 110, 0.5));
  color: var(--text-bright);
}

/* 按钮行：左侧工具组 + 右侧发送按钮，同一行两端对齐 */
.button-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.left-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 右侧按钮组：模型选择下拉条 + 发送按钮同行紧贴 */
.right-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* FR-09-2 多模态输出选择器：紧凑尺寸，与工具栏图标对齐 */
.output-mode-select {
  width: 110px;
  flex-shrink: 0;
}
.output-mode-select :deep(.el-input__wrapper) {
  border-radius: 16px;
  background: var(--accent-cyan-a05, rgba(0, 245, 255, 0.05));
  box-shadow: 0 0 0 1px var(--accent-cyan-a20, rgba(0, 245, 255, 0.2)) inset;
}
.output-mode-select :deep(.el-input__wrapper):hover {
  box-shadow: 0 0 0 1px var(--neon-cyan, #00f5ff) inset;
}

/* v2: 多输出模式多选 trigger：紧凑按钮，hover 高亮，显示当前开启数量
   为什么用按钮而非 dropdown 自带 trigger：el-dropdown 默认 trigger 是 a 标签无样式，
   用 el-button 包裹可复用主题适配样式 */
.output-modes-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 16px;
  background: var(--accent-purple-a05, rgba(176, 38, 255, 0.05));
  border: 1px solid var(--accent-purple-a20, rgba(176, 38, 255, 0.2));
  color: var(--text-soft, #888);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.output-modes-trigger:hover {
  border-color: var(--neon-purple, #b226ff);
  color: var(--neon-purple, #b226ff);
}
.output-modes-label {
  font-family: var(--font-mono);
  letter-spacing: 0.5px;
}
.output-modes-count {
  font-size: 11px;
  color: var(--text-dim, #aaa);
  font-family: var(--font-mono);
}
/* 中间件多选 trigger：与 output-modes-trigger 风格统一，用 magenta 色调区分语义
   为什么独立色系：中间件是功能开关（启用/禁用），输出模式是可见性开关（显示/隐藏），
   语义不同需视觉区分，避免用户混淆 */
.middlewares-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 16px;
  background: var(--accent-magenta-a05, rgba(255, 0, 255, 0.05));
  border: 1px solid var(--accent-magenta-a20, rgba(255, 0, 255, 0.2));
  color: var(--text-soft, #888);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.middlewares-trigger:hover {
  border-color: var(--neon-magenta, #ff00ff);
  color: var(--neon-magenta, #ff00ff);
}
.middlewares-label {
  font-family: var(--font-mono);
  letter-spacing: 0.5px;
}
.middlewares-count {
  font-size: 11px;
  color: var(--text-dim, #aaa);
  font-family: var(--font-mono);
}
/* §真流式开关：与 output-modes-trigger 同行紧凑布局，胶囊样式 */
.stream-mode-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 16px;
  background: var(--accent-cyan-a05, rgba(0, 229, 255, 0.05));
  border: 1px solid var(--accent-cyan-a20, rgba(0, 229, 255, 0.2));
  cursor: pointer;
  transition: all 0.2s;
}
.stream-mode-toggle:hover {
  border-color: var(--neon-cyan, #00e5ff);
}
.stream-mode-label {
  font-size: 12px;
  color: var(--text-soft, #888);
  font-family: var(--font-mono);
  letter-spacing: 0.5px;
}

/* 发送按钮：v3.1 缩小尺寸（从原 large 38px 收到 30px 高），避免视觉抢占输入区
   为什么用 padding 而非 size 属性：el-button 的 size="large" 会同时改文字大小，
   当前按钮内只有 el-icon，文字大小无关，仅需控制外边距 + 内边距即可
   为什么要 flex-shrink:0：在右栏 flex 容器中避免被压缩成 0 宽 */
.send-btn {
  flex-shrink: 0;
  padding: 6px 12px;
  border-radius: 10px;
  min-height: 30px;
  height: 30px;
}
.send-btn :deep(.el-icon) {
  font-size: 14px;
}

/* 高级设置齿轮按钮：与工具栏按钮视觉对齐，点击时旋转 90° 反馈展开/收起状态
   为什么用胶囊背景：与 output-modes-trigger / stream-mode-toggle 风格统一 */
.advanced-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 16px;
  background: var(--accent-purple-a05, rgba(176, 38, 255, 0.05));
  border: 1px solid var(--accent-purple-a20, rgba(176, 38, 255, 0.2));
  color: var(--text-soft, #888);
  cursor: pointer;
  transition: all 0.25s ease;
  flex-shrink: 0;
  padding: 0;
}
.advanced-toggle:hover {
  border-color: var(--neon-purple, #b226ff);
  color: var(--neon-purple, #b226ff);
  background: var(--accent-purple-a12, rgba(176, 38, 255, 0.12));
}
.advanced-toggle.active {
  border-color: var(--neon-purple, #b226ff);
  color: var(--neon-purple, #b226ff);
  background: var(--accent-purple-a18, rgba(176, 38, 255, 0.18));
}
/* 齿轮图标旋转：active 状态旋转 90°，让用户感知面板已展开
   为什么用 transform 而非 background 图标切换：transform 走 GPU 加速且无重排 */
.advanced-icon {
  transition: transform 0.3s ease;
}
.advanced-toggle.active .advanced-icon {
  transform: rotate(90deg);
}

/* 高级设置面板：按钮栏下方的折叠容器，承载输出相关非高频设置
   布局：flex 横排，所有控件在同一行紧凑展示
   为什么用 transform/opacity 而非 height 做动画：v-if 切换时元素从无到有，
   height 无法从 0 过渡到 auto；用 opacity + scaleY 模拟折叠感更流畅 */
.advanced-panel {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 4px 2px;
  border-top: 1px dashed var(--accent-purple-a20, rgba(176, 38, 255, 0.2));
  /* 起源动画基线：与 Transition 钩子配合 */
  transform-origin: top center;
}

/* v3.1 高级设置面板中 AI 伙伴选择器：与同 panel 内 output-mode-select 宽度策略一致
   为什么要单独命名 advanced-skill-select：原 .skill-selector 是右栏专用类，
   此处 panel 内需要更紧凑宽度，区分命名避免误改 */
.advanced-skill-select {
  width: 130px;
  flex-shrink: 0;
}
.advanced-skill-select :deep(.el-input__wrapper) {
  border-radius: 16px;
  background: var(--accent-cyan-a05, rgba(0, 245, 255, 0.05));
  box-shadow: 0 0 0 1px var(--accent-cyan-a20, rgba(0, 245, 255, 0.2)) inset;
}
.advanced-skill-select :deep(.el-input__wrapper):hover {
  box-shadow: 0 0 0 1px var(--neon-cyan, #00f5ff) inset;
}

/* Vue Transition：advanced-panel 命名钩子
   enter-from/leave-to 设为 opacity:0 + scaleY 收缩
   enter-active/leave-active 提供过渡曲线
   元素出现/消失时由内联 .advanced-panel 接收过渡态 */
.advanced-panel-enter-active,
.advanced-panel-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
  overflow: hidden;
}
.advanced-panel-enter-from,
.advanced-panel-leave-to {
  opacity: 0;
  transform: scaleY(0.6);
}
.advanced-panel-enter-to,
.advanced-panel-leave-from {
  opacity: 1;
  transform: scaleY(1);
}

/* F-3.1 流式输出态：气泡脉动光晕，首字节后激活，让用户感知"正在生成" */
@keyframes neon-pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 transparent;
    border-color: var(--accent-cyan-a25, rgba(0, 245, 255, 0.25));
  }
  50% {
    box-shadow: 0 0 20px 2px var(--accent-cyan-a35, rgba(0, 245, 255, 0.35));
    border-color: var(--accent-cyan-a60, rgba(0, 245, 255, 0.6));
  }
}

/* F-3.1 加载态：首字节前显示 3 圆点脉动 + "正在思考…" 文案 */
.loading-dots {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}
.loading-dots .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--neon-cyan, #00f5ff);
  /* 三个圆点依次延迟 0.2s 跳动，形成"波浪"脉动效果 */
  animation: loading-bounce 1.2s ease-in-out infinite;
}
.loading-dots .dot:nth-child(1) { animation-delay: 0s; }
.loading-dots .dot:nth-child(2) { animation-delay: 0.2s; }
.loading-dots .dot:nth-child(3) { animation-delay: 0.4s; }
.loading-dots .loading-text {
  margin-left: 8px;
  font-size: 13px;
  color: var(--text-soft, #888);
}
@keyframes loading-bounce {
  0%, 80%, 100% {
    transform: scale(0.6);
    opacity: 0.4;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}

/* F-3.2 代码块语言徽章：wrapper 提供定位上下文，徽章绝对定位在 pre 右上角
   为什么用 wrapper 而非直接给 pre 加伪元素：徽章是独立 DOM 节点，方便后续扩展复制按钮 */
.markdown-body :deep(.code-block-wrapper) {
  position: relative;
  margin: 0.75em 0;
}

.markdown-body :deep(.code-lang-badge) {
  position: absolute;
  top: 6px;
  right: 8px;
  padding: 2px 8px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--neon-cyan, #00f5ff);
  background: var(--accent-cyan-a12, rgba(0, 245, 255, 0.12));
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  border-radius: 4px;
  pointer-events: none;
  user-select: none;
  z-index: 1;
  letter-spacing: 0.5px;
}

/* 让 wrapper 内的 pre 不再单独撑外边距，避免双重间距 */
.markdown-body :deep(.code-block-wrapper pre) {
  margin: 0;
}

/* F-3.2 图片悬停反馈：让用户感知图片可点击放大 */
.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: 8px;
  cursor: zoom-in;
  transition: opacity 0.2s ease;
}

.markdown-body :deep(img:hover) {
  opacity: 0.9;
}

/* F-3.7 工具栏触发：hover 包装器（气泡+工具栏）时显现
   为什么用 wrapper 而非 bubble：工具栏已移到气泡外部，hover bubble 时若工具栏不显示会导致鼠标移到工具栏时消失，
   用 wrapper（含 bubble + toolbar）作为 hover 触发域，鼠标在两者间移动也能保持显示 */
.msg-content-wrapper:hover .msg-toolbar {
  opacity: 1;
  pointer-events: auto;
}

/* F-3.7 代码块复制按钮：hover wrapper 时显现，避免常态视觉噪音 */
.markdown-body :deep(.code-copy-btn) {
  position: absolute;
  top: 6px;
  right: 8px;
  padding: 2px 8px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-soft, #888);
  background: var(--bg-scene, rgba(0, 0, 0, 0.35));
  border: 1px solid var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s ease, color 0.2s ease;
  z-index: 2;
  /* 与语言徽章错位：徽章在右上方，复制按钮在徽章下方
     实际通过 right 偏移避免重叠 */
}

.markdown-body :deep(.code-block-wrapper:hover .code-copy-btn) {
  opacity: 1;
}

.markdown-body :deep(.code-copy-btn:hover) {
  color: var(--neon-cyan, #00f5ff);
  border-color: var(--accent-cyan-a50, rgba(0, 245, 255, 0.5));
}

/* 有语言徽章时，复制按钮下移避免与徽章重叠 */
.markdown-body :deep(.code-lang-badge) ~ .code-copy-btn {
  top: 28px;
}

/* F-3.8 [N] 引用编号锚点：内联显示，点击不跳转 URL 而是滚动到 ref 卡片 */
.markdown-body :deep(.ref-anchor) {
  color: var(--neon-cyan, #00f5ff);
  text-decoration: none;
  cursor: pointer;
  font-family: var(--font-mono, monospace);
  font-size: 0.9em;
  padding: 0 2px;
  border-radius: 3px;
  transition: background 0.2s;
}
.markdown-body :deep(.ref-anchor:hover) {
  background: var(--accent-cyan-a18, rgba(0, 245, 255, 0.18));
  text-decoration: underline;
}

/* F-3.8 锚点跳转闪烁高亮：ref-flash 类添加 1.5s 渐变背景 */
:deep(.ref-item.ref-flash) {
  animation: ref-flash-anim 1.5s ease;
}
@keyframes ref-flash-anim {
  0% { background: var(--accent-cyan-a30, rgba(0, 245, 255, 0.3)); }
  60% { background: var(--accent-cyan-a15, rgba(0, 245, 255, 0.15)); }
  100% { background: transparent; }
}

/* 多媒体嵌入容器：video / audio / iframe 统一外边距 + 圆角 + 边框 */
.markdown-body :deep(.media-embed) {
  margin: 0.75em 0;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  background: var(--bg-scene, rgba(0, 0, 0, 0.2));
}

/* 原生 video / audio：宽度自适应，避免超大尺寸撑破气泡 */
.markdown-body :deep(.media-embed video),
.markdown-body :deep(.media-embed audio) {
  width: 100%;
  max-width: 100%;
  display: block;
}

/* audio 无视觉内容，仅保留控件高度，避免大块黑色背景 */
.markdown-body :deep(.media-audio) {
  background: transparent;
  border-width: 1px;
  padding: 6px 8px;
}

/* iframe 嵌入：16:9 响应式比例，适配 B站/YouTube/抖音 */
.markdown-body :deep(.media-iframe) {
  position: relative;
  padding-bottom: 56.25%; /* 9/16，保持 16:9 宽高比 */
  height: 0;
}

.markdown-body :deep(.media-iframe iframe) {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: 0;
}

/* v3 视频生成对话框样式：使用 CSS 变量适配主题切换，避免硬编码颜色 */
.video-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 200px;
}
.video-input-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.video-submit-btn {
  align-self: flex-start;
}
.video-error-tip {
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--accent-pink-a10, rgba(255, 100, 150, 0.1));
  border: 1px solid var(--accent-pink-a30, rgba(255, 100, 150, 0.3));
  color: var(--accent-pink, #ff6496);
  font-size: 13px;
}
.video-progress-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 24px 0;
  align-items: center;
}
.video-status-text {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-soft, #888);
}
.video-tip {
  font-size: 12px;
  color: var(--text-soft, #888);
  text-align: center;
}
.video-result-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.video-player {
  width: 100%;
  max-height: 360px;
  border-radius: 8px;
  background: var(--bg-scene, #000);
}
.video-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.video-download-link {
  color: var(--accent-purple, #8a5cf5);
  text-decoration: none;
  font-size: 13px;
}
.video-download-link:hover {
  text-decoration: underline;
}
</style>

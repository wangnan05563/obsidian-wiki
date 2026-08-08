/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
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
import { useQueryStore, ALL_OUTPUT_MODES, OUTPUT_MODE_LABELS, ALL_MIDDLEWARES, MIDDLEWARE_LABELS } from '../stores/query';
import { useAuthStore } from '../stores/auth';
import { useConversationsStore } from '../stores/conversations';
import { useModelStore } from '../stores/model';
import { useAttachmentsStore } from '../stores/attachments';
import { dbGet, CHAT_STORES } from '../services/chatDb';
import { apiErrorMessage } from '../utils/apiError';
import { renderMarkdown } from '../utils/markdown';
import { consumeQuerySSE } from '../utils/sse';
import { STORAGE_KEYS } from '../constants/storageKeys';
// F-3.2 图片点击放大预览：v-html 内容不经过 Vue 编译，无法绑定 Vue 事件，需事件委托
// 参考 MarkdownRenderer.vue 同款实现模式：监听根元素 click，target.tagName === 'IMG' 触发预览
const previewSrc = ref('');
const previewVisible = ref(false);
const handleImgClick = (e) => {
    const target = e.target;
    if (target.tagName === 'IMG') {
        e.preventDefault();
        previewSrc.value = target.src;
        previewVisible.value = true;
    }
};
// F-3.7 代码块复制：事件委托捕获 .code-copy-btn 点击，从兄弟 pre > code 取 textContent
// 为什么从 DOM 取而非 data 属性：避免长代码 HTML 转义/属性大小限制
async function copyCodeToClipboard(text) {
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
    }
    catch {
        return false;
    }
}
const handleCodeCopyClick = async (e) => {
    const target = e.target;
    // 命中复制按钮或其子节点
    const btn = target.closest('[data-action="copy-code"]');
    if (!btn)
        return;
    e.preventDefault();
    // 从兄弟 pre > code 取原始代码
    const wrapper = btn.closest('.code-block-wrapper');
    const codeEl = wrapper?.querySelector('pre code');
    if (!codeEl)
        return;
    const code = codeEl.textContent || '';
    const ok = await copyCodeToClipboard(code);
    ElMessage[ok ? 'success' : 'warning'](ok ? '已复制代码' : '复制失败，请手动选择');
};
// F-3.8 [1] 引用编号锚点点击：事件委托捕获 .ref-anchor 点击，阻止默认导航，改为平滑滚动到 ref 卡片
// 为什么阻止默认：默认 #ref-N 会跳到 id=ref-N 元素但无滚动动画，体验突兀
// 为什么需要展开折叠：ref 卡片可能折叠隐藏，需先展开 RefsList 再滚动
const handleRefAnchorClick = (e) => {
    const target = e.target;
    const anchor = target.closest('.ref-anchor');
    if (!anchor)
        return;
    e.preventDefault();
    const refNum = anchor.dataset.ref;
    if (!refNum)
        return;
    // 找到本条 assistant 消息对应的 refs-list（位于同一消息容器内）
    const msgContainer = anchor.closest('.msg-bubble, .message');
    if (!msgContainer)
        return;
    const refsList = msgContainer.querySelector('.refs-list');
    if (!refsList)
        return;
    // 若 refs-list 已折叠，先展开（点击 toggleExpanded 等价行为）
    // 为什么用属性检查：Vue 渲染的 .refs-body v-if="expanded" 不在 DOM 时需触发展开
    let refsBody = refsList.querySelector('.refs-body');
    if (!refsBody) {
        // 折叠态：点击 header 触发 toggleExpanded
        const header = refsList.querySelector('.refs-header');
        header?.click();
    }
    // 等 Vue 重新渲染 refs-body 后再滚动（nextTick 等价）
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const targetEl = msgContainer.querySelector(`#ref-${refNum}`);
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
const skills = ref([]);
const activeSkillId = ref('');
async function loadSkills() {
    try {
        const res = await fetch(`${API_BASE}/ai/config`);
        if (!res.ok)
            return;
        const cfg = await res.json();
        skills.value = cfg.skills?.filter((s) => s.enabled) ?? [];
        activeSkillId.value = cfg.activeSkill ?? '';
    }
    catch { /* skills 加载失败不阻断主流程 */ }
}
async function handleSkillChange(skillId) {
    try {
        await fetch(`${API_BASE}/ai/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeSkill: skillId }),
        });
        const preset = skills.value.find((s) => s.id === skillId);
        if (preset) {
            ElMessage.success(`AI 伙伴：${preset.name}`);
        }
        else {
            ElMessage.success('已切换到默认模式');
        }
    }
    catch (err) {
        ElMessage.error('伙伴切换失败：' + err.message);
        // 回滚 UI
        activeSkillId.value = '';
    }
}
// F-3.10 progress 事件展示文案：后端 step 英文枚举 → 前端中文友好提示
const searchProgressLabel = computed(() => {
    const step = store.searchProgress?.step;
    if (step === 'searching')
        return '正在联网搜索...';
    if (step === 'fetching')
        return '正在抓取网页...';
    if (step === 'done')
        return '联网搜索完成';
    return step || '';
});
const inputQuestion = ref('');
const chatBodyRef = ref(null);
let abortController = null;
// 问答超时机制：LLM 长时间无响应时自动中断，避免用户卡在"正在思考"
// 为什么 120 秒：覆盖 MCP 扩展工具加载（最多 30s，已并行优化）+ LLM 首字节延迟（5-15s）
//   + 深度思考模式推理时间（30-60s），同时避免无限等待。
// 历史：原 60s 阈值在 MCP 服务器串行加载时（2×30s=60s）刚好被触发，
//   导致 AI 实际有回复但前端已超时中断，用户感知"AI 未回复信息"。
const QUESTION_TIMEOUT_MS = 120_000;
let questionTimeoutId = null;
// 标记本次中断的原因，供 finally 分支区分用户停止 / 超时 / 正常完成
let abortReason = null;
const sidebarState = ref(localStorage.getItem(STORAGE_KEYS.SIDEBAR_STATE) || 'expanded');
function setSidebarState(state) {
    sidebarState.value = state;
    localStorage.setItem(STORAGE_KEYS.SIDEBAR_STATE, state);
}
// 二态循环：expanded ↔ hidden，一次点击即折叠到位
function toggleSidebar() {
    setSidebarState(sidebarState.value === 'expanded' ? 'hidden' : 'expanded');
}
// F-3.11 Ctrl+B 快捷键：全局监听，二态切换（expanded ↔ hidden）
// 为什么用 keydown 而非 keystroke：Ctrl+B 是浏览器默认"加粗"快捷键，需 preventDefault 屏蔽
function handleGlobalKeydown(e) {
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
const outputMode = ref('normal');
const outputModeOptions = [
    { value: 'normal', label: '普通' },
    { value: 'mindmap', label: '思维导图' },
    { value: 'faq', label: 'FAQ' },
    { value: 'timeline', label: '时间线' },
    { value: 'image', label: '图像' },
    { value: 'ppt', label: 'PPT' },
];
function handleOutputModeChange(val) {
    outputMode.value = val;
}
// v2: 多输出模式多选切换。点击复选框/下拉项时切换模式。
// 为什么用 stopPropagation：避免 el-dropdown-item 默认行为与 checkbox 冲突（重复触发）
function handleToggleOutputMode(mode) {
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
function handleToggleMiddleware(mw) {
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
function handleSelectMode(mode) {
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
        }
        else {
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
const videoStatus = ref('idle');
const videoProgress = ref(0);
const videoUrl = ref('');
const videoError = ref('');
let videoPollTimer = null;
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
    }
    catch (err) {
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
        if (!videoTaskId.value)
            return;
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
            }
            else if (data.status === 'failed') {
                videoError.value = data.error || '视频生成失败';
                stopVideoPolling();
            }
        }
        catch (err) {
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
const pendingAttachmentIds = ref([]);
function handleAddAttachment(id) {
    pendingAttachmentIds.value.push(id);
}
function handleRemoveAttachment(id) {
    pendingAttachmentIds.value = pendingAttachmentIds.value.filter(i => i !== id);
}
function scrollToBottom() {
    nextTick(() => {
        if (chatBodyRef.value) {
            chatBodyRef.value.scrollTop = chatBodyRef.value.scrollHeight;
        }
    });
}
watch(() => [store.messages.length, store.streamingAnswer, store.currentThinking.length], scrollToBottom);
// Blob 转 dataURL（base64）：用于把附件内嵌到 SSE 请求体
// 为什么用 dataURL 而非裸 base64：后端可直接识别 mimeType 并落盘或转发
function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}
// §5.2 收集附件：从 IndexedDB 读取 blob，转 base64，返回后端期望格式
async function collectAttachments() {
    const result = [];
    for (const id of pendingAttachmentIds.value) {
        const record = await dbGet(CHAT_STORES.attachments, id);
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
function normalizeRefs(refs) {
    if (!refs || refs.length === 0)
        return [];
    if (typeof refs[0] === 'string') {
        return refs.map((path, i) => ({
            path,
            // 路径形式（带 .md）取 basename 去后缀作 title；裸页面名原样使用
            title: (path.split('/').pop() || path).replace(/\.md$/, ''),
            snippet: '',
            source: 'vault',
            citeIndex: i + 1,
        }));
    }
    return refs;
}
async function sendQuestion(question) {
    abortController = new AbortController();
    abortReason = null;
    // 线程隔离 + 本地记忆：已有 threadId 时，后端优先从本地记忆（data/threads/{id}/memory.json）
    // 注入历史上下文（保证跨重启连贯），前端无需再重复发送 history；
    // 无线程（新会话首问）时回退为前端透传完整 history（向后兼容，后端记忆为空时亦会回退）。
    const activeThreadId = store.currentThreadId;
    const history = activeThreadId
        ? undefined
        : store.messages.map((m) => ({ role: m.role, content: m.content }));
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
    const body = { question };
    // 仅当无 threadId（新会话首问）时携带前端 history 作为上下文回退；
    // 有 threadId 时后端从本地记忆注入，前端不再发送 history（避免重复上下文）
    if (!activeThreadId && history && history.length > 0) {
        body.history = history;
    }
    // 携带 threadId 供后端定位本地记忆与归档（后端在记忆非空时优先用记忆，否则回退 history）
    if (activeThreadId) {
        body.threadId = activeThreadId;
    }
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
    }
    catch (err) {
        // AbortError 已在 consumeQuerySSE 内吞掉，此处只会是真实网络/API 错误
        const msg = err.message;
        store.handleError(msg);
        ElMessage.warning(apiErrorMessage('问答失败', err));
    }
    finally {
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
            }
            else {
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
    if (!abortController || !store.isLoading)
        return;
    abortReason = 'user';
    abortController.abort();
}
function handleSubmit() {
    const q = inputQuestion.value.trim();
    if (!q || store.isLoading)
        return;
    store.submitQuestion(q);
    inputQuestion.value = '';
    void sendQuestion(q);
}
function handleKeydown(e) {
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
async function handleSelectConversation(id) {
    await conversationsStore.selectConversation(id);
}
async function archiveMessage(idx) {
    const msg = store.messages[idx];
    if (!msg || !msg.sessionId || msg.messageIndex === undefined || msg.archived)
        return;
    // 为什么用 authFetch 而非裸 fetch：归档接口受认证保护，需带 Authorization 头
    // 否则 401 会被前端统一提示"归档失败，请检查后端服务"，掩盖真实原因
    try {
        const res = await authStore.authFetch(`${API_BASE}/query/archive`, {
            method: 'POST',
            // threadId 优先（线程隔离定位），缺失时回退 sessionId（两者同源）
            body: JSON.stringify({
                threadId: msg.threadId ?? msg.sessionId,
                sessionId: msg.sessionId,
                messageIndex: msg.messageIndex,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        ElMessage.success(`已归档到 ${data.path}`);
        store.markArchived(idx);
    }
    catch (err) {
        // 区分错误类型给出准确提示，避免一律"请检查后端服务"误导用户
        const msg = err.message || '';
        if (msg.includes('不存在') || msg.includes('过期')) {
            ElMessage.warning('该问答已过期（后端会话已清理），无法归档');
        }
        else if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
            ElMessage.error('网络错误，请检查后端服务是否运行');
        }
        else {
            ElMessage.warning(`归档失败：${msg}`);
        }
    }
}
// F-3.13 重新生成：复用该消息对应的 user 问题，丢弃原 assistant 回答，触发新问答
// 为什么不直接重发：SRS 要求"重新生成产生新 sessionId"，所以必须重新走完整 SSE 流程
// 策略：找到 idx-1 的 user 消息内容 → removeMessagesFrom(idx) 丢弃 assistant 回答 → sendQuestion
function handleRegenerate(idx) {
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
function handleRemoveMessage(idx) {
    store.removeMessage(idx);
    ElMessage.success('已删除消息');
    // 异步持久化：不阻塞 UI 反馈
    void conversationsStore.persistConversation(store.messages);
}
// 工具栏高级设置面板：齿轮按钮点击展开/收起，集中展示输出相关非高频设置
// 为什么用 mousedown 而非 click 关闭：click 事件在 element-plus 内部触发顺序不稳定，
// mousedown 触发早于下拉/选择等组件内部的 click 监听，避免面板内点击被先关闭再打开
const advancedOpen = ref(false);
const advancedPanelRef = ref(null);
// 多选下拉可见性：用 el-popover + trigger="manual" 完全手动控制
// 为什么不用 el-dropdown：el-dropdown 内置 outside-click 检测（基于 pointerdown + contains），
//   即使设 :hide-on-click="false" 与 @pointerdown.stop 仍会在某些边缘场景关闭菜单；
//   el-popover 的 trigger="manual" 把可见性完全交给外部 ref，从机制上根除自动关闭问题
const outputModesOpen = ref(false);
const middlewaresOpen = ref(false);
// 两个 popover 互斥：同时只允许一个打开，避免视觉重叠与交互混乱
function toggleOutputModes() {
    outputModesOpen.value = !outputModesOpen.value;
    if (outputModesOpen.value)
        middlewaresOpen.value = false;
}
function toggleMiddlewares() {
    middlewaresOpen.value = !middlewaresOpen.value;
    if (middlewaresOpen.value)
        outputModesOpen.value = false;
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
    flexDirection: 'column',
    gap: '4px',
    padding: '4px 8px',
};
function handleToggleAdvanced() {
    advancedOpen.value = !advancedOpen.value;
}
// §click outside 关闭：点击面板外部任意位置收起高级设置
// 为什么用 capture: true 捕获阶段监听：避免被 element-plus 内部 stopPropagation 吞掉
function handleAdvancedOutsideClick(e) {
    if (!advancedOpen.value)
        return;
    const target = e.target;
    const targetEl = target;
    // el-popover 内容 teleport 到 body，先检查是否点击在 popover 内
    // 为什么优先检查 popover：popover 内点击不关闭任何东西，让 checkbox 正常切换
    if (targetEl?.closest('.multi-select-popover'))
        return;
    // 面板内点击：不关闭面板，但需要关闭已打开的 popover（点击 trigger 按钮除外，由 trigger 自己 toggle）
    if (advancedPanelRef.value?.contains(target)) {
        // 点击 trigger 按钮时让 @click 自己处理切换，不在此处关闭
        if (targetEl?.closest('.output-modes-trigger') || targetEl?.closest('.middlewares-trigger'))
            return;
        outputModesOpen.value = false;
        middlewaresOpen.value = false;
        return;
    }
    // 齿轮按钮自身点击不关闭（否则 toggle 会被两个监听器抵消）
    if (targetEl?.closest('.advanced-toggle'))
        return;
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
    }
    catch {
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
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['sidebar-show-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-body']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-body']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-body']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-body']} */ ;
/** @type {__VLS_StyleScopedClasses['suggestion-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-row']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content']} */ ;
/** @type {__VLS_StyleScopedClasses['followups-track']} */ ;
/** @type {__VLS_StyleScopedClasses['followups-track']} */ ;
/** @type {__VLS_StyleScopedClasses['followup-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['followup-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['chip-tooltip']} */ ;
/** @type {__VLS_StyleScopedClasses['input-area']} */ ;
/** @type {__VLS_StyleScopedClasses['input-area']} */ ;
/** @type {__VLS_StyleScopedClasses['input-area']} */ ;
/** @type {__VLS_StyleScopedClasses['el-textarea__inner']} */ ;
/** @type {__VLS_StyleScopedClasses['input-area']} */ ;
/** @type {__VLS_StyleScopedClasses['el-textarea__inner']} */ ;
/** @type {__VLS_StyleScopedClasses['output-mode-select']} */ ;
/** @type {__VLS_StyleScopedClasses['output-mode-select']} */ ;
/** @type {__VLS_StyleScopedClasses['el-input__wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['output-modes-trigger']} */ ;
/** @type {__VLS_StyleScopedClasses['middlewares-trigger']} */ ;
/** @type {__VLS_StyleScopedClasses['stream-mode-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['send-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['advanced-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['advanced-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['advanced-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['advanced-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['advanced-skill-select']} */ ;
/** @type {__VLS_StyleScopedClasses['el-input__wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['advanced-skill-select']} */ ;
/** @type {__VLS_StyleScopedClasses['el-input__wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['code-block-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['code-block-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['code-copy-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['code-copy-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['code-lang-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['code-copy-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['ref-anchor']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['media-embed']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['media-embed']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['media-iframe']} */ ;
/** @type {__VLS_StyleScopedClasses['video-download-link']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "query-page" },
});
if (__VLS_ctx.sidebarState === 'hidden') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.sidebarState === 'hidden'))
                    return;
                __VLS_ctx.setSidebarState('expanded');
            } },
        ...{ class: "sidebar-show-btn" },
        title: "展开侧栏（Ctrl+B）",
    });
    const __VLS_0 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({}));
    const __VLS_2 = __VLS_1({}, ...__VLS_functionalComponentArgsRest(__VLS_1));
    __VLS_3.slots.default;
    const __VLS_4 = {}.Menu;
    /** @type {[typeof __VLS_components.Menu, ]} */ ;
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
    const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
    var __VLS_3;
}
/** @type {[typeof ConversationSidebar, ]} */ ;
// @ts-ignore
const __VLS_8 = __VLS_asFunctionalComponent(ConversationSidebar, new ConversationSidebar({
    ...{ 'onToggle': {} },
    ...{ 'onNewSession': {} },
    ...{ 'onSelect': {} },
    state: (__VLS_ctx.sidebarState),
}));
const __VLS_9 = __VLS_8({
    ...{ 'onToggle': {} },
    ...{ 'onNewSession': {} },
    ...{ 'onSelect': {} },
    state: (__VLS_ctx.sidebarState),
}, ...__VLS_functionalComponentArgsRest(__VLS_8));
let __VLS_11;
let __VLS_12;
let __VLS_13;
const __VLS_14 = {
    onToggle: (__VLS_ctx.toggleSidebar)
};
const __VLS_15 = {
    onNewSession: (__VLS_ctx.handleNewSession)
};
const __VLS_16 = {
    onSelect: (__VLS_ctx.handleSelectConversation)
};
var __VLS_10;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card query-card fade-up" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ref: "chatBodyRef",
    ...{ class: "chat-body" },
});
/** @type {typeof __VLS_ctx.chatBodyRef} */ ;
if (__VLS_ctx.store.messages.length === 0 && !__VLS_ctx.store.streamingAnswer) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "chat-empty" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "empty-tip" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-suggestions" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.store.messages.length === 0 && !__VLS_ctx.store.streamingAnswer))
                    return;
                __VLS_ctx.inputQuestion = '什么是 LLM Wiki？';
            } },
        ...{ class: "suggestion-chip" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.store.messages.length === 0 && !__VLS_ctx.store.streamingAnswer))
                    return;
                __VLS_ctx.inputQuestion = '知识库中有哪些页面？';
            } },
        ...{ class: "suggestion-chip" },
    });
}
for (const [msg, idx] of __VLS_getVForSourceType((__VLS_ctx.store.messages))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-row" },
        ...{ class: (msg.role) },
    });
    if (msg.role === 'user') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "msg-avatar" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "user-avatar" },
        });
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-content-wrapper" },
        ...{ class: (msg.role) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-bubble" },
        ...{ class: (msg.role) },
    });
    if (msg.thinking && msg.thinking.length > 0) {
        /** @type {[typeof ThinkingBlock, ]} */ ;
        // @ts-ignore
        const __VLS_17 = __VLS_asFunctionalComponent(ThinkingBlock, new ThinkingBlock({
            steps: (msg.thinking),
        }));
        const __VLS_18 = __VLS_17({
            steps: (msg.thinking),
        }, ...__VLS_functionalComponentArgsRest(__VLS_17));
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-content markdown-body" },
    });
    __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderMarkdown(msg.content)) }, null, null);
    if (msg.multimodal) {
        /** @type {[typeof MultimodalOutputCard, ]} */ ;
        // @ts-ignore
        const __VLS_20 = __VLS_asFunctionalComponent(MultimodalOutputCard, new MultimodalOutputCard({
            output: (msg.multimodal),
        }));
        const __VLS_21 = __VLS_20({
            output: (msg.multimodal),
        }, ...__VLS_functionalComponentArgsRest(__VLS_20));
    }
    if (msg.image) {
        /** @type {[typeof MultimodalOutputCard, ]} */ ;
        // @ts-ignore
        const __VLS_23 = __VLS_asFunctionalComponent(MultimodalOutputCard, new MultimodalOutputCard({
            output: ({ type: 'image', content: msg.image.alt, imageUrl: msg.image.url }),
        }));
        const __VLS_24 = __VLS_23({
            output: ({ type: 'image', content: msg.image.alt, imageUrl: msg.image.url }),
        }, ...__VLS_functionalComponentArgsRest(__VLS_23));
    }
    if (msg.ppt) {
        /** @type {[typeof MultimodalOutputCard, ]} */ ;
        // @ts-ignore
        const __VLS_26 = __VLS_asFunctionalComponent(MultimodalOutputCard, new MultimodalOutputCard({
            output: ({ type: 'ppt', content: msg.ppt.title, pptMarkdown: msg.ppt.markdown }),
        }));
        const __VLS_27 = __VLS_26({
            output: ({ type: 'ppt', content: msg.ppt.title, pptMarkdown: msg.ppt.markdown }),
        }, ...__VLS_functionalComponentArgsRest(__VLS_26));
    }
    if (msg.followups && msg.followups.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "msg-followups" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "followups-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "followups-track" },
        });
        for (const [f, i] of __VLS_getVForSourceType((msg.followups))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ onClick: (...[$event]) => {
                        if (!(msg.followups && msg.followups.length > 0))
                            return;
                        __VLS_ctx.inputQuestion = f;
                    } },
                key: (i),
                ...{ class: "followup-chip" },
            });
            (f);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "chip-tooltip" },
            });
        }
    }
    if (__VLS_ctx.normalizeRefs(msg.refs).length > 0) {
        /** @type {[typeof RefsList, ]} */ ;
        // @ts-ignore
        const __VLS_29 = __VLS_asFunctionalComponent(RefsList, new RefsList({
            refs: (__VLS_ctx.normalizeRefs(msg.refs)),
        }));
        const __VLS_30 = __VLS_29({
            refs: (__VLS_ctx.normalizeRefs(msg.refs)),
        }, ...__VLS_functionalComponentArgsRest(__VLS_29));
    }
    if (msg.role === 'assistant' && msg.sessionId) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "msg-actions" },
        });
        const __VLS_32 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
            ...{ 'onClick': {} },
            size: "small",
            text: true,
            disabled: (msg.archived),
        }));
        const __VLS_34 = __VLS_33({
            ...{ 'onClick': {} },
            size: "small",
            text: true,
            disabled: (msg.archived),
        }, ...__VLS_functionalComponentArgsRest(__VLS_33));
        let __VLS_36;
        let __VLS_37;
        let __VLS_38;
        const __VLS_39 = {
            onClick: (...[$event]) => {
                if (!(msg.role === 'assistant' && msg.sessionId))
                    return;
                __VLS_ctx.archiveMessage(idx);
            }
        };
        __VLS_35.slots.default;
        (msg.archived ? '已归档' : '归档');
        var __VLS_35;
    }
    /** @type {[typeof MessageToolbar, ]} */ ;
    // @ts-ignore
    const __VLS_40 = __VLS_asFunctionalComponent(MessageToolbar, new MessageToolbar({
        ...{ 'onRegenerate': {} },
        ...{ 'onRemove': {} },
        role: (msg.role),
        content: (msg.content),
        msgId: (msg.id),
        createdAt: (msg.createdAt),
        canRegenerate: (!__VLS_ctx.store.isLoading),
    }));
    const __VLS_41 = __VLS_40({
        ...{ 'onRegenerate': {} },
        ...{ 'onRemove': {} },
        role: (msg.role),
        content: (msg.content),
        msgId: (msg.id),
        createdAt: (msg.createdAt),
        canRegenerate: (!__VLS_ctx.store.isLoading),
    }, ...__VLS_functionalComponentArgsRest(__VLS_40));
    let __VLS_43;
    let __VLS_44;
    let __VLS_45;
    const __VLS_46 = {
        onRegenerate: (...[$event]) => {
            __VLS_ctx.handleRegenerate(idx);
        }
    };
    const __VLS_47 = {
        onRemove: (...[$event]) => {
            __VLS_ctx.handleRemoveMessage(idx);
        }
    };
    var __VLS_42;
}
if (__VLS_ctx.store.streamingAnswer || __VLS_ctx.store.isLoading) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-row assistant" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "msg-bubble assistant" },
        ...{ class: ({ streaming: !!__VLS_ctx.store.streamingAnswer, loading: __VLS_ctx.store.isLoading && !__VLS_ctx.store.streamingAnswer }) },
    });
    if (__VLS_ctx.store.currentThinking.length > 0) {
        /** @type {[typeof ThinkingBlock, ]} */ ;
        // @ts-ignore
        const __VLS_48 = __VLS_asFunctionalComponent(ThinkingBlock, new ThinkingBlock({
            steps: (__VLS_ctx.store.currentThinking),
        }));
        const __VLS_49 = __VLS_48({
            steps: (__VLS_ctx.store.currentThinking),
        }, ...__VLS_functionalComponentArgsRest(__VLS_48));
    }
    if (__VLS_ctx.store.searchProgress) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "search-progress" },
        });
        (__VLS_ctx.searchProgressLabel);
        if (__VLS_ctx.store.searchProgress.count) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.store.searchProgress.count);
        }
    }
    if (__VLS_ctx.store.isLoading && !__VLS_ctx.store.streamingAnswer && __VLS_ctx.store.currentThinking.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "loading-dots" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "dot" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "dot" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "dot" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "loading-text" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "msg-content markdown-body" },
        });
        __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.renderMarkdown(__VLS_ctx.store.streamingAnswer || '')) }, null, null);
    }
    if (__VLS_ctx.store.currentMultimodal) {
        /** @type {[typeof MultimodalOutputCard, ]} */ ;
        // @ts-ignore
        const __VLS_51 = __VLS_asFunctionalComponent(MultimodalOutputCard, new MultimodalOutputCard({
            output: (__VLS_ctx.store.currentMultimodal),
        }));
        const __VLS_52 = __VLS_51({
            output: (__VLS_ctx.store.currentMultimodal),
        }, ...__VLS_functionalComponentArgsRest(__VLS_51));
    }
    if (__VLS_ctx.store.currentRefs.length > 0) {
        /** @type {[typeof RefsList, ]} */ ;
        // @ts-ignore
        const __VLS_54 = __VLS_asFunctionalComponent(RefsList, new RefsList({
            refs: (__VLS_ctx.store.currentRefs),
        }));
        const __VLS_55 = __VLS_54({
            refs: (__VLS_ctx.store.currentRefs),
        }, ...__VLS_functionalComponentArgsRest(__VLS_54));
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "input-area" },
});
const __VLS_57 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_58 = __VLS_asFunctionalComponent(__VLS_57, new __VLS_57({
    ...{ 'onKeydown': {} },
    modelValue: (__VLS_ctx.inputQuestion),
    type: "textarea",
    rows: (1),
    autosize: ({ minRows: 1, maxRows: 6 }),
    placeholder: "输入问题，Ctrl+Enter 发送…",
    resize: "none",
    disabled: (__VLS_ctx.store.isLoading),
}));
const __VLS_59 = __VLS_58({
    ...{ 'onKeydown': {} },
    modelValue: (__VLS_ctx.inputQuestion),
    type: "textarea",
    rows: (1),
    autosize: ({ minRows: 1, maxRows: 6 }),
    placeholder: "输入问题，Ctrl+Enter 发送…",
    resize: "none",
    disabled: (__VLS_ctx.store.isLoading),
}, ...__VLS_functionalComponentArgsRest(__VLS_58));
let __VLS_61;
let __VLS_62;
let __VLS_63;
const __VLS_64 = {
    onKeydown: (__VLS_ctx.handleKeydown)
};
var __VLS_60;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "button-bar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "left-buttons" },
});
/** @type {[typeof AttachmentUploader, ]} */ ;
// @ts-ignore
const __VLS_65 = __VLS_asFunctionalComponent(AttachmentUploader, new AttachmentUploader({
    ...{ 'onAdd': {} },
    ...{ 'onRemove': {} },
    attachments: (__VLS_ctx.pendingAttachmentIds),
    iconOnly: (true),
}));
const __VLS_66 = __VLS_65({
    ...{ 'onAdd': {} },
    ...{ 'onRemove': {} },
    attachments: (__VLS_ctx.pendingAttachmentIds),
    iconOnly: (true),
}, ...__VLS_functionalComponentArgsRest(__VLS_65));
let __VLS_68;
let __VLS_69;
let __VLS_70;
const __VLS_71 = {
    onAdd: (__VLS_ctx.handleAddAttachment)
};
const __VLS_72 = {
    onRemove: (__VLS_ctx.handleRemoveAttachment)
};
var __VLS_67;
/** @type {[typeof InputToolbar, ]} */ ;
// @ts-ignore
const __VLS_73 = __VLS_asFunctionalComponent(InputToolbar, new InputToolbar({
    ...{ 'onSelect': {} },
    tools: (__VLS_ctx.toolbarTools),
    activeMode: (__VLS_ctx.activeMode),
    iconOnly: (true),
}));
const __VLS_74 = __VLS_73({
    ...{ 'onSelect': {} },
    tools: (__VLS_ctx.toolbarTools),
    activeMode: (__VLS_ctx.activeMode),
    iconOnly: (true),
}, ...__VLS_functionalComponentArgsRest(__VLS_73));
let __VLS_76;
let __VLS_77;
let __VLS_78;
const __VLS_79 = {
    onSelect: (__VLS_ctx.handleSelectMode)
};
var __VLS_75;
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.handleToggleAdvanced) },
    type: "button",
    ...{ class: "advanced-toggle" },
    ...{ class: ({ active: __VLS_ctx.advancedOpen }) },
    title: "高级设置",
    'aria-label': "高级设置",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
    ...{ class: "advanced-icon" },
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
    cx: "12",
    cy: "12",
    r: "3",
    stroke: "currentColor",
    'stroke-width': "1.8",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
    d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
    stroke: "currentColor",
    'stroke-width': "1.6",
    'stroke-linejoin': "round",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "right-buttons" },
});
/** @type {[typeof ModelSelector, ]} */ ;
// @ts-ignore
const __VLS_80 = __VLS_asFunctionalComponent(ModelSelector, new ModelSelector({}));
const __VLS_81 = __VLS_80({}, ...__VLS_functionalComponentArgsRest(__VLS_80));
if (!__VLS_ctx.store.isLoading) {
    const __VLS_83 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_84 = __VLS_asFunctionalComponent(__VLS_83, new __VLS_83({
        ...{ 'onClick': {} },
        type: "primary",
        ...{ class: "send-btn" },
        disabled: (!__VLS_ctx.inputQuestion.trim()),
        title: "发送",
    }));
    const __VLS_85 = __VLS_84({
        ...{ 'onClick': {} },
        type: "primary",
        ...{ class: "send-btn" },
        disabled: (!__VLS_ctx.inputQuestion.trim()),
        title: "发送",
    }, ...__VLS_functionalComponentArgsRest(__VLS_84));
    let __VLS_87;
    let __VLS_88;
    let __VLS_89;
    const __VLS_90 = {
        onClick: (__VLS_ctx.handleSubmit)
    };
    __VLS_86.slots.default;
    const __VLS_91 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_92 = __VLS_asFunctionalComponent(__VLS_91, new __VLS_91({}));
    const __VLS_93 = __VLS_92({}, ...__VLS_functionalComponentArgsRest(__VLS_92));
    __VLS_94.slots.default;
    const __VLS_95 = {}.Promotion;
    /** @type {[typeof __VLS_components.Promotion, ]} */ ;
    // @ts-ignore
    const __VLS_96 = __VLS_asFunctionalComponent(__VLS_95, new __VLS_95({}));
    const __VLS_97 = __VLS_96({}, ...__VLS_functionalComponentArgsRest(__VLS_96));
    var __VLS_94;
    var __VLS_86;
}
else {
    const __VLS_99 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_100 = __VLS_asFunctionalComponent(__VLS_99, new __VLS_99({
        ...{ 'onClick': {} },
        type: "danger",
        ...{ class: "send-btn" },
        title: "停止回答",
    }));
    const __VLS_101 = __VLS_100({
        ...{ 'onClick': {} },
        type: "danger",
        ...{ class: "send-btn" },
        title: "停止回答",
    }, ...__VLS_functionalComponentArgsRest(__VLS_100));
    let __VLS_103;
    let __VLS_104;
    let __VLS_105;
    const __VLS_106 = {
        onClick: (__VLS_ctx.handleStop)
    };
    __VLS_102.slots.default;
    const __VLS_107 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_108 = __VLS_asFunctionalComponent(__VLS_107, new __VLS_107({}));
    const __VLS_109 = __VLS_108({}, ...__VLS_functionalComponentArgsRest(__VLS_108));
    __VLS_110.slots.default;
    const __VLS_111 = {}.VideoPause;
    /** @type {[typeof __VLS_components.VideoPause, ]} */ ;
    // @ts-ignore
    const __VLS_112 = __VLS_asFunctionalComponent(__VLS_111, new __VLS_111({}));
    const __VLS_113 = __VLS_112({}, ...__VLS_functionalComponentArgsRest(__VLS_112));
    var __VLS_110;
    var __VLS_102;
}
const __VLS_115 = {}.Transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.Transition, ]} */ ;
// @ts-ignore
const __VLS_116 = __VLS_asFunctionalComponent(__VLS_115, new __VLS_115({
    name: "advanced-panel",
}));
const __VLS_117 = __VLS_116({
    name: "advanced-panel",
}, ...__VLS_functionalComponentArgsRest(__VLS_116));
__VLS_118.slots.default;
if (__VLS_ctx.advancedOpen) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onMousedown: () => { } },
        ref: "advancedPanelRef",
        ...{ class: "advanced-panel" },
    });
    /** @type {typeof __VLS_ctx.advancedPanelRef} */ ;
    const __VLS_119 = {}.ElSelect;
    /** @type {[typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, ]} */ ;
    // @ts-ignore
    const __VLS_120 = __VLS_asFunctionalComponent(__VLS_119, new __VLS_119({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.activeSkillId),
        size: "small",
        ...{ class: "advanced-skill-select" },
        placeholder: "AI 伙伴",
        disabled: (__VLS_ctx.store.isLoading),
    }));
    const __VLS_121 = __VLS_120({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.activeSkillId),
        size: "small",
        ...{ class: "advanced-skill-select" },
        placeholder: "AI 伙伴",
        disabled: (__VLS_ctx.store.isLoading),
    }, ...__VLS_functionalComponentArgsRest(__VLS_120));
    let __VLS_123;
    let __VLS_124;
    let __VLS_125;
    const __VLS_126 = {
        onChange: (__VLS_ctx.handleSkillChange)
    };
    __VLS_122.slots.default;
    const __VLS_127 = {}.ElOption;
    /** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
    // @ts-ignore
    const __VLS_128 = __VLS_asFunctionalComponent(__VLS_127, new __VLS_127({
        label: "默认（无预设）",
        value: "",
    }));
    const __VLS_129 = __VLS_128({
        label: "默认（无预设）",
        value: "",
    }, ...__VLS_functionalComponentArgsRest(__VLS_128));
    for (const [s] of __VLS_getVForSourceType((__VLS_ctx.skills))) {
        const __VLS_131 = {}.ElOption;
        /** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
        // @ts-ignore
        const __VLS_132 = __VLS_asFunctionalComponent(__VLS_131, new __VLS_131({
            key: (s.id),
            label: (s.name),
            value: (s.id),
        }));
        const __VLS_133 = __VLS_132({
            key: (s.id),
            label: (s.name),
            value: (s.id),
        }, ...__VLS_functionalComponentArgsRest(__VLS_132));
    }
    var __VLS_122;
    const __VLS_135 = {}.ElSelect;
    /** @type {[typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, ]} */ ;
    // @ts-ignore
    const __VLS_136 = __VLS_asFunctionalComponent(__VLS_135, new __VLS_135({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.outputMode),
        size: "small",
        ...{ class: "output-mode-select" },
    }));
    const __VLS_137 = __VLS_136({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.outputMode),
        size: "small",
        ...{ class: "output-mode-select" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_136));
    let __VLS_139;
    let __VLS_140;
    let __VLS_141;
    const __VLS_142 = {
        onChange: (__VLS_ctx.handleOutputModeChange)
    };
    __VLS_138.slots.default;
    for (const [opt] of __VLS_getVForSourceType((__VLS_ctx.outputModeOptions))) {
        const __VLS_143 = {}.ElOption;
        /** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
        // @ts-ignore
        const __VLS_144 = __VLS_asFunctionalComponent(__VLS_143, new __VLS_143({
            key: (opt.value),
            label: (opt.label),
            value: (opt.value),
        }));
        const __VLS_145 = __VLS_144({
            key: (opt.value),
            label: (opt.label),
            value: (opt.value),
        }, ...__VLS_functionalComponentArgsRest(__VLS_144));
    }
    var __VLS_138;
    const __VLS_147 = {}.ElPopover;
    /** @type {[typeof __VLS_components.ElPopover, typeof __VLS_components.elPopover, typeof __VLS_components.ElPopover, typeof __VLS_components.elPopover, ]} */ ;
    // @ts-ignore
    const __VLS_148 = __VLS_asFunctionalComponent(__VLS_147, new __VLS_147({
        visible: (__VLS_ctx.outputModesOpen),
        placement: "bottom",
        width: (200),
        trigger: "manual",
        popperClass: "multi-select-popover",
        popperStyle: (__VLS_ctx.multiSelectPopperStyle),
        showArrow: (false),
    }));
    const __VLS_149 = __VLS_148({
        visible: (__VLS_ctx.outputModesOpen),
        placement: "bottom",
        width: (200),
        trigger: "manual",
        popperClass: "multi-select-popover",
        popperStyle: (__VLS_ctx.multiSelectPopperStyle),
        showArrow: (false),
    }, ...__VLS_functionalComponentArgsRest(__VLS_148));
    __VLS_150.slots.default;
    {
        const { reference: __VLS_thisSlot } = __VLS_150.slots;
        const __VLS_151 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_152 = __VLS_asFunctionalComponent(__VLS_151, new __VLS_151({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "output-modes-trigger" },
            title: (__VLS_ctx.outputModesTooltip),
        }));
        const __VLS_153 = __VLS_152({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "output-modes-trigger" },
            title: (__VLS_ctx.outputModesTooltip),
        }, ...__VLS_functionalComponentArgsRest(__VLS_152));
        let __VLS_155;
        let __VLS_156;
        let __VLS_157;
        const __VLS_158 = {
            onClick: (__VLS_ctx.toggleOutputModes)
        };
        __VLS_154.slots.default;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "output-modes-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "output-modes-count" },
        });
        (__VLS_ctx.store.outputModes.length);
        (__VLS_ctx.ALL_OUTPUT_MODES.length);
        var __VLS_154;
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multi-select-list" },
        ...{ style: (__VLS_ctx.multiSelectListStyle) },
    });
    for (const [mode] of __VLS_getVForSourceType((__VLS_ctx.ALL_OUTPUT_MODES))) {
        const __VLS_159 = {}.ElCheckbox;
        /** @type {[typeof __VLS_components.ElCheckbox, typeof __VLS_components.elCheckbox, typeof __VLS_components.ElCheckbox, typeof __VLS_components.elCheckbox, ]} */ ;
        // @ts-ignore
        const __VLS_160 = __VLS_asFunctionalComponent(__VLS_159, new __VLS_159({
            ...{ 'onChange': {} },
            key: (mode),
            modelValue: (__VLS_ctx.store.outputModes.includes(mode)),
        }));
        const __VLS_161 = __VLS_160({
            ...{ 'onChange': {} },
            key: (mode),
            modelValue: (__VLS_ctx.store.outputModes.includes(mode)),
        }, ...__VLS_functionalComponentArgsRest(__VLS_160));
        let __VLS_163;
        let __VLS_164;
        let __VLS_165;
        const __VLS_166 = {
            onChange: (...[$event]) => {
                if (!(__VLS_ctx.advancedOpen))
                    return;
                __VLS_ctx.handleToggleOutputMode(mode);
            }
        };
        __VLS_162.slots.default;
        (__VLS_ctx.OUTPUT_MODE_LABELS[mode]);
        var __VLS_162;
    }
    var __VLS_150;
    const __VLS_167 = {}.ElPopover;
    /** @type {[typeof __VLS_components.ElPopover, typeof __VLS_components.elPopover, typeof __VLS_components.ElPopover, typeof __VLS_components.elPopover, ]} */ ;
    // @ts-ignore
    const __VLS_168 = __VLS_asFunctionalComponent(__VLS_167, new __VLS_167({
        visible: (__VLS_ctx.middlewaresOpen),
        placement: "bottom",
        width: (200),
        trigger: "manual",
        popperClass: "multi-select-popover",
        popperStyle: (__VLS_ctx.multiSelectPopperStyle),
        showArrow: (false),
    }));
    const __VLS_169 = __VLS_168({
        visible: (__VLS_ctx.middlewaresOpen),
        placement: "bottom",
        width: (200),
        trigger: "manual",
        popperClass: "multi-select-popover",
        popperStyle: (__VLS_ctx.multiSelectPopperStyle),
        showArrow: (false),
    }, ...__VLS_functionalComponentArgsRest(__VLS_168));
    __VLS_170.slots.default;
    {
        const { reference: __VLS_thisSlot } = __VLS_170.slots;
        const __VLS_171 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_172 = __VLS_asFunctionalComponent(__VLS_171, new __VLS_171({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "middlewares-trigger" },
            title: (__VLS_ctx.middlewaresTooltip),
        }));
        const __VLS_173 = __VLS_172({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "middlewares-trigger" },
            title: (__VLS_ctx.middlewaresTooltip),
        }, ...__VLS_functionalComponentArgsRest(__VLS_172));
        let __VLS_175;
        let __VLS_176;
        let __VLS_177;
        const __VLS_178 = {
            onClick: (__VLS_ctx.toggleMiddlewares)
        };
        __VLS_174.slots.default;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "middlewares-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "middlewares-count" },
        });
        (__VLS_ctx.store.middlewares.length);
        (__VLS_ctx.ALL_MIDDLEWARES.length);
        var __VLS_174;
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "multi-select-list" },
        ...{ style: (__VLS_ctx.multiSelectListStyle) },
    });
    for (const [mw] of __VLS_getVForSourceType((__VLS_ctx.ALL_MIDDLEWARES))) {
        const __VLS_179 = {}.ElCheckbox;
        /** @type {[typeof __VLS_components.ElCheckbox, typeof __VLS_components.elCheckbox, typeof __VLS_components.ElCheckbox, typeof __VLS_components.elCheckbox, ]} */ ;
        // @ts-ignore
        const __VLS_180 = __VLS_asFunctionalComponent(__VLS_179, new __VLS_179({
            ...{ 'onChange': {} },
            key: (mw),
            modelValue: (__VLS_ctx.store.middlewares.includes(mw)),
        }));
        const __VLS_181 = __VLS_180({
            ...{ 'onChange': {} },
            key: (mw),
            modelValue: (__VLS_ctx.store.middlewares.includes(mw)),
        }, ...__VLS_functionalComponentArgsRest(__VLS_180));
        let __VLS_183;
        let __VLS_184;
        let __VLS_185;
        const __VLS_186 = {
            onChange: (...[$event]) => {
                if (!(__VLS_ctx.advancedOpen))
                    return;
                __VLS_ctx.handleToggleMiddleware(mw);
            }
        };
        __VLS_182.slots.default;
        (__VLS_ctx.MIDDLEWARE_LABELS[mw]);
        var __VLS_182;
    }
    var __VLS_170;
    const __VLS_187 = {}.ElTooltip;
    /** @type {[typeof __VLS_components.ElTooltip, typeof __VLS_components.elTooltip, typeof __VLS_components.ElTooltip, typeof __VLS_components.elTooltip, ]} */ ;
    // @ts-ignore
    const __VLS_188 = __VLS_asFunctionalComponent(__VLS_187, new __VLS_187({
        content: (__VLS_ctx.store.streamMode ? '真流式输出（点击关闭）' : '假流式输出（点击开启真流式）'),
        placement: "top",
    }));
    const __VLS_189 = __VLS_188({
        content: (__VLS_ctx.store.streamMode ? '真流式输出（点击关闭）' : '假流式输出（点击开启真流式）'),
        placement: "top",
    }, ...__VLS_functionalComponentArgsRest(__VLS_188));
    __VLS_190.slots.default;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stream-mode-toggle" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "stream-mode-label" },
    });
    const __VLS_191 = {}.ElSwitch;
    /** @type {[typeof __VLS_components.ElSwitch, typeof __VLS_components.elSwitch, ]} */ ;
    // @ts-ignore
    const __VLS_192 = __VLS_asFunctionalComponent(__VLS_191, new __VLS_191({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.store.streamMode),
        size: "small",
    }));
    const __VLS_193 = __VLS_192({
        ...{ 'onChange': {} },
        modelValue: (__VLS_ctx.store.streamMode),
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_192));
    let __VLS_195;
    let __VLS_196;
    let __VLS_197;
    const __VLS_198 = {
        onChange: (...[$event]) => {
            if (!(__VLS_ctx.advancedOpen))
                return;
            __VLS_ctx.store.toggleStreamMode();
        }
    };
    var __VLS_194;
    var __VLS_190;
}
var __VLS_118;
if (__VLS_ctx.previewVisible) {
    const __VLS_199 = {}.ElImageViewer;
    /** @type {[typeof __VLS_components.ElImageViewer, typeof __VLS_components.elImageViewer, ]} */ ;
    // @ts-ignore
    const __VLS_200 = __VLS_asFunctionalComponent(__VLS_199, new __VLS_199({
        ...{ 'onClose': {} },
        urlList: ([__VLS_ctx.previewSrc]),
    }));
    const __VLS_201 = __VLS_200({
        ...{ 'onClose': {} },
        urlList: ([__VLS_ctx.previewSrc]),
    }, ...__VLS_functionalComponentArgsRest(__VLS_200));
    let __VLS_203;
    let __VLS_204;
    let __VLS_205;
    const __VLS_206 = {
        onClose: (...[$event]) => {
            if (!(__VLS_ctx.previewVisible))
                return;
            __VLS_ctx.previewVisible = false;
        }
    };
    var __VLS_202;
}
const __VLS_207 = {}.ElDialog;
/** @type {[typeof __VLS_components.ElDialog, typeof __VLS_components.elDialog, typeof __VLS_components.ElDialog, typeof __VLS_components.elDialog, ]} */ ;
// @ts-ignore
const __VLS_208 = __VLS_asFunctionalComponent(__VLS_207, new __VLS_207({
    ...{ 'onClose': {} },
    modelValue: (__VLS_ctx.videoDialogVisible),
    title: "视频生成",
    width: "560px",
    closeOnClickModal: (false),
}));
const __VLS_209 = __VLS_208({
    ...{ 'onClose': {} },
    modelValue: (__VLS_ctx.videoDialogVisible),
    title: "视频生成",
    width: "560px",
    closeOnClickModal: (false),
}, ...__VLS_functionalComponentArgsRest(__VLS_208));
let __VLS_211;
let __VLS_212;
let __VLS_213;
const __VLS_214 = {
    onClose: (__VLS_ctx.closeVideoDialog)
};
__VLS_210.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "video-dialog-body" },
});
if (__VLS_ctx.videoStatus === 'idle' || __VLS_ctx.videoStatus === 'failed') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "video-input-section" },
    });
    const __VLS_215 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_216 = __VLS_asFunctionalComponent(__VLS_215, new __VLS_215({
        modelValue: (__VLS_ctx.videoPrompt),
        type: "textarea",
        rows: (3),
        placeholder: "描述你想生成的视频内容，例如：一只猫在草地上奔跑",
        maxlength: "500",
        showWordLimit: true,
    }));
    const __VLS_217 = __VLS_216({
        modelValue: (__VLS_ctx.videoPrompt),
        type: "textarea",
        rows: (3),
        placeholder: "描述你想生成的视频内容，例如：一只猫在草地上奔跑",
        maxlength: "500",
        showWordLimit: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_216));
    const __VLS_219 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_220 = __VLS_asFunctionalComponent(__VLS_219, new __VLS_219({
        ...{ 'onClick': {} },
        type: "primary",
        ...{ class: "video-submit-btn" },
    }));
    const __VLS_221 = __VLS_220({
        ...{ 'onClick': {} },
        type: "primary",
        ...{ class: "video-submit-btn" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_220));
    let __VLS_223;
    let __VLS_224;
    let __VLS_225;
    const __VLS_226 = {
        onClick: (__VLS_ctx.submitVideoTask)
    };
    __VLS_222.slots.default;
    var __VLS_222;
    if (__VLS_ctx.videoError) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "video-error-tip" },
        });
        (__VLS_ctx.videoError);
    }
}
else if (__VLS_ctx.videoStatus === 'queued' || __VLS_ctx.videoStatus === 'processing') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "video-progress-section" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "video-status-text" },
    });
    const __VLS_227 = {}.ElIcon;
    /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
    // @ts-ignore
    const __VLS_228 = __VLS_asFunctionalComponent(__VLS_227, new __VLS_227({
        ...{ class: "is-loading" },
    }));
    const __VLS_229 = __VLS_228({
        ...{ class: "is-loading" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_228));
    __VLS_230.slots.default;
    const __VLS_231 = {}.Loading;
    /** @type {[typeof __VLS_components.Loading, ]} */ ;
    // @ts-ignore
    const __VLS_232 = __VLS_asFunctionalComponent(__VLS_231, new __VLS_231({}));
    const __VLS_233 = __VLS_232({}, ...__VLS_functionalComponentArgsRest(__VLS_232));
    var __VLS_230;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    (__VLS_ctx.videoStatus === 'queued' ? '任务排队中…' : '视频生成中…');
    const __VLS_235 = {}.ElProgress;
    /** @type {[typeof __VLS_components.ElProgress, typeof __VLS_components.elProgress, ]} */ ;
    // @ts-ignore
    const __VLS_236 = __VLS_asFunctionalComponent(__VLS_235, new __VLS_235({
        percentage: (__VLS_ctx.videoProgress),
        strokeWidth: (10),
        duration: (1),
    }));
    const __VLS_237 = __VLS_236({
        percentage: (__VLS_ctx.videoProgress),
        strokeWidth: (10),
        duration: (1),
    }, ...__VLS_functionalComponentArgsRest(__VLS_236));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "video-tip" },
    });
}
else if (__VLS_ctx.videoStatus === 'completed') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "video-result-section" },
    });
    if (__VLS_ctx.videoUrl) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.video)({
            src: (__VLS_ctx.videoUrl),
            controls: true,
            ...{ class: "video-player" },
        });
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "video-actions" },
    });
    if (__VLS_ctx.videoUrl) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
            href: (__VLS_ctx.videoUrl),
            target: "_blank",
            rel: "noopener",
            ...{ class: "video-download-link" },
        });
    }
    const __VLS_239 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_240 = __VLS_asFunctionalComponent(__VLS_239, new __VLS_239({
        ...{ 'onClick': {} },
        size: "small",
    }));
    const __VLS_241 = __VLS_240({
        ...{ 'onClick': {} },
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_240));
    let __VLS_243;
    let __VLS_244;
    let __VLS_245;
    const __VLS_246 = {
        onClick: (__VLS_ctx.resetVideoDialog)
    };
    __VLS_242.slots.default;
    var __VLS_242;
}
{
    const { footer: __VLS_thisSlot } = __VLS_210.slots;
    const __VLS_247 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_248 = __VLS_asFunctionalComponent(__VLS_247, new __VLS_247({
        ...{ 'onClick': {} },
    }));
    const __VLS_249 = __VLS_248({
        ...{ 'onClick': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_248));
    let __VLS_251;
    let __VLS_252;
    let __VLS_253;
    const __VLS_254 = {
        onClick: (__VLS_ctx.closeVideoDialog)
    };
    __VLS_250.slots.default;
    var __VLS_250;
}
var __VLS_210;
/** @type {__VLS_StyleScopedClasses['query-page']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar-show-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['query-card']} */ ;
/** @type {__VLS_StyleScopedClasses['fade-up']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-body']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-suggestions']} */ ;
/** @type {__VLS_StyleScopedClasses['suggestion-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['suggestion-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-row']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
/** @type {__VLS_StyleScopedClasses['user-avatar']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content-wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-followups']} */ ;
/** @type {__VLS_StyleScopedClasses['followups-label']} */ ;
/** @type {__VLS_StyleScopedClasses['followups-track']} */ ;
/** @type {__VLS_StyleScopedClasses['followup-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['chip-tooltip']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-row']} */ ;
/** @type {__VLS_StyleScopedClasses['assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['assistant']} */ ;
/** @type {__VLS_StyleScopedClasses['search-progress']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-dots']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['loading-text']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-content']} */ ;
/** @type {__VLS_StyleScopedClasses['markdown-body']} */ ;
/** @type {__VLS_StyleScopedClasses['input-area']} */ ;
/** @type {__VLS_StyleScopedClasses['button-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['left-buttons']} */ ;
/** @type {__VLS_StyleScopedClasses['advanced-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['advanced-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['right-buttons']} */ ;
/** @type {__VLS_StyleScopedClasses['send-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['send-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['advanced-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['advanced-skill-select']} */ ;
/** @type {__VLS_StyleScopedClasses['output-mode-select']} */ ;
/** @type {__VLS_StyleScopedClasses['output-modes-trigger']} */ ;
/** @type {__VLS_StyleScopedClasses['output-modes-label']} */ ;
/** @type {__VLS_StyleScopedClasses['output-modes-count']} */ ;
/** @type {__VLS_StyleScopedClasses['multi-select-list']} */ ;
/** @type {__VLS_StyleScopedClasses['middlewares-trigger']} */ ;
/** @type {__VLS_StyleScopedClasses['middlewares-label']} */ ;
/** @type {__VLS_StyleScopedClasses['middlewares-count']} */ ;
/** @type {__VLS_StyleScopedClasses['multi-select-list']} */ ;
/** @type {__VLS_StyleScopedClasses['stream-mode-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['stream-mode-label']} */ ;
/** @type {__VLS_StyleScopedClasses['video-dialog-body']} */ ;
/** @type {__VLS_StyleScopedClasses['video-input-section']} */ ;
/** @type {__VLS_StyleScopedClasses['video-submit-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['video-error-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['video-progress-section']} */ ;
/** @type {__VLS_StyleScopedClasses['video-status-text']} */ ;
/** @type {__VLS_StyleScopedClasses['is-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['video-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['video-result-section']} */ ;
/** @type {__VLS_StyleScopedClasses['video-player']} */ ;
/** @type {__VLS_StyleScopedClasses['video-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['video-download-link']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Promotion: Promotion,
            VideoPause: VideoPause,
            Menu: Menu,
            Loading: Loading,
            ConversationSidebar: ConversationSidebar,
            AttachmentUploader: AttachmentUploader,
            InputToolbar: InputToolbar,
            ThinkingBlock: ThinkingBlock,
            ModelSelector: ModelSelector,
            RefsList: RefsList,
            MessageToolbar: MessageToolbar,
            MultimodalOutputCard: MultimodalOutputCard,
            ALL_OUTPUT_MODES: ALL_OUTPUT_MODES,
            OUTPUT_MODE_LABELS: OUTPUT_MODE_LABELS,
            ALL_MIDDLEWARES: ALL_MIDDLEWARES,
            MIDDLEWARE_LABELS: MIDDLEWARE_LABELS,
            renderMarkdown: renderMarkdown,
            previewSrc: previewSrc,
            previewVisible: previewVisible,
            store: store,
            skills: skills,
            activeSkillId: activeSkillId,
            handleSkillChange: handleSkillChange,
            searchProgressLabel: searchProgressLabel,
            inputQuestion: inputQuestion,
            chatBodyRef: chatBodyRef,
            sidebarState: sidebarState,
            setSidebarState: setSidebarState,
            toggleSidebar: toggleSidebar,
            activeMode: activeMode,
            toolbarTools: toolbarTools,
            outputMode: outputMode,
            outputModeOptions: outputModeOptions,
            handleOutputModeChange: handleOutputModeChange,
            handleToggleOutputMode: handleToggleOutputMode,
            outputModesTooltip: outputModesTooltip,
            handleToggleMiddleware: handleToggleMiddleware,
            middlewaresTooltip: middlewaresTooltip,
            handleSelectMode: handleSelectMode,
            videoDialogVisible: videoDialogVisible,
            videoPrompt: videoPrompt,
            videoStatus: videoStatus,
            videoProgress: videoProgress,
            videoUrl: videoUrl,
            videoError: videoError,
            submitVideoTask: submitVideoTask,
            closeVideoDialog: closeVideoDialog,
            resetVideoDialog: resetVideoDialog,
            pendingAttachmentIds: pendingAttachmentIds,
            handleAddAttachment: handleAddAttachment,
            handleRemoveAttachment: handleRemoveAttachment,
            normalizeRefs: normalizeRefs,
            handleStop: handleStop,
            handleSubmit: handleSubmit,
            handleKeydown: handleKeydown,
            handleNewSession: handleNewSession,
            handleSelectConversation: handleSelectConversation,
            archiveMessage: archiveMessage,
            handleRegenerate: handleRegenerate,
            handleRemoveMessage: handleRemoveMessage,
            advancedOpen: advancedOpen,
            advancedPanelRef: advancedPanelRef,
            outputModesOpen: outputModesOpen,
            middlewaresOpen: middlewaresOpen,
            toggleOutputModes: toggleOutputModes,
            toggleMiddlewares: toggleMiddlewares,
            multiSelectPopperStyle: multiSelectPopperStyle,
            multiSelectListStyle: multiSelectListStyle,
            handleToggleAdvanced: handleToggleAdvanced,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */

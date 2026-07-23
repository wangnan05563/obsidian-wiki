<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { Promotion, Loading } from '@element-plus/icons-vue';
import ConversationSidebar from '../components/ConversationSidebar.vue';
import AttachmentUploader from '../components/AttachmentUploader.vue';
import InputToolbar from '../components/InputToolbar.vue';
import ThinkingBlock from '../components/ThinkingBlock.vue';
import ModelSelector from '../components/ModelSelector.vue';
import RefsList from '../components/RefsList.vue';
import MessageToolbar from '../components/MessageToolbar.vue';
import { useQueryStore } from '../stores/query';
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
const conversationsStore = useConversationsStore();
const modelStore = useModelStore();
const attachmentsStore = useAttachmentsStore();

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

// F-3.11 三态侧栏：expanded(280px) / collapsed(60px,仅图标) / hidden(0,仅浮动展开按钮)
// 为什么用字符串而非 boolean：三态无法用 true/false 表达，字符串可读性更好
// 状态持久化到 localStorage，刷新后保留
type SidebarState = 'expanded' | 'collapsed' | 'hidden';
const sidebarState = ref<SidebarState>(
  (localStorage.getItem(STORAGE_KEYS.SIDEBAR_STATE) as SidebarState) || 'expanded'
);
function setSidebarState(state: SidebarState) {
  sidebarState.value = state;
  localStorage.setItem(STORAGE_KEYS.SIDEBAR_STATE, state);
}
// 三态循环：expanded → collapsed → hidden → expanded
// 拆分嵌套三元为 if/else，避免 S3358 警告并提升可读性
function toggleSidebar() {
  let next: SidebarState;
  if (sidebarState.value === 'expanded') {
    next = 'collapsed';
  } else if (sidebarState.value === 'collapsed') {
    next = 'hidden';
  } else {
    next = 'expanded';
  }
  setSidebarState(next);
}
// F-3.11 Ctrl+B 快捷键：全局监听，三态循环切换
// 为什么用 keydown 而非 keystroke：Ctrl+B 是浏览器默认"加粗"快捷键，需 preventDefault 屏蔽
function handleGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
    e.preventDefault();
    toggleSidebar();
  }
}

// F-3.4 工具栏模式（SRS F-3.4 工具清单）
// v2.0.0 范围：
//   - fast/write/translate：mode 字段传递，后端按需处理
//   - ppt/image/video：v2.0.0 仅 UI 标记 + mode 字段传递，实际生成留 v3（disabled 灰显）
//   - more：点击展开 secondaryTools 下拉
//   - web/deep：放入"更多"下拉层（保留现有 SSE 处理逻辑：web→webSearch, deep→mode）
const activeMode = ref('');
const moreOpen = ref(false);
const toolbarTools = [
  { key: 'fast', label: '快速' },
  { key: 'write', label: '帮我写作' },
  {
    key: 'ppt',
    label: 'PPT 生成',
    disabled: true,
    disabledReason: 'v3 待实现（v2.0.0 仅做标记）',
  },
  {
    key: 'image',
    label: '图像生成',
    disabled: true,
    disabledReason: 'v3 待实现（v2.0.0 仅做标记）',
  },
  {
    key: 'video',
    label: '视频生成',
    disabled: true,
    disabledReason: 'v3 待实现（v2.0.0 仅做标记）',
  },
  { key: 'translate', label: '翻译' },
  { key: 'more', label: '更多' },
];
const secondaryTools = [
  { key: 'web', label: '联网搜索' },
  { key: 'deep', label: '深度思考' },
];
// 点击同一工具切换为关闭；点击不同工具切换为该模式；点击"更多"切换下拉
function handleSelectMode(mode: string) {
  if (mode === 'more') {
    moreOpen.value = !moreOpen.value;
    return;
  }
  activeMode.value = activeMode.value === mode ? '' : mode;
  // 选择主工具后自动关闭"更多"下拉，避免视觉遮挡
  moreOpen.value = false;
}
function handleToggleMore() {
  moreOpen.value = !moreOpen.value;
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
  const history = store.messages.map((m) => ({ role: m.role, content: m.content }));

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

  try {
    const response = await fetch('/api/query', {
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
    await consumeQuerySSE(response, store, abortController.signal);
    // 持久化对话到 IndexedDB（支持侧栏历史列表）
    await conversationsStore.persistConversation(store.messages);
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') return;
    const msg = (err as Error).message;
    store.handleError(msg);
    ElMessage.warning(apiErrorMessage('问答失败', err));
  } finally {
    abortController = null;
  }
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
  try {
    const res = await fetch('/api/query/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: msg.sessionId, messageIndex: msg.messageIndex }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    ElMessage.success(`已归档到 ${data.path}`);
    store.markArchived(idx);
  } catch (err) {
    console.error('归档失败:', err);
    ElMessage.warning('归档失败，请检查后端服务。');
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

onMounted(async () => {
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
});

onBeforeUnmount(() => {
  abortController?.abort();
  // F-3.2 / F-3.7 / F-3.8 卸载事件委托，避免内存泄漏
  chatBodyRef.value?.removeEventListener('click', handleImgClick);
  chatBodyRef.value?.removeEventListener('click', handleCodeCopyClick);
  chatBodyRef.value?.removeEventListener('click', handleRefAnchorClick);
  // F-3.11 卸载 Ctrl+B 监听
  globalThis.removeEventListener('keydown', handleGlobalKeydown);
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
    >☰</button>
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
      <div class="msg-bubble" :class="msg.role">
              <ThinkingBlock v-if="msg.thinking && msg.thinking.length > 0" :steps="msg.thinking" />
              <div class="msg-content markdown-body" v-html="renderMarkdown(msg.content)"></div>
              <!-- F-3.7 / F-3.13 浮窗工具栏：hover assistant 气泡时淡入，提供复制 / 重新生成 / 反馈 -->
              <MessageToolbar
                v-if="msg.role === 'assistant'"
                :content="msg.content"
                :msg-id="msg.id"
                :can-regenerate="!store.isLoading"
                @regenerate="handleRegenerate(idx)"
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
        <!-- 按钮行：左侧附件+联网+深度思考，右侧模型选择+发送，全部同行紧凑布局 -->
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
              :secondary-tools="secondaryTools"
              :active-mode="activeMode"
              :icon-only="true"
              :more-open="moreOpen"
              @select="handleSelectMode"
              @toggle-more="handleToggleMore"
            />
          </div>
          <!-- 模型选择下拉条：紧贴发送按钮左侧，与工具栏同行，避免占据独立行放大输入区视野 -->
          <div class="right-buttons">
            <ModelSelector />
            <el-button
              type="primary"
              size="large"
              :disabled="!inputQuestion.trim() || store.isLoading"
              :title="store.isLoading ? '回答中' : '发送'"
              @click="handleSubmit"
            >
              <el-icon v-if="store.isLoading" class="spin-icon"><Loading /></el-icon>
              <el-icon v-else><Promotion /></el-icon>
            </el-button>
          </div>
        </div>
      </div>
    </div>
    <!-- F-3.2 图片点击放大预览：通过事件委托捕获 v-html 中的 img 点击触发 -->
    <el-image-viewer
      v-if="previewVisible"
      :url-list="[previewSrc]"
      @close="previewVisible = false"
    />
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
  border: 1px solid rgba(0, 245, 255, 0.3);
  background: rgba(0, 245, 255, 0.1);
  color: var(--neon-cyan, #00f5ff);
  cursor: pointer;
  font-size: 16px;
  backdrop-filter: var(--blur);
  transition: all 0.2s ease;
}
.sidebar-show-btn:hover {
  background: rgba(0, 245, 255, 0.2);
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
  background: rgba(176, 38, 255, 0.08);
  border: 1px solid rgba(176, 38, 255, 0.3);
  border-radius: var(--radius-pill);
  font-size: 13px;
  color: var(--text-base);
  cursor: pointer;
  transition: all 0.3s ease;
  font-family: var(--font-body);
}

.suggestion-chip:hover {
  background: rgba(176, 38, 255, 0.18);
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

/* 消息气泡：不对称圆角 + 渐变；紧凑 padding 减少行间留白，让同屏看到更多内容 */
.msg-bubble {
  max-width: 75%;
  padding: 10px 14px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-base);
  position: relative;
}

.msg-bubble.assistant {
  background: rgba(0, 245, 255, 0.06);
  border: 1px solid rgba(0, 245, 255, 0.25);
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
  /* 文字颜色随主题切换：深色主题下 --text-bright 为浅紫近白，浅色主题（macaron）下为深紫
     避免 macaron 主题下浅粉背景 + 白色文字导致看不清的问题 */
  color: var(--text-bright);
  box-shadow: 0 4px 20px rgba(255, 0, 110, 0.3);
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
  background: rgba(0, 245, 255, 0.08);
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
  border-top: 1px dashed rgba(176, 38, 255, 0.2);
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
  scrollbar-color: rgba(0, 245, 255, 0.3) transparent;
  /* 隐藏横向滚动条视觉，保持纯净 */
  -ms-overflow-style: none;
}
.followups-track::-webkit-scrollbar {
  height: 4px;
}
.followups-track::-webkit-scrollbar-thumb {
  background: rgba(0, 245, 255, 0.3);
  border-radius: 2px;
}

/* F-3.12 chip：nowrap 保证 chip 内文字不换行，track 才能横向滚动 */
.followup-chip {
  position: relative;
  flex-shrink: 0;
  white-space: nowrap;
  padding: 4px 12px;
  background: rgba(0, 245, 255, 0.08);
  border: 1px solid rgba(0, 245, 255, 0.25);
  border-radius: var(--radius-pill);
  font-size: 11px;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
  cursor: pointer;
  transition: all 0.25s;
}

.followup-chip:hover {
  background: rgba(0, 245, 255, 0.18);
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
  background: rgba(0, 0, 0, 0.75);
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

/* 输入区：输入框与按钮行紧凑布局，缩小垂直间距让问答框显示更多内容 */
.input-area {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: relative;
  z-index: 1;
}

/* 让 textarea 内部行高与字号紧凑，避免文字下方出现空行
   el-textarea 默认 min-height: 33px 会撑出空行；强制 min-height: 0 让高度由 rows/autosize 决定 */
.input-area :deep(.el-textarea) {
  --el-textarea-min-height: 0;
}
.input-area :deep(.el-textarea__inner) {
  padding: 6px 12px;
  line-height: 1.5;
  min-height: 0 !important;
  box-shadow: none;
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

/* 发送按钮图标化样式 */
.button-bar .el-button.is-large {
  padding: 10px 14px;
  border-radius: 10px;
}

.spin-icon {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* F-3.1 流式输出态：气泡脉动光晕，首字节后激活，让用户感知"正在生成" */
@keyframes neon-pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(0, 245, 255, 0);
    border-color: rgba(0, 245, 255, 0.25);
  }
  50% {
    box-shadow: 0 0 20px 2px rgba(0, 245, 255, 0.35);
    border-color: rgba(0, 245, 255, 0.6);
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
  background: rgba(0, 245, 255, 0.12);
  border: 1px solid rgba(0, 245, 255, 0.3);
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

/* F-3.7 浮窗工具栏触发：hover 父气泡时显现
   为什么放 Query.vue：scoped 隔离下父元素 hover 只能在父作用域定义 */
.msg-bubble.assistant:hover .msg-toolbar {
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
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(0, 245, 255, 0.2);
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
  border-color: rgba(0, 245, 255, 0.5);
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
  border: 1px solid rgba(0, 245, 255, 0.2);
  background: rgba(0, 0, 0, 0.2);
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
</style>

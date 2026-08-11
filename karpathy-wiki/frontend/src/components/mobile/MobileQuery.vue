<script setup lang="ts">
// 移动端知识问答页（SRS FR-QRY，v2 多会话优化）：
// - 双模式：列表模式（历史会话，首屏有历史时进入）/ 聊天模式（首屏无历史直接进入，展示招呼语）
// - 历史会话：置顶排序、长按弹出操作菜单（置顶/取消置顶 · 重命名 · 删除）、右下 FAB 新建会话
// - 输入栏：语音输入（Web Speech API）+ 模型切换（useModelStore 预设）+ 发送/停止
// - 会话切换安全：仅"浏览列表"不打断后台生成；主动打开并发送另一会话时优雅中止上一会话流，避免串台
// 复用链路：useQueryStore / useConversationsStore（状态与会话持久化，ownerId 多账户隔离）
//          consumeQuerySSE + apiFetch + API_BASE（流式消费与鉴权注入）
//          useChatAutoScroll / ThinkingBlock / RefsList / FollowupsChips（与桌面端一致）
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { ElMessageBox, ElMessage } from 'element-plus';
import {
  Mic,
  Plus,
  MoreFilled,
  Top,
  Edit,
  Delete,
  ChatLineRound,
  Loading,
} from '@element-plus/icons-vue';
import { API_BASE, apiFetch } from '../../utils/apiBase';
import { renderMarkdown } from '../../utils/markdown';
import { consumeQuerySSE } from '../../utils/sse';
import { useQueryStore, DEFAULT_ACTIVE } from '../../stores/query';
import { useConversationsStore, getLastActiveConversationId } from '../../stores/conversations';
import { useModelStore } from '../../stores/model';
import { useChatAutoScroll } from '../../composables/useChatAutoScroll';
import { useSpeechRecognition } from '../../composables/useSpeechRecognition';
import ThinkingBlock from '../ThinkingBlock.vue';
import RefsList from '../RefsList.vue';
import FollowupsChips from '../FollowupsChips.vue';
import type { ChatMessage, Reference } from '../../types';

const store = useQueryStore();
const conversationsStore = useConversationsStore();
const modelStore = useModelStore();
const inputQuestion = ref('');
const chatBodyRef = ref<HTMLDivElement | null>(null);
// 当前"激活"会话（其消息驻留 store 扁平缓冲，SSE 写入目标）；切到别的会话会优雅中止其后台流
const activeId = ref<string | null>(null);

// 模式：list=历史会话列表（有历史首屏进入）；chat=问答聊天
const mode = ref<'list' | 'chat'>('chat');
const hasHistory = computed(() => conversationsStore.conversations.length > 0);

// 长按操作菜单（置顶/取消置顶 · 重命名 · 删除）
const actionSheet = reactive<{ open: boolean; id: string | null; pinned: boolean }>({
  open: false,
  id: null,
  pinned: false,
});
// 模型切换底部面板
const modelSheet = ref(false);

// ===== 计算属性 =====
const hasMessages = computed(() => store.messages.length > 0);
const canSend = computed(() => !!inputQuestion.value.trim() && !store.isLoading);
// 是否有任意会话正在生成（驱动头部历史图标动画）
const isStreaming = computed(() => store.anySessionStreaming);

// 历史会话：置顶优先，其次按更新时间倒序
const sortedConversations = computed(() =>
  [...conversationsStore.conversations].sort((a, b) => {
    if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  }),
);

// 当前会话标题（用于聊天头部）
const currentTitle = computed(() => {
  const id = activeId.value;
  const rec = id ? conversationsStore.conversations.find((c) => c.id === id) : undefined;
  return rec?.title || '新知识问答';
});

// 招呼语（空态展示）
const greeting = '你好，我是知识库助手。向知识库提问，随时获取流式回答与引用来源。';
const suggestions = [
  'Karpathy 怎么看 LLM 训练？',
  '什么是 Software 2.0？',
  '如何入门深度学习？',
];

// 统一 msg.refs 为 Reference[]，兼容 v1 string[] 与 v2 Reference[]
function normalizeRefs(refs: ChatMessage['refs']): Reference[] {
  if (!refs || refs.length === 0) return [];
  if (typeof refs[0] === 'string') {
    return (refs as string[]).map((path, i) => ({
      path,
      title: (path.split('/').pop() || path).replace(/\.md$/, ''),
      snippet: '',
      source: 'vault' as const,
      citeIndex: i + 1,
    }));
  }
  return refs as Reference[];
}

function formatTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 自动贴底滚动（流式输出场景）
const { scrollToBottom } = useChatAutoScroll(chatBodyRef, () => store.isLoading);
watch(() => store.messages.length, () => scrollToBottom(true));
watch(
  () => [store.streamingAnswer, store.currentThinking.length] as const,
  () => scrollToBottom(),
);

// ===== 语音输入 =====
const speech = useSpeechRecognition({
  onFinal: (text) => {
    const t = text.trim();
    if (t) inputQuestion.value = (inputQuestion.value ? inputQuestion.value + ' ' : '') + t;
  },
  onError: (msg) => {
    store.setErrorMessage(`语音输入失败：${msg}`);
  },
});
function toggleVoice() {
  if (speech.listening.value) speech.stop();
  else speech.start();
}

// ===== 会话切换（并行流式）=====
// 每个会话拥有独立缓冲（store.sessions）；切换仅改变 activeId，后台流继续写入各自缓冲。
// 真正并行：A 在后台流式时打开 B，A 的 SSE writer 按 conversationId 路由到 sessions[A]，
// 不被打断；回到 A 时 writer 动态地改写 active 缓冲，无缝衔接。
let activeAbort: AbortController | null = null;

// 确保当前有真实会话 id（新建首问前若尚未落到某会话，则开一个）
function ensureSessionId(): string {
  if (store.activeId && store.activeId !== DEFAULT_ACTIVE) {
    activeId.value = store.activeId;
    return store.activeId;
  }
  const newId = crypto.randomUUID();
  conversationsStore.currentConversationId = newId;
  store.swapSession(newId);
  activeId.value = newId;
  return newId;
}

// 离开当前会话前：把该会话缓冲（含流式中间态）落盘，避免后台进度丢失
function persistActiveIfAny() {
  const id = store.activeId;
  if (!id || id === DEFAULT_ACTIVE) return;
  const buf = store.getSessionBuffer(id);
  if (buf && buf.messages.length > 0) {
    conversationsStore.currentConversationId = id;
    void conversationsStore.persistConversation(
      store.messagesWithStreamingFor(id),
      buf.currentThreadId ?? undefined,
    );
  }
}

function openConversation(id: string) {
  if (id === store.activeId) {
    mode.value = 'chat';
    return;
  }
  // 先落盘即将离开的会话（其缓冲可能仍在流式）
  persistActiveIfAny();
  const rec = conversationsStore.conversations.find((c) => c.id === id) ?? null;
  const buf = store.getSessionBuffer(id);
  if (buf && buf.isLoading) {
    // 该会话正在后台流式：保留实时进度，仅切换激活缓冲
    store.swapSession(id);
  } else {
    // 非流式：载入持久化消息并恢复线程隔离键
    store.swapSession(id, { messages: rec ? rec.messages : [], threadId: rec?.threadId ?? null });
  }
  conversationsStore.currentConversationId = id;
  activeId.value = id;
  mode.value = 'chat';
  // 切换后贴底（若有历史）
  requestAnimationFrame(() => scrollToBottom(true));
}

function newSession() {
  persistActiveIfAny();
  // 中止当前激活会话的后台流（其进度已落盘，安全）
  if (activeAbort && store.isLoading) {
    activeAbort.abort();
    activeAbort = null;
  }
  const newId = crypto.randomUUID();
  conversationsStore.currentConversationId = newId;
  store.swapSession(newId);
  activeId.value = newId;
  mode.value = 'chat';
  inputQuestion.value = '';
}

function goList() {
  // 仅浏览列表，不打断任何后台生成（active 缓冲的后台流继续演进）
  mode.value = 'list';
}

// ===== 长按菜单 =====
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressed = false;
function pressStart(id: string, pinned: boolean) {
  longPressed = false;
  if (pressTimer) clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    longPressed = true;
    actionSheet.id = id;
    actionSheet.pinned = pinned;
    actionSheet.open = true;
  }, 500);
}
function pressEnd() {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}
function onConvClick(id: string) {
  // 长按已触发菜单则不重复打开
  if (longPressed) {
    longPressed = false;
    return;
  }
  openConversation(id);
}
function closeActionSheet() {
  actionSheet.open = false;
  actionSheet.id = null;
}
async function doPin() {
  const id = actionSheet.id;
  if (id) await conversationsStore.togglePin(id);
  closeActionSheet();
}
async function doRename() {
  const id = actionSheet.id;
  closeActionSheet();
  if (!id) return;
  const rec = conversationsStore.conversations.find((c) => c.id === id);
  try {
    const { value } = await ElMessageBox.prompt('请输入新的会话名称', '重命名会话', {
      inputValue: rec?.title ?? '',
      inputPlaceholder: '会话名称',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    });
    const name = (value || '').trim();
    if (name) await conversationsStore.renameConversation(id, name);
  } catch {
    /* 用户取消 */
  }
}
async function doDelete() {
  const id = actionSheet.id;
  closeActionSheet();
  if (!id) return;
  try {
    await ElMessageBox.confirm('删除后不可恢复，确定删除该会话？', '删除会话', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    await conversationsStore.deleteConversation(id);
    // 删除对应会话缓冲（若删除的是当前激活会话，store 自动回落默认空缓冲）
    store.removeSession(id);
    if (activeId.value === id) {
      activeId.value = null;
    }
  } catch {
    /* 用户取消 */
  }
}

// ===== 模型切换 =====
function pickModel(key: string) {
  void modelStore.switchModel(key);
  modelSheet.value = false;
}

// ===== 发送 / 流式 =====
function handleSubmit() {
  const q = inputQuestion.value.trim();
  if (!q || store.isLoading) return;
  // 确保当前展示的会话即激活会话，并取得其会话 id（用于并行流式路由）
  const convId = ensureSessionId();
  store.submitQuestion(q);
  conversationsStore.currentConversationId = convId;
  void conversationsStore.persistConversation(
    store.messagesWithStreamingFor(convId),
    store.getSessionBuffer(convId)?.currentThreadId ?? undefined,
  );
  inputQuestion.value = '';
  void sendQuestion(q, convId);
}

function onFollowup(question: string) {
  if (store.isLoading) return;
  inputQuestion.value = question;
  handleSubmit();
}

async function sendQuestion(question: string, convId: string) {
  activeAbort = new AbortController();
  // 读取该会话缓冲的线程隔离键 / 历史，而非全局状态
  const buf = store.getSessionBuffer(convId);
  const activeThreadId = buf?.currentThreadId ?? null;
  const history = activeThreadId
    ? undefined
    : (buf?.messages ?? []).map((m) => ({ role: m.role, content: m.content }));

  const body: Record<string, unknown> = { question, stream: store.streamMode };
  if (activeThreadId) {
    body.threadId = activeThreadId;
  } else if (history && history.length > 0) {
    body.history = history;
  }

  try {
    const response = await apiFetch(`${API_BASE}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: activeAbort.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    // 按 conversationId 路由 SSE 写入：切走后写 sessions[convId]，切回后自动写 active 缓冲
    await consumeQuerySSE(response, store.getSessionWriter(convId), activeAbort.signal);
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') return;
    // 错误写入目标会话缓冲（可能非 active）
    store.getSessionWriter(convId).handleError((err as Error).message);
    ElMessage.warning((err as Error).message);
  } finally {
    if (!activeAbort?.signal.aborted) {
      conversationsStore.currentConversationId = convId;
      void conversationsStore.persistConversation(
        store.messagesWithStreamingFor(convId),
        store.getSessionBuffer(convId)?.currentThreadId ?? undefined,
      );
    }
    activeAbort = null;
  }
}

function handleStop() {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

// 新建会话：清空本地会话作用域
function handleNewSession() {
  newSession();
}

// FR-RM-09 断点续答：针对指定会话缓冲续答
function resumeLastAnswer(convId: string) {
  const buf = store.getSessionBuffer(convId);
  if (!buf) return;
  const msgs = buf.messages;
  if (!msgs.length) return;
  const last = msgs[msgs.length - 1];
  if (last.role === 'assistant' && last.status === 'streaming') {
    // 移除流式占位（active 缓冲即该会话，故 removeMessage 作用正确）
    store.removeMessage(msgs.length - 1);
  }
  let question: string | undefined;
  for (let i = buf.messages.length - 1; i >= 0; i--) {
    if (buf.messages[i].role === 'user') {
      question = buf.messages[i].content;
      break;
    }
  }
  if (!question) return;
  void sendQuestion(question, convId);
}

async function maybeResumeOnLoad() {
  if (store.anySessionStreaming) return;
  const lastId = getLastActiveConversationId();
  if (!lastId) return;
  const rec = conversationsStore.conversations.find((c) => c.id === lastId);
  if (!rec) return;
  // 载入到以 lastId 为键的会话缓冲（含线程隔离键），而非默认 active
  store.swapSession(lastId, { messages: rec.messages, threadId: rec.threadId });
  conversationsStore.currentConversationId = lastId;
  activeId.value = lastId;
  const buf = store.getSessionBuffer(lastId);
  const msgs = buf?.messages ?? [];
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'assistant' && last.status === 'streaming') {
    resumeLastAnswer(lastId);
  }
}

onMounted(async () => {
  try {
    await conversationsStore.loadConversations();
  } catch {
    /* IndexedDB 不可用时静默降级 */
  }
  try {
    await modelStore.loadPresets();
  } catch {
    /* 模型列表不可用时静默降级 */
  }
  // 有历史首屏进列表，无历史直接进聊天（含招呼语）
  mode.value = hasHistory.value ? 'list' : 'chat';
  try {
    await maybeResumeOnLoad();
  } catch {
    /* 续答失败不阻断首屏 */
  }
});

onBeforeUnmount(() => {
  if (pressTimer) clearTimeout(pressTimer);
  speech.stop();
  activeAbort = null;
});
</script>

<template>
  <div class="mq-root">
    <!-- 顶部标题栏 -->
    <header class="mq-header">
      <button
        v-if="mode === 'chat' && hasHistory"
        class="mq-hist-btn"
        :class="{ spinning: isStreaming }"
        title="历史会话"
        @click="goList"
      >
        <el-icon v-if="isStreaming"><Loading /></el-icon>
        <el-icon v-else><ChatLineRound /></el-icon>
      </button>
      <span class="mq-title">{{ mode === 'list' ? '历史会话' : currentTitle }}</span>
      <button v-if="mode === 'chat'" class="mq-new-btn" title="新会话" @click="handleNewSession">
        <el-icon><Plus /></el-icon>
      </button>
    </header>

    <!-- 列表模式：历史会话 -->
    <div v-if="mode === 'list'" class="mq-listview">
      <div class="mq-list-empty" v-if="!hasHistory">
        <el-icon class="mq-list-empty-icon"><ChatLineRound /></el-icon>
        <p>还没有会话，点击右下角按钮开始提问</p>
      </div>
      <div
        v-for="c in sortedConversations"
        :key="c.id"
        class="mq-conv-item"
        :class="{ pinned: c.isPinned }"
        @click="onConvClick(c.id)"
        @pointerdown="pressStart(c.id, !!c.isPinned)"
        @pointerup="pressEnd"
        @pointerleave="pressEnd"
        @pointercancel="pressEnd"
      >
        <div class="mq-conv-main">
          <div class="mq-conv-title">
            <el-icon v-if="c.isPinned" class="mq-pin"><Top /></el-icon>
            <span class="mq-conv-name">{{ c.title || '未命名会话' }}</span>
          </div>
          <div class="mq-conv-preview">{{ c.preview || '（暂无内容）' }}</div>
        </div>
        <div class="mq-conv-meta">
          <span class="mq-conv-time">{{ formatTime(c.updatedAt) }}</span>
          <el-icon v-if="store.isSessionStreaming(c.id)" class="mq-conv-spin"><Loading /></el-icon>
        </div>
      </div>
      <!-- 右下 FAB 新建会话 -->
      <button class="mq-fab" title="新建会话" @click="newSession">
        <el-icon><Plus /></el-icon>
      </button>
    </div>

    <!-- 聊天模式 -->
    <div v-else class="mq-chat">
      <div ref="chatBodyRef" class="mq-messages">
        <!-- 空态：招呼语 + 建议问题 -->
        <div v-if="!hasMessages" class="mq-empty">
          <div class="mq-empty-robot">🤖</div>
          <p class="mq-empty-greeting">{{ greeting }}</p>
          <div class="mq-suggestions">
            <button v-for="s in suggestions" :key="s" class="mq-suggestion" @click="onFollowup(s)">
              {{ s }}
            </button>
          </div>
        </div>

        <div v-else class="mq-list">
          <div v-for="(msg, idx) in store.messages" :key="msg.id || idx" class="mq-row" :class="msg.role">
            <div class="mq-bubble" :class="msg.role">
              <ThinkingBlock v-if="msg.thinking && msg.thinking.length > 0" :steps="msg.thinking" />
              <div class="markdown-body mq-md" v-html="renderMarkdown(msg.content)"></div>
              <FollowupsChips
                v-if="msg.followups && msg.followups.length > 0"
                :followups="msg.followups"
                @click="onFollowup"
              />
              <RefsList v-if="normalizeRefs(msg.refs).length > 0" :refs="normalizeRefs(msg.refs)" />
              <div v-if="msg.createdAt" class="mq-time">{{ formatTime(msg.createdAt) }}</div>
            </div>
          </div>

          <!-- 流式输出中的 assistant 消息 -->
          <div v-if="store.isLoading || store.streamingAnswer" class="mq-row assistant">
            <div class="mq-bubble assistant" :class="{ streaming: !!store.streamingAnswer }">
              <ThinkingBlock
                v-if="store.currentThinking.length > 0"
                :steps="store.currentThinking"
                :live="store.isLoading"
              />
              <div v-if="store.isLoading && !store.streamingAnswer && store.currentThinking.length === 0" class="mq-dots">
                <span class="dot"></span><span class="dot"></span><span class="dot"></span>
                <span class="mq-dots-text">正在思考…</span>
              </div>
              <div
                v-else
                class="markdown-body mq-md streaming-content"
                v-html="renderMarkdown(store.streamingAnswer || '')"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 错误条 -->
      <div v-if="store.errorMessage" class="mq-error">{{ store.errorMessage }}</div>

      <!-- 输入栏 -->
      <div class="mq-inputbar">
        <button
          class="mq-mic"
          :class="{ listening: speech.listening.value }"
          title="语音输入"
          :disabled="!speech.supported.value"
          @click="toggleVoice"
        >
          <el-icon><Mic /></el-icon>
        </button>
        <textarea
          v-model="inputQuestion"
          class="mq-input"
          rows="1"
          :placeholder="speech.listening.value ? '正在聆听…' : '输入你的问题…'"
          :disabled="store.isLoading"
          @keydown.enter.exact.prevent="handleSubmit"
        ></textarea>
        <button class="mq-model" title="切换模型" @click="modelSheet = true">
          <span class="mq-model-label">{{ modelStore.currentModel || '模型' }}</span>
        </button>
        <button
          v-if="store.isLoading"
          class="mq-send mq-stop"
          @click="handleStop"
          title="停止生成"
        >停止</button>
        <button v-else class="mq-send" :disabled="!canSend" @click="handleSubmit" title="发送">发送</button>
      </div>
    </div>

    <!-- 长按操作菜单（底部动作面板）-->
    <transition name="mq-sheet">
      <div v-if="actionSheet.open" class="mq-sheet-mask" @click.self="closeActionSheet">
        <div class="mq-sheet">
          <button class="mq-sheet-item" @click="doPin">
            <el-icon><Top v-if="actionSheet.pinned" /><Top v-else /></el-icon>
            {{ actionSheet.pinned ? '取消置顶' : '置顶' }}
          </button>
          <button class="mq-sheet-item" @click="doRename">
            <el-icon><Edit /></el-icon>重命名
          </button>
          <button class="mq-sheet-item danger" @click="doDelete">
            <el-icon><Delete /></el-icon>删除
          </button>
          <button class="mq-sheet-item cancel" @click="closeActionSheet">取消</button>
        </div>
      </div>
    </transition>

    <!-- 模型切换面板 -->
    <transition name="mq-sheet">
      <div v-if="modelSheet" class="mq-sheet-mask" @click.self="modelSheet = false">
        <div class="mq-sheet">
          <div class="mq-sheet-title">切换模型</div>
          <button
            v-for="p in modelStore.presets"
            :key="p.key"
            class="mq-sheet-item"
            :class="{ active: p.key === modelStore.selectedPresetKey }"
            @click="pickModel(p.key)"
          >
            {{ p.label || p.model }}
            <span class="mq-sheet-sub">{{ p.model }}</span>
          </button>
          <button class="mq-sheet-item cancel" @click="modelSheet = false">取消</button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.mq-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 顶部标题栏 */
.mq-header {
  flex-shrink: 0;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  padding-top: env(safe-area-inset-top, 0);
  background: rgba(5, 0, 16, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--accent-purple-a30);
  position: relative;
  z-index: 5;
}
.mq-title {
  flex: 1;
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 1px;
  background: var(--grad-aurora);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mq-hist-btn,
.mq-new-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  color: var(--text-bright);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  border-radius: 10px;
}
.mq-hist-btn:active,
.mq-new-btn:active {
  background: rgba(168, 85, 247, 0.18);
}
.mq-hist-btn.spinning :deep(svg) {
  animation: mq-spin 1s linear infinite;
  color: var(--neon-cyan);
}
@keyframes mq-spin {
  to { transform: rotate(360deg); }
}

/* 列表模式 */
.mq-listview {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px 12px 80px;
  position: relative;
}
.mq-list-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-soft);
  text-align: center;
  padding: 24px;
}
.mq-list-empty-icon {
  font-size: 40px;
  opacity: 0.6;
}
.mq-conv-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  margin-bottom: 10px;
  background: rgba(20, 12, 40, 0.7);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 14px;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
  user-select: none;
  -webkit-user-select: none;
  touch-action: manipulation;
}
.mq-conv-item:active {
  background: rgba(168, 85, 247, 0.16);
}
.mq-conv-item.pinned {
  border-color: rgba(0, 245, 255, 0.4);
}
.mq-conv-main {
  flex: 1;
  min-width: 0;
}
.mq-conv-title {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mq-pin {
  color: var(--neon-cyan);
  font-size: 14px;
}
.mq-conv-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mq-conv-preview {
  margin-top: 4px;
  font-size: 12.5px;
  color: var(--text-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mq-conv-meta {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.mq-conv-time {
  font-size: 11px;
  color: var(--text-soft);
  opacity: 0.8;
}
.mq-conv-spin {
  color: var(--neon-cyan);
  animation: mq-spin 1s linear infinite;
}

/* FAB 新建会话 */
.mq-fab {
  position: absolute;
  right: 18px;
  bottom: 22px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  background: var(--grad-aurora, linear-gradient(135deg, #00f5ff, #a855f7));
  color: #0a0214;
  font-size: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(0, 245, 255, 0.35);
  transition: transform 0.15s ease;
}
.mq-fab:active {
  transform: scale(0.92);
}

/* 聊天模式 */
.mq-chat {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.mq-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px 12px 8px;
}
.mq-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
}
.mq-empty-robot {
  font-size: 44px;
  filter: drop-shadow(0 0 10px rgba(0, 245, 255, 0.4));
}
.mq-empty-greeting {
  color: var(--text-soft, #9aa0b4);
  font-size: 14px;
  margin: 0;
  line-height: 1.6;
}
.mq-suggestions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 320px;
  margin-top: 4px;
}
.mq-suggestion {
  border: 1px solid var(--accent-purple-a30, rgba(168, 85, 247, 0.3));
  background: rgba(168, 85, 247, 0.08);
  color: var(--text-bright, #e8e9f3);
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
  transition: all 0.2s ease;
}
.mq-suggestion:active {
  transform: scale(0.98);
  border-color: var(--neon-cyan, #00f5ff);
}

.mq-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.mq-row {
  display: flex;
  justify-content: flex-start;
}
.mq-row.user {
  justify-content: flex-end;
}
.mq-bubble {
  max-width: 86%;
  padding: 10px 13px;
  border-radius: 16px;
  font-size: 15px;
  line-height: 1.6;
  word-break: break-word;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
}
.mq-bubble.assistant {
  background: rgba(20, 12, 40, 0.85);
  border: 1px solid var(--accent-purple-a30, rgba(168, 85, 247, 0.25));
  border-bottom-left-radius: 5px;
}
.mq-bubble.user {
  background: linear-gradient(135deg, rgba(0, 245, 255, 0.18), rgba(168, 85, 247, 0.28));
  border: 1px solid rgba(0, 245, 255, 0.35);
  border-bottom-right-radius: 5px;
}
.mq-md {
  font-size: 15px;
}
.mq-md :deep(pre) {
  background: rgba(0, 0, 0, 0.4);
  border-radius: 8px;
  padding: 10px;
  overflow-x: auto;
  font-size: 13px;
}
.mq-md :deep(code) {
  font-family: var(--font-mono, monospace);
  font-size: 13px;
}
.mq-md :deep(p) {
  margin: 0.4em 0;
}
.mq-md :deep(ul), .mq-md :deep(ol) {
  padding-left: 1.2em;
  margin: 0.4em 0;
}
.mq-md :deep(a) {
  color: var(--neon-cyan, #00f5ff);
}
.mq-time {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-soft, #9aa0b4);
  text-align: right;
  opacity: 0.7;
}
.mq-dots {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 2px;
}
.mq-dots .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--neon-cyan, #00f5ff);
  animation: mq-blink 1.2s infinite ease-in-out;
}
.mq-dots .dot:nth-child(2) { animation-delay: 0.2s; }
.mq-dots .dot:nth-child(3) { animation-delay: 0.4s; }
.mq-dots-text {
  font-size: 13px;
  color: var(--text-soft, #9aa0b4);
  margin-left: 4px;
}
@keyframes mq-blink {
  0%, 80%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
}

.mq-error {
  flex-shrink: 0;
  margin: 0 12px;
  padding: 8px 12px;
  background: rgba(255, 80, 80, 0.12);
  border: 1px solid rgba(255, 80, 80, 0.4);
  border-radius: 10px;
  color: #ff9a9a;
  font-size: 13px;
}

/* 输入栏 */
.mq-inputbar {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0));
  background: rgba(5, 0, 16, 0.92);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid var(--accent-purple-a30, rgba(168, 85, 247, 0.25));
}
.mq-mic,
.mq-model {
  flex-shrink: 0;
  height: 38px;
  border-radius: 10px;
  border: 1px solid var(--accent-purple-a30, rgba(168, 85, 247, 0.3));
  background: rgba(168, 85, 247, 0.12);
  color: var(--text-bright, #e8e9f3);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
}
.mq-mic {
  width: 38px;
}
.mq-mic.listening {
  border-color: var(--neon-cyan, #00f5ff);
  color: var(--neon-cyan, #00f5ff);
  animation: mq-pulse 1.2s ease-in-out infinite;
}
.mq-mic:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
@keyframes mq-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(0, 245, 255, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(0, 245, 255, 0); }
}
.mq-model {
  padding: 0 10px;
  font-size: 12.5px;
  max-width: 92px;
  overflow: hidden;
}
.mq-model-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mq-input {
  flex: 1;
  min-height: 38px;
  max-height: 110px;
  resize: none;
  border-radius: 12px;
  border: 1px solid var(--accent-purple-a30, rgba(168, 85, 247, 0.3));
  background: rgba(10, 4, 24, 0.9);
  color: var(--text-bright, #e8e9f3);
  padding: 9px 12px;
  font-size: 15px;
  font-family: var(--font-body);
  line-height: 1.45;
}
.mq-input:focus {
  outline: none;
  border-color: var(--neon-cyan, #00f5ff);
  box-shadow: 0 0 0 2px rgba(0, 245, 255, 0.18);
}
.mq-input::placeholder { color: var(--text-soft, #6b7088); }

.mq-send {
  flex-shrink: 0;
  height: 38px;
  padding: 0 16px;
  border-radius: 12px;
  border: none;
  background: var(--grad-aurora, linear-gradient(135deg, #00f5ff, #a855f7));
  color: #0a0214;
  font-weight: 800;
  font-size: 14px;
  cursor: pointer;
  transition: opacity 0.2s ease, transform 0.15s ease;
}
.mq-send:active { transform: scale(0.95); }
.mq-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mq-stop {
  background: rgba(255, 80, 80, 0.85);
  color: #fff;
}

/* 底部动作面板 */
.mq-sheet-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-end;
  z-index: 50;
}
.mq-sheet {
  width: 100%;
  background: rgba(16, 8, 32, 0.98);
  border-top-left-radius: 18px;
  border-top-right-radius: 18px;
  padding: 8px 12px calc(12px + env(safe-area-inset-bottom, 0));
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--accent-purple-a30);
}
.mq-sheet-title {
  text-align: center;
  font-size: 13px;
  color: var(--text-soft);
  padding: 6px 0 4px;
}
.mq-sheet-item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 50px;
  border: none;
  border-radius: 12px;
  background: rgba(168, 85, 247, 0.1);
  color: var(--text-bright);
  font-size: 15px;
  cursor: pointer;
}
.mq-sheet-item.active {
  background: rgba(0, 245, 255, 0.16);
  border: 1px solid rgba(0, 245, 255, 0.4);
  color: var(--neon-cyan);
}
.mq-sheet-item.danger {
  color: #ff9a9a;
  background: rgba(255, 80, 80, 0.12);
}
.mq-sheet-item.cancel {
  color: var(--text-soft);
  background: transparent;
}
.mq-sheet-sub {
  font-size: 11px;
  color: var(--text-soft);
  opacity: 0.8;
}
.mq-sheet-enter-active,
.mq-sheet-leave-active {
  transition: opacity 0.2s ease;
}
.mq-sheet-enter-from,
.mq-sheet-leave-to {
  opacity: 0;
}
.mq-sheet-enter-active .mq-sheet,
.mq-sheet-leave-active .mq-sheet {
  transition: transform 0.25s ease;
}
.mq-sheet-enter-from .mq-sheet,
.mq-sheet-leave-to .mq-sheet {
  transform: translateY(100%);
}
</style>

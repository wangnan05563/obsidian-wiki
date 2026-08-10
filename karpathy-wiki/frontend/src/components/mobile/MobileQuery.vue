<script setup lang="ts">
// 移动端知识问答页（SRS FR-QRY）：纯增量复用桌面端问答能力，不引入 Element Plus 组件。
// 复用链路：useQueryStore / useConversationsStore（状态与会话持久化）
//          consumeQuerySSE + apiFetch + API_BASE（流式消费与鉴权注入）
//          useChatAutoScroll（流式贴底滚动）
//          ThinkingBlock / RefsList / FollowupsChips（思考过程 / 引用 / 追问）
//          renderMarkdown（与桌面端一致的 Markdown 渲染，html:false 防 XSS）
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { API_BASE, apiFetch } from '../../utils/apiBase';
import { renderMarkdown } from '../../utils/markdown';
import { consumeQuerySSE } from '../../utils/sse';
import { useQueryStore } from '../../stores/query';
import { useConversationsStore, getLastActiveConversationId } from '../../stores/conversations';
import { useChatAutoScroll } from '../../composables/useChatAutoScroll';
import ThinkingBlock from '../ThinkingBlock.vue';
import RefsList from '../RefsList.vue';
import FollowupsChips from '../FollowupsChips.vue';
import type { ChatMessage, Reference } from '../../types';

const store = useQueryStore();
const conversationsStore = useConversationsStore();
const inputQuestion = ref('');
const chatBodyRef = ref<HTMLDivElement | null>(null);
let abortController: AbortController | null = null;

const hasMessages = computed(() => store.messages.length > 0);
const canSend = computed(() => !!inputQuestion.value.trim() && !store.isLoading);

// 空闲引导问题（仿 FloatingChat 空态），点击直接发送
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

// 自动贴底滚动（流式输出场景）：复用桌面端成熟逻辑
const { scrollToBottom } = useChatAutoScroll(chatBodyRef, () => store.isLoading);
// 新消息 / 流式 token 到达时贴底
watch(() => store.messages.length, () => scrollToBottom(true));
watch(
  () => [store.streamingAnswer, store.currentThinking.length] as const,
  () => scrollToBottom(),
);

// 发送一轮问答：立即落盘用户问题（FR-RM-09 刷新可恢复），再发起 SSE
function handleSubmit() {
  const q = inputQuestion.value.trim();
  if (!q || store.isLoading) return;
  store.submitQuestion(q);
  void conversationsStore.persistConversation(store.messagesWithStreaming());
  inputQuestion.value = '';
  void sendQuestion(q);
}

// 追问 chips 点击：直接作为新问题发送（移动端更顺手）
function onFollowup(question: string) {
  if (store.isLoading) return;
  inputQuestion.value = question;
  handleSubmit();
}

async function sendQuestion(question: string) {
  abortController = new AbortController();
  // 线程隔离：已有 threadId 时交给后端注入本地记忆上下文，不再重复发送 history
  const activeThreadId = store.currentThreadId;
  const history = activeThreadId
    ? undefined
    : store.messages.map((m) => ({ role: m.role, content: m.content }));

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
      signal: abortController.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    // SSE 流消费统一委托 utils/sse.ts（含 abort 时不抛 AbortError）
    await consumeQuerySSE(response, store, abortController.signal);
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') return;
    store.handleError((err as Error).message);
  } finally {
    // 完成后落盘完整答案（done 事件已 finalize 到 messages）
    if (!abortController?.signal.aborted) {
      void conversationsStore.persistConversation(store.messages);
    }
    abortController = null;
  }
}

// 停止生成：中断 SSE 流，store 在 catch 中自然 finalize（保留已收到部分答案）
function handleStop() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

// 新建会话：清空本地会话作用域，下次落盘创建全新会话
function handleNewSession() {
  store.reset();
  conversationsStore.startNewConversation();
  inputQuestion.value = '';
}

// FR-RM-09 断点续答（与 FloatingChat 一致）：重载后若上次会话末尾为 streaming 则自动续答
function resumeLastAnswer() {
  const msgs = store.messages;
  if (!msgs.length) return;
  const last = msgs[msgs.length - 1];
  if (last.role === 'assistant' && last.status === 'streaming') {
    store.removeMessage(msgs.length - 1);
  }
  let question: string | undefined;
  for (let i = store.messages.length - 1; i >= 0; i--) {
    if (store.messages[i].role === 'user') {
      question = store.messages[i].content;
      break;
    }
  }
  if (!question) return;
  void sendQuestion(question);
}

async function maybeResumeOnLoad() {
  if (store.isLoading) return;
  const lastId = getLastActiveConversationId();
  if (!lastId) return;
  const rec = conversationsStore.conversations.find((c) => c.id === lastId);
  if (!rec) return;
  await conversationsStore.selectConversation(lastId);
  const msgs = store.messages;
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'assistant' && last.status === 'streaming') {
    resumeLastAnswer();
  }
}

onMounted(async () => {
  // 加载本地会话列表（IndexedDB 多账户隔离），确保桌面端历史在移动端可见
  try {
    await conversationsStore.loadConversations();
  } catch {
    /* IndexedDB 不可用时静默降级，仅内存态 */
  }
  try {
    await maybeResumeOnLoad();
  } catch {
    /* 续答失败不阻断首屏 */
  }
});

onBeforeUnmount(() => {
  // 切 Tab 不中断后台 SSE（与 FloatingChat 一致：模块级 abortController 独立存活）
  abortController = null;
});
</script>

<template>
  <div class="mq-root">
    <!-- 消息列表区：内部滚动，输入栏常驻底部 -->
    <div ref="chatBodyRef" class="mq-messages">
      <!-- 空态：机器人引导 + 建议问题 -->
      <div v-if="!hasMessages" class="mq-empty">
        <div class="mq-empty-robot">🤖</div>
        <p class="mq-empty-hint">向知识库提问，随时获取流式回答与引用来源</p>
        <div class="mq-suggestions">
          <button
            v-for="s in suggestions"
            :key="s"
            class="mq-suggestion"
            @click="onFollowup(s)"
          >
            {{ s }}
          </button>
        </div>
      </div>

      <div v-else class="mq-list">
        <div
          v-for="(msg, idx) in store.messages"
          :key="msg.id || idx"
          class="mq-row"
          :class="msg.role"
        >
          <div class="mq-bubble" :class="msg.role">
            <ThinkingBlock
              v-if="msg.thinking && msg.thinking.length > 0"
              :steps="msg.thinking"
            />
            <div
              class="markdown-body mq-md"
              v-html="renderMarkdown(msg.content)"
            ></div>
            <FollowupsChips
              v-if="msg.followups && msg.followups.length > 0"
              :followups="msg.followups"
              @click="onFollowup"
            />
            <RefsList
              v-if="normalizeRefs(msg.refs).length > 0"
              :refs="normalizeRefs(msg.refs)"
            />
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

    <!-- 错误条（如缺 BYOK 密钥 400 / 网络异常） -->
    <div v-if="store.errorMessage" class="mq-error">{{ store.errorMessage }}</div>

    <!-- 输入栏：固定常驻底部（位于 Tab 栏之上） -->
    <div class="mq-inputbar">
      <button class="mq-new" title="新会话" @click="handleNewSession" :disabled="store.isLoading">＋</button>
      <textarea
        v-model="inputQuestion"
        class="mq-input"
        rows="1"
        placeholder="输入你的问题…"
        :disabled="store.isLoading"
        @keydown.enter.exact.prevent="handleSubmit"
      ></textarea>
      <button
        v-if="store.isLoading"
        class="mq-send mq-stop"
        @click="handleStop"
        title="停止生成"
      >停止</button>
      <button
        v-else
        class="mq-send"
        :disabled="!canSend"
        @click="handleSubmit"
        title="发送"
      >发送</button>
    </div>
  </div>
</template>

<style scoped>
.mq-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
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
.mq-empty-hint {
  color: var(--text-soft, #9aa0b4);
  font-size: 14px;
  margin: 0;
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

.mq-new {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  border: 1px solid var(--accent-purple-a30, rgba(168, 85, 247, 0.3));
  background: rgba(168, 85, 247, 0.12);
  color: var(--text-bright, #e8e9f3);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
.mq-new:active { transform: scale(0.94); }

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
</style>

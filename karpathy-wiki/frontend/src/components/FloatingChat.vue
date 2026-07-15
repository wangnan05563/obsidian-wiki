<script setup lang="ts">
import { ref, nextTick, watch, computed } from 'vue';
import { Promotion, Loading, Close, Minus } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import RobotAvatar from './RobotAvatar.vue';
import { useQueryStore } from '../stores/query';
import { apiErrorMessage } from '../utils/apiError';
import { renderMarkdown } from '../utils/markdown';
import type { ThinkingStep } from '../types';

const store = useQueryStore();
const isOpen = ref(false);
const inputQuestion = ref('');
const chatBodyRef = ref<HTMLDivElement | null>(null);
let abortController: AbortController | null = null;

// §5.2 接收当前是否在 Query 页面的标志：Query 页面时悬浮按钮移到左下角避免遮挡输入区
const props = defineProps<{ inQueryPage?: boolean }>();

const hasMessages = computed(() => store.messages.length > 0);

function scrollToBottom() {
  nextTick(() => {
    if (chatBodyRef.value) {
      chatBodyRef.value.scrollTop = chatBodyRef.value.scrollHeight;
    }
  });
}

watch(
  () => [store.messages.length, store.streamingAnswer],
  scrollToBottom,
);

// 解析单个 SSE 事件，提取 eventType 和 data
function parseSSEEvent(evt: string): { eventType: string; data: string } | null {
  const lines = evt.split('\n');
  let eventType = '';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) eventType = line.slice(7);
    if (line.startsWith('data: ')) data = line.slice(6);
  }
  if (!eventType || !data) return null;
  return { eventType, data };
}

// 根据 eventType 分发到对应的 store 处理函数
function handleSSEEvent(eventType: string, data: string) {
  try {
    const parsed = JSON.parse(data);
    if (eventType === 'answer') {
      store.appendAnswer(parsed.text || '');
    } else if (eventType === 'refs') {
      store.setRefs(parsed.refs || []);
    } else if (eventType === 'thinking') {
      // 补全 thinking 事件处理，与 Query.vue 保持一致
      const step: ThinkingStep = {
        phase: parsed.phase,
        message: parsed.message,
        tool: parsed.tool,
        args: parsed.args,
        ts: new Date().toISOString(),
      };
      store.appendThinking(step);
    } else if (eventType === 'progress') {
      store.setProgress(parsed.step, parsed.count);
    } else if (eventType === 'followups') {
      store.setFollowups(parsed.followups || []);
    } else if (eventType === 'done') {
      store.finalizeAnswer(parsed.sessionId, parsed.messageIndex);
    } else if (eventType === 'error') {
      store.handleError(parsed.message || '问答出错');
      ElMessage.warning(parsed.message || '问答出错');
    }
  } catch {
    // 非 JSON 数据跳过
  }
}

// 批量处理 SSE 事件，避免 sendQuestion 嵌套过深
function processSSEEvents(events: string[]) {
  for (const evt of events) {
    const parsed = parseSSEEvent(evt);
    if (!parsed) continue;
    handleSSEEvent(parsed.eventType, parsed.data);
  }
}

async function sendQuestion(question: string) {
  abortController = new AbortController();
  const history = store.messages.map((m) => ({ role: m.role, content: m.content }));

  try {
    const response = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history }),
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      processSSEEvents(events);
    }
    if (store.isLoading && store.streamingAnswer) {
      store.finalizeAnswer();
    }
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
}

function toggleOpen() {
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    nextTick(() => scrollToBottom());
  }
}

function handleClose() {
  isOpen.value = false;
}
</script>

<template>
  <!-- 悬浮按钮：固定在右下角 -->
  <!-- 为什么面板不用 glass-card：glass-card 的 ::before 顶部高光线 + 固定暗色背景
       在 macaron 等浅色主题下会出现"外层透明框"且背景与主题冲突，
       改为使用主题变量驱动的半透明背景，顶部不再绘制高光线 -->
  <transition name="float-fade">
    <div v-if="isOpen" class="floating-panel">
      <!-- 面板头部 -->
      <div class="panel-header">
        <div class="panel-title">
          <RobotAvatar :size="28" />
          <span>AI 知识库问答</span>
        </div>
        <div class="panel-actions">
          <el-button
            v-if="hasMessages"
            :icon="Minus"
            size="small"
            circle
            text
            @click="handleNewSession"
            title="新会话"
          />
          <el-button
            :icon="Close"
            size="small"
            circle
            text
            @click="handleClose"
            title="关闭"
          />
        </div>
      </div>

      <!-- 消息区域 -->
      <div ref="chatBodyRef" class="panel-messages">
        <div v-if="store.messages.length === 0" class="messages-empty">
          <RobotAvatar :size="48" :floating="false" />
          <p class="empty-hint">向我提问知识库相关内容</p>
          <div class="suggestion-list">
            <span
              v-for="suggestion in ['什么是 RAG？', 'Embedding 是什么？', 'Vector Database 的作用']"
              :key="suggestion"
              class="suggestion-chip"
              @click="inputQuestion = suggestion"
            >{{ suggestion }}</span>
          </div>
        </div>
        <div v-else class="messages-list">
          <div
            v-for="(msg, idx) in store.messages"
            :key="idx"
            class="msg-row"
            :class="msg.role"
          >
            <div class="msg-avatar">
              <div v-if="msg.role === 'user'" class="user-avatar">U</div>
              <RobotAvatar v-else :size="32" :floating="false" />
            </div>
            <div class="msg-bubble" :class="msg.role">
              <div class="msg-content markdown-body" v-html="renderMarkdown(msg.content)"></div>
              <div v-if="msg.refs" class="msg-refs">
                <span class="refs-label">参考：</span>
                <span
                  v-for="(ref, i) in (msg.refs as Array<string | { title: string; url?: string; path?: string; snippet?: string }>)"
                  :key="i"
                  class="ref-chip"
                >{{ typeof ref === 'string' ? ref : (ref.title || ref.path || ref.url) }}</span>
              </div>
              <div v-if="msg.followups" class="msg-followups">
                <span class="followups-label">猜猜你想问：</span>
                <span
                  v-for="(f, i) in msg.followups"
                  :key="i"
                  class="followup-chip"
                  @click="inputQuestion = f"
                >{{ f }}</span>
              </div>
            </div>
          </div>
          <!-- 流式输出中的 assistant 消息 -->
          <div v-if="store.isLoading" class="msg-row assistant">
            <div class="msg-avatar">
              <RobotAvatar :size="32" :floating="true" />
            </div>
            <div class="msg-bubble assistant streaming">
              <div class="msg-content markdown-body" v-html="renderMarkdown(store.streamingAnswer || '思考中...')"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 输入区域 -->
      <div class="panel-input">
        <textarea
          v-model="inputQuestion"
          class="panel-textarea"
          placeholder="输入你的问题…"
          rows="1"
          :disabled="store.isLoading"
          @keydown="handleKeydown"
        />
        <el-button
          type="primary"
          :icon="store.isLoading ? Loading : Promotion"
          :disabled="!inputQuestion.trim() || store.isLoading"
          circle
          @click="handleSubmit"
        />
      </div>
    </div>
  </transition>

  <!-- 悬浮按钮：固定在右下角 -->
  <!-- 为什么不用 glass-card 类：glass-card 的 ::before 顶部高光线和卡片边框
       会让圆形按钮看起来像有"外层透明框"，去掉后只保留按钮自身的圆形边框和发光效果 -->
  <transition name="float-btn">
    <button
      v-if="!isOpen"
      class="float-btn"
      :class="{ 'in-query': props.inQueryPage }"
      @click="toggleOpen"
      title="点击展开问答面板"
    >
      <RobotAvatar :size="40" :floating="false" />
    </button>
  </transition>
</template>

<style scoped>
/* ========== 悬浮按钮 ========== */
/* 为什么没有 border 和 box-shadow：
   之前用 2px 青边框 + 青色光晕在浅色主题下形成"外层透明框"视觉效果
   （圆形描边 + 模糊光晕），用户希望按钮与背景融为一体，只显示机器人图标本身。
   这里去掉所有装饰边框，机器人 SVG 自带主题色，背景完全透明。 */
.float-btn {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  background: transparent;
  cursor: pointer;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: transform 0.2s ease;
}

.float-btn:hover {
  transform: scale(1.1);
}

/* §5.2 Query 页面时悬浮按钮移到左下角，避免遮挡右侧发送按钮 */
.float-btn.in-query {
  bottom: 24px;
  left: 24px;
  right: auto;
}

/* ========== 悬浮面板 ========== */
/* 为什么无 border/box-shadow/backdrop-filter：
   用户要求面板与背景融为一体，不显示外层透明框。
   - border: 0 → 无描边
   - box-shadow: none → 无投影
   - backdrop-filter: none → 无模糊，不遮挡背景内容
   - background: var(--bg-card) → 半透明主题色，主题切换时自动适配
   内部面板元素（header、messages、input）有各自背景色形成自然的视觉分区。 */
.floating-panel {
  position: fixed;
  bottom: 92px;
  right: 24px;
  width: 420px;
  /* 自适应视口：在大屏保持 560px 高度，在小屏（< 660px）自动收缩避免标题头被遮挡
     用 min() 函数比 max-height 更直接：height 直接等于 min(560, 视口-100) */
  height: min(560px, calc(100vh - 100px));
  max-height: calc(100vh - 80px);
  border-radius: 16px;
  border: none;
  background: var(--bg-card);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: none;
  outline: none;
}

/* 面板头部 */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: none;
  flex-shrink: 0;
}

.panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.5px;
}

.panel-actions {
  display: flex;
  gap: 4px;
}

.panel-actions .el-button {
  --el-button-text-color: var(--text-soft);
  --el-button-hover-text-color: var(--neon-cyan);
  --el-button-hover-bg-color: var(--accent-cyan-a10);
}

/* 消息区域 */
.panel-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.messages-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

.empty-hint {
  margin: 0;
  color: var(--text-soft);
  font-size: 13px;
  font-family: var(--font-mono);
}

.suggestion-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

.suggestion-chip {
  padding: 6px 14px;
  background: var(--accent-purple-a10);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 20px;
  font-size: 12px;
  color: var(--text-bright);
  cursor: pointer;
  transition: all 0.2s ease;
}

.suggestion-chip:hover {
  background: var(--accent-purple-a25);
  border-color: var(--neon-purple);
  color: var(--neon-purple);
}

/* 消息行 */
.messages-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.msg-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.msg-row.user {
  flex-direction: row-reverse;
}

.msg-avatar {
  flex-shrink: 0;
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--grad-fire);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
}

.msg-bubble {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-bright);
  position: relative;
}

.msg-bubble.assistant {
  background: var(--accent-cyan-a10);
  border: 1px solid var(--accent-cyan-a20);
  border-top-left-radius: 4px;
}

.msg-bubble.assistant::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, var(--neon-cyan), transparent);
  opacity: 0.6;
}

.msg-bubble.user {
  background: var(--grad-fire);
  border-top-right-radius: 4px;
  color: #fff;
}

.msg-bubble.streaming {
  animation: neon-pulse 1.5s ease-in-out infinite;
}

.msg-content {
  /* 去掉 pre-wrap：让 markdown-it 的 <p> 段落分隔生效，AI 回答更紧凑
     用户消息（.user .msg-content）单独用 pre-wrap 保留换行 */
  white-space: normal;
  word-break: break-word;
}

/* 用户消息保留原始换行（用户可能输入多行问题） */
.msg-bubble.user .msg-content {
  white-space: pre-wrap;
}

.msg-refs {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--accent-purple-a25);
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.refs-label {
  font-size: 10px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.ref-chip {
  padding: 2px 8px;
  background: var(--accent-purple-a10);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 12px;
  font-size: 10px;
  color: var(--neon-purple);
  font-family: var(--font-mono);
}

.msg-followups {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.followups-label {
  font-size: 10px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.followup-chip {
  padding: 3px 10px;
  background: var(--accent-cyan-a10);
  border: 1px solid var(--accent-cyan-a30);
  border-radius: 16px;
  font-size: 11px;
  color: var(--neon-cyan);
  cursor: pointer;
  transition: all 0.2s;
}

.followup-chip:hover {
  background: var(--accent-cyan-a20);
  border-color: var(--neon-cyan);
}

/* 输入区域 */
.panel-input {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  border-top: none;
  align-items: flex-end;
  flex-shrink: 0;
}

.panel-textarea {
  flex: 1;
  padding: 10px 14px;
  border: none;
  border-radius: 12px;
  background: var(--bg-card-solid);
  color: var(--text-bright);
  font-size: 13px;
  font-family: var(--font-body);
  resize: none;
  outline: none;
  line-height: 1.5;
  min-height: 40px;
  max-height: 120px;
  transition: box-shadow 0.2s;
}

.panel-textarea::placeholder {
  color: var(--text-dim);
}

.panel-textarea:focus {
  box-shadow: 0 0 0 2px var(--accent-cyan-a30) inset;
}

.panel-textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.panel-input .el-button {
  flex-shrink: 0;
  --el-button-bg-color: var(--grad-fire);
  --el-button-border-color: transparent;
  --el-button-hover-bg-color: var(--grad-fire);
}

/* 动画 */
.float-fade-enter-active,
.float-fade-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.float-fade-enter-from,
.float-fade-leave-to {
  opacity: 0;
  transform: scale(0.9) translateY(10px);
}

.float-btn-enter-active,
.float-btn-leave-active {
  transition: opacity 0.2s ease;
}

.float-btn-enter-from,
.float-btn-leave-to {
  opacity: 0;
}

@keyframes neon-pulse {
  0%, 100% { opacity: 1; filter: brightness(1); }
  50% { opacity: 0.8; filter: brightness(1.2); }
}

/* 滚动条美化 */
.panel-messages::-webkit-scrollbar {
  width: 4px;
}

.panel-messages::-webkit-scrollbar-track {
  background: transparent;
}

.panel-messages::-webkit-scrollbar-thumb {
  background: var(--accent-cyan-a20);
  border-radius: 4px;
}

.panel-messages::-webkit-scrollbar-thumb:hover {
  background: var(--accent-cyan-a40);
}

/* 响应式 */
@media (max-width: 500px) {
  .floating-panel {
    width: calc(100vw - 16px);
    height: calc(100vh - 80px);
    bottom: 80px;
    right: 8px;
    border-radius: 12px;
  }

  .float-btn {
    bottom: 16px;
    right: 16px;
  }
}
</style>

<script setup lang="ts">
import { ref, nextTick, watch, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { Promotion, Loading } from '@element-plus/icons-vue';
import RobotAvatar from '../components/RobotAvatar.vue';
import { useQueryStore } from '../stores/query';

const store = useQueryStore();

const inputQuestion = ref('');
const chatBodyRef = ref<HTMLDivElement | null>(null);
let abortController: AbortController | null = null;

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
      for (const evt of events) {
        const lines = evt.split('\n');
        let eventType = '';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7);
          if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (!eventType || !data) continue;
        try {
          const parsed = JSON.parse(data);
          if (eventType === 'answer') {
            store.appendAnswer(parsed.text || '');
          } else if (eventType === 'refs') {
            store.setRefs(parsed.refs || []);
          } else if (eventType === 'done') {
            store.finalizeAnswer(parsed.sessionId, parsed.messageIndex);
          } else if (eventType === 'error') {
            store.handleError(parsed.message || '问答出错');
            ElMessage.error(parsed.message || '问答出错');
          }
        } catch {
          // 非 JSON 数据跳过
        }
      }
    }
    if (store.isLoading && store.streamingAnswer) {
      store.finalizeAnswer();
    }
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') return;
    const msg = (err as Error).message;
    store.handleError(msg);
    ElMessage.error('问答请求失败：' + msg);
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
    ElMessage.error('归档失败：' + (err as Error).message);
  }
}

onBeforeUnmount(() => {
  abortController?.abort();
});
</script>

<template>
  <div class="query-page">
    <div class="glass-card query-card fade-up">
      <div class="card-deco"></div>
      <!-- 不对称头部 -->
      <div class="query-head">
        <RobotAvatar :size="60" :floating="store.isLoading" />
        <div class="head-text">
          <span class="head-tag">// AI QUERY ENGINE</span>
          <h2 class="head-title grad-text">知识库问答</h2>
          <p class="head-tip">向机器人提问，它会基于知识库页面回答</p>
        </div>
        <el-button
          v-if="store.messages.length > 0"
          size="small"
          @click="handleNewSession"
        >
          新会话
        </el-button>
      </div>

      <div ref="chatBodyRef" class="chat-body">
        <div v-if="store.messages.length === 0 && !store.streamingAnswer" class="chat-empty">
          <RobotAvatar :size="120" :floating="true" />
          <p class="empty-tip">// 还没有对话，试试问个问题吧</p>
          <div class="empty-suggestions">
            <span class="suggestion-chip" @click="inputQuestion = '什么是 LLM Wiki？'">
              什么是 LLM Wiki？
            </span>
            <span class="suggestion-chip" @click="inputQuestion = '知识库中有哪些页面？'">
              知识库中有哪些页面？
            </span>
          </div>
        </div>

        <template v-for="(msg, idx) in store.messages" :key="idx">
          <div class="msg-row" :class="msg.role">
            <div class="msg-avatar">
              <RobotAvatar v-if="msg.role === 'assistant'" :size="36" />
              <div v-else class="user-avatar">ME</div>
            </div>
            <div class="msg-bubble" :class="msg.role">
              <div class="msg-content">{{ msg.content }}</div>
              <div v-if="msg.refs && msg.refs.length > 0" class="msg-refs">
                <span class="refs-label">REFS:</span>
                <span v-for="r in msg.refs" :key="r" class="ref-chip">[[{{ r }}]]</span>
              </div>
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
        <div v-if="store.streamingAnswer" class="msg-row assistant">
          <div class="msg-avatar">
            <RobotAvatar :size="36" />
          </div>
          <div class="msg-bubble assistant streaming">
            <div class="msg-content">{{ store.streamingAnswer }}</div>
            <div v-if="store.currentRefs.length > 0" class="msg-refs">
              <span class="refs-label">REFS:</span>
              <span v-for="r in store.currentRefs" :key="r" class="ref-chip">[[{{ r }}]]</span>
            </div>
          </div>
        </div>
      </div>

      <div class="input-bar">
        <el-input
          v-model="inputQuestion"
          type="textarea"
          :rows="2"
          placeholder="输入问题，Ctrl+Enter 发送…"
          resize="none"
          :disabled="store.isLoading"
          @keydown="handleKeydown"
        />
        <el-button
          type="primary"
          size="large"
          :disabled="!inputQuestion.trim() || store.isLoading"
          @click="handleSubmit"
        >
          <el-icon v-if="store.isLoading" class="spin-icon"><Loading /></el-icon>
          <el-icon v-else><Promotion /></el-icon>
          <span>{{ store.isLoading ? '回答中' : '发送' }}</span>
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.query-page {
  display: flex;
  flex-direction: column;
}

.query-card {
  padding: 28px 32px;
  display: flex;
  flex-direction: column;
  height: calc(100vh - 240px);
  min-height: 480px;
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

/* 不对称头部 */
.query-head {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 18px;
  position: relative;
  z-index: 1;
}

.head-text {
  flex: 1;
}

.head-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--neon-cyan);
  letter-spacing: 2px;
  display: block;
  margin-bottom: 4px;
}

.head-title {
  margin: 0 0 4px;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 1px;
}

.head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 13px;
}

.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 4px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  position: relative;
  z-index: 1;
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

/* 消息气泡：不对称圆角 + 渐变 */
.msg-bubble {
  max-width: 75%;
  padding: 14px 18px;
  border-radius: 20px;
  font-size: 14px;
  line-height: 1.7;
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
  color: #fff;
  box-shadow: 0 4px 20px rgba(255, 0, 110, 0.3);
}

/* 流式输出时的脉动效果 */
.msg-bubble.streaming {
  animation: neon-pulse 1.5s ease-in-out infinite;
}

.msg-content {
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-refs {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed rgba(176, 38, 255, 0.2);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.refs-label {
  font-size: 10px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

.ref-chip {
  padding: 3px 10px;
  background: rgba(176, 38, 255, 0.12);
  border: 1px solid rgba(176, 38, 255, 0.3);
  border-radius: var(--radius-pill);
  font-size: 11px;
  color: var(--neon-purple);
  font-family: var(--font-mono);
}

.msg-actions {
  margin-top: 8px;
  text-align: right;
}

.input-bar {
  margin-top: 18px;
  display: flex;
  gap: 14px;
  align-items: flex-end;
  position: relative;
  z-index: 1;
}

.input-bar .el-input {
  flex: 1;
}
</style>

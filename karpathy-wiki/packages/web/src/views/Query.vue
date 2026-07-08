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

// 自动滚动到底部，保证流式输出可见
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

// SSE 流式请求。POST 不能用 EventSource，用 fetch + ReadableStream 手动解析。
async function sendQuestion(question: string) {
  abortController = new AbortController();
  // 历史对话只取 role/content，避免传输冗余字段
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
      // SSE 协议：事件以空行（\n\n）分隔
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
            // done 事件附带 sessionId + messageIndex，供归档使用
            store.finalizeAnswer(parsed.sessionId, parsed.messageIndex);
          } else if (eventType === 'error') {
            store.handleError(parsed.message || '问答出错');
            ElMessage.error(parsed.message || '问答出错');
          }
        } catch {
          // 后端偶发非 JSON 数据时跳过这一条，避免整条流崩溃
        }
      }
    }
    // 流正常结束但未收到 done 事件时，兜底收尾（无 sessionId，不可归档）
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
  // Ctrl/Cmd + Enter 发送，避免单 Enter 误触
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    handleSubmit();
  }
}

function handleNewSession() {
  store.reset();
  inputQuestion.value = '';
}

// 归档问答到 Vault。POST /api/query/archive，服务端从会话存储取答案（防篡改）。
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
  // 离开页面时中断未完成的请求，避免内存泄漏
  abortController?.abort();
});
</script>

<template>
  <div class="query-page">
    <div class="glass-card query-card">
      <div class="query-head">
        <RobotAvatar :size="64" :floating="store.isLoading" />
        <div class="head-text">
          <h2 class="head-title">知识库问答</h2>
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

        <template v-for="(msg, idx) in store.messages" :key="idx">
          <div class="msg-row" :class="msg.role">
            <div class="msg-avatar">
              <RobotAvatar v-if="msg.role === 'assistant'" :size="36" />
              <div v-else class="user-avatar">我</div>
            </div>
            <div class="msg-bubble" :class="msg.role">
              <div class="msg-content">{{ msg.content }}</div>
              <div v-if="msg.refs && msg.refs.length > 0" class="msg-refs">
                <span class="refs-label">引用：</span>
                <span v-for="r in msg.refs" :key="r" class="ref-chip">[[{{ r }}]]</span>
              </div>
              <!-- 归档按钮：仅 assistant 消息且有 sessionId 时显示 -->
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
          <div class="msg-bubble assistant">
            <div class="msg-content">{{ store.streamingAnswer }}</div>
            <div v-if="store.currentRefs.length > 0" class="msg-refs">
              <span class="refs-label">引用：</span>
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
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
  height: calc(100vh - 220px);
  min-height: 480px;
}

.query-head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.head-text {
  flex: 1;
}

.head-title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
}

.head-tip {
  margin: 0;
  color: var(--color-text-soft);
  font-size: 13px;
}

.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 4px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

.empty-tip {
  margin: 0;
  color: var(--color-text-soft);
  font-size: 14px;
}

.empty-suggestions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
}

.suggestion-chip {
  padding: 6px 14px;
  background: var(--color-cyan);
  border-radius: 16px;
  font-size: 13px;
  color: var(--color-text);
  cursor: pointer;
  transition: all 0.2s ease;
}

.suggestion-chip:hover {
  background: var(--color-pink);
  transform: translateY(-2px);
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
  display: flex;
  align-items: center;
  justify-content: center;
}

.user-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--color-primary);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.msg-bubble {
  max-width: 75%;
  padding: 12px 16px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-text);
}

.msg-bubble.assistant {
  background: var(--color-cyan);
  border-top-left-radius: 4px;
}

.msg-bubble.user {
  background: var(--color-pink);
  border-top-right-radius: 4px;
}

.msg-content {
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-refs {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed rgba(74, 59, 71, 0.15);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.refs-label {
  font-size: 12px;
  color: var(--color-text-soft);
}

.ref-chip {
  padding: 2px 8px;
  background: rgba(255, 255, 255, 0.6);
  border-radius: 10px;
  font-size: 12px;
  color: var(--color-primary-deep);
  font-family: 'Courier New', monospace;
}

.msg-actions {
  margin-top: 6px;
  text-align: right;
}

.input-bar {
  margin-top: 16px;
  display: flex;
  gap: 12px;
  align-items: flex-end;
}

.input-bar .el-input {
  flex: 1;
}
</style>

<script setup lang="ts">
import { ref, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { Promotion, Loading } from '@element-plus/icons-vue';
import RobotAvatar from '../components/RobotAvatar.vue';
import ConversationSidebar from '../components/ConversationSidebar.vue';
import AttachmentUploader from '../components/AttachmentUploader.vue';
import InputToolbar from '../components/InputToolbar.vue';
import ThinkingBlock from '../components/ThinkingBlock.vue';
import ModelSelector from '../components/ModelSelector.vue';
import RefsList from '../components/RefsList.vue';
import { useQueryStore } from '../stores/query';
import { useConversationsStore } from '../stores/conversations';
import { useModelStore } from '../stores/model';
import { useAttachmentsStore } from '../stores/attachments';
import { dbGet, CHAT_STORES } from '../services/chatDb';
import { apiErrorMessage } from '../utils/apiError';
import { renderMarkdown } from '../utils/markdown';
import type { Attachment, Reference, ThinkingStep } from '../types';

// §2.1 Query.vue 完整重构：集成侧栏/模型选择/附件/工具栏/思考块/引用列表/追问。
// 设计参考：知识库问答AI对话流详细设计说明书 §2.1.2 / §2.1.3
const store = useQueryStore();
const conversationsStore = useConversationsStore();
const modelStore = useModelStore();
const attachmentsStore = useAttachmentsStore();

const inputQuestion = ref('');
const chatBodyRef = ref<HTMLDivElement | null>(null);
let abortController: AbortController | null = null;

// 侧栏折叠状态持久化到 localStorage，刷新页面后保留
const sidebarCollapsed = ref(localStorage.getItem('sidebarCollapsed') === 'true');
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem('sidebarCollapsed', String(sidebarCollapsed.value));
}

// §5.2 工具栏模式：'' 默认 / 'web' 联网搜索 / 'deep' 深度思考
const activeMode = ref('');
const toolbarTools = [
  { key: 'web', label: '联网搜索' },
  { key: 'deep', label: '深度思考' },
];
// 点击同一工具切换为关闭，点击不同工具切换为该模式
function handleSelectMode(mode: string) {
  activeMode.value = activeMode.value === mode ? '' : mode;
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
function normalizeRefs(refs: string[] | Reference[] | undefined): Reference[] {
  if (!refs || refs.length === 0) return [];
  if (typeof refs[0] === 'string') {
    return (refs as string[]).map((path, i) => ({
      path,
      title: path.split('/').pop() || path,
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

  // 构造请求体：按当前模式构造，模型切换由 PUT /api/ai/config 统一处理
  const body: Record<string, unknown> = { question, history };
  if (activeMode.value === 'web') {
    body.mode = 'web';
    body.webSearch = true;
  } else if (activeMode.value === 'deep') {
    body.mode = 'deep';
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
          } else if (eventType === 'thinking') {
            // 后端 ThinkingChunk → 前端 ThinkingStep（补 ts 字段供排序）
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
    }
    // 流正常结束但未收到 done 事件时兜底
    if (store.isLoading && store.streamingAnswer) {
      store.finalizeAnswer();
    }
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

onMounted(async () => {
  try {
    await conversationsStore.loadConversations();
  } catch {
    // IndexedDB 不可用时静默降级，仅内存态
  }
});

onBeforeUnmount(() => {
  abortController?.abort();
});
</script>

<template>
  <div class="query-page">
    <ConversationSidebar
      :collapsed="sidebarCollapsed"
      @toggle="toggleSidebar"
      @new-session="handleNewSession"
      @select="handleSelectConversation"
    />
    <div class="glass-card query-card fade-up">
      <div class="card-deco"></div>
      <!-- 顶部精简：仅保留 ModelSelector，移除标题头和图标放大问答框 -->
      <div class="query-head">
        <div class="head-actions">
          <ModelSelector />
        </div>
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

        <template v-for="(msg, idx) in store.messages" :key="msg.id || idx">
          <div class="msg-row" :class="msg.role">
            <div class="msg-avatar">
              <RobotAvatar v-if="msg.role === 'assistant'" :size="36" />
              <div v-else class="user-avatar">ME</div>
            </div>
            <div class="msg-bubble" :class="msg.role">
              <ThinkingBlock v-if="msg.thinking && msg.thinking.length > 0" :steps="msg.thinking" />
              <div class="msg-content markdown-body" v-html="renderMarkdown(msg.content)"></div>
              <RefsList v-if="normalizeRefs(msg.refs).length > 0" :refs="normalizeRefs(msg.refs)" />
              <div v-if="msg.followups && msg.followups.length > 0" class="msg-followups">
                <span class="followups-label">追问：</span>
                <span
                  v-for="(f, i) in msg.followups"
                  :key="i"
                  class="followup-chip"
                  @click="inputQuestion = f"
                >{{ f }}</span>
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
        <div v-if="store.streamingAnswer || store.isLoading" class="msg-row assistant">
          <div class="msg-avatar">
            <RobotAvatar :size="36" />
          </div>
          <div class="msg-bubble assistant streaming">
            <ThinkingBlock v-if="store.currentThinking.length > 0" :steps="store.currentThinking" />
            <div v-if="store.searchProgress" class="search-progress">
              {{ store.searchProgress.step }}
              <span v-if="store.searchProgress.count">（{{ store.searchProgress.count }} 条）</span>
            </div>
            <div class="msg-content markdown-body" v-html="renderMarkdown(store.streamingAnswer || '思考中...')"></div>
            <RefsList v-if="store.currentRefs.length > 0" :refs="store.currentRefs" />
          </div>
        </div>
      </div>

      <!-- 输入区：输入框在上，按钮在下同一行（左侧3个+右侧发送） -->
      <div class="input-area">
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
        </div>
        <!-- 按钮行：左侧附件+联网搜索+深度思考，右侧发送，全部图标化 -->
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
          </div>
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
</template>

<style scoped>
.query-page {
  display: flex;
  flex-direction: row;
}

.query-card {
  flex: 1;
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

.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
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

.msg-followups {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed rgba(176, 38, 255, 0.2);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.followups-label {
  font-size: 10px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

.followup-chip {
  padding: 3px 10px;
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

.msg-actions {
  margin-top: 8px;
  text-align: right;
}

/* 输入区：输入框在上，按钮行在下（左侧工具+右侧发送） */
.input-area {
  margin-top: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  z-index: 1;
}

.input-bar {
  display: flex;
  width: 100%;
}

.input-bar .el-input {
  flex: 1;
}

/* 按钮行：左侧工具组 + 右侧发送按钮，同一行两端对齐 */
.button-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.left-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
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
</style>

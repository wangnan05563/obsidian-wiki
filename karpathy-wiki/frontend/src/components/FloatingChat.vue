<script setup lang="ts">
import { API_BASE } from '../utils/apiBase';
import { ref, nextTick, watch, computed, onMounted, onBeforeUnmount } from 'vue';
import { Promotion, Close, Minus, VideoPause } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import RobotAvatar from './RobotAvatar.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import MessageToolbar from './MessageToolbar.vue';
import RefsList from './RefsList.vue';
import { useQueryStore } from '../stores/query';
import { apiErrorMessage } from '../utils/apiError';
import { renderMarkdown } from '../utils/markdown';
import { consumeQuerySSE } from '../utils/sse';
import { FLOATING_CHAT_CONFIG } from '../config/floatingChat';
import { STORAGE_KEYS } from '../constants/storageKeys';
import type { ChatMessage, Reference } from '../types';

// §5.2 全局悬浮问答入口：在所有页面右下角提供快速问答能力。
//   设计取舍：相比 Query.vue 完整功能，FloatingChat 是轻量级浮窗，仅保留核心问答流。
//   复用 ThinkingBlock / MessageToolbar / RefsList 以保持与主问答页一致的交互体验。
const store = useQueryStore();
const props = defineProps<{ inQueryPage?: boolean }>();

// 面板展开状态持久化：用户刷新页面后保留偏好
const isOpen = ref(localStorage.getItem(STORAGE_KEYS.FLOATING_CHAT_OPEN) === 'true');
const inputQuestion = ref('');
const chatBodyRef = ref<HTMLDivElement | null>(null);
let abortController: AbortController | null = null;

const hasMessages = computed(() => store.messages.length > 0);

// 统一 msg.refs 为 Reference[]，兼容 v1 string[] 与 v2 Reference[]
// 为什么抽出到 computed：原模板内 (msg.refs as Array<...>) 类型断言违反 vue-tsc 严格模式
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

// 时间戳格式化：仅显示 HH:MM，避免占用过多气泡空间
function formatTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
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

async function sendQuestion(question: string) {
  abortController = new AbortController();
  const history = store.messages.map((m) => ({ role: m.role, content: m.content }));

  try {
    const response = await fetch(`${API_BASE}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // §真流式：复用主问答的 streamMode 偏好，与 Query 页面行为一致
      body: JSON.stringify({ question, history, stream: store.streamMode }),
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    // SSE 流消费统一委托给 utils/sse.ts，降低本函数认知复杂度（S3776）
    await consumeQuerySSE(response, store, abortController.signal);
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

// 删除单条消息：用户点击工具栏删除按钮时调用
// FloatingChat 简化版无 conversationsStore 持久化，仅内存删除
function handleRemoveMessage(idx: number) {
  store.removeMessage(idx);
}

// 停止生成：调用 abortController 中断 SSE 流，store 会在 catch 中自然 finalize
// 为什么不调 store.stop：store 无 stop 方法，abort 触发后 SSE reader 自动抛 AbortError
function handleStop() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
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

// 统一展开/关闭入口：同时持久化到 localStorage
// 为什么合并原 handleClose：避免重复函数 + 状态分散
function setOpen(open: boolean) {
  isOpen.value = open;
  localStorage.setItem(STORAGE_KEYS.FLOATING_CHAT_OPEN, String(open));
  if (open) {
    nextTick(() => scrollToBottom());
  }
}

function toggleOpen() {
  setOpen(!isOpen.value);
}

// Esc 关闭面板：仅在面板展开时响应，避免全局拦截影响其他组件
function handleGlobalKeydown(e: KeyboardEvent) {
  if (e.key === FLOATING_CHAT_CONFIG.shortcuts.close && isOpen.value) {
    // 输入框聚焦时 Esc 默认行为是失焦，需 preventDefault 才能触发关闭
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      e.preventDefault();
    }
    setOpen(false);
  }
}

onMounted(() => {
  globalThis.addEventListener('keydown', handleGlobalKeydown);
});

onBeforeUnmount(() => {
  abortController?.abort();
  globalThis.removeEventListener('keydown', handleGlobalKeydown);
});
</script>

<template>
  <!-- 悬浮面板：固定在右下角，Query 页面时移到左下角 -->
  <!-- 为什么面板不用 glass-card：glass-card 的 ::before 顶部高光线 + 固定暗色背景
       在 macaron 等浅色主题下会出现"外层透明框"且背景与主题冲突，
       改为使用主题变量驱动的半透明背景，顶部不再绘制高光线 -->
  <transition name="float-fade">
    <div
      v-if="isOpen"
      class="floating-panel"
      :style="{
        '--panel-width': FLOATING_CHAT_CONFIG.panel.width + 'px',
        '--panel-min-height': FLOATING_CHAT_CONFIG.panel.minHeight + 'px',
        '--panel-max-height': FLOATING_CHAT_CONFIG.panel.maxHeight + 'px',
        '--panel-bottom': FLOATING_CHAT_CONFIG.position.bottom + 'px',
        '--panel-right': FLOATING_CHAT_CONFIG.position.right + 'px',
      }"
    >
      <!-- 面板头部 -->
      <div class="panel-header">
        <div class="panel-title">
          <RobotAvatar :size="28" />
          <span>{{ FLOATING_CHAT_CONFIG.panelTitle }}</span>
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
            @click="setOpen(false)"
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
              v-for="suggestion in FLOATING_CHAT_CONFIG.suggestionQuestions"
              :key="suggestion"
              class="suggestion-chip"
              @click="inputQuestion = suggestion"
            >{{ suggestion }}</span>
          </div>
        </div>
        <div v-else class="messages-list">
          <div
            v-for="(msg, idx) in store.messages"
            :key="msg.id || idx"
            class="msg-row"
            :class="msg.role"
          >
            <div class="msg-avatar">
              <div v-if="msg.role === 'user'" class="user-avatar">U</div>
              <RobotAvatar v-else :size="32" :floating="false" />
            </div>
            <div class="msg-content-wrapper" :class="msg.role">
              <div class="msg-bubble" :class="msg.role">
                <!-- 思考过程：复用 ThinkingBlock 保持与 Query.vue 一致的可折叠交互 -->
                <ThinkingBlock
                  v-if="msg.thinking && msg.thinking.length > 0"
                  :steps="msg.thinking"
                />
                <div class="msg-content markdown-body" v-html="renderMarkdown(msg.content)"></div>
                <!-- 联想追问 -->
                <div v-if="msg.followups && msg.followups.length > 0" class="msg-followups">
                  <span class="followups-label">猜猜你想问：</span>
                  <div class="followups-track">
                    <span
                      v-for="(f, i) in msg.followups"
                      :key="i"
                      class="followup-chip"
                      @click="inputQuestion = f"
                    >{{ f }}</span>
                  </div>
                </div>
                <!-- 参考资料列表：复用 RefsList 完整渲染（含来源徽章、点击跳转） -->
                <RefsList
                  v-if="normalizeRefs(msg.refs).length > 0"
                  :refs="normalizeRefs(msg.refs)"
                />
                <!-- 消息时间戳：右下角小字，不抢占主要内容视觉 -->
                <div v-if="msg.createdAt" class="msg-timestamp">{{ formatTime(msg.createdAt) }}</div>
              </div>
              <!-- 消息操作工具栏：气泡外部下方显示，复用 MessageToolbar（含复制/朗读/重新生成/反馈/删除） -->
              <MessageToolbar
                :role="msg.role"
                :content="msg.content"
                :msg-id="msg.id"
                :created-at="msg.createdAt"
                :can-regenerate="!store.isLoading"
                @remove="handleRemoveMessage(idx)"
              />
            </div>
          </div>
          <!-- 流式输出中的 assistant 消息 -->
          <div v-if="store.isLoading || store.streamingAnswer" class="msg-row assistant">
            <div class="msg-avatar">
              <RobotAvatar :size="32" :floating="true" />
            </div>
            <div class="msg-bubble assistant" :class="{ streaming: !!store.streamingAnswer }">
              <!-- 思考过程实时展示 -->
              <ThinkingBlock
                v-if="store.currentThinking.length > 0"
                :steps="store.currentThinking"
              />
              <!-- 首字节前 loading dots：让用户感知"正在思考" -->
              <div
                v-if="store.isLoading && !store.streamingAnswer && store.currentThinking.length === 0"
                class="loading-dots"
              >
                <span class="dot"></span>
                <span class="dot"></span>
                <span class="dot"></span>
                <span class="loading-text">正在思考…</span>
              </div>
              <div
                v-else
                class="msg-content markdown-body streaming-content"
                v-html="renderMarkdown(store.streamingAnswer || '')"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 输入区域：el-input + autosize 自动扩展高度，仿 Query.vue 模式 -->
      <div class="panel-input">
        <el-input
          v-model="inputQuestion"
          type="textarea"
          :rows="FLOATING_CHAT_CONFIG.textarea.minRows"
          :autosize="{ minRows: FLOATING_CHAT_CONFIG.textarea.minRows, maxRows: FLOATING_CHAT_CONFIG.textarea.maxRows }"
          placeholder="输入你的问题…"
          resize="none"
          :disabled="store.isLoading"
          @keydown="handleKeydown"
        />
        <!-- 停止生成按钮：isLoading 时切换为 Stop 图标，点击中断 SSE -->
        <el-button
          v-if="store.isLoading"
          type="danger"
          :icon="VideoPause"
          circle
          @click="handleStop"
          title="停止生成"
        />
        <el-button
          v-else
          type="primary"
          :icon="Promotion"
          :disabled="!inputQuestion.trim()"
          circle
          @click="handleSubmit"
          title="发送"
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
      :style="{
        width: FLOATING_CHAT_CONFIG.floatButtonSize + 'px',
        height: FLOATING_CHAT_CONFIG.floatButtonSize + 'px',
        '--panel-bottom': FLOATING_CHAT_CONFIG.position.bottom + 'px',
        '--panel-right': FLOATING_CHAT_CONFIG.position.right + 'px',
      }"
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
   这里去掉所有装饰边框，机器人 SVG 自带主题色，背景完全透明。
   尺寸从内联 style 注入（--float-size），避免硬编码违反配置驱动约束 */
.float-btn {
  position: fixed;
  bottom: var(--panel-bottom, 24px);
  right: var(--panel-right, 24px);
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
  bottom: var(--panel-bottom, 24px);
  left: var(--panel-right, 24px);
  right: auto;
}

/* ========== 悬浮面板 ========== */
/* 为什么无 border/box-shadow/backdrop-filter：
   用户要求面板与背景融为一体，不显示外层透明框。
   - border: 0 → 无描边
   - box-shadow: none → 无投影
   - backdrop-filter: none → 无模糊，不遮挡背景内容
   - background: var(--bg-card) → 半透明主题色，主题切换时自动适配
   内部面板元素（header、messages、input）有各自背景色形成自然的视觉分区。
   尺寸/位置从内联 CSS 变量注入（--panel-width 等），符合配置驱动原则 */
.floating-panel {
  position: fixed;
  bottom: calc(var(--panel-bottom) + 68px);
  right: var(--panel-right);
  width: var(--panel-width);
  /* 自适应视口：在大屏保持 maxHeight，在小屏自动收缩避免标题头被遮挡
     用 min() 函数比 max-height 更直接：height 直接等于 min(maxHeight, 视口-100) */
  height: min(var(--panel-max-height), calc(100vh - 100px));
  min-height: var(--panel-min-height);
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

/* 内容包装器：气泡 + 工具栏垂直排列，让工具栏显示在气泡外部下方
   为什么需要 wrapper：msg-row 是 flex 横向布局（avatar + bubble），
   不用 wrapper 的话工具栏会被当作 flex 第三项横向排列 */
.msg-content-wrapper {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 80%;
}
.msg-content-wrapper.user {
  align-items: flex-end;
  /* §用户气泡宽度恢复 100%：撑满可用宽度，高度通过 padding/line-height 收窄减少占用空间 */
  max-width: 100%;
}
.msg-content-wrapper.assistant {
  align-items: flex-start;
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

/* max-width 由父级 .msg-content-wrapper 控制，气泡自身撑满父级即可 */
.msg-bubble {
  padding: 10px 14px;
  border-radius: 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-bright);
  position: relative;
}

.msg-bubble.assistant {
  /* §AI 气泡撑满 wrapper：与 Query.vue 一致，width: 100% 让气泡跟随 wrapper 宽度自适应屏幕 */
  width: 100%;
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
  /* 跨主题可读：强制白色 + 强阴影确保任意主题下用户文字清晰可读 */
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
  /* §高度收窄：进一步减小 padding/line-height/font-size，与 Query.vue 保持一致 */
  padding: 2px 12px;
  line-height: 1.2;
  font-size: 13px;
}

/* §修复：用户气泡内的 .msg-content.markdown-body 会被全局 style.css 中
   .markdown-body { color: var(--text-base) } 覆盖，必须用 :deep 强制白色 */
.msg-bubble.user :deep(.msg-content),
.msg-bubble.user :deep(.markdown-body),
.msg-bubble.user :deep(.markdown-body p),
.msg-bubble.user :deep(.markdown-body strong) {
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
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

/* 流式输出末尾的打字机光标：闪烁提示用户"正在生成" */
.streaming-content::after {
  content: '▋';
  display: inline-block;
  margin-left: 2px;
  color: var(--neon-cyan);
  animation: cursor-blink 1s steps(2) infinite;
}

@keyframes cursor-blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

/* loading dots：首字节前的"正在思考"动画 */
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
  background: var(--neon-cyan);
  animation: loading-bounce 1.2s ease-in-out infinite;
}
.loading-dots .dot:nth-child(1) { animation-delay: 0s; }
.loading-dots .dot:nth-child(2) { animation-delay: 0.2s; }
.loading-dots .dot:nth-child(3) { animation-delay: 0.4s; }
.loading-dots .loading-text {
  margin-left: 8px;
  font-size: 13px;
  color: var(--text-soft);
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

/* 消息时间戳：右下角小字 */
.msg-timestamp {
  margin-top: 6px;
  text-align: right;
  font-size: 10px;
  color: var(--text-dim);
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

.followups-track {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
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

/* hover 包装器（气泡+工具栏）时显现 MessageToolbar
   为什么用 wrapper：工具栏已移到气泡外部，用 wrapper 作为 hover 触发域，
   鼠标在气泡与工具栏间移动时保持显示 */
.msg-content-wrapper:hover :deep(.msg-toolbar) {
  opacity: 1;
  pointer-events: auto;
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

/* el-input textarea 样式覆盖：紧凑行高避免空行 */
.panel-input :deep(.el-textarea) {
  --el-textarea-min-height: 0;
}
.panel-input :deep(.el-textarea__inner) {
  padding: 10px 14px;
  border: none;
  border-radius: 12px;
  background: var(--bg-card-solid);
  color: var(--text-bright);
  font-size: 13px;
  font-family: var(--font-body);
  line-height: 1.5;
  min-height: 0 !important;
  box-shadow: none;
  transition: box-shadow 0.2s;
}

.panel-input :deep(.el-textarea__inner)::placeholder {
  color: var(--text-dim);
}

.panel-input :deep(.el-textarea__inner):focus {
  box-shadow: 0 0 0 2px var(--accent-cyan-a30) inset;
}

.panel-input :deep(.el-textarea__inner):disabled {
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
    width: calc(100vw - 16px) !important;
    height: calc(100vh - 80px) !important;
    bottom: 80px;
    right: 8px;
    border-radius: 12px;
  }

  .float-btn {
    bottom: 16px !important;
    right: 16px !important;
  }
}
</style>

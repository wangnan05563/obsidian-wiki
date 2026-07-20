<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { DocumentCopy, Document, RefreshRight, VideoPlay, VideoPause } from '@element-plus/icons-vue';
import { useTtsStore } from '../stores/tts';

// F-3.7 + F-3.13 + F-3.6 消息操作工具栏：hover assistant 气泡时浮窗淡入
// 当前实现：复制纯文本 / 复制 MD / 朗读 / 重新生成 / 👍 / 👎
const props = defineProps<{
  content: string;
  // F-3.13 消息 ID：用于 localStorage 反馈持久化的 key，以及 TTS 朗读切换
  msgId?: string;
  // F-3.13 是否允许重新生成：流式输出中或正在加载时应禁用
  canRegenerate?: boolean;
}>();

const emit = defineEmits<{
  // F-3.13 重新生成：父组件处理"复用 user 问题 + 丢弃当前 assistant 回答 + 触发新问答"
  regenerate: [];
}>();

// F-3.13 反馈状态：'up' | 'down' | null
// 为什么用 ref + localStorage 同步：本地读取避免每次点击都查 localStorage
const feedback = ref<'up' | 'down' | null>(null);
const FEEDBACK_PREFIX = 'msg-feedback-';

// F-3.6 TTS：通过 store 协调多条消息的朗读切换，避免同时多条朗读
const ttsStore = useTtsStore();

// F-3.6 浏览器是否支持 speechSynthesis：不支持时灰显朗读按钮
const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

// F-3.6 当前消息朗读状态：仅当 currentMsgId === props.msgId 时才有意义
// 为什么用 computed：store 中 currentMsgId 变化时自动更新按钮图标
const ttsState = computed(() => {
  if (ttsStore.currentMsgId !== props.msgId) return 'idle';
  return ttsStore.state;
});

// F-3.6 朗读按钮图标：未朗读 → 🔊；朗读中 → ⏸；已暂停 → ▶
const ttsIcon = computed(() => {
  if (ttsState.value === 'playing') return VideoPause;
  if (ttsState.value === 'paused') return VideoPlay;
  return VideoPlay;
});
const ttsTitle = computed(() => {
  if (!ttsSupported) return '当前浏览器不支持语音朗读';
  if (ttsState.value === 'playing') return '暂停朗读';
  if (ttsState.value === 'paused') return '继续朗读';
  return '朗读';
});

onMounted(() => {
  // 恢复当前消息已记录的反馈状态
  if (props.msgId) {
    const saved = localStorage.getItem(FEEDBACK_PREFIX + props.msgId);
    if (saved === 'up' || saved === 'down') {
      feedback.value = saved;
    }
  }
});

// 复制到剪贴板：优先 navigator.clipboard（HTTPS / localhost 可用）
// 降级到 document.execCommand('copy')（兼容非 HTTPS 场景，如 HTTP 局域网访问）
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // 降级路径：创建临时 textarea + execCommand，兼容旧浏览器 / 非 HTTPS
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Markdown → 纯文本：剥离常见 markdown 语法
// 为什么不引入 marked.lexer：单文件正则足够覆盖 90% 场景，避免增加 bundle
// 为什么不复用 useTTS.ts 的 stripMarkdown：两者用途不同
//   - 这里用于「复制纯文本」：代码块需保留代码内容（用户希望粘贴可读源码）
//   - useTTS.ts 用于「语音朗读」：代码块替换为「代码块」占位（避免朗读源码）
//   - 拆分两份实现避免引入跨模块耦合，且各自职责清晰
function stripMarkdown(md: string): string {
  return md
    // 代码块：替换为占位（保留代码内容，去除 ``` 围栏）
    .replace(/```[\s\S]*?\n([\s\S]*?)```/g, (_, code) => code.trim())
    // 行内代码：去反引号
    .replace(/`([^`]+)`/g, '$1')
    // 图片：替换为 alt 文本
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // 链接：替换为文本
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 标题井号
    .replace(/^#{1,6}\s+/gm, '')
    // 引用块 >
    .replace(/^>\s+/gm, '')
    // 粗体/斜体
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // 删除线
    .replace(/~~([^~]+)~~/g, '$1')
    // 无序列表标记
    .replace(/^[-*+]\s+/gm, '')
    // 有序列表标记
    .replace(/^\d+\.\s+/gm, '')
    // 水平分割线
    .replace(/^---+$/gm, '')
    // 收敛多余空行
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function handleCopyPlain() {
  const ok = await copyToClipboard(stripMarkdown(props.content));
  ElMessage[ok ? 'success' : 'warning'](ok ? '已复制纯文本' : '复制失败，请手动选择');
}

async function handleCopyMarkdown() {
  const ok = await copyToClipboard(props.content);
  ElMessage[ok ? 'success' : 'warning'](ok ? '已复制 Markdown' : '复制失败，请手动选择');
}

// F-3.6 朗读切换：根据当前状态决定 speak / pause / resume / stop
// 切换到其他消息会自动停止当前（store.speak 内部已处理）
function handleTtsToggle() {
  if (!ttsSupported) {
    ElMessage.warning('当前浏览器不支持语音朗读');
    return;
  }
  if (!props.msgId) {
    ElMessage.warning('消息 ID 缺失，无法朗读');
    return;
  }
  if (ttsState.value === 'playing') {
    ttsStore.pause();
  } else if (ttsState.value === 'paused') {
    ttsStore.resume();
  } else {
    // idle 或其他消息朗读中 → 重新 speak
    // useTTS.stripMarkdown 已内置剥离，这里直接传原始 content
    ttsStore.speak(props.content, props.msgId);
  }
}

// F-3.13 重新生成：直接 emit，由父组件处理具体逻辑（删除消息、复用问题、重新触发）
function handleRegenerate() {
  if (props.canRegenerate === false) {
    ElMessage.warning('回答生成中，请稍后');
    return;
  }
  emit('regenerate');
}

// F-3.13 反馈：写 localStorage（v2.0.0 仅本地，后续可云端）
// 重复点击同一反馈 = 取消；点击相反反馈 = 切换
function handleFeedback(type: 'up' | 'down') {
  if (!props.msgId) {
    ElMessage.warning('消息 ID 缺失，无法记录反馈');
    return;
  }
  if (feedback.value === type) {
    // 取消反馈
    feedback.value = null;
    localStorage.removeItem(FEEDBACK_PREFIX + props.msgId);
    ElMessage.info('已取消反馈');
  } else {
    feedback.value = type;
    localStorage.setItem(FEEDBACK_PREFIX + props.msgId, type);
    ElMessage.success('感谢反馈');
  }
}
</script>

<template>
  <!-- F-3.7 / F-3.13 / F-3.6 浮窗：默认透明 + pointer-events:none，hover 父气泡时显现 -->
  <div class="msg-toolbar" @click.stop>
    <button
      class="toolbar-btn"
      title="复制纯文本"
      @click="handleCopyPlain"
    >
      <el-icon><Document /></el-icon>
    </button>
    <button
      class="toolbar-btn"
      title="复制 Markdown"
      @click="handleCopyMarkdown"
    >
      <el-icon><DocumentCopy /></el-icon>
    </button>
    <!-- F-3.6 朗读按钮：未朗读 ▶；朗读中 ⏸；已暂停 ▶；不支持时灰显 -->
    <button
      class="toolbar-btn"
      :class="{ active: ttsState !== 'idle', disabled: !ttsSupported }"
      :disabled="!ttsSupported"
      :title="ttsTitle"
      @click="handleTtsToggle"
    >
      <el-icon><component :is="ttsIcon" /></el-icon>
    </button>
    <!-- F-3.13 重新生成：复用该消息对应的 user 问题，重新发起问答 -->
    <button
      class="toolbar-btn"
      :class="{ disabled: canRegenerate === false }"
      :title="canRegenerate === false ? '回答生成中' : '重新生成'"
      @click="handleRegenerate"
    >
      <el-icon><RefreshRight /></el-icon>
    </button>
    <!-- F-3.13 反馈：👍 / 👎，写 localStorage 持久化 -->
    <button
      class="toolbar-btn"
      :class="{ active: feedback === 'up' }"
      title="点赞"
      @click="handleFeedback('up')"
    >👍</button>
    <button
      class="toolbar-btn"
      :class="{ active: feedback === 'down' }"
      title="点踩"
      @click="handleFeedback('down')"
    >👎</button>
  </div>
</template>

<style scoped>
.msg-toolbar {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  gap: 2px;
  padding: 2px 4px;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: var(--blur);
  border: 1px solid rgba(0, 245, 255, 0.2);
  border-radius: 6px;
  /* 默认隐藏：hover 父气泡才显现，避免常态视觉噪音 */
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease;
  z-index: 2;
}

.toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--text-soft, #888);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s ease;
  font-size: 13px;
}

.toolbar-btn:hover {
  background: rgba(0, 245, 255, 0.18);
  color: var(--neon-cyan, #00f5ff);
}

/* F-3.6 / F-3.13 激活态：高亮显示当前朗读/反馈状态 */
.toolbar-btn.active {
  background: rgba(0, 245, 255, 0.25);
  color: var(--neon-cyan, #00f5ff);
  box-shadow: inset 0 0 0 1px rgba(0, 245, 255, 0.5);
}

/* F-3.6 / F-3.13 禁用态：降低不透明度 + 阻止 hover 反馈 */
.toolbar-btn.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.toolbar-btn.disabled:hover {
  background: transparent;
  color: var(--text-soft, #888);
}

/* hover 父气泡时显现：触发规则由 Query.vue 控制
   为什么不放这里：scoped 隔离下无法选中父元素，需在父组件作用域定义 */
</style>

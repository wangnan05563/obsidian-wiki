<script setup lang="ts">
import { ref, computed } from 'vue';
import { useClipboard } from '../composables/useClipboard';
import { useTtsStore } from '../stores/tts';

// §2.5 MessageActions — 消息操作浮窗。
// 职责：hover assistant 消息时显示操作按钮（复制纯文本/复制 Markdown/朗读/重新生成/反馈）。
// 设计选择：复制提供两种模式（纯文本/Markdown），朗读通过 ttsStore 统一管理状态。
const props = defineProps<{
  message: { id: string; content: string };
  index: number;
}>();
const emit = defineEmits<{
  regenerate: [index: number];
  feedback: [index: number, type: 'up' | 'down'];
}>();

const { copy, copyPlainText } = useClipboard();
const ttsStore = useTtsStore();
const copiedPlain = ref(false);
const copiedMd = ref(false);

async function handleCopyPlain() {
  await copy(copyPlainText(props.message.content));
  copiedPlain.value = true;
  setTimeout(() => (copiedPlain.value = false), 2000);
}

async function handleCopyMd() {
  await copy(props.message.content);
  copiedMd.value = true;
  setTimeout(() => (copiedMd.value = false), 2000);
}

// 朗读按钮：当前正在朗读此消息则停止，否则开始朗读
const isCurrentPlaying = computed(() =>
  ttsStore.state === 'playing' && ttsStore.currentMsgId === props.message.id,
);

function handleTts() {
  if (isCurrentPlaying.value) {
    ttsStore.stop();
  } else {
    ttsStore.speak(props.message.content, props.message.id);
  }
}

function handleFeedback(type: 'up' | 'down') {
  emit('feedback', props.index, type);
}
</script>

<template>
  <div class="message-actions">
    <button class="action-btn" :class="{ active: copiedPlain }" @click="handleCopyPlain" title="复制纯文本">
      <span v-if="copiedPlain">✓</span>
      <span v-else>📋</span>
      <span class="btn-label">{{ copiedPlain ? '已复制' : '纯文本' }}</span>
    </button>
    <button class="action-btn" :class="{ active: copiedMd }" @click="handleCopyMd" title="复制 Markdown">
      <span v-if="copiedMd">✓</span>
      <span v-else>📝</span>
      <span class="btn-label">{{ copiedMd ? '已复制' : 'MD' }}</span>
    </button>
    <button class="action-btn" :class="{ active: isCurrentPlaying }" @click="handleTts" title="语音朗读">
      <span>{{ isCurrentPlaying ? '⏹' : '🔊' }}</span>
      <span class="btn-label">{{ isCurrentPlaying ? '停止' : '朗读' }}</span>
    </button>
    <button class="action-btn" @click="emit('regenerate', props.index)" title="重新生成">
      <span>🔄</span>
      <span class="btn-label">重生成</span>
    </button>
    <button class="action-btn" @click="handleFeedback('up')" title="赞">
      <span>👍</span>
    </button>
    <button class="action-btn" @click="handleFeedback('down')" title="踩">
      <span>👎</span>
    </button>
  </div>
</template>

<style scoped>
.message-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  opacity: 0;
  transition: opacity 0.2s;
}
.action-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--text-soft, #888);
  font-size: 12px;
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.2s;
}
.action-btn:hover {
  background: var(--accent-cyan-a10, rgba(0, 245, 255, 0.1));
  color: var(--neon-cyan, #00f5ff);
}
.action-btn.active {
  color: var(--neon-cyan, #00f5ff);
}
.btn-label {
  font-size: 11px;
}
</style>

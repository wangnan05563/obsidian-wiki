<script setup lang="ts">
import { computed } from 'vue';
import { VideoPlay, VideoPause, Bell, Close } from '@element-plus/icons-vue';
import { useTtsStore } from '../stores/tts';

// §2.x TtsController — TTS 全局浮动控制器。
// 职责：朗读进行时显示在消息区底部，提供暂停/继续/停止控制。
// 设计选择：仅在 state !== 'idle' 时显示，避免遮挡内容。
const ttsStore = useTtsStore();

const statusText = computed(() => {
  if (ttsStore.state === 'playing') return '朗读中';
  if (ttsStore.state === 'paused') return '已暂停';
  return '';
});

function handlePauseResume() {
  if (ttsStore.state === 'playing') {
    ttsStore.pause();
  } else if (ttsStore.state === 'paused') {
    ttsStore.resume();
  }
}

function handleStop() {
  ttsStore.stop();
}
</script>

<template>
  <transition name="slide-up">
    <div v-if="ttsStore.state !== 'idle'" class="tts-controller">
      <el-icon class="tts-icon"><Bell /></el-icon>
      <span class="tts-status">{{ statusText }}</span>
      <div class="tts-controls">
        <button class="ctrl-btn" @click="handlePauseResume" :title="ttsStore.state === 'playing' ? '暂停' : '继续'">
          <el-icon><component :is="ttsStore.state === 'playing' ? VideoPause : VideoPlay" /></el-icon>
        </button>
        <button class="ctrl-btn" @click="handleStop" title="停止">
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.tts-controller {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  background: var(--bg-card-solid, rgba(26, 26, 46, 0.92));
  backdrop-filter: var(--blur, blur(12px));
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  border-radius: 24px;
  box-shadow: 0 4px 20px var(--accent-cyan-a15, rgba(0, 245, 255, 0.15));
  z-index: 100;
  font-size: 13px;
  color: var(--text-main, #ccc);
}
.tts-icon {
  font-size: 14px;
}
.tts-status {
  color: var(--neon-cyan, #00f5ff);
  font-size: 12px;
}
.tts-controls {
  display: flex;
  gap: 4px;
}
.ctrl-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
  color: var(--neon-cyan, #00f5ff);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}
.ctrl-btn:hover {
  background: var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  border-color: var(--neon-cyan, #00f5ff);
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease;
}
.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(20px);
}
</style>

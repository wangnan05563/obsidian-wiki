<script setup lang="ts">
import { computed } from 'vue';
import { Microphone, VideoPause, VideoPlay, Headset, Check } from '@element-plus/icons-vue';
import { useTtsStore } from '../../stores/tts';
import { useListenQueueStore } from '../../stores/listenQueue';

// T02942（FR-QRY-06 前半句）：移动端助手消息的朗读入口。
// 窄屏不照搬桌面 hover 工具条，改为气泡内常驻两个小按钮：
//   朗读 —— 复用 ttsStore.speak(text, msgId)，切换消息时 store 先停旧朗读；
//   加入聆听 —— 写入 MobileListen 共用的播放列表（listenQueue store）。
const props = defineProps<{ message: { id: string; content: string } }>();

const ttsStore = useTtsStore();
const listenQueue = useListenQueueStore();

// 同一条消息的三种朗读态：playing → 停止；paused → 继续；否则 → 朗读
const isCurrent = computed(() => ttsStore.currentMsgId === props.message.id);
const speaking = computed(() => isCurrent.value && ttsStore.state === 'playing');
const paused = computed(() => isCurrent.value && ttsStore.state === 'paused');
const speakLabel = computed(() => {
  if (speaking.value) return '停止';
  if (paused.value) return '继续';
  return '朗读';
});

const path = computed(() => `message:${props.message.id}`);
const inListen = computed(() => listenQueue.has(path.value));

function toggleSpeak(): void {
  if (speaking.value) ttsStore.stop();
  else if (paused.value) ttsStore.resume();
  else ttsStore.speak(props.message.content, props.message.id);
}

/** 标题取正文首个有效行（去 Markdown 标记），超长截断——与聆听列表的曲目名口径一致 */
function listenTitle(content: string): string {
  const line = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('---') && !l.startsWith('```'));
  const clean = (line ?? '').replace(/^#{1,6}\s*/, '').replace(/[*_`>]/g, '').trim();
  return (clean || '问答回答').slice(0, 40);
}

function addToListen(): void {
  listenQueue.add({ path: path.value, title: listenTitle(props.message.content), body: props.message.content });
}
</script>

<template>
  <div class="mq-msg-actions">
    <button class="mq-msg-btn" :class="{ on: speaking || paused }" :title="speakLabel" @click="toggleSpeak">
      <VideoPause v-if="speaking" />
      <VideoPlay v-else-if="paused" />
      <Microphone v-else />
      <span>{{ speakLabel }}</span>
    </button>
    <button class="mq-msg-btn" :class="{ added: inListen }" :disabled="inListen" :title="inListen ? '已在聆听列表' : '加入聆听播放列表'" @click="addToListen">
      <Check v-if="inListen" />
      <Headset v-else />
      <span>{{ inListen ? '已在聆听' : '加入聆听' }}</span>
    </button>
  </div>
</template>

<style scoped>
.mq-msg-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.mq-msg-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--m-border-2, #e2e4e8);
  border-radius: 999px;
  background: var(--m-surface, #ffffff);
  color: var(--m-text-2, #666666);
  font-family: var(--m-font, inherit);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.mq-msg-btn svg {
  width: 14px;
  height: 14px;
}
.mq-msg-btn:active {
  background: var(--m-fill, #f4f5f7);
}
.mq-msg-btn.on {
  color: var(--m-primary, #1554d1);
  border-color: var(--m-primary, #1554d1);
  background: var(--m-primary-soft, rgba(21, 84, 209, 0.08));
}
.mq-msg-btn.added {
  color: var(--m-text-3, #9aa0a6);
  background: var(--m-fill, #f4f5f7);
  cursor: default;
}
</style>

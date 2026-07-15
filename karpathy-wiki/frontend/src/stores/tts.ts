import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useTTS } from '../composables/useTTS';

// §3.4 useTtsStore — TTS 状态管理。
// 职责：协调多条消息的朗读切换，确保同时只有一条消息在朗读。
// 设计选择：在 store 层组合 useTTS composable，避免每个 MessageActions 实例各持一份 speechSynthesis 句柄。
export const useTtsStore = defineStore('tts', () => {
  const state = ref<'idle' | 'playing' | 'paused'>('idle');
  const currentMsgId = ref<string | null>(null);
  const { speak: ttsSpeak, pause: ttsPause, resume: ttsResume, stop: ttsStop } = useTTS();

  function speak(text: string, msgId: string) {
    // 切换到新消息时停止当前朗读，避免语音队列堆积
    if (currentMsgId.value && currentMsgId.value !== msgId) {
      ttsStop();
    }
    currentMsgId.value = msgId;
    state.value = 'playing';
    ttsSpeak(text);
  }

  function pause() {
    ttsPause();
    state.value = 'paused';
  }

  function resume() {
    ttsResume();
    state.value = 'playing';
  }

  function stop() {
    ttsStop();
    state.value = 'idle';
    currentMsgId.value = null;
  }

  return { state, currentMsgId, speak, pause, resume, stop };
});

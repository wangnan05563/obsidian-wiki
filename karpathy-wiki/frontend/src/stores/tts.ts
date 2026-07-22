import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useTTS } from '../composables/useTTS';

// §3.4 useTtsStore — TTS 状态管理。
// 职责：协调多条消息的朗读切换，确保同时只有一条消息在朗读。
// 设计选择：在 store 层组合 useTTS composable，避免每个 MessageActions 实例各持一份 speechSynthesis 句柄。
// F-3.6 语速调节：rate/currentText 暴露给组件，朗读中调整 rate 时用 currentText 重启 utterance
export const useTtsStore = defineStore('tts', () => {
  const state = ref<'idle' | 'playing' | 'paused'>('idle');
  const currentMsgId = ref<string | null>(null);
  // 保留当前朗读文本：朗读中调整 rate 需重启 utterance，必须持有原文
  const currentText = ref('');
  // F-3.6 在 store 内创建独立 rate ref
  // 为什么不引用 useTTS.rate：Pinia setup store 实测不暴露从 composable 引用/解构的 ref/computed，
  // 即使改为 const tts = useTTS() + computed(() => tts.rate.value) 也无效（storeKeys 仍缺 rate/setRate）
  // 在 store 内直接 ref(1) 让 Pinia 必然识别为 state，setRate 同步到 useTTS 内部
  const rate = ref(1);

  const tts = useTTS();

  function speak(text: string, msgId: string) {
    // 切换到新消息时停止当前朗读，避免语音队列堆积
    if (currentMsgId.value && currentMsgId.value !== msgId) {
      tts.stop();
    }
    currentMsgId.value = msgId;
    currentText.value = text;
    state.value = 'playing';
    // 同步当前 rate 到 useTTS 内部，防御 composable 内 rate 漂移
    tts.setRate(rate.value);
    tts.speak(text);
  }

  function pause() {
    tts.pause();
    state.value = 'paused';
  }

  function resume() {
    tts.resume();
    state.value = 'playing';
  }

  function stop() {
    tts.stop();
    state.value = 'idle';
    currentMsgId.value = null;
    currentText.value = '';
  }

  // F-3.6 修改语速：clamp 后写入 store.rate，并同步到 useTTS 内部
  // 朗读中调整时重启 utterance 应用新 rate；非朗读态仅更新 rate 供下次 speak 使用
  function setRate(newRate: number) {
    rate.value = Math.min(2, Math.max(0.5, newRate));
    // 仅 state='playing' 时传 restartText 触发重启，避免 idle/paused 态无意义重启
    tts.setRate(rate.value, state.value === 'playing' ? currentText.value : undefined);
  }

  return { state, currentMsgId, rate, speak, pause, resume, stop, setRate };
});

import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { useTTS } from '../composables/useTTS';
import type { TTSProviderType } from '../composables/tts';
import { useAuthStore } from './auth';
import { loadTtsConfig, saveTtsConfig, DEFAULT_TTS_CONFIG, type TtsUserConfig } from '../services/ttsConfig';

// §3.4 useTtsStore — TTS 状态管理。
// 职责：协调多条消息的朗读切换，确保同时只有一条消息在朗读。
// 设计选择：在 store 层组合 useTTS composable，避免每个 MessageActions 实例各持一份 speechSynthesis 句柄。
// F-3.6 语速调节：rate/currentText 暴露给组件，朗读中调整 rate 时用 currentText 重启 utterance
//
// 按用户维度隔离（需求：配置数据按用户隔离存储与读取）：
//   - 当前登录用户的朗读配置从 IndexedDB（chatDb.preferences，键名含 userId）读取与写入；
//   - 登录/切换账户/登出时通过 watch(authStore.user?.id) 重新加载对应用户的配置，互不干扰；
//   - 未登录（游客）使用 'guest' 命名空间，避免与已登录用户配置混淆。
export const useTtsStore = defineStore('tts', () => {
  const state = ref<'idle' | 'playing' | 'paused'>('idle');
  const currentMsgId = ref<string | null>(null);
  // 保留当前朗读文本：朗读中调整 rate 需重启 utterance，必须持有原文
  const currentText = ref('');
  // F-3.6 在 store 内创建独立 rate ref
  const rate = ref(DEFAULT_TTS_CONFIG.rate);

  const tts = useTTS();
  const authStore = useAuthStore();

  // 当前 provider 名称（'edge' / 'browser' / 'doubao'）：供 UI 显示与切换
  const providerName = computed(() => tts.providerName.value);

  // 当前用户 id（用于 per-user 配置读写）；未登录时为 'guest'
  const currentUserId = ref<string>('guest');

  // 从默认配置初始化（loadForUser 会在用户确定后覆盖为实际存储值）
  const currentVoice = ref<string>(DEFAULT_TTS_CONFIG.voice);
  const currentStyle = ref<string>(DEFAULT_TTS_CONFIG.style);
  const currentVolume = ref<number>(DEFAULT_TTS_CONFIG.volume);
  const currentPitch = ref<number>(DEFAULT_TTS_CONFIG.pitch);

  // 说话风格 → prosody 预设映射。
  // 说明：本环境免费 Edge TTS 端点不支持 <mstts:express-as>（实测被拒绝），
  // 故用 prosody（语速/音量/音调）微调模拟不同朗读"性格"，沿用 20_News 的 prosody 拟人思路。
  const STYLE_PRESETS: Record<string, { rate: number; volume: number; pitch: number }> = {
    general:            { rate: 1.0,  volume: 0,  pitch: 0 },
    'narration-relaxed': { rate: 0.95, volume: 2,  pitch: 1 },
    chat:               { rate: 1.05, volume: 0,  pitch: 2 },
    newscast:           { rate: 1.08, volume: 3,  pitch: -1 },
    'newscast-casual':  { rate: 1.02, volume: 2,  pitch: 0 },
    empathetic:         { rate: 0.92, volume: 0,  pitch: 1 },
    calm:               { rate: 0.9,  volume: -2, pitch: -1 },
    gentle:             { rate: 0.93, volume: 0,  pitch: 2 },
    cheerful:           { rate: 1.08, volume: 3,  pitch: 3 },
    serious:            { rate: 1.0,  volume: 1,  pitch: -2 },
  };

  // 应用风格预设：同步 rate/volume/pitch（clamp）。注意：此处不写入存储，
  // 由调用方 setStyle 统一持久化，避免"仅改风格"与"持久化"逻辑分散。
  function applyStylePreset(style: string): void {
    const p = STYLE_PRESETS[style] ?? STYLE_PRESETS.general;
    rate.value = Math.min(2, Math.max(0.5, p.rate));
    currentVolume.value = Math.min(30, Math.max(-30, Math.round(p.volume)));
    currentPitch.value = Math.min(10, Math.max(-10, Math.round(p.pitch)));
    restartCurrent();
  }

  // 当前朗读参数变化时，若正在朗读则重启当前文本以应用（音色/风格/音量/音调/引擎）
  function restartCurrent(): void {
    if (state.value !== 'playing' || !currentText.value || !currentMsgId.value) return;
    tts.setRate(rate.value);
    tts.speak(currentText.value, {
      lang: 'zh-CN',
      rate: rate.value,
      voice: currentVoice.value,
      style: currentStyle.value,
      volume: currentVolume.value,
      pitch: currentPitch.value,
    });
  }

  // ===== 按用户维度加载/持久化 =====

  // 加载指定用户的配置：覆盖当前所有朗读参数，并切换 provider。
  // 用递增 token 防止快速切换账户时旧异步加载覆盖新加载（竞态保护）。
  let loadToken = 0;
  async function loadForUser(userId: string): Promise<void> {
    const uid = userId || 'guest';
    currentUserId.value = uid;
    const token = ++loadToken;
    const cfg = await loadTtsConfig(uid);
    if (token !== loadToken) return; // 已被更新的加载取代，丢弃本次结果
    currentVoice.value = cfg.voice;
    currentStyle.value = cfg.style;
    rate.value = cfg.rate;
    currentVolume.value = cfg.volume;
    currentPitch.value = cfg.pitch;
    tts.setProvider(cfg.provider);
  }

  // 持久化当前配置到当前用户的命名空间（fire-and-forget，失败静默降级）
  function persist(): void {
    if (!currentUserId.value) return;
    const cfg: TtsUserConfig = {
      provider: (tts.providerName.value as TTSProviderType) ?? DEFAULT_TTS_CONFIG.provider,
      voice: currentVoice.value,
      style: currentStyle.value,
      rate: rate.value,
      volume: currentVolume.value,
      pitch: currentPitch.value,
    };
    void saveTtsConfig(currentUserId.value, cfg);
  }

  // 监听登录用户变化：登录/切换账户/登出时重新加载对应用户配置，实现隔离。
  // immediate 触发首次加载（此时可能为游客 'guest'，登录后自动重载为真实用户）。
  watch(
    () => authStore.user?.id,
    (id) => { void loadForUser(id ?? 'guest'); },
    { immediate: true },
  );

  function speak(text: string, msgId: string) {
    // 切换到新消息时停止当前朗读，避免语音队列堆积
    if (currentMsgId.value && currentMsgId.value !== msgId) {
      tts.stop();
    }
    currentMsgId.value = msgId;
    currentText.value = text;
    state.value = 'playing';
    // 同步当前 rate/voice/style/volume/pitch 到 useTTS 内部，防御 composable 内漂移
    tts.setRate(rate.value);
    tts.speak(text, {
      lang: 'zh-CN',
      rate: rate.value,
      voice: currentVoice.value,
      style: currentStyle.value,
      volume: currentVolume.value,
      pitch: currentPitch.value,
    });
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
  // 朗读中调整时通过 restartCurrent() 重启 utterance，确保 voice/style/volume/pitch
  // 等 per-user 参数一并生效（useTTS.setRate 若自行重启只会传 rate，会丢失音色/风格）。
  function setRate(newRate: number) {
    rate.value = Math.min(2, Math.max(0.5, newRate));
    // 仅更新速率值，不直接触发重启（避免丢失 per-user 参数）
    tts.setRate(rate.value);
    if (state.value === 'playing') restartCurrent();
    persist();
  }

  // 切换 TTS provider（edge / browser / doubao）
  function setProvider(type: TTSProviderType) {
    tts.setProvider(type);
    persist();
    restartCurrent();
  }

  // 切换音色（仅 edge provider 生效）
  function setVoice(voice: string) {
    currentVoice.value = voice;
    persist();
    restartCurrent();
  }

  // 切换风格：存储风格名并应用其 prosody 预设（语速/音量/音调），
  // 让"说话风格"芯片真正改变听感（模拟不同朗读性格），随后持久化
  function setStyle(style: string) {
    currentStyle.value = style;
    applyStylePreset(style);
    persist();
  }

  // 调整音量偏移（百分点，-30~+30）
  function setVolume(volume: number) {
    currentVolume.value = Math.min(30, Math.max(-30, Math.round(volume)));
    persist();
    restartCurrent();
  }

  // 调整音调偏移（赫兹，-10~+10）
  function setPitch(pitch: number) {
    currentPitch.value = Math.min(10, Math.max(-10, Math.round(pitch)));
    persist();
    restartCurrent();
  }

  return { state, currentMsgId, rate, providerName, currentVoice, currentStyle, currentVolume, currentPitch, speak, pause, resume, stop, setRate, setProvider, setVoice, setStyle, setVolume, setPitch };
});

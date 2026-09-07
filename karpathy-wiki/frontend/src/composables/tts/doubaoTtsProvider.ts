import { ref, type Ref } from 'vue';
import { API_BASE, apiFetch } from '../../utils/apiBase';
import type { TTSProvider, TTSState, TTSSpeakOptions } from './types';

// DoubaoTTSProvider：基于后端代理的豆包 TTS（volcengine）云端朗读。
// 设计动机：浏览器原生 speechSynthesis 中文音色机械、音质差，
//   豆包 TTS 提供更自然的语音合成（参考豆包 App 体验）。
//   前端不直接调 volcengine：避免泄露 API key，由后端 /api/tts/synthesize 代理。
//
// 现状（v2.0.0）：
//   - 此 provider 是预留接口，前端 UI 可选用但底层抛 "未启用" 错误
//   - 后端 /api/tts/synthesize 路由尚未实现（依赖用户配置 volcengine API key）
//   - 当后端实现 + 前端 toggle 开关启用后即可直接生效
//
// 实现细节：
//   - 用 HTMLAudioElement 播放后端返回的音频流（mp3/wav/pcm 由后端决定）
//   - pause/resume/stop 通过 audio 元素原生方法控制
//   - state 同步通过 audio 的 play/pause/end 事件维护

export interface DoubaoTTSConfig {
  /** 豆包 voice_id（如 'BV001_streaming' / 'BV002_streaming'），不指定则由后端默认 */
  voice?: string;
  /** 语速倍率，0.5 - 2.0 */
  rate?: number;
  /** 后端 TTS 路由路径，默认 /api/tts/synthesize */
  endpoint?: string;
}

export function createDoubaoTTSProvider(config: DoubaoTTSConfig = {}): TTSProvider & { state: Ref<TTSState> } {
  const state: Ref<TTSState> = ref('idle');
  let currentAudio: HTMLAudioElement | null = null;

  function clearAudio() {
    if (currentAudio) {
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudio.onpause = null;
      currentAudio.onplay = null;
      currentAudio.pause();
      currentAudio.src = '';
      // 不 remove()：复用 audio 元素避免频繁创建；释放 src 即可
      currentAudio = null;
    }
  }

  const provider: TTSProvider & { state: Ref<TTSState> } = {
    name: 'doubao',
    state,

    isSupported(): boolean {
      // Doubao TTS 需要后端启用 + 用户在 Config 中配置 volcengine API key
      // 前端无配置中心化开关前用 feature flag 判断：localStorage 显式 opt-in
      try {
        return localStorage.getItem('tts.provider') === 'doubao';
      } catch {
        return false;
      }
    },

    speak(text: string, options?: TTSSpeakOptions): void {
      if (!this.isSupported()) {
        // 未启用时给出清晰提示，让用户知道如何启用
        console.warn('豆包 TTS 未启用：在 localStorage 设置 tts.provider = "doubao" 并确保后端 /api/tts/synthesize 已实现');
        return;
      }
      // 切换朗读前清理旧 audio
      clearAudio();

      // 调用后端 TTS 接口获取音频 URL/blob
      // 后端预期返回 { url: string } 或直接音频流（Content-Type: audio/mpeg）
      const endpoint = config.endpoint ?? '/api/tts/synthesize';
      const voice = options?.voice ?? config.voice;
      const rate = options?.rate ?? config.rate ?? 1;

      const audio = new Audio();
      currentAudio = audio;

      // 异步获取音频并播放：避免阻塞 speak() 调用契约
      void (async () => {
        try {
          const res = await apiFetch(`${API_BASE}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice, rate }),
          });
          if (!res.ok) {
            throw new Error(`TTS API HTTP ${res.status}`);
          }
          const data = (await res.json()) as { url?: string; audioBase64?: string };
          if (data.url) {
            audio.src = data.url;
          } else if (data.audioBase64) {
            // 后端可选择直接返回 base64，前端转 dataURL
            audio.src = `data:audio/mpeg;base64,${data.audioBase64}`;
          } else {
            throw new Error('TTS API 返回缺少 url/audioBase64');
          }

          audio.onended = () => {
            state.value = 'idle';
          };
          audio.onerror = () => {
            state.value = 'idle';
            console.error('豆包 TTS 音频播放失败');
          };
          audio.onplay = () => {
            state.value = 'playing';
          };
          audio.onpause = () => {
            // 仅在用户主动 pause 时更新为 paused；自然结束由 onend 处理
            if (state.value === 'playing') state.value = 'paused';
          };

          await audio.play();
        } catch (err) {
          console.error('豆包 TTS 合成失败：', err);
          state.value = 'idle';
        }
      })();
    },

    pause(): void {
      currentAudio?.pause();
      state.value = 'paused';
    },

    resume(): void {
      // audio.play() 返回 Promise，可能因 autoplay policy 失败，需捕获
      currentAudio?.play().catch((err) => {
        console.error('豆包 TTS resume 失败：', err);
        state.value = 'idle';
      });
      state.value = 'playing';
    },

    stop(): void {
      clearAudio();
      state.value = 'idle';
    },

    dispose(): void {
      this.stop();
    },
  };

  return provider;
}

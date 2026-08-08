import { ref, watch, type Ref } from 'vue';
import { API_BASE } from '../../utils/apiBase';
import type { TTSProvider, TTSState, TTSSpeakOptions } from './types';
import { createBrowserTTSProvider } from './browserTtsProvider';

// EdgeTtsProvider：基于后端 /api/tts/synthesize 的微软 Edge 神经网络语音朗读。
//
// 设计动机：
//   - 浏览器原生 speechSynthesis 中文音色机械、不自然，用户体验差
//   - 微软 Edge TTS 提供与 Azure 同源的神经网络音色（晓晓/云扬等），免费、无 API Key、音质自然
//   - 参考 20_News 项目 Python edge-tts 方案，后端用 undici WebSocket 实现，前端通过 HTTP API 调用
//
// 与 DoubaoTTSProvider 的区别：
//   - Doubao 需要用户配置 volcengine API key，后端路由未实现（预留）
//   - Edge TTS 完全免费、零配置、后端已实现 /api/tts/synthesize
//   - Edge TTS 作为默认 provider，Doubao 作为可选升级路径保留
//
// 实现细节：
//   - 用 HTMLAudioElement 播放后端返回的 MP3 音频流
//   - pause/resume/stop 通过 audio 元素原生方法控制
//   - state 同步通过 audio 的 play/pause/end 事件维护
//   - 支持音色选择（通过 localStorage 持久化用户选择的音色）
//   - 长文本分段合成：超过 2000 字按句号分段，逐段合成播放

/** 默认音色：晓晓（温婉自然的女声，适合知识朗读） */
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/** 默认风格：轻松讲述（narration-relaxed），最适合知识库朗读，显著提升拟人度 */
const DEFAULT_STYLE = 'narration-relaxed';

/** 单次合成文本上限（与后端一致，前端提前分段避免超限） */
const MAX_TEXT_PER_REQUEST = 2000;

/** 将数字音量偏移（-30~+30）转换为 SSML 百分比格式 */
export function volToSsml(volume: number): string {
  const pct = Math.round(volume);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

/** 将数字音调偏移（-10~+10）转换为 SSML 赫兹格式 */
export function pitchToSsml(pitch: number): string {
  const hz = Math.round(pitch);
  return hz >= 0 ? `+${hz}Hz` : `${hz}Hz`;
}

/** 将数字语速（0.5-2.0）转换为 SSML percentage 格式 */
export function rateToSsml(rate: number): string {
  const percentage = Math.round((rate - 1) * 100);
  return percentage >= 0 ? `+${percentage}%` : `${percentage}%`;
}

/** 将长文本按句号/换行分段，每段不超过 MAX_TEXT_PER_REQUEST 字 */
export function splitText(text: string): string[] {
  if (text.length <= MAX_TEXT_PER_REQUEST) return [text];
  const segments: string[] = [];
  // 按句号、问号、感叹号、换行分段
  const sentences = text.split(/(?<=[。！？\n.!?])\s*/);
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > MAX_TEXT_PER_REQUEST) {
      if (current) segments.push(current);
      // 单句超长时硬切
      if (sentence.length > MAX_TEXT_PER_REQUEST) {
        for (let i = 0; i < sentence.length; i += MAX_TEXT_PER_REQUEST) {
          segments.push(sentence.slice(i, i + MAX_TEXT_PER_REQUEST));
        }
        current = '';
      } else {
        current = sentence;
      }
    } else {
      current += sentence;
    }
  }
  if (current) segments.push(current);
  return segments;
}

export function createEdgeTTSProvider(): TTSProvider & { state: Ref<TTSState> } {
  const state: Ref<TTSState> = ref('idle');
  let currentAudio: HTMLAudioElement | null = null;
  // 分段播放队列
  let segmentQueue: string[] = [];
  let currentSegmentIndex = 0;
  let currentRate = 1;
  let currentVoice = DEFAULT_VOICE;
  let currentLang = 'zh-CN';
  let currentStyle = DEFAULT_STYLE;
  let currentVolume = 0;
  let currentPitch = 0;
  // abort flag：stop() 后阻止后续段落继续播放
  let aborted = false;

  // 降级到浏览器原生 TTS 时使用（当后端 Edge TTS 不可达，保证朗读功能始终可用）
  let originalText = '';
  let originalOptions: TTSSpeakOptions | undefined;
  let fallbackProvider: ReturnType<typeof createBrowserTTSProvider> | null = null;
  let stopFallbackWatch: (() => void) | null = null;

  /** 降级到浏览器原生 speechSynthesis（Edge TTS 不可用时兜底） */
  function fallbackToBrowser(): void {
    if (fallbackProvider) {
      stopFallbackWatch?.();
      fallbackProvider.dispose();
    }
    fallbackProvider = createBrowserTTSProvider() as ReturnType<typeof createBrowserTTSProvider>;
    // 将浏览器 provider 的 state 桥接到本 provider，保持 UI 状态一致
    stopFallbackWatch = watch(
      fallbackProvider.state,
      (v) => { state.value = v; },
      { flush: 'sync' },
    );
    state.value = 'playing';
    fallbackProvider.speak(originalText, originalOptions);
  }

  function clearAudio() {
    if (currentAudio) {
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudio.onpause = null;
      currentAudio.onplay = null;
      currentAudio.pause();
      currentAudio.src = '';
      currentAudio = null;
    }
  }

  /** 播放下一段文本（分段合成场景） */
  async function playNextSegment() {
    if (aborted) return;
    if (currentSegmentIndex >= segmentQueue.length) {
      state.value = 'idle';
      return;
    }

    const text = segmentQueue[currentSegmentIndex];
    const voice = currentVoice;
    const rateStr = rateToSsml(currentRate);
    const volumeStr = volToSsml(currentVolume);
    const pitchStr = pitchToSsml(currentPitch);
    const styleStr = currentStyle && currentStyle !== 'general' ? currentStyle : '';

    try {
      const res = await fetch(`${API_BASE}/api/tts/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, rate: rateStr, volume: volumeStr, pitch: pitchStr, style: styleStr }),
      });
      if (!res.ok) {
        throw new Error(`TTS API HTTP ${res.status}`);
      }

      if (aborted) return;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      // 释放上一段的 object URL 避免内存泄漏
      if (currentAudio?.src.startsWith('blob:')) {
        URL.revokeObjectURL(currentAudio.src);
      }

      const audio = new Audio(url);
      currentAudio = audio;

      audio.onended = () => {
        currentSegmentIndex++;
        if (currentSegmentIndex < segmentQueue.length && !aborted) {
          void playNextSegment();
        } else {
          state.value = 'idle';
          // 播放完毕释放最后一段的 object URL
          if (audio.src.startsWith('blob:')) {
            URL.revokeObjectURL(audio.src);
          }
        }
      };
      audio.onerror = () => {
        console.error('Edge TTS 音频播放失败');
        state.value = 'idle';
      };
      audio.onplay = () => {
        if (!aborted) state.value = 'playing';
      };

      await audio.play();
    } catch (err) {
      console.error('Edge TTS 合成失败：', err);
      // 首段即失败：整段降级到浏览器原生 TTS，保证朗读功能始终可用
      if (currentSegmentIndex === 0 && !aborted) {
        fallbackToBrowser();
      } else {
        state.value = 'idle';
      }
    }
  }

  const provider: TTSProvider & { state: Ref<TTSState> } = {
    name: 'edge',
    state,

    isSupported(): boolean {
      // Edge TTS 通过后端 API 实现，无需浏览器特性检测
      // 只要后端运行即可用（前端无法同步检测后端状态，乐观返回 true）
      return true;
    },

    speak(text: string, options?: TTSSpeakOptions): void {
      // 切换朗读前清理旧 audio 和队列
      aborted = true;
      clearAudio();
      // 清理可能正在运行的浏览器降级 provider
      if (fallbackProvider) {
        stopFallbackWatch?.();
        fallbackProvider.dispose();
        fallbackProvider = null;
        stopFallbackWatch = null;
      }
      aborted = false;

      currentRate = options?.rate ?? 1;
      currentVoice = options?.voice ?? DEFAULT_VOICE;
      currentLang = options?.lang ?? 'zh-CN';
      currentStyle = options?.style ?? DEFAULT_STYLE;
      currentVolume = options?.volume ?? 0;
      currentPitch = options?.pitch ?? 0;
      originalText = text;
      originalOptions = options;

      // 分段
      segmentQueue = splitText(text);
      currentSegmentIndex = 0;

      if (segmentQueue.length === 0) {
        state.value = 'idle';
        return;
      }

      state.value = 'playing';
      void playNextSegment();
    },

    pause(): void {
      // 浏览器降级场景：委托给 fallback provider
      if (fallbackProvider) {
        fallbackProvider.pause();
        state.value = 'paused';
        return;
      }
      currentAudio?.pause();
      state.value = 'paused';
    },

    resume(): void {
      // 浏览器降级场景：委托给 fallback provider
      if (fallbackProvider) {
        fallbackProvider.resume();
        state.value = 'playing';
        return;
      }
      currentAudio?.play().catch((err) => {
        console.error('Edge TTS resume 失败：', err);
        state.value = 'idle';
      });
      state.value = 'playing';
    },

    stop(): void {
      aborted = true;
      clearAudio();
      if (fallbackProvider) {
        fallbackProvider.stop();
      }
      segmentQueue = [];
      currentSegmentIndex = 0;
      state.value = 'idle';
    },

    dispose(): void {
      this.stop();
      stopFallbackWatch?.();
    },
  };

  return provider;
}

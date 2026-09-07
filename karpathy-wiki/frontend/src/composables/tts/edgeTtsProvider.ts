import { ref, watch, type Ref } from 'vue';
import { API_BASE, apiFetch } from '../../utils/apiBase';
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

/** 将超长句子硬切成不超过 MAX_TEXT_PER_REQUEST 的片段 */
function splitLongSentence(sentence: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < sentence.length; i += MAX_TEXT_PER_REQUEST) {
    parts.push(sentence.slice(i, i + MAX_TEXT_PER_REQUEST));
  }
  return parts;
}

export function splitText(text: string): string[] {
  if (text.length <= MAX_TEXT_PER_REQUEST) return [text];
  const segments: string[] = [];
  // 按句号、问号、感叹号、换行分段
  const sentences = text.split(/(?<=[。！？\n.!?])\s*/);
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > MAX_TEXT_PER_REQUEST) {
      if (current) segments.push(current);
      if (sentence.length > MAX_TEXT_PER_REQUEST) {
        segments.push(...splitLongSentence(sentence));
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

export function createEdgeTTSProvider(): TTSProvider & { state: Ref<TTSState>; loading: Ref<boolean> } {
  const state: Ref<TTSState> = ref('idle');
  // loading：true 表示正在向后端 /api/tts/synthesize 请求合成 / 等待 audio.play()，
  // 用于 store 与 UI 屏蔽重复点击导致的"叠加"朗读
  const loading = ref(false);
  let currentAudio: HTMLAudioElement | null = null;
  // 分段播放队列
  let segmentQueue: string[] = [];
  let currentSegmentIndex = 0;
  let currentRate = 1;
  let currentVoice = DEFAULT_VOICE;
  let currentStyle = DEFAULT_STYLE;
  let currentVolume = 0;
  let currentPitch = 0;
  // abort flag：stop() 后阻止后续段落继续播放
  let aborted = false;
  // requestId：每次 speak 自增，await fetch / await play 后校验，防止快速重复点击时
  // 旧一轮 await 拿到 url 后仍继续创建 Audio 元素，与新一轮叠加播放
  let requestId = 0;

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

  /** 处理音频播放结束：播放下⼀段或标记完成 */
  function onSegmentEnded(audio: HTMLAudioElement) {
    currentSegmentIndex++;
    if (currentSegmentIndex < segmentQueue.length && !aborted) {
      void playNextSegment(requestId);
    } else {
      state.value = 'idle';
      loading.value = false;
      if (audio.src.startsWith('blob:')) {
        URL.revokeObjectURL(audio.src);
      }
    }
  }

  /** 从后端获取 TTS 音频并返回 Blob URL */
  async function fetchTtsAudio(): Promise<string> {
    const text = segmentQueue[currentSegmentIndex];
    const rateStr = rateToSsml(currentRate);
    const volumeStr = volToSsml(currentVolume);
    const pitchStr = pitchToSsml(currentPitch);
    const styleStr = currentStyle && currentStyle !== 'general' ? currentStyle : '';

    const res = await apiFetch(`${API_BASE}/tts/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: currentVoice, rate: rateStr, volume: volumeStr, pitch: pitchStr, style: styleStr }),
    });
    if (!res.ok) {
      throw new Error(`TTS API HTTP ${res.status}`);
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  /** 播放下一段文本（分段合成场景） */
  async function playNextSegment(myReq: number) {
    // 入参即校检：被新一轮 speak 取代时直接退出
    if (myReq !== requestId) return;
    if (aborted) return;
    if (currentSegmentIndex >= segmentQueue.length) {
      state.value = 'idle';
      loading.value = false;
      return;
    }

    try {
      const url = await fetchTtsAudio();
      // await 期间可能被新一轮 speak 取代：丢弃过期结果
      if (myReq !== requestId) {
        URL.revokeObjectURL(url);
        return;
      }
      if (aborted) {
        URL.revokeObjectURL(url);
        return;
      }

      // 释放上一段的 object URL 避免内存泄漏
      if (currentAudio?.src.startsWith('blob:')) {
        URL.revokeObjectURL(currentAudio.src);
      }

      const audio = new Audio(url);
      currentAudio = audio;

      audio.onended = () => onSegmentEnded(audio);
      audio.onerror = () => {
        console.error('Edge TTS 音频播放失败');
        state.value = 'idle';
        loading.value = false;
      };
      audio.onplay = () => {
        // 播放真正开始：解除 loading（之前是合成/等待阶段）
        if (myReq === requestId && !aborted) {
          state.value = 'playing';
          loading.value = false;
        }
      };

      await audio.play();
    } catch (err) {
      console.error('Edge TTS 合成失败：', err);
      // 仅在仍为最新请求且未中止时降级
      if (myReq !== requestId || aborted) return;
      // 首段即失败：整段降级到浏览器原生 TTS，保证朗读功能始终可用
      if (currentSegmentIndex === 0) {
        fallbackToBrowser();
        loading.value = false;
      } else {
        state.value = 'idle';
        loading.value = false;
      }
    }
  }

  const provider: TTSProvider & { state: Ref<TTSState>; loading: Ref<boolean> } = {
    name: 'edge',
    state,
    loading,

    isSupported(): boolean {
      // Edge TTS 通过后端 API 实现，无需浏览器特性检测
      // 只要后端运行即可用（前端无法同步检测后端状态，乐观返回 true）
      return true;
    },

    speak(text: string, options?: TTSSpeakOptions): void {
      // requestId 自增：让上一轮 await fetch 后的结果在比较时失效，避免叠加
      const myReq = ++requestId;
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
      // 进入加载态：屏蔽 UI 重复点击
      loading.value = true;

      currentRate = options?.rate ?? 1;
      currentVoice = options?.voice ?? DEFAULT_VOICE;
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
        loading.value = false;
        return;
      }

      state.value = 'playing';
      void playNextSegment(myReq);
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
      // 暂停不解除 loading：暂停期间仍可能重复点击，UI 应通过 state 区分
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
        loading.value = false;
      });
      state.value = 'playing';
    },

    stop(): void {
      // requestId 自增 + aborted：让所有进行中的 await 在 await 后被丢弃
      requestId++;
      aborted = true;
      clearAudio();
      if (fallbackProvider) {
        fallbackProvider.stop();
      }
      segmentQueue = [];
      currentSegmentIndex = 0;
      state.value = 'idle';
      loading.value = false;
    },

    dispose(): void {
      this.stop();
      stopFallbackWatch?.();
    },
  };

  return provider;
}

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { TTSProvider, TTSState, TTSSpeakOptions } from './types';
import { createBrowserTTSProvider } from './browserTtsProvider';
import { createDoubaoTTSProvider } from './doubaoTtsProvider';
import { createEdgeTTSProvider } from './edgeTtsProvider';

/** Provider 类型标识 */
export type TTSProviderType = 'edge' | 'browser' | 'doubao';

/** 桥接接口：provider 实现可选择性暴露 state ref 让 useTTS watch */
export interface StateAwareProvider extends TTSProvider {
  state: Ref<TTSState>;
}

/** useTTS composable 暴露给业务层的接口（与 useTTS.ts 保持一致） */
export interface UseTTSReturn {
  state: Ref<TTSState>;
  rate: Ref<number>;
  speak: (text: string, options?: TTSSpeakOptions) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setRate: (newRate: number, restartText?: string, lang?: string) => void;
  /** 当前使用的 provider 名称（只读） */
  providerName: ComputedRef<string>;
  /** 切换 provider（如从浏览器切到豆包） */
  setProvider: (type: TTSProviderType) => void;
}

// 解析用户偏好的 provider：localStorage > 默认 edge（微软神经网络语音，更拟人化）
// 为什么默认 edge 而非 browser：浏览器原生 Web Speech API 中文音色机械不自然，
// Edge TTS 提供与 Azure 同源的神经网络音色，免费、无 API Key、音质自然
function resolveProviderType(): TTSProviderType {
  try {
    const raw = localStorage.getItem('tts.provider');
    if (raw === 'edge' || raw === 'doubao' || raw === 'browser') return raw;
  } catch {
    // 忽略 localStorage 访问异常
  }
  return 'edge';
}

// 创建 provider 实例：按类型分发。edge 为默认（微软神经网络语音）；browser 为降级方案
function createProvider(type: TTSProviderType): StateAwareProvider {
  if (type === 'edge') return createEdgeTTSProvider() as StateAwareProvider;
  if (type === 'doubao') return createDoubaoTTSProvider() as StateAwareProvider;
  return createBrowserTTSProvider() as StateAwareProvider;
}

/**
 * useTTS composable：业务层入口
 *
 * 设计动机：保留原 useTTS.ts 的接口（state/rate/speak/pause/resume/stop/setRate），
 *   内部从直接调 speechSynthesis 改为通过 TTSProvider 抽象层调用，
 *   后续切换 provider 只需修改 provider 实例，不影响业务组件。
 *
 * 用法（与旧版完全兼容）：
 *   const tts = useTTS();
 *   tts.speak('你好');
 *   tts.setRate(1.5);
 */
export function useTTS(): UseTTSReturn {
  // 业务侧 state：保持同一 ref identity，watch 桥接 provider 内部 state
  const state = ref<TTSState>('idle');
  // 语速：useTTS 层单独管理，因为 setRate 需影响当前 provider（可能跨 provider 复用）
  const rate = ref(1);

  // 每次 useTTS() 调用都创建独立 provider 实例
  // 为什么不用单例：useTTS 是 composable，应遵循"每次调用独立状态"惯例
  const initialType = resolveProviderType();
  let currentProvider: StateAwareProvider = createProvider(initialType);
  // 暴露 provider name 给 UI：用于"当前使用：浏览器/豆包"展示
  const providerName = computed(() => currentProvider.name);

  // 桥接 provider.state → useTTS state
  // 用 watch 监听 provider 内部 state，同步到 useTTS 的 state，
  // 确保业务侧拿到的是统一 ref，即使 provider 被替换也通过 stopWatch 切换
  function bridgeProviderState(p: StateAwareProvider): () => void {
    // 立即同步初值
    state.value = p.state.value;
    return watch(
      p.state,
      (v) => {
        state.value = v;
      },
      { flush: 'sync' },
    );
  }
  let stopWatch = bridgeProviderState(currentProvider);

  function setProvider(type: TTSProviderType): void {
    // 切换前 dispose 旧 provider，避免音频/audioContext 泄漏
    currentProvider.dispose();
    stopWatch();
    currentProvider = createProvider(type);
    stopWatch = bridgeProviderState(currentProvider);
    // 持久化偏好
    try {
      localStorage.setItem('tts.provider', type);
    } catch {
      // 写入失败静默降级
    }
  }

  return {
    state,
    rate,
    speak(
      text: string,
      options?: { lang?: string; rate?: number; voice?: string; style?: string; volume?: number; pitch?: number },
    ) {
      currentProvider.speak(text, options ?? { lang: 'zh-CN', rate: rate.value });
    },
    pause() {
      currentProvider.pause();
    },
    resume() {
      currentProvider.resume();
    },
    stop() {
      currentProvider.stop();
    },
    setRate(newRate: number, restartText?: string, lang = 'zh-CN') {
      rate.value = Math.min(2, Math.max(0.5, newRate));
      // 仅在朗读中且有原文时重启
      if (state.value === 'playing' && restartText) {
        currentProvider.speak(restartText, { lang, rate: rate.value });
      }
    },
    providerName,
    setProvider,
  };
}

// 显式 re-export，方便业务侧按需 import
export type { TTSProvider, TTSState, TTSSpeakOptions } from './types';
export { createBrowserTTSProvider } from './browserTtsProvider';
export { createDoubaoTTSProvider } from './doubaoTtsProvider';
export { createEdgeTTSProvider } from './edgeTtsProvider';

import { computed, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import type { TTSProvider, TTSState, TTSSpeakOptions } from './types';
import { createBrowserTTSProvider } from './browserTtsProvider';
import { createDoubaoTTSProvider } from './doubaoTtsProvider';
import { createEdgeTTSProvider } from './edgeTtsProvider';

/** Provider 类型标识 */
export type TTSProviderType = 'edge' | 'browser' | 'doubao';

/** 桥接接口：provider 实现可选择性暴露 state ref 让 useTTS watch */
export interface StateAwareProvider extends TTSProvider {
  state: Ref<TTSState>;
  /** 可选：provider 在合成/等待阶段暴露 loading=true，让 store 与 UI 屏蔽重复点击 */
  loading?: Ref<boolean>;
}

/** useTTS composable 暴露给业务层的接口（与 useTTS.ts 保持一致） */
export interface UseTTSReturn {
  state: Ref<TTSState>;
  /** 合成/等待阶段为 true，用于 UI 屏蔽重复点击（loading 期间 speak 应被忽略） */
  loading: Ref<boolean>;
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
  // 业务侧 loading：复用 provider 暴露的 loading ref；未暴露的 provider 默认 false
  const loading = ref(false);
  // 语速：useTTS 层单独管理，因为 setRate 需影响当前 provider（可能跨 provider 复用）
  const rate = ref(1);

  // 每次 useTTS() 调用都创建独立 provider 实例
  // 为什么不用单例：useTTS 是 composable，应遵循"每次调用独立状态"惯例
  const initialType = resolveProviderType();
  // 用 shallowRef 持有 provider 实例：setProvider 整体替换实例（.value = ...）时会触发响应式，
  // 让下方的 providerName computed 能感知引擎切换。
  // 旧实现用普通 local let，computed 闭包捕获的是非响应式变量且其 .name 为静态字符串，
  // 导致 computed 仅求值一次后被缓存、切换引擎后 providerName 永远停在初始 'edge'，
  // 表现即"语音引擎切换后厂商标签不跟随高亮"。
  const currentProvider = shallowRef<StateAwareProvider>(createProvider(initialType));
  // 暴露 provider name 给 UI：用于"当前使用：浏览器/豆包"展示（依赖 currentProvider.value，可响应切换）
  const providerName = computed(() => currentProvider.value.name);

  // 桥接 provider.state → useTTS state
  // 用 watch 监听 provider 内部 state，同步到 useTTS 的 state，
  // 确保业务侧拿到的是统一 ref，即使 provider 被替换也通过 stopWatch 切换
  function bridgeProviderState(p: StateAwareProvider): () => void {
    // 立即同步初值
    state.value = p.state.value;
    if (p.loading) loading.value = p.loading.value;
    const stopState = watch(
      p.state,
      (v) => {
        state.value = v;
      },
      { flush: 'sync' },
    );
    let stopLoading: (() => void) | null = null;
    if (p.loading) {
      stopLoading = watch(
        p.loading,
        (v) => {
          loading.value = v;
        },
        { flush: 'sync' },
      );
    }
    return () => {
      stopState();
      stopLoading?.();
    };
  }
  let stopWatch = bridgeProviderState(currentProvider.value);

  function setProvider(type: TTSProviderType): void {
    // 切换前 dispose 旧 provider，避免音频/audioContext 泄漏
    currentProvider.value.dispose();
    stopWatch();
    currentProvider.value = createProvider(type);
    stopWatch = bridgeProviderState(currentProvider.value);
    // 持久化偏好
    try {
      localStorage.setItem('tts.provider', type);
    } catch {
      // 写入失败静默降级
    }
  }

  return {
    state,
    loading,
    rate,
    speak(
      text: string,
      options?: { lang?: string; rate?: number; voice?: string; style?: string; volume?: number; pitch?: number },
    ) {
      // loading 期间忽略重复 speak：防止快速点击导致的合成任务 / Audio 元素叠加
      if (loading.value) return;
      // 朗读前剥离 markdown 排版符号（* # 等），避免语音逐字念出
      currentProvider.value.speak(stripMarkdownForTTS(text), options ?? { lang: 'zh-CN', rate: rate.value });
    },
    pause() {
      currentProvider.value.pause();
    },
    resume() {
      currentProvider.value.resume();
    },
    stop() {
      currentProvider.value.stop();
    },
    setRate(newRate: number, restartText?: string, lang = 'zh-CN') {
      rate.value = Math.min(2, Math.max(0.5, newRate));
      // 仅在朗读中且有原文时重启
      if (state.value === 'playing' && restartText) {
        currentProvider.value.speak(restartText, { lang, rate: rate.value });
      }
    },
    providerName,
    setProvider,
  };
}

// 显式 re-export，方便业务侧按需 import
// 朗读专用 markdown → 纯文本剥离。
// 为什么单独实现而非复用组件里的 stripMarkdown：
//   - 组件里那版用于"复制纯文本"，必须保留代码块内容供粘贴阅读；
//   - 朗读版则相反：代码块无意义地朗读源码，应整块替换为简短的"代码块"占位，
//     避免语音把 ``` # * 等排版符号和代码逐字念出来。
// 为什么放在 speak 统一入口而非各 provider：确保 edge/browser/doubao 三个引擎
// 及 restartCurrent（调速/换音色重启）读到的都是已清洗文本，职责收敛到一处。
function stripMarkdownForTTS(md: string): string {
  return md
    // 代码块：整块替换为占位（朗读源码无意义）
    .replaceAll(/```[\s\S]*?```/g, '代码块')
    // 行内代码：去反引号
    .replaceAll(/`([^`]+)`/g, '$1')
    // 图片：替换为 alt 文本
    .replaceAll(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // 链接：替换为文本
    .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 标题井号、引用块、无序/有序列表标记
    .replaceAll(/^#{1,6}\s+/gm, '')
    .replaceAll(/^>\s+/gm, '')
    .replaceAll(/^\s*[-*+]\s+/gm, '')
    .replaceAll(/^\s*\d+\.\s+/gm, '')
    // 粗体/斜体/删除线
    .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
    .replaceAll(/\*([^*]+)\*/g, '$1')
    .replaceAll(/__([^_]+)__/g, '$1')
    .replaceAll(/_([^_]+)_/g, '$1')
    .replaceAll(/~~([^~]+)~~/g, '$1')
    // 兜底：清除上述标记后仍可能孤立的 markdown 符号，避免被逐字朗读
    .replaceAll(/[*#_~`>]/g, '')
    // 水平分割线与多余空行收敛
    .replaceAll(/^-{3,}$/gm, '')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

export type { TTSProvider, TTSState, TTSSpeakOptions } from './types';
export { createBrowserTTSProvider } from './browserTtsProvider';
export { createDoubaoTTSProvider } from './doubaoTtsProvider';
export { createEdgeTTSProvider } from './edgeTtsProvider';

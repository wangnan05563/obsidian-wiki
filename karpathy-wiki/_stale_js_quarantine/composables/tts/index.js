import { computed, ref, watch } from 'vue';
import { createBrowserTTSProvider } from './browserTtsProvider';
import { createDoubaoTTSProvider } from './doubaoTtsProvider';
// 解析用户偏好的 provider：localStorage > 默认 browser
// 为什么 localStorage 而非 store：TTS 偏好是 UI 状态，store 引入会与业务耦合
function resolveProviderType() {
    try {
        const raw = localStorage.getItem('tts.provider');
        if (raw === 'doubao' || raw === 'browser')
            return raw;
    }
    catch {
        // 忽略 localStorage 访问异常
    }
    return 'browser';
}
// 创建 provider 实例：按类型分发。browser 已实现 state 暴露；doubao 通过 audio 事件异步更新
// 这里统一返回 StateAwareProvider 供桥接逻辑使用
function createProvider(type) {
    return (type === 'doubao' ? createDoubaoTTSProvider() : createBrowserTTSProvider());
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
export function useTTS() {
    // 业务侧 state：保持同一 ref identity，watch 桥接 provider 内部 state
    const state = ref('idle');
    // 语速：useTTS 层单独管理，因为 setRate 需影响当前 provider（可能跨 provider 复用）
    const rate = ref(1);
    // 每次 useTTS() 调用都创建独立 provider 实例
    // 为什么不用单例：useTTS 是 composable，应遵循"每次调用独立状态"惯例
    const initialType = resolveProviderType();
    let currentProvider = createProvider(initialType);
    // 暴露 provider name 给 UI：用于"当前使用：浏览器/豆包"展示
    const providerName = computed(() => currentProvider.name);
    // 桥接 provider.state → useTTS state
    // 用 watch 监听 provider 内部 state，同步到 useTTS 的 state，
    // 确保业务侧拿到的是统一 ref，即使 provider 被替换也通过 stopWatch 切换
    function bridgeProviderState(p) {
        // 立即同步初值
        state.value = p.state.value;
        return watch(p.state, (v) => {
            state.value = v;
        }, { flush: 'sync' });
    }
    let stopWatch = bridgeProviderState(currentProvider);
    function setProvider(type) {
        // 切换前 dispose 旧 provider，避免音频/audioContext 泄漏
        currentProvider.dispose();
        stopWatch();
        currentProvider = createProvider(type);
        stopWatch = bridgeProviderState(currentProvider);
        // 持久化偏好
        try {
            localStorage.setItem('tts.provider', type);
        }
        catch {
            // 写入失败静默降级
        }
    }
    return {
        state,
        rate,
        speak(text, lang = 'zh-CN') {
            currentProvider.speak(text, { lang, rate: rate.value });
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
        setRate(newRate, restartText, lang = 'zh-CN') {
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
export { createBrowserTTSProvider } from './browserTtsProvider';
export { createDoubaoTTSProvider } from './doubaoTtsProvider';

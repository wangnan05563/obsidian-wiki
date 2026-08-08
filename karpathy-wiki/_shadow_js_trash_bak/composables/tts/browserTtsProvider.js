import { ref } from 'vue';
// BrowserTTSProvider：基于 Web Speech API（speechSynthesis）的 TTS 实现。
// 设计要点：
//   - utterance 必须保留引用：浏览器 GC 后会回收导致 onend 不触发
//   - 切换朗读先 cancel：避免 speechSynthesis 队列堆积
//   - rate 修改需重启 utterance：Web Speech API 不支持动态修改 rate
//   - 优先选择精确匹配 voice，无则按语言前缀降级
//   - speak() 不 await：保持与 useTTS composable 现有调用契约一致
//
// 暴露 state 字段：useTTS composable 通过 watch 桥接 provider 内部 state 到业务侧 ref。
export function createBrowserTTSProvider() {
    // 暴露给外部的 state：只读 ref，禁止外部 .value = 写入
    const state = ref('idle');
    // 当前语速：speak() 时应用到 utterance，setRate 时若朗读中则重启
    let currentRate = 1;
    // 保留 utterance 引用避免被 GC
    let currentUtterance = null;
    function pickVoice(lang) {
        if (!('speechSynthesis' in globalThis))
            return null;
        const voices = globalThis.speechSynthesis.getVoices();
        return (voices.find((v) => v.lang === lang) ||
            voices.find((v) => v.lang.startsWith(lang.split('-')[0])) ||
            null);
    }
    const provider = {
        name: 'browser',
        state,
        isSupported() {
            return typeof globalThis !== 'undefined' && 'speechSynthesis' in globalThis;
        },
        speak(text, options) {
            if (!this.isSupported()) {
                console.warn('浏览器不支持语音合成');
                return;
            }
            // 切换朗读前先停止当前，避免队列堆积
            globalThis.speechSynthesis.cancel();
            const lang = options?.lang ?? 'zh-CN';
            const rate = options?.rate ?? currentRate;
            currentRate = Math.min(2, Math.max(0.5, rate));
            const u = new SpeechSynthesisUtterance(text);
            u.lang = lang;
            u.rate = currentRate;
            if (options?.volume !== undefined)
                u.volume = Math.min(1, Math.max(0, options.volume));
            if (options?.pitch !== undefined)
                u.pitch = Math.min(2, Math.max(0, options.pitch));
            const voice = pickVoice(lang);
            if (voice)
                u.voice = voice;
            u.onend = () => {
                state.value = 'idle';
            };
            u.onerror = () => {
                state.value = 'idle';
            };
            currentUtterance = u;
            globalThis.speechSynthesis.speak(u);
            state.value = 'playing';
        },
        pause() {
            if (!this.isSupported())
                return;
            globalThis.speechSynthesis.pause();
            state.value = 'paused';
        },
        resume() {
            if (!this.isSupported())
                return;
            globalThis.speechSynthesis.resume();
            state.value = 'playing';
        },
        stop() {
            if (!this.isSupported())
                return;
            globalThis.speechSynthesis.cancel();
            currentUtterance = null;
            state.value = 'idle';
        },
        dispose() {
            this.stop();
            currentUtterance = null;
        },
    };
    return provider;
}

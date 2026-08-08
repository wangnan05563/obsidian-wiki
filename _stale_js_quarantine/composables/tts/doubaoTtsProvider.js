import { ref } from 'vue';
import { API_BASE } from '../../utils/apiBase';
export function createDoubaoTTSProvider(config = {}) {
    const state = ref('idle');
    let currentAudio = null;
    // 保存当前播放文本，用于 pause→resume 不丢失内容（resume 仍由 audio.play() 实现）
    let currentText = '';
    let currentOptions = {};
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
    const provider = {
        name: 'doubao',
        state,
        isSupported() {
            // Doubao TTS 需要后端启用 + 用户在 Config 中配置 volcengine API key
            // 前端无配置中心化开关前用 feature flag 判断：localStorage 显式 opt-in
            try {
                return localStorage.getItem('tts.provider') === 'doubao';
            }
            catch {
                return false;
            }
        },
        speak(text, options) {
            if (!this.isSupported()) {
                // 未启用时给出清晰提示，让用户知道如何启用
                console.warn('豆包 TTS 未启用：在 localStorage 设置 tts.provider = "doubao" 并确保后端 /api/tts/synthesize 已实现');
                return;
            }
            // 切换朗读前清理旧 audio
            clearAudio();
            currentText = text;
            currentOptions = options ?? {};
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
                    const res = await fetch(`${API_BASE}${endpoint}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text, voice, rate }),
                    });
                    if (!res.ok) {
                        throw new Error(`TTS API HTTP ${res.status}`);
                    }
                    const data = (await res.json());
                    if (data.url) {
                        audio.src = data.url;
                    }
                    else if (data.audioBase64) {
                        // 后端可选择直接返回 base64，前端转 dataURL
                        audio.src = `data:audio/mpeg;base64,${data.audioBase64}`;
                    }
                    else {
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
                        if (state.value === 'playing')
                            state.value = 'paused';
                    };
                    await audio.play();
                }
                catch (err) {
                    console.error('豆包 TTS 合成失败：', err);
                    state.value = 'idle';
                }
            })();
        },
        pause() {
            currentAudio?.pause();
            state.value = 'paused';
        },
        resume() {
            // audio.play() 返回 Promise，可能因 autoplay policy 失败，需捕获
            currentAudio?.play().catch((err) => {
                console.error('豆包 TTS resume 失败：', err);
                state.value = 'idle';
            });
            state.value = 'playing';
        },
        stop() {
            clearAudio();
            currentText = '';
            currentOptions = {};
            state.value = 'idle';
        },
        dispose() {
            this.stop();
        },
    };
    return provider;
}

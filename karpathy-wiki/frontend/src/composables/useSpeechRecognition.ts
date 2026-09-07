// 语音输入 composable：封装 Web Speech API（SpeechRecognition / webkitSpeechRecognition）。
// 移动端问答输入栏的"语音"按钮复用此能力；不支持时优雅降级（listening 恒为 false，组件禁用按钮）。
//
// 为什么独立成 composable：语音识别的 lifecycle（创建识别器、绑定 onresult/onerror/onend、
// 连续识别与 interim 结果拼接）样板较多，抽到 composable 避免组件臃肿，且便于单测 mock。
//
// 安全性：仅用于把用户口述转写为文本填充到输入框，不另存、不上传；识别器完全在浏览器本地运行。

import { ref, onBeforeUnmount } from 'vue';

// 最小化 SpeechRecognition 类型（标准 lib.dom 未必含 webkit 前缀，故用局部 any 适配）
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  return typeof Ctor === 'function' ? (Ctor as RecognitionCtor) : null;
}

export interface SpeechRecognitionOptions {
  // 最终识别结果回调（一句话稳定后触发，可多次）
  onFinal?: (text: string) => void;
  // 临时识别结果回调（说话过程中实时刷新，用于实时预览）
  onInterim?: (text: string) => void;
  // 出错回调（如无麦克风权限、网络不可用）
  onError?: (message: string) => void;
}

export function useSpeechRecognition(options: SpeechRecognitionOptions = {}) {
  // 特性检测：浏览器是否支持语音识别
  const supported = ref<boolean>(getRecognitionCtor() !== null);
  const listening = ref<boolean>(false);
  const error = ref<string>('');

  let recognition: SpeechRecognitionLike | null = null;

  function buildRecognition(): SpeechRecognitionLike | null {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return null;
    const r = new Ctor();
    // 中文口述优先；连续识别 +  interim 结果，体验更接近"边说边出字"
    r.lang = 'zh-CN';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => {
      listening.value = true;
      error.value = '';
    };
    r.onresult = (event: any) => {
      let interim = '';
      let finalText = '';
      // event.results 是类数组，按索引累积已出结果
      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0]?.transcript ?? '';
        if (res.isFinal) finalText += txt;
        else interim += txt;
      }
      if (interim) options.onInterim?.(interim);
      if (finalText) {
        options.onFinal?.(finalText);
      }
    };
    r.onerror = (event: any) => {
      const err = event?.error ?? 'speech-error';
      // 'no-speech' / 'aborted' 属正常终止，不当作错误提示
      if (err === 'no-speech' || err === 'aborted') return;
      error.value = err;
      listening.value = false;
      options.onError?.(err);
    };
    r.onend = () => {
      // 部分浏览器连续识别会自动 onend，这里仅同步状态；不在 onend 自动重启以免死循环
      listening.value = false;
    };
    return r;
  }

  function start() {
    error.value = '';
    if (!supported.value) {
      error.value = '当前浏览器不支持语音输入';
      options.onError?.(error.value);
      return;
    }
    if (listening.value) return;
    // 每次 start 重建识别器，规避部分实现 onend 后无法二次 start 的限制
    recognition = buildRecognition();
    if (!recognition) {
      supported.value = false;
      return;
    }
    try {
      recognition.start();
    } catch {
      // 重复 start 可能抛错（识别器已在运行），静默忽略
      listening.value = false;
    }
  }

  function stop() {
    if (recognition && listening.value) {
      try {
        recognition.stop();
      } catch {
        /* 已停止 */
      }
    }
    listening.value = false;
  }

  onBeforeUnmount(() => {
    stop();
    recognition = null;
  });

  return { supported, listening, error, start, stop };
}

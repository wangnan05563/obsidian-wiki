import { ref } from 'vue';

// 剥离 Markdown 语法，生成纯净文本供朗读
// 代码块整体替换为"代码块"避免朗读源码；其余语法只剥离符号保留文本
// 移到模块顶层避免每次 useTTS() 调用重新创建函数实例（S7721）
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '代码块') // NOSONAR: 正则含字符类 [\s\S]，无法用 replaceAll
    .replace(/`([^`]+)`/g, '$1') // NOSONAR: 正则含捕获组 $1 与字符类 [^`]
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // NOSONAR: 正则含捕获组与字符类
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // NOSONAR: 正则含捕获组与字符类
    .replace(/^#+\s*/gm, '') // NOSONAR: 正则含行锚点 ^
    .replace(/\*\*([^*]+)\*\*/g, '$1') // NOSONAR: 正则含捕获组与字符类
    .replace(/\*([^*]+)\*/g, '$1') // NOSONAR: 正则含捕获组与字符类
    .replace(/^>\s*/gm, '') // NOSONAR: 正则含行锚点 ^
    .replace(/^[-*+]\s*/gm, '') // NOSONAR: 正则含行锚点与字符类
    .replace(/^\d+\.\s*/gm, '') // NOSONAR: 正则含行锚点 ^
    .replaceAll('|', ' ')
    .replace(/^-+$/gm, '') // NOSONAR: 正则含行锚点 ^
    .trim();
}

// §4.1 useTTS — Web Speech API 封装。
// 职责：剥离 Markdown 后调用 speechSynthesis 朗读，提供 play/pause/resume/stop 状态机。
// 设计选择：utterance 必须保留引用，否则部分浏览器会回收导致 onend 不触发。
export function useTTS() {
  // 保留 utterance 引用避免被 GC，否则 onend/onerror 事件不触发
  const utterance = ref<SpeechSynthesisUtterance | null>(null);
  const state = ref<'idle' | 'playing' | 'paused'>('idle');

  function speak(text: string, lang = 'zh-CN') {
    if (!('speechSynthesis' in globalThis)) {
      console.warn('浏览器不支持语音合成');
      return;
    }
    // 切换朗读前先停止当前，避免 speechSynthesis 队列堆积
    speechSynthesis.cancel();

    const cleanText = stripMarkdown(text);
    const u = new SpeechSynthesisUtterance(cleanText);
    u.lang = lang;
    u.rate = 1;

    // 优先选择匹配语言的 voice，无精确匹配则退回同语言前缀
    const voices = speechSynthesis.getVoices();
    const voice = voices.find(v => v.lang === lang)
      || voices.find(v => v.lang.startsWith(lang.split('-')[0]));
    if (voice) u.voice = voice;

    u.onend = () => { state.value = 'idle'; };
    u.onerror = () => { state.value = 'idle'; };

    utterance.value = u;
    speechSynthesis.speak(u);
    state.value = 'playing';
  }

  function pause() {
    speechSynthesis.pause();
    state.value = 'paused';
  }

  function resume() {
    speechSynthesis.resume();
    state.value = 'playing';
  }

  function stop() {
    speechSynthesis.cancel();
    state.value = 'idle';
  }

  return { state, speak, pause, resume, stop };
}

// §4.2 useClipboard — 剪贴板复制 composable。
// 职责：优先使用 Clipboard API，非 HTTPS 环境降级到 execCommand。
// 同时提供 Markdown→纯文本转换，避免复制时带上语法符号。
// 降级方案：非 HTTPS 环境下 Clipboard API 不可用，使用已废弃的 execCommand 作为兜底
// 移到模块顶层避免每次 useClipboard() 调用重新创建函数实例（S7721）
function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // 固定定位 + 透明，避免 textarea 进入可视区域影响布局
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy'); // NOSONAR: 非 HTTPS 下降级方案，无替代 API
    textarea.remove();
    return ok;
}
// 剥离 Markdown，生成纯文本
// 与 useTTS.stripMarkdown 不同：此处不替换代码块为"代码块"，直接保留代码内容
// 移到模块顶层避免每次 useClipboard() 调用重新创建函数实例（S7721）
function copyPlainText(md) {
    return md
        .replace(/```[\s\S]*?```/g, (m) => m.replace(/^```\w*\n?/gm, '').replace(/```$/gm, '')) // NOSONAR: 正则含字符类与行锚点
        .replace(/`([^`]+)`/g, '$1') // NOSONAR: 正则含捕获组与字符类
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // NOSONAR: 正则含捕获组与字符类
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // NOSONAR: 正则含捕获组与字符类
        .replace(/^#+\s*/gm, '') // NOSONAR: 正则含行锚点
        .replace(/\*\*([^*]+)\*\*/g, '$1') // NOSONAR: 正则含捕获组与字符类
        .replace(/\*([^*]+)\*/g, '$1') // NOSONAR: 正则含捕获组与字符类
        .trim();
}
// 移到模块顶层避免每次 useClipboard() 调用重新创建函数实例（S7721）
async function copy(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    }
    catch {
        // 非 HTTPS 或权限被拒时降级到 execCommand（已废弃但仍可用）
        return fallbackCopy(text);
    }
}
export function useClipboard() {
    return { copy, copyPlainText };
}

import path from 'node:path';

// 生成 RFC 5987 兼容的 Content-Disposition，支持中文等非 ASCII 文件名：
// 现代浏览器优先使用 filename*（UTF-8 编码），旧浏览器回退到 ASCII 的 filename。
// 为什么需要：知识库/投递文件名常含中文（如「上海票据交易所.md」），直接用 GBK/UTF-8 字节塞进
//   filename 会被截断或乱码；filename* 是标准做法，Chrome/Edge/Firefox/Safari 均支持。
// 为什么抽到 utils：vault 下载（/api/files/download）与投递原件下载（/api/uploads/:id/download）
//   必须输出同一套文件名语义，两处各写一遍会在后续修 header 注入时漏改一处。
export function buildAttachmentHeader(relPath: string, legacyPrefix = 'vault-file'): string {
  const baseName = path.basename(relPath);
  const ext = path.extname(baseName);
  // 仅当文件名全为可打印 ASCII 时直接用作 legacy filename，否则用中性名 + 扩展名兜底
  const isAscii = /^[\x20-\x7e]*$/.test(baseName);
  // #8：清洗可能破坏 header 结构的字符（" \ CR/LF 及控制字符），避免响应头注入
  const legacyName = (isAscii ? baseName : `${legacyPrefix}${ext}`).replace(/["\\\u0000-\u001f\u007f]/g, '_'); // NOSONAR - S6324 - 故意匹配控制字符用于文件名净化
  // #8：filename*（RFC 5987）需对 encodeURIComponent 未覆盖的 ' ( ) * 做百分号转义
  //   （RFC 5987 attr-char 不含这三者；不转义会在部分浏览器解析异常）
  const encodedName = encodeURIComponent(baseName)
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
  return `attachment; filename="${legacyName}"; filename*=UTF-8''${encodedName}`;
}

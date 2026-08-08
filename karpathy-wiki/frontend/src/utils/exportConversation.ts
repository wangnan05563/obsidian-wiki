import type { ConversationRecord } from '../types';

// 会话导出工具（F-3.3 增强：会话导出）
// 将会话内容导出为可读的 Markdown 文本，并触发浏览器端文件下载。
// 纯函数与 DOM 操作分离，便于单元测试覆盖。

// 将会话记录渲染为 Markdown 纯文本。
// 为什么用 Markdown：知识库问答场景下人类可读、易分享、可被再次编译入库。
export function buildConversationMarkdown(record: ConversationRecord): string {
  const lines: string[] = [];
  lines.push(`# ${record.title}`);
  lines.push('');
  lines.push(`> 导出时间：${new Date().toISOString()}`);
  lines.push(`> 消息数：${record.messages.length}`);
  lines.push(`> 创建时间：${record.createdAt}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 对话内容');
  lines.push('');

  for (const msg of record.messages) {
    lines.push(msg.role === 'user' ? '**用户：**' : '**AI：**');
    lines.push('');
    lines.push((msg.content ?? '').trim() || '_(空)_');

    // 引用页面（如有）：兼容 string[] 老格式与 Reference[] 新格式
    const refs = msg.refs;
    if (Array.isArray(refs) && refs.length > 0) {
      lines.push('');
      lines.push('*参考：*');
      for (const r of refs) {
        if (typeof r === 'string') {
          lines.push(`- ${r}`);
        } else {
          const urlPart = r.url ? ` (${r.url})` : '';
          lines.push(`- ${r.title}${urlPart}`);
        }
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// 生成导出文件名：清洗标题中的文件系统非法字符，回退为 conversation。
// 与 CODING 用户输入作文件名的清洗规则保持一致（\ / : * ? " < > |）。
export function buildConversationFilename(record: ConversationRecord): string {
  const base = (record.title.replace(/[\\/:*?"<>|]/g, '_').trim()) || 'conversation';
  return `${base}.md`;
}

// 浏览器端触发文本文件下载（会话导出）。
// 不依赖任何后端接口，纯客户端生成 Blob 并模拟点击 <a download>。
export function downloadTextFile(
  filename: string,
  content: string,
  mime = 'text/markdown;charset=utf-8'
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 延迟释放，确保下载已开始
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import MarkdownIt from 'markdown-it';

// 单例 md 实例：避免每次渲染重复初始化
// html: false 禁止原始 HTML（防注入）
// breaks: false 关闭单换行转 <br>，让 \n\n 真正成为段落分隔，避免与 pre-wrap 叠加产生视觉空行
//   LLM 输出"## 标题\n\n正文"会被 markdown-it 解析为独立 <p>，不再被 breaks 转成多余 <br>
// linkify: true 自动识别 URL 文本为链接
// typographer: true 智能排版（中文标点、破折号等）
// 注：用户纯文本消息的换行由 .msg-bubble.user .msg-content white-space: pre-wrap 单独处理
const md = new MarkdownIt({
  html: false,
  breaks: false,
  linkify: true,
  typographer: true,
});

// 外部链接添加 target="_blank" 和 rel="noopener"，防止 tabnabbing
const defaultLinkOpen = md.renderer.rules.link_open || function(tokens, idx, options, env, self) {
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.link_open = function(tokens, idx, options, env, self) {
  const targetIndex = tokens[idx].attrIndex('target');
  if (targetIndex < 0) {
    tokens[idx].attrPush(['target', '_blank']);
    tokens[idx].attrPush(['rel', 'noopener noreferrer']);
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// 将 markdown 文本渲染为 HTML
// 为什么需要：LLM 返回的答案包含 markdown 语法（标题、列表、代码块等），需格式化展示
export function renderMarkdown(text: string): string {
  if (!text) return '';
  return md.render(text);
}

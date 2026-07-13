import MarkdownIt from 'markdown-it';

// 单例 md 实例：避免每次渲染重复初始化
// html: true 允许输出 HTML 标签（前端用 v-html 渲染）
// breaks: true 将换行符转为 <br>，适配聊天场景的单行换行
// linkify: true 自动识别 URL 文本为链接
const md = new MarkdownIt({
  html: false,
  breaks: true,
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

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

// F-3.2 代码块语言徽章 + F-3.7 代码块复制按钮
// 为什么不用 highlight.js：SRS 明确"无高亮但有语言徽章"，引入高亮库会增大 bundle 且与 macaron 主题冲突
// 实现策略：覆盖默认 fence 规则，用 wrapper div 包裹 pre + 语言徽章 + 复制按钮
const defaultFence = md.renderer.rules.fence || function(tokens, idx, options, env, self) {
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.fence = function(tokens, idx, options, env, self) {
  const token = tokens[idx];
  const lang = (token.info || '').trim().toLowerCase();
  // 仅对已知语言显示徽章，未知语言不显示（避免 LLM 输出乱码语言名时出现噪音）
  const knownLangs = ['js', 'javascript', 'ts', 'typescript', 'py', 'python', 'bash', 'sh', 'shell', 'json', 'html', 'css', 'vue', 'go', 'rust', 'java', 'sql'];
  const langLabel: Record<string, string> = {
    js: 'JavaScript', javascript: 'JavaScript',
    ts: 'TypeScript', typescript: 'TypeScript',
    py: 'Python', python: 'Python',
    bash: 'Bash', sh: 'Bash', shell: 'Bash',
    json: 'JSON', html: 'HTML', css: 'CSS',
    vue: 'Vue', go: 'Go', rust: 'Rust',
    java: 'Java', sql: 'SQL',
  };
  const code = md.utils.escapeHtml(token.content);
  const preHtml = `<pre><code>${code}</code></pre>`;
  // F-3.7 复制按钮：通过 data-action="copy-code" 标记，事件委托在 Query.vue 统一处理
  // 按钮点击时从兄弟 pre > code 的 textContent 取原始代码，避免 HTML 转义问题
  const copyBtn = `<button class="code-copy-btn" data-action="copy-code" title="复制代码">复制</button>`;
  if (lang && knownLangs.includes(lang)) {
    const label = langLabel[lang] || lang.toUpperCase();
    // 语言徽章 + 复制按钮都绝对定位在 pre 右上角，CSS 在 Query.vue .markdown-body 中定义
    return `<div class="code-block-wrapper"><span class="code-lang-badge">${label}</span>${copyBtn}${preHtml}</div>`;
  }
  // 未知语言：仅显示复制按钮，不显示徽章
  return `<div class="code-block-wrapper">${copyBtn}${preHtml}</div>`;
};

// F-3.2 图片懒加载：给 img 注入 loading="lazy"，滚动到视口才加载
// 为什么用原生 loading="lazy" 而非 IntersectionObserver：原生属性零依赖，现代浏览器全支持
const defaultImage = md.renderer.rules.image || function(tokens, idx, options, env, self) {
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.image = function(tokens, idx, options, env, self) {
  const token = tokens[idx];
  if (token.attrIndex('loading') < 0) {
    token.attrPush(['loading', 'lazy']);
  }
  return defaultImage(tokens, idx, options, env, self);
};

// F-3.8 引用编号锚点：将 assistant 文本中的 [1]/[2] 等纯数字引用转为可点击锚点
// 跳转目标为 RefsList 卡片的 id="ref-N"，点击后浏览器 scrollIntoView 平滑滚动
// 为什么用 inline 规则而非 text 后处理：避免破坏 code_block / link 等已渲染 token
// 为什么要求 [N] 后非 '('：防止与 markdown 链接 [text](url) 冲突，链接形式不会命中此规则
md.inline.ruler.before('link', 'ref_anchor', (state, silent) => {
  const src = state.src;
  const pos = state.pos;
  // 必须以 '[' 开头
  if (src.codePointAt(pos) !== 0x5B /* [ */) return false;
  // 解析数字
  let i = pos + 1;
  let num = '';
  while (i < src.length && src.codePointAt(i)! >= 0x30 && src.codePointAt(i)! <= 0x39) {
    num += src[i];
    i++;
  }
  // 必须至少 1 位数字
  if (num.length === 0) return false;
  // 必须以 ']' 闭合
  if (src.codePointAt(i) !== 0x5D /* ] */) return false;
  // 后一字符不能是 '('，否则是 markdown 链接 [N](url)（虽然不常见但防御）
  if (src.codePointAt(i + 1) === 0x28 /* ( */) return false;
  // silent 模式仅探测不消费，避免影响其他规则的探测
  if (silent) return true;
  // 消费字符并推送 token
  state.pos = i + 1;
  const token = state.push('ref_anchor', '', 0);
  token.meta = { num };
  return true;
});
// 渲染 ref_anchor token 为 <a> 标签
md.renderer.rules.ref_anchor = (tokens, idx) => {
  const num = tokens[idx].meta.num;
  const escaped = md.utils.escapeHtml(num);
  return `<a href="#ref-${escaped}" class="ref-anchor" data-ref="${escaped}">[${escaped}]</a>`;
};

// 将 markdown 文本渲染为 HTML
// 为什么需要：LLM 返回的答案包含 markdown 语法（标题、列表、代码块等），需格式化展示
export function renderMarkdown(text: string): string {
  if (!text) return '';
  return md.render(text);
}

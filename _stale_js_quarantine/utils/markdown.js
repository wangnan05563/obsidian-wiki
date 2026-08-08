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
const defaultLinkOpen = md.renderer.rules.link_open || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
};
md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
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
const defaultFence = md.renderer.rules.fence || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
};
md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const lang = (token.info || '').trim().toLowerCase();
    // 仅对已知语言显示徽章，未知语言不显示（避免 LLM 输出乱码语言名时出现噪音）
    const knownLangs = ['js', 'javascript', 'ts', 'typescript', 'py', 'python', 'bash', 'sh', 'shell', 'json', 'html', 'css', 'vue', 'go', 'rust', 'java', 'sql'];
    const langLabel = {
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
const defaultImage = md.renderer.rules.image || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
};
md.renderer.rules.image = function (tokens, idx, options, env, self) {
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
    if (src.codePointAt(pos) !== 0x5B /* [ */)
        return false;
    // 解析数字
    let i = pos + 1;
    let num = '';
    // 为什么用显式守卫而非 codePointAt(i)!：codePointAt 越界返回 undefined，
    //   非空断言会掩盖类型不安全，用 if 守卫显式处理 undefined 分支（BR-028-1）
    while (i < src.length) {
        const cp = src.codePointAt(i);
        if (cp === undefined || cp < 0x30 || cp > 0x39)
            break;
        num += src[i];
        i++;
    }
    // 必须至少 1 位数字
    if (num.length === 0)
        return false;
    // 必须以 ']' 闭合
    if (src.codePointAt(i) !== 0x5D /* ] */)
        return false;
    // 后一字符不能是 '('，否则是 markdown 链接 [N](url)（虽然不常见但防御）
    if (src.codePointAt(i + 1) === 0x28 /* ( */)
        return false;
    // silent 模式仅探测不消费，避免影响其他规则的探测
    if (silent)
        return true;
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
// 多媒体嵌入：@[type](arg) 语法
// 为什么用 @[type] 而非 ![]()：图片语法已被 markdown-it 占用，需独立前缀避免冲突
// 支持类型：video / audio / bilibili / youtube / douyin
// 安全：URL 转义 + 视频 ID 白名单校验（字母数字 - _），iframe 加 sandbox 防注入
const MEDIA_EMBED_TYPES = ['video', 'audio', 'bilibili', 'youtube', 'douyin'];
// 各平台 iframe 嵌入 URL 模板：{id} 占位符由校验后的视频 ID 替换
// 集中管理便于后续平台 URL 变更时单点修改
const MEDIA_IFRAME_TEMPLATES = {
    bilibili: 'https://player.bilibili.com/player.html?bvid={id}&high_quality=1&autoplay=0',
    youtube: 'https://www.youtube-nocookie.com/embed/{id}',
    douyin: 'https://open.douyin.com/platform/resource/embed?vid={id}',
};
// 视频 ID 白名单：字母数字 + 短横线 + 下划线（覆盖 BV号、YouTube ID、抖音 vid）
// 为什么不用更宽松的正则：防止 URL 参数注入（如 &autoplay=1 被拼到 ID 里）
const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
// URL 白名单：http/https 协议头 + 常见媒体扩展名或任意路径
// 为什么校验协议：防止 javascript:/data: 等危险协议
const MEDIA_URL_PATTERN = /^https?:\/\/[^\s"<>]+$/i;
function buildMediaHtml(type, arg) {
    // 为什么 video/audio 用 encodeURI 而非 escapeHtml：URL 中的 & 会被 escapeHtml 转义为 &amp;，
    //   导致带查询参数的 URL（如 https://example.com/video.mp4?token=abc&sig=def）被破坏。
    //   encodeURI 仅转义 URL 中不安全的字符（如空格、中文），保留 & = ? 等合法 URL 字符。
    // iframe 嵌入类 arg 为视频 ID（已用 MEDIA_ID_PATTERN 白名单校验），无需 encodeURI。
    if (type === 'video') {
        if (!MEDIA_URL_PATTERN.test(arg))
            return '';
        const safeUrl = encodeURI(arg.trim());
        if (!safeUrl)
            return '';
        return `<div class="media-embed media-video"><video controls preload="metadata" src="${safeUrl}"></video></div>`;
    }
    if (type === 'audio') {
        if (!MEDIA_URL_PATTERN.test(arg))
            return '';
        const safeUrl = encodeURI(arg.trim());
        if (!safeUrl)
            return '';
        return `<div class="media-embed media-audio"><audio controls preload="metadata" src="${safeUrl}"></audio></div>`;
    }
    // iframe 嵌入类（bilibili/youtube/douyin）：arg 为视频 ID
    if (!MEDIA_ID_PATTERN.test(arg))
        return '';
    const template = MEDIA_IFRAME_TEMPLATES[type];
    if (!template)
        return '';
    const embedUrl = template.replace('{id}', encodeURIComponent(arg));
    // sandbox 限制：允许脚本 + 同源 + 弹窗 + 指针，禁用顶层导航
    // allowfullscreen 兼容旧浏览器，全屏观看视频必备
    return `<div class="media-embed media-iframe media-${type}"><iframe src="${embedUrl}" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" allowfullscreen frameborder="0" loading="lazy"></iframe></div>`;
}
// 解析 @[type](arg) 中的类型名：从 pos+2 开始，仅允许小写字母
// 返回 { type, end } 或 null（end 为类型名后的索引位置）
// 为什么独立函数：降低主规则函数认知复杂度（S3776），便于单元测试
function parseMediaType(src, start) {
    let i = start;
    let typeStr = '';
    // 为什么用显式守卫而非 codePointAt(i)!：同 ref_anchor 规则，避免非空断言（BR-028-1）
    while (i < src.length) {
        const cp = src.codePointAt(i);
        if (cp === undefined)
            break;
        // 类型名仅允许小写字母
        if (cp >= 0x61 && cp <= 0x7A) {
            typeStr += src[i];
            i++;
        }
        else {
            break;
        }
    }
    if (typeStr.length === 0)
        return null;
    if (!MEDIA_EMBED_TYPES.includes(typeStr))
        return null;
    return { type: typeStr, end: i };
}
// inline 规则：在 ref_anchor 之后、link 之前解析 @[type](arg)
// 为什么放在 link 之前：避免 link 规则把 @[video](url) 误解为文本链接
md.inline.ruler.after('ref_anchor', 'media_embed', (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    // 必须以 '@[' 开头
    if (src.codePointAt(pos) !== 0x40 /* @ */)
        return false;
    if (src.codePointAt(pos + 1) !== 0x5B /* [ */)
        return false;
    const parsed = parseMediaType(src, pos + 2);
    if (!parsed)
        return false;
    // 必须以 ']' 闭合
    if (src.codePointAt(parsed.end) !== 0x5D /* ] */)
        return false;
    // 必须紧跟 '('
    if (src.codePointAt(parsed.end + 1) !== 0x28 /* ( */)
        return false;
    // 解析参数直到 ')'
    const closeParen = src.indexOf(')', parsed.end + 2);
    if (closeParen < 0)
        return false;
    const arg = src.slice(parsed.end + 2, closeParen);
    if (arg.length === 0)
        return false;
    if (silent)
        return true;
    state.pos = closeParen + 1;
    const token = state.push('media_embed', '', 0);
    token.meta = { type: parsed.type, arg };
    return true;
});
md.renderer.rules.media_embed = (tokens, idx) => {
    const { type, arg } = tokens[idx].meta;
    return buildMediaHtml(type, arg);
};
// 将 markdown 文本渲染为 HTML
// 为什么需要：LLM 返回的答案包含 markdown 语法（标题、列表、代码块等），需格式化展示
export function renderMarkdown(text) {
    if (!text)
        return '';
    return md.render(text);
}

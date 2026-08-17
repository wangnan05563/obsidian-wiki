// 网页捕获（书签捕获）子系统路由
// 解决场景：被站点 WAF/出口 IP 黑名单拦截的页面（如 shcpe），服务端 fetch 永远 420/黑名单页。
//   由用户本机浏览器访问目标页（走用户受信网络），通过 bookmarklet 把页面 outerHTML 发回本端点，
//   服务端仅做 HTML→文本清洗 + 合并 Markdown，返回 combinedMarkdown；前端再走 /api/compile 的 text 模式编译。
// 职责单一：本端点不调用 adapter.compile（编译由前端用返回的 combinedMarkdown 触发），与 url-ingest 两段式一致。
// 安全：requireAuth 保证仅登录用户可投递；html 长度上限防滥用；仅做只读清洗，不写盘、不回连目标站。

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AppConfig } from '../types.js';
import { extractHtmlContent, combinePagesToMarkdown, DEFAULT_CRAWL_CONFIG, type UrlCrawlPage } from '../utils/url-crawl.js';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';

// html 正文长度上限（字符）：>5MB 的页面视为异常，直接拒绝，避免单次请求占用过多内存
const MAX_HTML_LENGTH = 5_000_000;

// 注册网页捕获路由
export function registerRawIngestRoute(
  app: FastifyInstance,
  _config?: AppConfig,
  guards: IsolationGuards = createIsolationGuards(),
) {
  // ==========================================================================
  // POST /api/ingest/raw-html
  // 接收 bookmarklet 从目标页抓回的 outerHTML，提取正文并合并为 Markdown。
  // 请求体：{ html: string; url?: string; title?: string }
  //   - html 必填，来自 document.documentElement.outerHTML（含页面脚本，服务端会剥离）
  //   - url/title 可选，来自 bookmarklet 的 location.href / document.title；缺省时回退到 html 内 <title> 或占位
  // 响应（JSON）：{ ok, title, sourceUrl, contentLength, combinedMarkdown, pages }
  //   - combinedMarkdown 直接喂给 /api/compile 的 text 模式，复用现有编译管线
  // ==========================================================================
  app.post('/api/ingest/raw-html', {
    preHandler: guards.requireAuth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { html?: string; url?: string; title?: string };
    const html = (body.html ?? '').trim();
    if (!html) {
      return void reply.code(400).send({ error: '缺少 html 字段' });
    }
    if (html.length > MAX_HTML_LENGTH) {
      return void reply.code(413).send({ error: `html 过大（上限 ${MAX_HTML_LENGTH} 字符）` });
    }

    // 来源 URL 与标题：优先用 bookmarklet 传入；标题缺失时尝试从 html 的 <title> 提取
    const sourceUrl = (body.url ?? '').trim();
    let title = (body.title ?? '').trim();
    if (!title) {
      const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      title = m ? m[1].trim() : (sourceUrl || '未命名页面');
    }

    // 复用与 URL 爬取完全一致的 HTML→文本清洗（剥离 script/style/template/Handlebars 占位，标题转 Markdown）
    const { text } = extractHtmlContent(html, sourceUrl || 'about:blank');
    const contentLength = text.length;

    // 单页组装为 UrlCrawlPage，复用 combinePagesToMarkdown 生成与爬取同构的 Markdown
    const page: UrlCrawlPage = {
      url: sourceUrl || 'about:blank',
      title,
      content: text,
      depth: 0,
      attachments: [],
    };
    const combinedMarkdown = combinePagesToMarkdown([page], DEFAULT_CRAWL_CONFIG.copyrightNotice);

    return reply.send({
      ok: true,
      title,
      sourceUrl,
      contentLength,
      combinedMarkdown,
      pages: [{ url: page.url, title: page.title, contentLength }],
    });
  });
}

// ==========================================================================

// URL Crawling Subsystem

// ==========================================================================



import * as fs from 'node:fs';

import * as path from 'node:path';

export interface RobotsRule { pattern: string; allow: boolean; }



export interface RobotsTxt { rules: RobotsRule[]; crawlDelaySec: number; fetched: boolean; }



export interface UrlCrawlAttachment {

  url: string;

  type: 'document' | 'image' | 'audio' | 'video' | 'other';

  extension: string;

  size?: number;

}



export interface UrlCrawlPage {

  url: string; title: string; content: string; depth: number;

  attachments: UrlCrawlAttachment[];

}



export interface UrlCrawlConfig {

  maxHops?: number; timeoutMs?: number; maxPages?: number; userAgent?: string;

  allowedAttachmentTypes?: string[]; followRobotsTxt?: boolean; crawlDelayMs?: number;

  concurrency?: number; excludeTemplateElements?: boolean; renderJs?: boolean;

  contentAttachmentTypes?: string[]; retryAttempts?: number; retryBackoffMs?: number;

  enableAttachmentDedup?: boolean;

  logging?: { enabled?: boolean; logFilePath?: string };

  connectTimeoutMs?: number; readTimeoutMs?: number; copyrightNotice?: string;

  preserveOnCancel?: boolean; incrementalCrawl?: boolean;

  incrementalStatePath?: string; resumeCrawl?: boolean;

}



interface UrlCrawlEvent {

  type: 'progress' | 'page_start' | 'page_done' | 'page_error' | 'page_skipped' | 'attachment' | 'done' | 'error';

  step: string; message: string; data?: Record<string, unknown>;

}



interface RequiredUrlCrawlConfig extends UrlCrawlConfig {

  maxHops: number; timeoutMs: number; maxPages: number; userAgent: string;

  allowedAttachmentTypes: string[]; followRobotsTxt: boolean; crawlDelayMs: number;

  concurrency: number; excludeTemplateElements: boolean; renderJs: boolean;

  contentAttachmentTypes: string[]; retryAttempts: number; retryBackoffMs: number;

  enableAttachmentDedup: boolean;

  logging: { enabled: boolean; logFilePath: string };

  connectTimeoutMs: number; readTimeoutMs: number; copyrightNotice: string;

  preserveOnCancel: boolean; incrementalCrawl: boolean;

  incrementalStatePath: string; resumeCrawl: boolean;

}



export const DEFAULT_CRAWL_CONFIG: RequiredUrlCrawlConfig = {

  maxHops: 3, timeoutMs: 10000, maxPages: 50,

  userAgent: 'KarpathyWikiBot/1.0',

  allowedAttachmentTypes: [

    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',

    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',

    'mp4', 'webm', 'mp3', 'wav', 'ogg',

  ],

  followRobotsTxt: true, crawlDelayMs: 0, concurrency: 1,

  excludeTemplateElements: true, renderJs: false,

  contentAttachmentTypes: [

    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',

    'mp4', 'webm', 'mp3', 'wav', 'ogg',

  ],

  retryAttempts: 1, retryBackoffMs: 500, enableAttachmentDedup: true,

  logging: { enabled: false, logFilePath: '../data/url-crawl.log' },

  connectTimeoutMs: 0, readTimeoutMs: 0,

  copyrightNotice: '\u672c\u6587\u5185\u5bb9\u6765\u6e90\u4e8e\u4e92\u8054\u7f51\u516c\u5f00\u8d44\u6e90\uff0c\u4ec5\u7528\u4e8e\u4e2a\u4eba\u77e5\u8bc6\u7ba1\u7406\uff0c\u5982\u6709\u4fb5\u6743\u8bf7\u8054\u7cfb\u5220\u9664',

  preserveOnCancel: true, incrementalCrawl: false,

  incrementalStatePath: '../data/url-crawl-state.json', resumeCrawl: false,

};



async function checkSSRF(urlStr: string) {

  const hostname = new URL(urlStr).hostname;

  try {

    const dns = await import('node:dns');

    const ipv4s = await dns.promises.resolve4(hostname);

    for (const addr of ipv4s) {

      if (/^10[.]/.test(addr) || /^172[.](1[6-9]|2[0-9]|3[01])[.]/.test(addr) ||

          /^192[.]168[.]/.test(addr) || /^127[.]/.test(addr)) {

        throw new Error("SSRF blocked: " + hostname);

      }

    }

  } catch { }

}



export function parseRobotsTxt(raw: string) {

  const lines = raw.split("\n");

  const rules = [];

  let crawlDelaySec = 0, currentUserAgents = [], inOurBlock = false;

  const ROBOTS_BOT_NAME = 'KarpathyWikiBot';

  for (const rawLine of lines) {

    const line = rawLine.split('#')[0].trim();

    if (!line) continue;

    const colonIdx = line.indexOf(':');

    if (colonIdx < 0) continue;

    const directive = line.slice(0, colonIdx).trim().toLowerCase();

    const value = line.slice(colonIdx + 1).trim();

    if (directive === 'user-agent') {

      currentUserAgents.push(value.toLowerCase());

      inOurBlock = currentUserAgents.some((ua) => ua === '*' || ua === ROBOTS_BOT_NAME.toLowerCase());

      continue;

    }

    if (inOurBlock) {

      if (directive === 'allow') rules.push({ pattern: value, allow: true });

      else if (directive === 'disallow' && value !== '') rules.push({ pattern: value, allow: false });

      else if (directive === 'crawl-delay') {

        const parsed = parseInt(value, 10);

        if (!Number.isNaN(parsed) && parsed > 0) crawlDelaySec = parsed;

      }

    }

    if (directive !== 'user-agent') { currentUserAgents = []; inOurBlock = false; }

  }

  return { rules, crawlDelaySec, fetched: true };

}



function robotsPatternToRegex(pattern: string) {

  let re = '';

  for (const ch of pattern) {

    if (ch === '*') re += '.*';

    else if (ch === '$') re += '$';

    else re += ch.replace(/[' + '[' + NBSP '+?^`{}()|[\b\\]/g, '\\$&');

  }

  return new RegExp('^' + re + '$');

}

function extractHtmlContent(html: string, _baseUrl: string) {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // 移除无文本价值的块级元素：JS/CSS/模板占位/内联图标
  // 为什么在去标签前去块：若先去标签，<script> 内的 JS 代码会残留为正文噪声
  // 解决 shcpe 等 Ajax 站爬取到模板骨架 + JS 代码的质量问题
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<template[\s\S]*?<\/template>/gi, '');
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  // 移除 Handlebars 模板语法（{{#if}}/{{title}}/{{/if}} 等占位符无语义）
  // 为什么单独处理：shcpe 用 Handlebars 渲染，模板占位符不被标签正则匹配会混入正文
  text = text.replace(/\{\{[\s\S]*?\}\}/g, '');
  // <h\1 backreference using hex: \x31 = '1'
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\x31>/gi, (_match: string, level: string, content: string) => {
    return '\n' + '#'.repeat(Number(level)) + ' ' + stripTags(content).trim() + '\n';
  });
  text = text.replace(/<\/(?:p|div|section|article|li|tr|br|main|nav|header|footer|aside)\b[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '\"').replace(/&#39;/g, "'");
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/\n{3,}/g, '\n\n');
  return { text };
}

function stripTags(html: string) {
  return html.replace(/<[^>]+>/g, '');
}

// URL 规范化：解析相对 URL、剥离 hash、白名单协议
// 为什么需要：爬取队列中的链接可能是相对路径（../vip/x.html），需基于 baseUrl 解析为绝对 URL；
// 剥离 hash 避免 #section 重复爬取；仅允许 http/https 防止 javascript:/data: 等危险协议
export function normalizeUrl(rawUrl: string, baseUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim(), baseUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

// 目录前缀提取：用于限制爬取范围在入口 URL 同级或子路径下
// 为什么需要：BFS 爬取时需判断新链接是否在入口 URL 的目录前缀下，
// 避免爬取到外部站点（如入口 /content/shcpe/index.html → 前缀 /content/shcpe/，仅爬取该前缀下页面）
export function getDirectoryPrefix(entryUrl: string): string {
  try {
    const u = new URL(entryUrl);
    const dir = u.pathname.substring(0, u.pathname.lastIndexOf('/') + 1);
    return dir.endsWith('/') ? dir : dir + '/';
  } catch {
    return '';
  }
}

// 去重键提取：用 pathname+search 作为页面唯一标识
// 为什么需要：同一页面可能因 query 参数顺序不同产生不同 URL 字符串，用 pathname+search 作为去重键避免重复爬取
export function getDedupeKey(url: string): string {
  try {
    return new URL(url).pathname + new URL(url).search;
  } catch {
    return url;
  }
}

function extractLinksAndAttachments(html: string, baseUrl: string, allowedTypes: string[], contentTypes: string[]) {
  const links = [];
  const attachments = [];
  const seenAttUrl = new Set();

  // 为什么用捕获组 ()：原正则无捕获组导致 m[1] 永远 undefined，new URL(undefined) 抛错被吞，附件/链接全丢失
  const attrREStr = '<(?:a|img|video|audio|source)\\b[^>]*\\b(?:href|src)\\s*=\\s*[\x22\x27]([^\x22\x27]*)[\x22\x27]';
  const attrPattern = new RegExp(attrREStr, 'gi');

  let m;
  while ((m = attrPattern.exec(html)) !== null) {
    const rawUrl = m[1];
    try {
      const u = new URL(rawUrl, baseUrl);
      if (!['http:', 'https:'].includes(u.protocol)) continue;
      if (u.pathname.startsWith('/devtools/')) continue;
      const normalized = u.toString();
      const ext = (rawUrl.match(/\.(.+)$/) || [])[1] || '';
      if (allowedTypes.includes(ext.toLowerCase())) {
        // 为什么用字面量联合类型而非 string：attachments.push 要求 type 为 UrlCrawlAttachment['type']，
        //   用 let attTypeLabel: string 会导致类型不匹配，用 const + 字面量断言让 TS 收窄为联合类型
        let attTypeLabel: UrlCrawlAttachment['type'] = 'other';
        if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext.toLowerCase())) attTypeLabel = 'document';
        else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext.toLowerCase())) attTypeLabel = 'image';
        else if (['mp3', 'wav', 'ogg'].includes(ext.toLowerCase())) attTypeLabel = 'audio';
        else if (['mp4', 'webm'].includes(ext.toLowerCase())) attTypeLabel = 'video';
        attachments.push({ url: normalized, type: attTypeLabel, extension: ext.toLowerCase() });
        seenAttUrl.add(normalized);
      }
      if (ext.toLowerCase() === '' || ['html', 'htm', 'xhtml'].includes(ext.toLowerCase())) links.push(normalized);
    } catch { /* malformed URL */ }
  }
  return { links, attachments };
}

interface CrawlStateEntry { html: string; etag?: string | null; lastModified?: string | null; fetchedAt: string; title?: string; }
interface CrawlStateMeta { lastEntryUrl?: string; visitedUrls?: string[]; savedAt?: string; }
interface CrawlState { meta?: CrawlStateMeta; pages: Record<string, CrawlStateEntry>; }

async function loadCrawlState(statePath: string): Promise<CrawlState> {
  try {
    const raw = await fs.promises.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { meta: parsed.meta, pages: parsed.pages || {} };
  } catch { return { pages: {} }; }
}

async function saveCrawlState(statePath: string, state: CrawlState) {
  try {
    await fs.promises.mkdir(require('path').dirname(statePath), { recursive: true });
    await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2));
  } catch { }
}

async function appendLog(logFilePath: string, line: string) {
  try {
    await fs.promises.mkdir(require('path').dirname(logFilePath), { recursive: true });
    await fs.promises.appendFile(logFilePath, line + '\n', 'utf8');
  } catch { }
}

// Main BFS crawl generator
export async function* crawlUrl(entryUrl: string, options: UrlCrawlConfig): AsyncGenerator<UrlCrawlEvent> {
  const config = { ...DEFAULT_CRAWL_CONFIG, ...options };
  if (options?.logging) {
    config.logging = {
      enabled: options.logging.enabled ?? config.logging.enabled,
      logFilePath: options.logging.logFilePath ?? config.logging.logFilePath,
    };
  }

  const startTime = Date.now();
  const logEnabled = config.logging.enabled === true && !!config.logging.logFilePath;
  const log = (line: string) => {
    if (logEnabled && config.logging.logFilePath) appendLog(config.logging.logFilePath, '[' + new Date().toISOString() + '] ' + line);
  };

  const normalizedEntry = normalizeUrl(entryUrl, entryUrl);
  if (!normalizedEntry) {
    yield { type: 'error', step: 'init', message: 'Invalid entry URL' };
    return;
  }

  const prefix = getDirectoryPrefix(normalizedEntry);
  const queue = [{ url: normalizedEntry, depth: 0 }];
  const visited = new Set<string>();
  const allPages: UrlCrawlPage[] = [];
  const allAttachments: UrlCrawlAttachment[] = [];
  let pagesSkipped = 0;

  yield { type: 'progress', step: 'init', message: 'Starting crawl from: ' + normalizedEntry };
  // 为什么不在此处把入口 URL 加入 visited：循环体会统一执行 visited 检查与 add，
  // 若在此处预先加入，循环首次处理入口 URL 时会命中 visited.has 被跳过，导致 0 页爬取

  // Incremental crawl: load saved state
  if (config.incrementalCrawl && config.incrementalStatePath) {
    try {
      const state = await loadCrawlState(config.incrementalStatePath);
      if (state.meta?.visitedUrls) {
        for (const vk of state.meta.visitedUrls) {
          if (vk !== getDedupeKey(normalizedEntry)) visited.add(vk);
        }
      }
    } catch { }
  }

  while (queue.length > 0) {
    if (allPages.length >= config.maxPages) {
      yield { type: 'progress', step: 'limit', message: 'Reached maxPages=' + config.maxPages + ' limit' };
      break;
    }

    const currentDepth = queue[0].depth;
    const batch: Array<{ url: string; depth: number }> = [];
    while (queue.length > 0 && queue[0].depth === currentDepth && batch.length < config.concurrency) {
      // queue.shift() 在 while 守卫 queue.length > 0 下必然有值，但 TS 类型签名是 T | undefined
      // 用非空断言 ! 告知 TS 守卫已保证非空
      const item = queue.shift()!;
      batch.push(item);
    }

    for (const { url, depth } of batch) {
      if (depth >= config.maxHops) continue;
      if (allPages.length >= config.maxPages) break;

      const dedupeKey = getDedupeKey(url);
      if (visited.has(dedupeKey)) { pagesSkipped++; continue; }
      visited.add(dedupeKey);

      yield { type: 'page_start', step: 'fetch', message: url, data: { url, depth } };
      log('Fetching: ' + url);

      if (config.crawlDelayMs > 0) {
        try { await new Promise((r) => setTimeout(r, config.crawlDelayMs)); } catch { }
      }

      const timeoutMs = config.connectTimeoutMs || config.timeoutMs;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let html = '', title = '', pageError = null;

      try {
        await checkSSRF(url);
        const response = await fetch(url, {
          headers: { 'User-Agent': config.userAgent },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);

        html = await response.text();
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        title = titleMatch ? titleMatch[1].trim() : '';

        const { text } = extractHtmlContent(html, url);
        title = title || text.substring(0, 100) || 'Untitled';

        const { links, attachments } = extractLinksAndAttachments(html, url, config.allowedAttachmentTypes, config.contentAttachmentTypes);

        for (const att of attachments) {
          yield { type: 'attachment', step: 'parse', message: att.url, data: { attachment: att } };
          allAttachments.push(att);
        }

        if (config.incrementalCrawl && config.incrementalStatePath) {
          try {
            const state = await loadCrawlState(config.incrementalStatePath);
            state.pages[getDedupeKey(url)] = {
              html, etag: response.headers.get('etag') || null,
              lastModified: response.headers.get('last-modified') || null,
              fetchedAt: new Date().toISOString(), title,
            };
            if (!state.meta) state.meta = {};
            state.meta.visitedUrls = [...visited];
            state.meta.savedAt = new Date().toISOString();
            await saveCrawlState(config.incrementalStatePath, state);
          } catch { }
        }

        for (const link of links) {
          const resolved = normalizeUrl(link, url);
          if (!resolved) continue;
          const resolvedPrefix = getDirectoryPrefix(resolved);
          if (resolvedPrefix.startsWith(prefix) || resolved === normalizedEntry) {
            queue.push({ url: resolved, depth: depth + 1 });
          }
        }

        allPages.push({ url, title, content: text, depth, attachments: [...attachments] });

        yield { type: 'page_done', step: 'parse', message: 'Completed: ' + (title || url),
          data: { url, depth, title, contentLength: text.length, attachmentCount: attachments.length } };
      } catch (err) {
        clearTimeout(timeoutId);
        pageError = err instanceof Error ? err : new Error(String(err));
        yield { type: 'page_error', step: 'fetch', message: 'Failed: ' + url + ' -- ' + pageError.message,
          data: { url, depth, error: pageError.message } };
        log('Error fetching ' + url + ': ' + pageError.message);
      }
    }
  }

  // Done event
  try {
    const elapsed = Date.now() - startTime;
    const combinedMarkdown = combinePagesToMarkdown(allPages, config.copyrightNotice);
    yield { type: 'done', step: 'done', message: 'Crawl complete: ' + allPages.length + ' pages',
      data: {
        pagesCrawled: allPages.length, totalAttachmentCount: allAttachments.length,
        pages: allPages.map((p) => ({ url: p.url, title: p.title, depth: p.depth, contentLength: p.content.length, attachmentCount: p.attachments.length })),
        attachments: allAttachments, combinedMarkdown, elapsedMs: elapsed, pagesSkipped,
      }};
  } catch (err) {
    yield { type: 'error', step: 'done', message: err instanceof Error ? err.message : String(err) };
  }
}

export function combinePagesToMarkdown(pages: UrlCrawlPage[], copyrightNotice: string) {
  if (pages.length === 0) return '# Combined Crawl\n\n*No pages were crawled.*\n\n';
  let md = '# Combined Crawl\n\n';
  md += '> Crawled ' + pages.length + ' page(s).\n\n';
  md += '---\n\n';
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (i > 0) md += '\n\n---\n\n';
    const headingLevel = Math.min(page.depth + 1, 3);
    md += '#'.repeat(headingLevel) + ' ' + (page.title || page.url) + '\n\n';
    md += '_Source: [' + page.url + '](' + page.url + ')_\n\n';
    md += page.content + '\n\n';
    if (page.attachments.length > 0) {
      md += '### Attachments\n\n';
      for (const att of page.attachments) {
        // 为什么用 Record 类型断言：att.type 是联合类型，直接索引会报 TS7053
        const icons: Record<UrlCrawlAttachment['type'], string> = { document: '[D]', image: '[I]', audio: '[A]', video: '[V]', other: '[F]' };
        md += '- ' + (icons[att.type] || '[F]') + ' [' + att.url + '](' + att.url + ')\n';
      }
      md += '\n';
    }
  }
  if (copyrightNotice) md += '---\n\n> ' + copyrightNotice + '\n';
  return md;
}

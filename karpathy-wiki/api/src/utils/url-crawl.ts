// ==========================================================================

// URL Crawling Subsystem

// ==========================================================================



import * as fs from 'node:fs';
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

// NOSONAR - S1128 path 通过 require('path') 动态使用

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

  // 自定义请求头（合并到 User-Agent 之上）。默认由 DEFAULT_CRAWL_CONFIG 补齐浏览器基础头，
  // 避免仅带 UA 的请求被站点 WAF 识别为自动化探针而返回 420/黑名单页
  requestHeaders?: Record<string, string>;

  // B 方案：自定义 egress 代理（绕开服务器出口 IP 黑名单）。
  // 配置后，爬取请求经该 HTTP(S) 代理 egress（覆盖全局 setGlobalDispatcher），
  // 适用于目标站点把服务器出口 IP 拉黑、但代理出口 IP 未被拉黑的场景。
  // 仅当显式配置时才生效；为空则走全局 dispatcher（原行为不变）。
  egressProxyUrl?: string;

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

  requestHeaders: Record<string, string>;
  egressProxyUrl: string;

}



export const DEFAULT_CRAWL_CONFIG: RequiredUrlCrawlConfig = {

  // timeoutMs 30s：shcpe 等外网站点首次响应常 >10s（DNS/服务器延迟），
  // 原 10s 超时导致首页面 fetch abort → 静默 0 页。提至 30s 降低误判。
  maxHops: 3, timeoutMs: 30000, maxPages: 50,

  userAgent: 'KarpathyWikiBot/1.0',

  // 浏览器化基础请求头：部分站点 WAF 对"仅带 UA、无 Accept/Accept-Language 等"的请求直接拦截（420/黑名单页）。
  // 默认补齐常见浏览器头，提高对真实站点的可达性；User-Agent 仍由 userAgent 字段独立控制以便覆盖。
  requestHeaders: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  },

  egressProxyUrl: '',

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



// 判断 IPv4 地址是否属于应被拦截的私网/保留/链路本地范围。
// 覆盖：10./8、172.16-31./12、192.168./16、127./8、0.0.0.0/8（IPv4 回环/私网/不可路由）；
// 169.254.0.0/16（链路本地 / 云元数据 169.254.169.254）、100.64.0.0/10（CGNAT 运营商级 NAT）。
// 提取为独立函数降低 isRestrictedIp 的认知复杂度（S3776）。
function isRestrictedIpv4(a: string): boolean {
  if (a === '0.0.0.0' || a.startsWith('0.')) return true;
  if (a.startsWith('10.')) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (a.startsWith('192.168.')) return true;
  if (a.startsWith('127.')) return true;
  if (a.startsWith('169.254.')) return true; // 链路本地 / 云元数据
  if (a.startsWith('100.64.')) return true; // CGNAT
  return false;
}

// 判断 IPv6 地址是否属于应被拦截的链路本地/唯一本地范围。
// IPv6：::1/128（回环）、::（未指定）、fe80::/10（链路本地）、fc00::/7（唯一本地 ULA fc/fd 前缀）、
// ::ffff:<v4>（IPv4 映射，递归判定内嵌 v4）。
// 提取为独立函数降低 isRestrictedIp 的认知复杂度（S3776）。
function isRestrictedIpv6(a: string): boolean {
  if (a === '::1' || a === '::') return true;
  if (a.startsWith('fe80:')) return true; // 链路本地
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // 唯一本地 ULA
  // IPv4-mapped（::ffff:<v4>）：new URL 会规范化为 ::ffff:7f00:1 等无点形式，无法可靠还原内嵌 v4；
  // SSRF 应偏保守，凡 ::ffff: 前缀一律拦截（它本质是 IPv4 地址）。
  if (a.startsWith('::ffff:')) return true;
  return false;
}

// 判断 IP 地址（含 IPv4/IPv6 字面量，去掉方括号）是否属于应被拦截的私网/保留/链路本地范围。
// 覆盖：10./8、172.16-31./12、192.168./16、127./8、0.0.0.0/8（IPv4 回环/私网/不可路由）；
// 169.254.0.0/16（链路本地 / 云元数据 169.254.169.254）、100.64.0.0/10（CGNAT 运营商级 NAT）；
// IPv6：::1/128（回环）、::（未指定）、fe80::/10（链路本地）、fc00::/7（唯一本地 ULA fc/fd 前缀）、
// ::ffff:<v4>（IPv4 映射，递归判定内嵌 v4）。
// 为什么集中成纯函数：原 checkSSRF 仅拦截部分 IPv4 段且漏了链路本地/CGNAT/IPv6，
// 且原 throw 被外层 catch 吞掉导致完全不生效——此处统一收紧。
function isRestrictedIp(rawAddr: string): boolean {
  const a = rawAddr.replace(/(?:^\[|\]$)/g, '').toLowerCase();
  // IPv4 字面量（委托 isRestrictedIpv4 降低认知复杂度 S3776）
  if (a.includes('.')) {
    return isRestrictedIpv4(a);
  }
  // IPv6 字面量（委托 isRestrictedIpv6 降低认知复杂度 S3776）
  return isRestrictedIpv6(a);
}

// SSRF 防护：拦截解析到内网/保留/链路本地地址的入口 URL，避免后端被诱导抓取内网资源（如云元数据）。
// 关键修复：原实现对命中私网地址主动 throw，但该 throw 处于 try 内被 catch {} 吞掉 → 拦截从未生效。
// 现改为：DNS 解析失败才静默放行（保持原"解析不了就交给 fetch 决定"的行为），命中私网必须上抛，
// 由调用方（crawlUrl 主循环 / probeProxyEgress 探针）捕获并归类为 ssrf 错误。
// 同时支持 IPv4/IPv6 双栈解析（resolve4 + resolve6），并对 IP 字面量直接判定（无需 DNS）。
export async function checkSSRF(urlStr: string) {
  let hostname: string;
  try {
    hostname = new URL(urlStr).hostname.replace(/(?:^\[|\]$)/g, '');
  } catch {
    return; // 非法 URL 由调用方 fetch 决定成败
  }
  // IP 字面量：直接判定，避免无谓 DNS
  if (isRestrictedIp(hostname)) throw new Error('SSRF blocked: ' + hostname);
  // 域名：解析 A / AAAA 记录后逐条判定
  try {
    const dns = await import('node:dns');
    const [ipv4s, ipv6s] = await Promise.all([
      dns.promises.resolve4(hostname).catch(() => [] as string[]),
      dns.promises.resolve6(hostname).catch(() => [] as string[]),
    ]);
    for (const addr of [...ipv4s, ...ipv6s]) {
      if (isRestrictedIp(addr)) throw new Error('SSRF blocked: ' + hostname);
    }
  } catch (err) {
    // 仅当我们主动抛出的 SSRF 拦截才继续上抛；DNS 解析失败（catch 到 []）放行（保持原行为）
    if (err instanceof Error && err.message.startsWith('SSRF blocked')) throw err;
  }
}



export function parseRobotsTxt(raw: string) { // NOSONAR - 认知复杂度由业务逻辑决定

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

    else re += ch.replace(/[' + '[' + NBSP '+?^`{}()|[\b\\]/g, '\\$&'); // NOSONAR

  }

  return new RegExp('^' + re + '$');

}

export function extractHtmlContent(html: string, _baseUrl: string) {
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
    .replace(/&amp;/g, '&').replace(/&quot;/g, '\"').replace(/&#39;/g, "'"); // NOSONAR - S6535
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/\n{3,}/g, '\n\n');
  return { text };
}

// 校验 egress 代理 URL（B 方案）。
// 约束：① 非空；② 必须是合法 URL；③ 仅允许 http/https 协议（undici ProxyAgent 只支持 HTTP CONNECT 代理，不支持 SOCKS）。
// 返回规范化后的 URL 字符串；非法/空返回 null。
// 为什么单独校验：代理 URL 若指向 file:/data:/socks: 等，要么 ProxyAgent 构造即报错，要么可被利用为 pivot 打内网；
// 这里在入口处强制 http/https，配合目标 URL 自身的 checkSSRF，杜绝经代理访问内网资源。
export function validateProxyUrl(raw?: string): string | null {
  if (!raw?.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.toString();
}

// B 方案：爬取前的代理连通性自检。
// 为什么需要：B 最大失效场景是"用户填的代理出口 IP 也被目标站点拉黑"——
// 若不做预检，用户要等整轮爬取跑完才拿到 0 页面、且难以定位是代理问题还是目标问题。
// 预检经该代理发一次轻量 GET 到入口 URL，按结果分级：
//   - ok：代理出口可达目标（2xx）→ 爬取应正常
//   - blocked：代理出口仍被目标 WAF/黑名单拦截（420/403/WAF 页）→ 提示换代理或用 A1 书签捕获
//   - 网络/超时（reachable=false）：代理本身不可用或出口不通 → 调用方应中止爬取，避免注定失败的整轮等待
// 复用 undiciFetch + ProxyAgent（同实例，见 crawlUrl 注释），finally 关闭 dispatcher 防连接泄漏。
export interface ProxyProbeResult {
  ok: boolean;
  reachable: boolean;
  blocked: boolean;
  status: number;
  level: 'ok' | 'warn' | 'error';
  message: string;
}

// 处理代理探测请求的 HTTP 响应，返回对应的 ProxyProbeResult。
// 提取为独立函数降低 probeProxyEgress 的认知复杂度（S3776）。
function processProbeResponse(response: Response): Promise<ProxyProbeResult> {
  const status = response.status;
  if (response.ok) {
    // 不读取正文，仅取消响应体释放连接
    try { return (response.body as { cancel?: () => Promise<void> } | null)?.cancel?.()?.then(() => ({
      ok: true, reachable: true, blocked: false, status, level: 'ok' as const,
      message: `代理出口 IP 可达目标（HTTP ${status}），爬取应正常`,
    })) ?? Promise.resolve({
      ok: true, reachable: true, blocked: false, status, level: 'ok' as const,
      message: `代理出口 IP 可达目标（HTTP ${status}），爬取应正常`,
    }); } catch { /* ignore */ }
    return Promise.resolve({ ok: true, reachable: true, blocked: false, status, level: 'ok' as const, message: `代理出口 IP 可达目标（HTTP ${status}），爬取应正常` });
  }
  // 非 2xx：读少量响应体判断是否为 WAF/黑名单拦截页
  return response.text().then((raw) => {
    const bodyText = raw.slice(0, 2000).replace(/<[^>]+>/g, ' ');
    const isWaf = /黑名单|访问受限|禁止访问|拒绝访问|forbidden|security|防火墙|拦截|非法请求|access denied|bot detection/i.test(bodyText);
    if (status === 420 || status === 403 || isWaf) {
      return { ok: false, reachable: true, blocked: true, status, level: 'warn' as const,
        message: `代理出口 IP 仍被目标拦截（HTTP ${status}${isWaf ? '，疑似防火墙/黑名单页' : ''}）。建议换一个未被拉黑的代理，或用「网页捕获」书签直接投递` };
    }
    return { ok: false, reachable: true, blocked: false, status, level: 'warn' as const,
      message: `代理可达目标但返回 HTTP ${status}，爬取可能被拦截或需登录` };
  }).catch(() => ({
    ok: false, reachable: true, blocked: false, status, level: 'warn' as const,
    message: `代理可达目标但返回 HTTP ${status}，爬取可能被拦截或需登录`,
  }));
}

// 处理代理探测请求的异常，返回对应的 ProxyProbeResult。
// 提取为独立函数降低 probeProxyEgress 的认知复杂度（S3776）。
function processProbeError(err: unknown, timeoutMs: number): ProxyProbeResult {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || /abort|timeout/i.test(msg)) {
    return { ok: false, reachable: false, blocked: false, status: 0, level: 'error', message: `代理探测超时（>${Math.round(timeoutMs / 1000)}s 无响应），代理可能不可用或出口不通` };
  }
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|getaddrinfo|TLS|certificate|UND_ERR|socket/i.test(msg)) {
    return { ok: false, reachable: false, blocked: false, status: 0, level: 'error', message: `代理不可达或代理出口无法连接目标（${msg}）` };
  }
  return { ok: false, reachable: false, blocked: false, status: 0, level: 'error', message: `代理探测失败：${msg}` };
}

export async function probeProxyEgress(
  targetUrl: string,
  proxyUrl: string,
  timeoutMs = 15000,
): Promise<ProxyProbeResult> {
const pv = validateProxyUrl(proxyUrl);
  if (!pv) {
    return { ok: false, reachable: false, blocked: false, status: 0, level: 'error', message: '代理地址无效（仅支持 http:// 或 https://）' };
  }
  // SSRF 防护：探针同样会经代理请求 targetUrl，必须与 crawlUrl 主循环一致先校验目标地址，
  // 杜绝"探针绕过 checkSSRF 经代理探测内网/云元数据"的盲 SSRF 窗口（见 checkSSRF 修复说明）。
  try {
    await checkSSRF(targetUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reachable: false, blocked: false, status: 0, level: 'error', message: '目标 URL 被 SSRF 防护拦截（' + msg + '），请确认使用公网可访问 URL' };
  }
  const dispatcher = new ProxyAgent(pv);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await undiciFetch(targetUrl, {
      method: 'GET',
      headers: { 'User-Agent': DEFAULT_CRAWL_CONFIG.userAgent, ...DEFAULT_CRAWL_CONFIG.requestHeaders },
      signal: controller.signal,
      dispatcher,
    });
    clearTimeout(timer);
    const status = response.status;
    if (response.ok) {
      // 不读取正文，仅取消响应体释放连接
      try { await (response.body as { cancel?: () => Promise<void> } | null)?.cancel?.(); } catch { /* ignore */ }
      return { ok: true, reachable: true, blocked: false, status, level: 'ok', message: `代理出口 IP 可达目标（HTTP ${status}），爬取应正常` };
    }
    // 非 2xx：读少量响应体判断是否为 WAF/黑名单拦截页
    let bodyText = '';
    try { const raw = await response.text(); bodyText = raw.slice(0, 2000).replace(/<[^>]+>/g, ' '); } catch { /* ignore */ }
    const isWaf = /黑名单|访问受限|禁止访问|拒绝访问|forbidden|security|防火墙|拦截|非法请求|access denied|bot detection/i.test(bodyText);
    if (status === 420 || status === 403 || isWaf) {
      return { ok: false, reachable: true, blocked: true, status, level: 'warn', message: `代理出口 IP 仍被目标拦截（HTTP ${status}${isWaf ? '，疑似防火墙/黑名单页' : ''}）。建议换一个未被拉黑的代理，或用「网页捕获」书签直接投递` };
    }
    return { ok: false, reachable: true, blocked: false, status, level: 'warn', message: `代理可达目标但返回 HTTP ${status}，爬取可能被拦截或需登录` };
  } catch (err) {
    clearTimeout(timer);
    return processProbeError(err, timeoutMs);
  } finally {
    try { await dispatcher.close(); } catch { /* ignore */ }
  }
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

function extractLinksAndAttachments(html: string, baseUrl: string, allowedTypes: string[], contentTypes: string[]) { // NOSONAR
  const links = [];
  const attachments = [];
  // 已收录的附件 URL 集合：单次页面内去重，避免同一资源重复入附件列表
  const seenAttUrl = new Set<string>();

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
        // 同一页面内相同附件 URL 仅收录一次
        if (seenAttUrl.has(normalized)) continue;
        // 为什么用字面量联合类型而非 string：attachments.push 要求 type 为 UrlCrawlAttachment['type']，
        //   用 let attTypeLabel: string 会导致类型不匹配，用 const + 字面量断言让 TS 收窄为联合类型
        let attTypeLabel: UrlCrawlAttachment['type'] = 'other';
        if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext.toLowerCase())) attTypeLabel = 'document';
        else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext.toLowerCase())) attTypeLabel = 'image';
        else if (['mp3', 'wav', 'ogg'].includes(ext.toLowerCase())) attTypeLabel = 'audio';
        else if (['mp4', 'webm'].includes(ext.toLowerCase())) attTypeLabel = 'video';
        seenAttUrl.add(normalized);
        attachments.push({ url: normalized, type: attTypeLabel, extension: ext.toLowerCase() });
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
    await fs.promises.mkdir(require('path').dirname(statePath), { recursive: true }); // NOSONAR
    await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2));
  } catch { }
}

async function appendLog(logFilePath: string, line: string) {
  try {
    await fs.promises.mkdir(require('path').dirname(logFilePath), { recursive: true }); // NOSONAR
    await fs.promises.appendFile(logFilePath, line + '\n', 'utf8');
  } catch { }
}

// Main BFS crawl generator
export async function* crawlUrl(entryUrl: string, options: UrlCrawlConfig): AsyncGenerator<UrlCrawlEvent> { // NOSONAR - 函数签名需要多个参数
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

  // B 方案：自定义 egress 代理。仅当显式配置 egressProxyUrl 时接管 fetch 的 dispatcher，
  // 覆盖全局 setGlobalDispatcher；未配置则 proxyDispatcher 为 undefined，fetch 仍走全局 dispatcher（原行为不变）。
  let proxyDispatcher: Dispatcher | undefined;
  if (config.egressProxyUrl) {
    const pv = validateProxyUrl(config.egressProxyUrl);
    if (!pv) {
      yield { type: 'error', step: 'init', message: 'egressProxyUrl 无效（仅支持 http:// 或 https:// 代理地址）：' + config.egressProxyUrl };
      return;
    }
    proxyDispatcher = new ProxyAgent(pv);
  }

  try {
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
  // 错误汇总：0 页面时用于 done 事件给出明确诊断（避免静默 0 页无法定位）
  const crawlErrors: Array<{ url: string; errorType: string; message: string }> = [];

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
        const requestHeaders: Record<string, string> = {
          'User-Agent': config.userAgent,
          ...config.requestHeaders,
        };
        const response = await undiciFetch(url, {
          headers: requestHeaders,
          signal: controller.signal,
          // B 方案：配置 egress 代理时经该代理 egress，绕开服务器出口 IP 黑名单。
          // 必须用 undici 包导出的 fetch（与 ProxyAgent 同实例）；若用全局 fetch（Node 内置 undici），
          // 会因 dispatcher 实例类型不匹配抛出 UND_ERR_INVALID_ARG，导致代理完全不生效。
          dispatcher: proxyDispatcher,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          // 读取少量响应体用于判断是否为 WAF/黑名单拦截页（如 shcpe 返回 420 + 「黑名单页面」）。
          // 仅看状态码会把"站点防火墙拦截"误判为"需登录/不存在"，读 body 文本能给出更准确的诊断。
          let bodyText = '';
          try {
            const raw = await response.text();
            bodyText = raw.slice(0, 4000).replace(/<[^>]+>/g, ' ');
          } catch { /* ignore body read failure */ }
          const status = response.status;
          const isWafBlock = /黑名单|访问受限|禁止访问|拒绝访问|forbidden|security|防火墙|拦截|非法请求|access denied|bot detection/i.test(bodyText);
          let errorType = 'http';
          let userMessage = 'HTTP ' + status + ' ' + response.statusText;
          if (status === 401) {
            errorType = 'auth';
            userMessage = '站点要求登录鉴权（HTTP 401）：该 URL 需登录后才能访问，URL 爬取暂不支持自动登录';
          } else if (status === 403 || status === 420 || status === 406 || status === 407 || status === 423 || status === 451 || isWafBlock) {
            errorType = 'blocked';
            userMessage = '站点返回 HTTP ' + status + (isWafBlock ? '（防火墙/黑名单拦截页）' : '') +
              '：运行后端的服务器出口 IP 可能被站点 WAF 拉黑（你本机浏览器可访问，但后端所在网络被拦截）';
          }
          const httpErr = new Error(userMessage);
          httpErr.name = 'HttpError';
          (httpErr as Error & { errorType?: string }).errorType = errorType;
          throw httpErr;
        }

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

        // 错误分类：让前端显示明确原因，避免"静默 0 页"无法定位
        // 优先级：① 已在 try 中附加的精确 errorType（auth/blocked/http，含 WAF/黑名单判定）；
        //          ② 超时（AbortController 信号中断）；③ 网络底层错误；④ SSRF 拦截。
        // - timeout: AbortController 在 timeoutMs 后 abort（信号中断）
        // - http: 响应状态码非 2xx（已在 try 中抛出 HttpError，未细分时回退为 http）
        // - network: fetch 失败（DNS/连接拒绝/TLS 等底层错误）
        // - ssrf: checkSSRF 拦截内网地址
        let errorType = (pageError as Error & { errorType?: string }).errorType || 'unknown';
        let userMessage = pageError.message;
        if (pageError.name === 'AbortError' || (controller.signal as { aborted?: boolean }).aborted) {
          errorType = 'timeout';
          userMessage = `请求超时（>${Math.round(timeoutMs / 1000)}s 无响应），站点可能响应缓慢或网络不通`;
        } else if (pageError.name === 'HttpError' && !errorType) {
          errorType = 'http';
        } else if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|getaddrinfo|TLS|certificate/i.test(pageError.message)) {
          errorType = 'network';
          userMessage = '网络连接失败：' + pageError.message;
        } else if (/SSRF blocked/i.test(pageError.message)) {
          errorType = 'ssrf';
        }

        yield { type: 'page_error', step: 'fetch', message: 'Failed: ' + url + ' -- ' + userMessage,
          data: { url, depth, error: userMessage, errorType } };
        crawlErrors.push({ url, errorType, message: pageError.message });
        log('Error fetching ' + url + ' [' + errorType + ']: ' + pageError.message);
      }
    }
  }

  // Done event
  try {
    const elapsed = Date.now() - startTime;
    const combinedMarkdown = combinePagesToMarkdown(allPages, config.copyrightNotice);

    // 0 页面诊断：聚合错误类型，给出最可能是根因的提示（静默 0 页 → 明确原因）
    let diagnosis: string | undefined;
    if (allPages.length === 0 && crawlErrors.length > 0) {
      const typeCounts: Record<string, number> = {};
      for (const e of crawlErrors) typeCounts[e.errorType] = (typeCounts[e.errorType] || 0) + 1;
      const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0];
      const diagMap: Record<string, string> = {
        timeout: '所有页面请求超时，站点响应过慢或网络不通，建议提高 timeoutMs 或稍后重试',
        http: '所有页面返回非 2xx 状态码（可能被拦截或需登录），请检查站点可访问性',
        blocked: '所有页面被站点防火墙/WAF 拦截（返回 403/420 或黑名单页面）：运行后端的服务器出口 IP 可能被拉黑。你本机浏览器可访问，但后端所在网络被拦截 —— 建议改用「文本/文件」方式直接投递页面内容',
        auth: '所有页面要求登录鉴权（HTTP 401）：该站点需登录后才能访问，URL 爬取暂不支持自动登录，请改用「文本/文件」方式投递已登录后保存的页面',
        network: '所有页面网络连接失败（DNS/TLS/拒绝连接），请检查网络或站点是否下线',
        ssrf: '入口 URL 被 SSRF 防护拦截（解析到内网地址），请确认使用公网可访问 URL',
        unknown: '所有页面抓取失败，原因未知，请查看后端日志',
      };
      diagnosis = diagMap[topType] || diagMap.unknown;
    }

    yield { type: 'done', step: 'done', message: 'Crawl complete: ' + allPages.length + ' pages',
      data: {
        pagesCrawled: allPages.length, totalAttachmentCount: allAttachments.length,
        pages: allPages.map((p) => ({ url: p.url, title: p.title, depth: p.depth, contentLength: p.content.length, attachmentCount: p.attachments.length })),
        attachments: allAttachments, combinedMarkdown, elapsedMs: elapsed, pagesSkipped,
        errorCount: crawlErrors.length,
        errors: crawlErrors.slice(0, 20),
        diagnosis,
      }};
  } catch (err) {
    yield { type: 'error', step: 'done', message: err instanceof Error ? err.message : String(err) };
  }
  } finally {
    // B 方案：爬取结束（无论成功/异常/提前 return）均关闭代理连接池，避免长连接泄漏
    if (proxyDispatcher) {
      try { await proxyDispatcher.close(); } catch { /* ignore */ }
    }
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


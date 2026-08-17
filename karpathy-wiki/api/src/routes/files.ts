import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import matter from 'gray-matter';
import type { VaultService } from '../vault/vault-service.js';
import path from 'node:path';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';

// 注册文件管理路由。
//   GET  /api/files/tree          获取 Vault 目录树
//   GET  /api/files/pages         获取扁平化页面列表（FR-11 看板/日历视图数据源）
//   GET  /api/files?path=xxx      读取文件内容（含 frontmatter 解析）
//   PUT  /api/files?path=xxx      写入文件内容
// path 由 query 参数避免 URL 编码问题（L-5）。

// 目录树缓存（listTree 结果不变，可缓存）
const FILES_TREE_CACHE_TTL_MS = 30 * 1000; // 30秒
let filesTreeCache: { tree: unknown; cachedAt: number } | null = null;

// 页面扁平列表缓存（listAllPages 结果不变，可缓存）
let filesPagesCache: { pages: unknown; cachedAt: number } | null = null;

// 只读 GET 路由的统一限流配置（P1-4）：
// 全局默认 60 req/min 兜底写操作，这里覆盖为 300 req/min 提升浏览体验
// 为什么独立常量：files/graph/stats/schema/tags-pending 共用同一档位，便于统一调整
const READ_RATE_LIMIT = { max: 300, timeWindow: '1 minute' };

// 二进制扩展名与对应 Content-Type（GET /api/files 与 GET /api/files/download 共用）
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm']);
const BINARY_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
// 文本类扩展名对应的 Content-Type（下载端点按此设置，未知文本回退 text/plain）
const TEXT_CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
};

// 生成 RFC 5987 兼容的 Content-Disposition，支持中文等非 ASCII 文件名：
// 现代浏览器优先使用 filename*（UTF-8 编码），旧浏览器回退到 ASCII 的 filename。
// 为什么需要：vault 文件名常含中文（如「上海票据交易所.md」），直接用 GBK/UTF-8 字节塞进
//   filename 会被截断或乱码；filename* 是标准做法，Chrome/Edge/Firefox/Safari 均支持。
function buildAttachmentHeader(relPath: string): string {
  const baseName = path.basename(relPath);
  const ext = path.extname(baseName);
  // 仅当文件名全为可打印 ASCII 时直接用作 legacy filename，否则用中性名 + 扩展名兜底
  const isAscii = /^[\x20-\x7e]*$/.test(baseName);
  // #8：清洗可能破坏 header 结构的字符（" \ CR/LF 及控制字符），避免响应头注入
  const legacyName = (isAscii ? baseName : `vault-file${ext}`).replace(/["\\\x00-\x1f\x7f]/g, '_');
  // #8：filename*（RFC 5987）需对 encodeURIComponent 未覆盖的 ' ( ) * 做百分号转义
  //   （RFC 5987 attr-char 不含这三者；不转义会在部分浏览器解析异常）
  const encodedName = encodeURIComponent(baseName)
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
  return `attachment; filename="${legacyName}"; filename*=UTF-8''${encodedName}`;
}

// 将 vault 读取错误（含透传的 fs 错误码）映射为合适的 HTTP 状态码与消息（#7）。
// 路由原统一返回 404「文件不存在」，会误标目录/权限错误；这里按 code 分流：
//   EISDIR→400（当文件下的是目录）、EACCES/EPERM→403、ENOENT→404、EOUTSIDE→400（路径越界）、其它→500。
function mapVaultReadError(err: unknown): { status: number; message: string } {
  const e = err as (Error & { code?: string }) | null;
  const code = e?.code;
  const message = e?.message || '读取文件失败';
  if (code === 'EISDIR') return { status: 400, message };
  if (code === 'EACCES' || code === 'EPERM') return { status: 403, message };
  if (code === 'ENOENT') return { status: 404, message };
  if (code === 'EOUTSIDE') return { status: 400, message };
  // 未知错误（含磁盘故障等真实服务端错误）返回 500，避免被误认为「资源不存在」
  return { status: 500, message };
}

// 公开媒体文件服务路由：服务 queries/ 下服务端生成的图像/视频等二进制文件，无需认证。
// 为什么需要：浏览器 <img>/<video> 标签无法携带 Authorization header，
//   若走 /api/files（受 filesReadAuthRequired 保护）会 401。
// 安全边界：① 仅限 queries/ 目录（服务端生成归档，非用户上传）；
// ② 文件名含时间戳（不可枚举）；③ URL 仅通过 SSE 分发给已认证用户。
// 路径格式：GET /api/media/file/image-20260814-221213.png → vault readFileBuffer('queries/image-20260814-221213.png')
const MEDIA_PREFIX = 'queries/';
const MEDIA_PATH_RE = /^([a-zA-Z0-9_\-./]+)$/; // 防路径穿越：仅允许字母数字._-/.

export function registerPublicMediaServeRoute(app: FastifyInstance, vault: VaultService): void {
  // 用无约束的 '*' 通配（find-my-way 原生 catch-all），不要用 ':path*' 命名通配符——
  // 后者在匹配带扩展名的文件名时会抛 'invalid parameter value' (400)，且无约束 '*' 不影响
  // 本 handler（路径完全从 request.url 解析，不依赖任何 param 命名）。
  app.get('/api/media/file/*', {
    config: { rateLimit: READ_RATE_LIMIT },
  },   async (request: FastifyRequest, reply: FastifyReply) => {
    // 从 request.url 直接提取文件名，避免依赖 fastify 通配符的 param 命名差异。
    const urlPath = (request.url || '').split('?')[0];
    const MEDIA_SERVE_PREFIX = '/api/media/file/';
    const rawPath = urlPath.startsWith(MEDIA_SERVE_PREFIX)
      ? decodeURIComponent(urlPath.slice(MEDIA_SERVE_PREFIX.length))
      : '';
    // 纵深防御：拒绝路径穿越序列（vault.resolve 另有 EOUTSIDE 兜底，这里再挡一层）。
    if (!MEDIA_PATH_RE.test(rawPath) || rawPath.includes('..')) {
      return void reply.code(400).send({ error: '非法文件名', rawPath });
    }
    const relPath = MEDIA_PREFIX + rawPath;
    const ext = path.extname(rawPath).toLowerCase();
    try {
      if (!BINARY_EXTENSIONS.has(ext)) {
        return void reply.code(400).send({ error: '仅支持二进制媒体文件' });
      }
      const buffer = await vault.readFileBuffer(relPath);
      reply.header('Content-Type', BINARY_CONTENT_TYPES[ext] || 'application/octet-stream');
      // 缓存策略：生成媒体不变更，允许浏览器/CDN 缓存 1 小时
      reply.header('Cache-Control', 'public, max-age=3600, immutable');
      return void reply.send(buffer);
    } catch (err: unknown) {
      const { status, message } = mapVaultReadError(err);
      return void reply.code(status).send({ error: message });
    }
  });
}

export function registerFilesRoutes(
  app: FastifyInstance,
  vault: VaultService,
  guards: IsolationGuards = createIsolationGuards(),
  // #5：读端点是否要求登录（配置驱动，默认 false 不破坏既有公开可读性）。
  // 置 true 且 auth 启用时，/tree /pages /files /download 四个读端点统一挂 guards.requireAuth，
  // 实现「知识库仅登录可见」；auth.enabled=false（单租户）时守卫恒放行，本开关不再生效。
  opts?: { filesReadAuthRequired?: boolean },
) {
  // 仅当配置要求读鉴权且 auth 已启用时才挂载守卫（auth 关闭则守卫恒放行，无需挂）。
  const readPreHandler = opts?.filesReadAuthRequired && guards.enabled ? guards.requireAuth : undefined;
  // 目录树：返回 Vault 内所有文件与目录的嵌套结构，供前端 el-tree 渲染。
  app.get('/api/files/tree', { config: { rateLimit: READ_RATE_LIMIT }, preHandler: readPreHandler }, async (_request, reply) => {
    const now = Date.now();
    // 检查缓存
    if (filesTreeCache && (now - filesTreeCache.cachedAt) < FILES_TREE_CACHE_TTL_MS) {
      return void reply.send({ tree: filesTreeCache.tree });
    }

    try {
      const tree = await vault.listTree();
      // 写入缓存
      filesTreeCache = { tree, cachedAt: now };
      return void reply.send({ tree });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 页面扁平列表：返回所有正式页面（含 frontmatter），供看板/日历视图分组。
  // 为什么单独端点：el-tree 是嵌套结构，看板/日历需要扁平 + frontmatter，复用不划算
  app.get('/api/files/pages', { config: { rateLimit: READ_RATE_LIMIT }, preHandler: readPreHandler }, async (_request, reply) => {
    const now = Date.now();
    if (filesPagesCache && (now - filesPagesCache.cachedAt) < FILES_TREE_CACHE_TTL_MS) {
      return void reply.send({ pages: filesPagesCache.pages });
    }
    try {
      const pages = await vault.listAllPages();
      filesPagesCache = { pages, cachedAt: now };
      return void reply.send({ pages });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 读文件：返回 content 与 frontmatter（解析后对象），供前端渲染页面详情。
  app.get('/api/files', { config: { rateLimit: READ_RATE_LIMIT }, preHandler: readPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { path?: string };
    if (!query.path) {
      return void reply.code(400).send({ error: '缺少 path 参数' });
    }
    try {
      // 图片等二进制文件：直接返回二进制流（不经过 gray-matter 解析）
      // 为什么需要：前端 <img src="/api/files?path=xxx.png"> 需要二进制流，JSON 包装无法显示
      const ext = path.extname(query.path).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        const buffer = await vault.readFileBuffer(query.path);
        reply.header('Content-Type', BINARY_CONTENT_TYPES[ext] || 'application/octet-stream');
        return void reply.send(buffer);
      }
      const content = await vault.readFile(query.path);
      // gray-matter 分离 frontmatter 与正文，前端可分别渲染元信息与 Markdown 正文
      const parsed = matter(content);
      return void reply.send({
        content,
        frontmatter: parsed.data,
        body: parsed.content,
      });
    } catch (err: unknown) {
      const { status, message } = mapVaultReadError(err);
      return void reply.code(status).send({ error: message });
    }
  });

  // 下载端点：返回文件原始字节（文本或二进制），并带 Content-Disposition: attachment，
  // 触发浏览器/移动端「保存到本地」而非内联预览。复用 vault.resolve 做路径越界防护。
  // 与 GET /api/files 区别：后者对文本返回 JSON（含 frontmatter 解析），本端点返回原始字节，
  //   语义上专为「下载」设计；两者共用同一档 readPreHandler 守卫（#5）：当 config.auth.filesReadAuthRequired
  //   为 true 且 auth 启用时，未登录请求在此即被 401 拒绝（SPA 已通过 apiFetch 注入 Bearer Token，登录态正常通过）。
  // 文件名通过 buildAttachmentHeader 输出 RFC 5987 filename*，兼容中文等非 ASCII 文件名。
  // 错误响应（4xx/5xx）不携带 Content-Disposition（#6）；状态码按底层错误码分流（#7）。
  app.get('/api/files/download', { config: { rateLimit: READ_RATE_LIMIT }, preHandler: readPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { path?: string };
    if (!query.path) {
      return void reply.code(400).send({ error: '缺少 path 参数' });
    }
    try {
      const ext = path.extname(query.path).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        const buffer = await vault.readFileBuffer(query.path);
        reply.header('Content-Type', BINARY_CONTENT_TYPES[ext] || 'application/octet-stream');
        reply.header('Content-Disposition', buildAttachmentHeader(query.path));
        return void reply.send(buffer);
      }
      // 文本类（含 .md）：返回原始文件内容（含 frontmatter），前端或移动端可整文件保存
      const content = await vault.readFile(query.path);
      reply.header('Content-Type', TEXT_CONTENT_TYPES[ext] || 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', buildAttachmentHeader(query.path));
      return void reply.send(content);
    } catch (err: unknown) {
      // #6：响应头仅在成功读取后设置，错误响应不再携带 Content-Disposition（避免误导客户端）
      // #7：按底层错误码分流状态码，而非一律 404
      const { status, message } = mapVaultReadError(err);
      return void reply.code(status).send({ error: message });
    }
  });

  // 写文件：用户在编辑器中修改内容后保存。受 VaultService 白名单约束。
  app.put('/api/files', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { path?: string };
    if (!query.path) {
      return void reply.code(400).send({ error: '缺少 path 参数' });
    }
    const body = request.body as { content?: string };
    if (!body || typeof body.content !== 'string') {
      return void reply.code(400).send({ error: '请求体须有 content 字段' });
    }
    try {
      await vault.writeFile(query.path, body.content);
      // 文件变更后使目录树与页面列表缓存同时失效（写后即刷）
      filesTreeCache = null;
      filesPagesCache = null;
      return void reply.send({ ok: true, path: query.path });
    } catch (err: unknown) {
      return void reply.code(403).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

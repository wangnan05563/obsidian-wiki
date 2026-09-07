import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import matter from 'gray-matter';
import type { VaultService } from '../vault/vault-service.js';
import path from 'node:path';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';
// FR-18 知识时效派生状态：在 /files/pages 返回时按需计算并注入，供 Browse 角标使用。
// 为什么后端注入而非前端重算：knowledge_status 判定在 utils/knowledge-status.ts，前端无该逻辑，
//   注入单一来源保证 Browse 角标与问答/健康检查三处取值一致。
import { computeKnowledgeStatus } from '../utils/knowledge-status.js';

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
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.pptx']);
const BINARY_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  // .pptx 是 OOXML zip，公开媒体路由按二进制放行，供前端 a[download] 下载生成的原生 PPT
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
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
  const legacyName = (isAscii ? baseName : `vault-file${ext}`).replace(/["\\\u0000-\u001f\u007f]/g, '_'); // NOSONAR - S6324 - 故意匹配控制字符用于文件名净化
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
// ② 文件名用随机 UUID（不可枚举，见 media-generation-workflow.randomMediaId），避免被遍历泄露他人内容；
// ③ URL 仅通过 SSE 分发给已认证用户；④ 仅放行二进制扩展名（.md 等归档文本返回 400，不泄露 prompt 等文本）。
// 路径格式：GET /api/media/file/image-<uuid>.png → vault readFileBuffer('queries/media/image-<uuid>.png')
// 仅服务 queries/media/ 子目录：生成的图像/视频统一归档于此，公开路由不暴露 queries/ 顶层
// （避免误服务爬虫附件、用户文档等其它 vault 内容）；.md 文本仍被 BINARY_EXTENSIONS 拦截返回 400。
const MEDIA_PREFIX = 'queries/media/';
const MEDIA_PATH_RE = /^([a-zA-Z0-9_\-./]+)$/; // 防路径穿越：仅允许字母数字._-/.

// 解析 RFC 7233 Range 头（bytes=start-end），返回有效区间或 null。
// 为什么手动实现而非 @fastify/range：仅这一个公开媒体路由需要 Range，
//   引入插件的代价大于收益；标准协议手写 ~20 行即可。
// 支持三种合法语法：
//   bytes=0-1023      → 闭区间
//   bytes=1024-       → 从 1024 到末尾（end 省略）
//   bytes=-500        → 最后 500 字节（start 省略，后缀区间）
// 越界 / 非法 / start>end 一律返回 null，由调用方返回 416。
function parseRange(rangeHeader: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return null;
  const startStr = match[1];
  const endStr = match[2];
  if (startStr === '' && endStr === '') return null; // "bytes=-" 非法
  let start: number;
  let end: number;
  if (startStr === '') {
    // 后缀区间：取最后 N 字节。start 不能为负，超出文件长度则取 0
    const suffixLen = Number(endStr);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return null;
    start = Math.max(0, size - suffixLen);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Number(endStr);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  }
  // 超出文件长度或 start>end 视为非法 Range，由调用方返回 416 + Content-Range: bytes */size
  if (start < 0 || start >= size || end < start) return null;
  // end 超过 size-1 时截断到文件末尾（部分客户端不会计算完整 end）
  end = Math.min(end, size - 1);
  return { start, end };
}

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
      const contentType = BINARY_CONTENT_TYPES[ext] || 'application/octet-stream';
      // 缓存策略：生成媒体不变更，允许浏览器/CDN 缓存 1 小时
      const cacheControl = 'public, max-age=3600, immutable';

      // Range 请求处理（RFC 7233）：支持视频/音频 seek 与大图分片加载。
      // 为什么必加：现代浏览器对 <video> 元素默认发 Range 请求拉取头部探测编码，
      //   不响应 Range 会导致部分浏览器卡死或无法 seek。
      const rangeHeader = request.headers.range;
      if (rangeHeader) {
        const range = parseRange(rangeHeader, buffer.length);
        if (!range) {
          // 416 Range Not Satisfiable：告知客户端资源实际大小，便于其修正 Range。
          // 为什么只发 header 不发 body：已声明 Content-Range 头，fastify 不接受
          //   object payload（会抛 FST_ERR_REP_INVALID_PAYLOAD_TYPE 整进程崩溃），
          //   按 RFC 7233 §4.4 416 响应 body 可选。
          reply
            .code(416)
            .header('Content-Range', `bytes */${buffer.length}`)
            .header('Content-Type', contentType)
            .header('Cache-Control', cacheControl)
            .send('');
          return;
        }
        const { start, end } = range;
        const chunkSize = end - start + 1;
        // 206 Partial Content：subarray 复用底层 ArrayBuffer，零拷贝切片
        reply
          .code(206)
          .header('Content-Type', contentType)
          .header('Content-Length', String(chunkSize))
          .header('Content-Range', `bytes ${start}-${end}/${buffer.length}`)
          .header('Accept-Ranges', 'bytes')
          .header('Cache-Control', cacheControl)
          .send(buffer.subarray(start, end + 1));
        return;
      }

      // 非 Range 请求：返回完整文件，并显式声明 Accept-Ranges: bytes，
      //   让浏览器知道后续可发 Range 请求（Chrome/Edge 默认会探测编码）
      reply
        .header('Content-Type', contentType)
        .header('Content-Length', String(buffer.length))
        .header('Accept-Ranges', 'bytes')
        .header('Cache-Control', cacheControl)
        .send(buffer);
      return;
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
  // FR-18 知识时效阈值（knowledge.staleDays，默认 365）：/files/pages 据此注入每页 knowledge_status
  knowledgeStaleDays = 365,
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
      // FR-18 时效角标：为每页注入派生 knowledge_status，前端据此渲染绿/橙/灰点
      const withStatus = pages.map((p) => ({
        ...p,
        knowledge_status: computeKnowledgeStatus(p.frontmatter, knowledgeStaleDays),
      }));
      filesPagesCache = { pages: withStatus, cachedAt: now };
      return void reply.send({ pages: withStatus });
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

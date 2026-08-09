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

export function registerFilesRoutes(app: FastifyInstance, vault: VaultService, guards: IsolationGuards = createIsolationGuards()) {
  // 目录树：返回 Vault 内所有文件与目录的嵌套结构，供前端 el-tree 渲染。
  app.get('/api/files/tree', { config: { rateLimit: READ_RATE_LIMIT } }, async (_request, reply) => {
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
  app.get('/api/files/pages', { config: { rateLimit: READ_RATE_LIMIT } }, async (_request, reply) => {
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
  app.get('/api/files', { config: { rateLimit: READ_RATE_LIMIT } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { path?: string };
    if (!query.path) {
      return void reply.code(400).send({ error: '缺少 path 参数' });
    }
    try {
      // 图片等二进制文件：直接返回二进制流（不经过 gray-matter 解析）
      // 为什么需要：前端 <img src="/api/files?path=xxx.png"> 需要二进制流，JSON 包装无法显示
      const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm']);
      const ext = path.extname(query.path).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        const buffer = await vault.readFileBuffer(query.path);
        const contentTypes: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
          '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
          '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
        };
        reply.header('Content-Type', contentTypes[ext] || 'application/octet-stream');
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
      return void reply.code(404).send({
        error: err instanceof Error ? err.message : String(err),
      });
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

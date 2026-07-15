import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import matter from 'gray-matter';
import type { VaultService } from '../vault/vault-service.js';

// 注册文件管理路由。
//   GET  /api/files/tree          获取 Vault 目录树
//   GET  /api/files?path=xxx      读取文件内容（含 frontmatter 解析）
//   PUT  /api/files?path=xxx      写入文件内容
// path 用 query 参数避免 URL 编码问题（L-5）。
export function registerFilesRoutes(app: FastifyInstance, vault: VaultService) {
  // 目录树：返回 Vault 内所有文件与目录的嵌套结构，供前端 el-tree 渲染。
  app.get('/api/files/tree', async (_request, reply) => {
    try {
      const tree = await vault.listTree();
      return reply.send({ tree });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 读文件：返回 content 与 frontmatter（解析后对象），供前端渲染页面详情。
  app.get('/api/files', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { path?: string };
    if (!query.path) {
      return reply.code(400).send({ error: '缺少 path 参数' });
    }
    try {
      const content = await vault.readFile(query.path);
      // gray-matter 分离 frontmatter 与正文，前端可分别渲染元信息与 Markdown 正文
      const parsed = matter(content);
      return reply.send({
        content,
        frontmatter: parsed.data,
        body: parsed.content,
      });
    } catch (err: unknown) {
      return reply.code(404).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 写文件：用户在编辑器中修改内容后保存。受 VaultService 白名单约束。
  app.put('/api/files', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { path?: string };
    if (!query.path) {
      return reply.code(400).send({ error: '缺少 path 参数' });
    }
    const body = request.body as { content?: string };
    if (!body || typeof body.content !== 'string') {
      return reply.code(400).send({ error: '请求体须含 content 字段' });
    }
    try {
      await vault.writeFile(query.path, body.content);
      return reply.send({ ok: true, path: query.path });
    } catch (err: unknown) {
      return reply.code(403).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

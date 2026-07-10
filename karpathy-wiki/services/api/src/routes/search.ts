import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { VaultService } from '../vault/vault-service.js';
import { searchPages } from '../search-util.js';

// 注册全文检索路由。
//   GET /api/search?q=关键词&type=&tag=  全文检索
//
// 当前实现：朴素 includes 匹配（垂直切片最简实现）。
// type/tag 过滤参数预留，当前仅按 q 匹配（后续可扩展 frontmatter 过滤）。
export function registerSearchRoute(app: FastifyInstance, vault: VaultService) {
  app.get('/api/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { q?: string; type?: string; tag?: string };
    if (!query.q?.trim()) {
      return reply.code(400).send({ error: '缺少 q 参数' });
    }

    try {
      const hits = await searchPages(vault, query.q, 20);
      return reply.send({ hits, total: hits.length });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

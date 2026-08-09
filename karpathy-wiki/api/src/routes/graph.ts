import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { VaultService } from '../vault/vault-service.js';

// 注册图谱数据路由。
//   GET /api/graph   返回双向链接图数据 { nodes, edges }
// 节点 = 页面相对路径，边 = [[页面名]] 引用关系。
// § link graph 缓存已下沉到 VaultService.buildLinkGraph，此处不再独立缓存。
//   /api/graph 与 /api/stats 共享同一份缓存，避免双倍重算。
// § 只读 GET 限流 300 req/min（P1-4），与 files/stats/schema 同档位，提升前端图谱渲染体验

export function registerGraphRoute(app: FastifyInstance, vault: VaultService) {
  app.get('/api/graph', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const graph = await vault.buildLinkGraph();
      return void reply.send(graph);
    } catch (err: unknown) {
      reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { VaultService } from '../vault/vault-service.js';

// 注册图谱数据路由。
//   GET /api/graph   返回双向链接图数据 { nodes, edges }
// 节点 = 页面相对路径，边 = [[页面名]] 引用关系。
export function registerGraphRoute(app: FastifyInstance, vault: VaultService) {
  app.get('/api/graph', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const graph = await vault.buildLinkGraph();
      return reply.send(graph);
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

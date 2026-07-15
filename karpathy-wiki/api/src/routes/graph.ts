import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { VaultService } from '../vault/vault-service.js';

// 注册图谱数据路由。
//   GET /api/graph   返回双向链接图数据 { nodes, edges }
// 节点 = 页面相对路径，边 = [[页面名]] 引用关系。
// § graph 也依赖 buildLinkGraph，加缓存避免重复计算。
const GRAPH_CACHE_TTL_MS = 30 * 1000; // 30秒

interface GraphResult {
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
}

let _graphCache: GraphResult | null = null;
let _graphCachedAt = 0;

export function registerGraphRoute(app: FastifyInstance, vault: VaultService) {
  app.get('/api/graph', async (_request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    // 检查缓存
    if (_graphCache && (now - _graphCachedAt) < GRAPH_CACHE_TTL_MS) {
      return reply.send(_graphCache);
    }

    try {
      const graph = await vault.buildLinkGraph();
      // 写入缓存
      _graphCache = graph;
      _graphCachedAt = now;
      return reply.send(graph);
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

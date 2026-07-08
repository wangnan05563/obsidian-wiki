import type { FastifyInstance } from 'fastify';
import type { EngineAdapter } from '../types.js';

// 注册 POST /api/health-check 路由。
// healthCheck 是纯确定性逻辑（不调 LLM），返回 JSON 报告即可，无需 SSE。
export function registerHealthCheckRoute(app: FastifyInstance, adapter: EngineAdapter) {
  app.post('/api/health-check', async (_request, reply) => {
    const report = await adapter.healthCheck();
    return reply.send(report);
  });
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { VaultService } from '../vault/vault-service.js';

// 注册统计路由。
//   GET /api/stats   返回仪表盘汇总数据（页数、目录分布、最近编译记录）
// 纯确定性聚合，不调 LLM。
// § link graph 缓存已下沉到 VaultService.buildLinkGraph，此处不再独立缓存。
//   /api/graph 与 /api/stats 共享同一份缓存，避免双倍重算。
// § 只读 GET 限流 300 req/min（P1-4）：Dashboard 一次刷新触发 graph+stats+files 多请求，
//   全局 60/min 易触发 429 影响监控体验

export function registerStatsRoute(app: FastifyInstance, vault: VaultService) {
  app.get('/api/stats', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const graph = await vault.buildLinkGraph();
      const vaultPath = vault.getVaultPath();

      // 按目录统计页数：Promise.all 并行 readdir，避免串行 IO 等待
      const pageDirs = ['entities', 'concepts', 'comparisons', 'queries'];
      const dirCounts: Record<string, number> = {};
      const dirResults = await Promise.all(
        pageDirs.map(async (d) => {
          const dirFull = path.join(vaultPath, d);
          try {
            const entries = await fs.readdir(dirFull);
            return [d, entries.filter((f) => f.endsWith('.md')).length] as const;
          } catch {
            return [d, 0] as const;
          }
        }),
      );
      for (const [d, count] of dirResults) {
        dirCounts[d] = count;
      }

      // 读取 log.md 末尾若干行作为最近编译记录（简单实现，不解析完整结构）
      let recentLog = '';
      try {
        const logContent = await vault.readFile('log.md');
        // 取最后 500 字符作为最近记录摘要
        recentLog = logContent.slice(-500);
      } catch {
        // log.md 可能还未创建
      }

      reply.send({
        totalPages: graph.nodes.length,
        totalLinks: graph.edges.length,
        dirCounts,
        recentLog,
      });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs/promises';
import path from 'path';
import type { VaultService } from '../vault/vault-service.js';

// 注册统计路由。
//   GET /api/stats   返回仪表盘汇总数据（页面数、目录分布、最近编译记录）
// 纯确定性聚合，不调 LLM。
export function registerStatsRoute(app: FastifyInstance, vault: VaultService) {
  app.get('/api/stats', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const graph = await vault.buildLinkGraph();
      const vaultPath = vault.getVaultPath();

      // 按目录统计页面数
      const pageDirs = ['entities', 'concepts', 'comparisons', 'queries'];
      const dirCounts: Record<string, number> = {};
      for (const d of pageDirs) {
        const dirFull = path.join(vaultPath, d);
        try {
          const entries = await fs.readdir(dirFull);
          dirCounts[d] = entries.filter((f) => f.endsWith('.md')).length;
        } catch {
          dirCounts[d] = 0;
        }
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

      return reply.send({
        totalPages: graph.nodes.length,
        totalLinks: graph.edges.length,
        dirCounts,
        recentLog,
      });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

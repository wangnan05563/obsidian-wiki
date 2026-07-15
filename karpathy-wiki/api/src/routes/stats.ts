import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { VaultService } from '../vault/vault-service.js';

// 注册统计路由。
//   GET /api/stats   返回仪表盘汇总数据（页数、目录分布、最近编译记录）
// 纯确定性聚合，不调 LLM。
// § 统计接口也依赖 buildLinkGraph，加缓存避免重复计算。
const STATS_CACHE_TTL_MS = 30 * 1000; // 30秒

interface StatsResult {
  totalPages: number;
  totalLinks: number;
  dirCounts: Record<string, number>;
  recentLog: string;
}

let _statsCache: StatsResult | null = null;
let _statsCachedAt = 0;

export function registerStatsRoute(app: FastifyInstance, vault: VaultService) {
  app.get('/api/stats', async (_request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    // 检查缓存
    if (_statsCache && (now - _statsCachedAt) < STATS_CACHE_TTL_MS) {
      return reply.send(_statsCache);
    }

    try {
      const graph = await vault.buildLinkGraph();
      const vaultPath = vault.getVaultPath();

      // 按目录统计页数
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

      const result: StatsResult = {
        totalPages: graph.nodes.length,
        totalLinks: graph.edges.length,
        dirCounts,
        recentLog,
      };

      // 写入缓存
      _statsCache = result;
      _statsCachedAt = now;

      return reply.send(result);
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

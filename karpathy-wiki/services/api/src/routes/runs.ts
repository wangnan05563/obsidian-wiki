import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';

// §11.2 断点续传：查询中断的 compile 任务列表。
// 完整 resume 涉及工作流闭包重建（afterStep hook 依赖 queue/generatedPages 等），
// 标记为待详细设计。当前先提供查询 API，让用户感知中断任务。
//
// §12.3-8 日志查看：GET /api/compile/runs/:runId/log 读取 .harness/logs/{runId}.log
export function registerRunsRoute(app: FastifyInstance, stateDir: string) {
  // 日志目录与 state 目录同级：.harness/logs/
  const logDir = path.resolve(stateDir, '..', 'logs');

  app.get('/api/compile/runs', async (_request, reply) => {
    try {
      const files = await fs.readdir(stateDir);
      const runs = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(stateDir, f), 'utf8');
          const state = JSON.parse(raw) as {
            runId: string;
            status: string;
            step: number;
            tokenUsed: number;
            startedAt: string;
          };
          // 仅返回摘要，不含完整 messages（避免响应过大）
          runs.push({
            runId: state.runId,
            status: state.status,
            step: state.step,
            tokenUsed: state.tokenUsed,
            startedAt: state.startedAt,
          });
        } catch {
          // 单个文件解析失败跳过
        }
      }
      // 按开始时间倒序，最新的在前
      runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return reply.send({ runs });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // §12.3-8 读取某次编译的技术日志（JSONL 格式，每行一个 JSON 对象）
  app.get<{ Params: { runId: string } }>(
    '/api/compile/runs/:runId/log',
    async (request, reply) => {
      const { runId } = request.params;
      // 防路径穿越：只允许 UUID 格式的 runId
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
        return reply.code(400).send({ error: '无效的 runId' });
      }
      const logFile = path.join(logDir, `${runId}.log`);
      try {
        const raw = await fs.readFile(logFile, 'utf8');
        // JSONL：每行一个 JSON，空行跳过
        const entries = raw
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
        return reply.send({ entries });
      } catch {
        // 文件不存在或读取失败
        return reply.code(404).send({ error: '日志不存在', entries: [] });
      }
    },
  );
}

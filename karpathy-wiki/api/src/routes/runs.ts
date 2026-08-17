import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getApiDir } from '../utils/runtime.js';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';

// §11.2 断点续传：查询中断的 compile 任务列表。
// 完整 resume 涉及工作流闭包重建（afterStep hook 依赖 queue/generatedPages 等），
// 标记为待详细设计。当前先提供查询 API，让用户感知中断任务。
//
// §12.3-8 日志查看：GET /api/compile/runs/:runId/log 读取 .harness/logs/{runId}.log
// §X-1 / §11.2 / §12.3-8 路由：query 步骤级追踪 + compile 续传/日志。
// 默认挂 requireAuth（与 api 其余端点一致）：这些端点含用户问题、工具结果、编译产物，
// 不应公开。前端 compile.ts / QueryTracePanel 均经 apiFetch 注入 token，登录态下无感。
export function registerRunsRoute(app: FastifyInstance, stateDir: string, guards: IsolationGuards = createIsolationGuards()) {
  // 日志目录与 state 目录同级：.harness/logs/
  const logDir = path.resolve(stateDir, '..', 'logs');

  app.get('/api/compile/runs', { preHandler: guards.requireAuth }, async (_request, reply) => {
    try {
      // 目录不存在时返回空列表：首次使用或清理后 state 目录尚未创建
      // 为什么不在这里 mkdir：state 目录由 compile 流程按需创建，查询接口不应有副作用
      let files: string[];
      try {
        files = await fs.readdir(stateDir);
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
          return void reply.send({ runs: [] });
        }
        throw err;
      }
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
      return void reply.send({ runs });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // §12.3-8 读取某次编译的技术日志（JSONL 格式，每行一个 JSON 对象）
  app.get<{ Params: { runId: string } }>(
    '/api/compile/runs/:runId/log',
    { preHandler: guards.requireAuth },
    async (request, reply) => {
      const { runId } = request.params;
      // 防路径穿越：只允许 UUID 格式的 runId
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
        return void reply.code(400).send({ error: '无效的 runId' });
      }
      const logFile = path.join(logDir, `${runId}.log`);
      try {
        const raw = await fs.readFile(logFile, 'utf8');
        // JSONL：每行一个 JSON，空行跳过
        const entries = raw
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
        reply.send({ entries });
      } catch {
        // 文件不存在或读取失败
        reply.code(404).send({ error: '日志不存在', entries: [] });
      }
    },
  );

  // ──────────────────────────────────────────────────────────────
  // §X-1 步骤级追踪：只读 query trace 路由。
  // query-run 状态由 harness 默认 FileStateStore 落在 api 进程 CWD 相对的
  // .harness/state（即 getApiDir()/.harness/state），与 compile 的
  // data/.harness/state 是不同目录，需独立读取。
  // 该路由对前端"横切 X-1 步骤级追踪面板"提供每步耗时分解（llmMs/toolMs/tokens/toolNames），
  // 直接定位 143s/282s 级长耗时瓶颈步骤。纯只读，无任何写副作用。
  const queryStateDir = path.resolve(getApiDir(), '.harness', 'state');

  // 列表：返回历史 query-run 摘要（runId / status / step / tokenUsed / startedAt / 总耗时），
  // 供面板选择某次运行进行下钻。仅读目录，无副作用。
  app.get('/api/query/runs', { preHandler: guards.requireAuth }, async (_request, reply) => {
    try {
      let files: string[];
      try {
        files = await fs.readdir(queryStateDir);
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
          return void reply.send({ runs: [] });
        }
        throw err;
      }
      const runs: Array<{
        runId: string;
        status: string;
        step: number;
        tokenUsed: number;
        startedAt: string;
        totalMs: number;
      }> = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(queryStateDir, f), 'utf8');
          const state = JSON.parse(raw) as {
            runId: string;
            status: string;
            step: number;
            tokenUsed: number;
            startedAt: string;
            timings?: Array<{ llmMs: number; toolMs: number }>;
          };
          const timings = state.timings ?? [];
          const totalMs = timings.reduce((s, t) => s + t.llmMs + t.toolMs, 0);
          runs.push({
            runId: state.runId,
            status: state.status,
            step: state.step,
            tokenUsed: state.tokenUsed,
            startedAt: state.startedAt,
            totalMs,
          });
        } catch {
          // 单个文件解析失败跳过
        }
      }
      runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return void reply.send({ runs });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 单 run trace：返回完整状态（events + 每步 timings + 聚合总耗时），供面板下钻渲染。
  app.get<{ Params: { runId: string } }>(
    '/api/query/runs/:runId',
    { preHandler: guards.requireAuth },
    async (request, reply) => {
      const { runId } = request.params;
      // 防路径穿越：仅允许 UUID（与 harness FileStateStore 校验一致）
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
        return void reply.code(400).send({ error: '无效的 runId' });
      }
      const file = path.join(queryStateDir, `${runId}.json`);
      try {
        const raw = await fs.readFile(file, 'utf8');
        const state = JSON.parse(raw) as {
          runId: string;
          task: string;
          events: unknown[];
          step: number;
          tokenUsed: number;
          status: string;
          startedAt: string;
          timings?: Array<{ step: number; llmMs: number; toolMs: number; tokens: number; toolNames: string[] }>;
        };
        const timings = state.timings ?? [];
        const totalLlmMs = timings.reduce((s, t) => s + t.llmMs, 0);
        const totalToolMs = timings.reduce((s, t) => s + t.toolMs, 0);
        return void reply.send({
          runId: state.runId,
          task: state.task,
          status: state.status,
          step: state.step,
          tokenUsed: state.tokenUsed,
          startedAt: state.startedAt,
          // §X-1 步骤级追踪核心：每步耗时分解
          timings,
          totalLlmMs,
          totalToolMs,
          totalMs: totalLlmMs + totalToolMs,
          events: state.events,
        });
      } catch {
        // 文件不存在或读取失败（含流式终端态尚未落盘）
        return void reply.code(404).send({ error: 'trace 不存在或尚未落盘', runId });
      }
    },
  );
}

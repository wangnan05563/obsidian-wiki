import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';

// §11.2 断点续传：查询中断的 compile 任务列表。
// 完整 resume 涉及工作流闭包重建（afterStep hook 依赖 queue/generatedPages 等），
// 标记为待详细设计。当前先提供查询 API，让用户感知中断任务。
//
// §12.3-8 日志查看：GET /api/compile/runs/:runId/log 读取 .harness/logs/{runId}.log
// §X-1 / §11.2 / §12.3-8 路由：query 步骤级追踪 + compile 续传/日志。
// 默认挂 requireAuth（与 api 其余端点一致）：这些端点含用户问题、工具结果、编译产物，
// 不应公开。前端 compile.ts / QueryTracePanel 均经 apiFetch 注入 token，登录态下无感。
export function registerRunsRoute(
  app: FastifyInstance,
  stateDir: string,
  guards: IsolationGuards = createIsolationGuards(),
  // T02772：run-state 目录清单（生产由 index.ts 传入「规范 + 遗留」合并清单）。
  // 默认只认传入的 stateDir：单测不传即只看自己造的临时目录，不会把真实用户目录读进断言。
  runStateDirsOverride?: string[],
) {
  // 日志目录与 state 目录同级：.harness/logs/
  const logDir = path.resolve(stateDir, '..', 'logs');
  const dirs = runStateDirsOverride ?? [stateDir];

  // 跨目录收集状态文件，按文件名（<runId>.json）去重，目录顺序即优先级。
  // 为什么规范目录在前：写入合流后新状态一定落在规范目录，遗留目录只用于
  // 补「升级前跑的那些存量运行」，同名时新数据不会被旧文件盖掉。
  async function listStateFiles(): Promise<string[]> {
    const byFileName = new Map<string, string>();
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        // 目录不存在 = 这个来源没有运行记录，继续下一个
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        if (!byFileName.has(name)) byFileName.set(name, path.join(dir, name));
      }
    }
    return [...byFileName.values()];
  }

  // 单 run 读取：按目录顺序返回第一个存在的 <runId>.json 内容，全无则 null。
  // 调用方已对 runId 做过 UUID 校验，拼接目录不会越权读别的文件。
  async function readStateFile(fileName: string): Promise<string | null> {
    for (const dir of dirs) {
      try {
        return await fs.readFile(path.join(dir, fileName), 'utf8');
      } catch {
        // 该目录没有，试下一个
      }
    }
    return null;
  }

  app.get('/api/compile/runs', { preHandler: guards.requireAuth }, async (_request, reply) => {
    try {
      // 目录不存在时返回空列表：首次使用或清理后 state 目录尚未创建
      // 为什么不在这里 mkdir：state 目录由 compile 流程按需创建，查询接口不应有副作用
      // T02772：清单跨目录收集——升级前落在遗留目录里的运行同样该出现在「中断任务」列表
      const files = await listStateFiles();
      const runs = [];
      for (const file of files) {
        try {
          const raw = await fs.readFile(file, 'utf8');
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
  // query-run 状态的目录口径见 utils/run-state-dirs.ts：历史上 harness 默认
  // FileStateStore 按**进程 CWD** 落盘（开发模式即 api/.harness/state，本机实测 107 个），
  // T02772 起写入合流到规范目录，读取仍跨「规范 + 遗留」合并——
  // 否则换了目录，历史运行的步骤追踪会凭空消失。纯只读，无任何写副作用。
  // 列表：返回历史 query-run 摘要（runId / status / step / tokenUsed / startedAt / 总耗时），
  // 供面板选择某次运行进行下钻。仅读目录，无副作用。
  app.get('/api/query/runs', { preHandler: guards.requireAuth }, async (_request, reply) => {
    try {
      const files = await listStateFiles();
      const runs: Array<{
        runId: string;
        status: string;
        step: number;
        tokenUsed: number;
        startedAt: string;
        totalMs: number;
      }> = [];
      for (const file of files) {
        try {
          const raw = await fs.readFile(file, 'utf8');
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
      const fileName = `${runId}.json`;
      try {
        const raw = await readStateFile(fileName);
        if (raw === null) throw new Error('状态文件不存在');
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

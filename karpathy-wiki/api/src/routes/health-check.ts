import path from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EngineAdapter, FixInput, BatchFixRequest } from '../types.js';
import { withCompileLock } from '../compile-queue.js';
import { createSSESender, setupSSE } from '../utils/sse.js';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';
import { BatchFixJobManager, type BatchFixSink } from '../workflows/batch-fix-job.js';
import { getDataDir } from '../utils/runtime.js';

// 快照瘦身：items 可能上千条（597 项批量 × 每项 target），对外响应只给状态与失败清单，
// 剩余项由后台作业自身持有，不让大数组在每次轮询/事件流里来回搬。
function withoutItems<T extends { items: unknown[] }>(snapshot: T): Omit<T, 'items'> {
  const { items, ...rest } = snapshot;
  void items;
  return rest;
}

// 注册健康检查路由。
//   POST /api/health-check                 体检（确定性逻辑，JSON 响应）
//   POST /api/health-check/fix             一键修复单个问题（走 LLM，SSE 流式响应）
//   POST /api/health-check/fix/batch       批量修复（T02466 起改为后台作业：立即返回 jobId）
//   GET  /api/health-check/fix/batch/current        最近一次批量作业快照（刷新/重进页面恢复进度）
//   GET  /api/health-check/fix/batch/estimate      启动前量化估算（问题数 / LLM 调用次数 / 预计耗时）
//   GET  /api/health-check/fix/batch/:jobId/events 订阅作业事件（SSE，支持 fromSeq 续传）
//   POST /api/health-check/fix/batch/pause|resume|cancel  暂停 / 继续 / 取消
//
// fix 走 withCompileLock 串行队列，避免与 compile 并发写入冲突；批量修复的作业内部
// 同样整批包在 withCompileLock 里（语义与改造前一致），只是不再绑定单次 HTTP 请求。
// SSE 写入统一用 createSSESender：客户端 abort 时 send 自动短路 + safeEnd 容错结束流，
// 避免 ERR_STREAM_DESTROYED 被 Fastify 转为 HTTP 500。
export function registerHealthCheckRoute(
  app: FastifyInstance,
  adapter: EngineAdapter,
  guards: IsolationGuards = createIsolationGuards(),
  jobsDir: string = path.join(getDataDir(), '.harness', 'batch-fix'),
) {
  const batchJobs = new BatchFixJobManager(jobsDir, adapter);

  app.post('/api/health-check', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    const report = await adapter.healthCheck();
    return void reply.send(report);
  });

  // 一键修复：SSE 流式返回修复进度
  app.post('/api/health-check/fix', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Partial<FixInput>;
    if (!body || (body.issueType !== 'broken_link' && body.issueType !== 'orphan') || !body.target) {
      return void reply.code(400).send({ error: '请求体须有 issueType(broken_link|orphan) 和 target' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const { send, isAborted, safeEnd } = createSSESender(reply, request);
    // T02466：记录真实耗时样本，供批量修复启动前的量化估算复用
    const fixStartedAt = Date.now();

    try {
      // 串行队列保护：fix 可能调用 write_file，与 compile 共享 vault 写入
      await withCompileLock(async () => {
        for await (const ev of adapter.healthCheckFix(body as FixInput)) {
          // 客户端已断开：提前退出迭代避免继续触发 LLM 调用与 vault 写入
          if (isAborted()) break;
          if (ev.step === 'done') {
            send('done', ev);
            if (ev.status === 'done') await batchJobs.recordDuration(Date.now() - fixStartedAt);
          } else if (ev.step === 'fixed') {
            send('fixed', ev);
          } else {
            send('progress', ev);
          }
        }
      });
    } catch (err: unknown) {
      request.log.error(
        { err, issueType: body.issueType },
        'health-check fix SSE stream error',
      );
      send('error', {
        step: 'done',
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      safeEnd();
    }
  });

  // ===== T02466（PRD R-F2 / H2）批量修复：后台作业化 =====
  // 改造原因：原实现把批量修复绑死在这一个 SSE 请求上——刷新/关页即失去进度，
  // 且无法暂停/取消，597 项只能「跑完或白跑」。现改为 POST 立即返回 jobId，
  // 由 BatchFixJobManager 在后台串行执行并逐项落盘，事件走独立订阅端点。
  app.post('/api/health-check/fix/batch', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Partial<BatchFixRequest> & { issueKeys?: string[] };
    if (!body || !Array.isArray(body.items) || body.items.length === 0) {
      return void reply.code(400).send({ error: '请求体须有非空 items 数组' });
    }
    for (const item of body.items) {
      if (!item || (item.issueType !== 'broken_link' && item.issueType !== 'orphan') || !item.target) {
        return void reply.code(400).send({
          error: 'items 中存在无效项，每项须有 issueType(broken_link|orphan) 和 target',
        });
      }
    }

    // 前端传入的 issueKey 数组（与 items 一一对应），用于日志与列表项状态联动。
    // 为什么仍由前端生成：列表项 key 已是稳定格式（如 "orphan:foo.md"），后端复用避免双源不一致。
    const issueKeys = body.issueKeys ?? [];
    const items = body.items.map((input, idx) => ({
      issueKey: issueKeys[idx] ?? `${input.issueType}:${idx}`,
      input,
    }));

    const snapshot = await batchJobs.start(items);
    void reply.code(202).send({
      jobId: snapshot.jobId,
      total: snapshot.total,
      status: snapshot.status,
      estimate: await batchJobs.estimate(snapshot.total),
    });
  });

  // 启动前量化估算：确认弹窗据此显示「N 个问题 / N 次 LLM 调用 / 约 X 分钟（估算）」。
  // 只读，无副作用；count 上限保护避免被当作压测入口。
  app.get('/api/health-check/fix/batch/estimate', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { count?: string };
    const raw = Number(query.count);
    if (!Number.isFinite(raw) || raw < 1) {
      return void reply.code(400).send({ error: 'count 须为不小于 1 的数字' });
    }
    const count = Math.min(Math.floor(raw), 5000);
    void reply.send(await batchJobs.estimate(count));
  });

  // 最近一次批量作业快照：页面刷新/重进时恢复进度面板（无作业返回 null）。
  app.get('/api/health-check/fix/batch/current', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    const snapshot = await batchJobs.latest();
    if (!snapshot) return void reply.send(null);
    void reply.send(withoutItems(snapshot));
  });

  // 指定作业快照：前端订阅事件前先用它校准状态。
  app.get<{ Params: { jobId: string } }>(
    '/api/health-check/fix/batch/:jobId',
    { preHandler: guards.requireAdmin },
    async (request, reply) => {
      const snapshot = await batchJobs.getSnapshot(request.params.jobId);
      if (!snapshot) return void reply.code(404).send({ error: '作业不存在或已过期' });
      void reply.send(withoutItems(snapshot));
    },
  );

  // 作业事件流：先回放缓冲（fromSeq 之后的事件，避免重连重复），再直播。
  // 客户端断开只退订，作业继续在后台跑——这是「关页不静默中断」的实现口径。
  app.get<{ Params: { jobId: string }; Querystring: { fromSeq?: string } }>(
    '/api/health-check/fix/batch/:jobId/events',
    { preHandler: guards.requireAdmin },
    async (request, reply) => {
      const jobId = request.params.jobId;
      const snapshot = await batchJobs.getSnapshot(jobId);
      if (!snapshot) return void reply.code(404).send({ error: '作业不存在或已过期' });

      setupSSE(reply);
      const { send, isAborted, safeEnd } = createSSESender(reply, request);
      const fromSeq = Number((request.query as { fromSeq?: string }).fromSeq ?? 0) || 0;
      const sink: BatchFixSink = {
        onEvent: (event, data) => {
          send(event, data);
        },
        isAborted,
        end: safeEnd,
      };
      batchJobs.subscribe(jobId, sink, fromSeq);
      request.raw.on('close', () => batchJobs.unsubscribe(jobId, sink));
    },
  );

  // 暂停 / 继续 / 取消：均返回最新快照，前端据此刷新按钮与文案。
  const controlActions: Array<['pause' | 'resume' | 'cancel', (jobId: string) => Promise<ReturnType<BatchFixJobManager['get']>>]> = [
    ['pause', (jobId) => batchJobs.pause(jobId)],
    ['resume', (jobId) => batchJobs.resume(jobId)],
    ['cancel', (jobId) => batchJobs.cancel(jobId)],
  ];
  for (const [action, run] of controlActions) {
    app.post(`/api/health-check/fix/batch/${action}`, { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { jobId?: unknown };
      const jobId = typeof body?.jobId === 'string' ? body.jobId : '';
      if (!jobId) return void reply.code(400).send({ error: '请求体须有 jobId' });
      const snapshot = await run(jobId);
      if (!snapshot) return void reply.code(404).send({ error: '作业不存在或已过期' });
      void reply.send(withoutItems(snapshot));
    });
  }

  // FR-18 AC-18-4：知识时效复核端点。确定性 JSON 操作，不走 LLM/SSE。
  // 为什么独立端点而非复用 fix：追加 reviewed_at 是纯 frontmatter 写，走 LLM fix 浪费 token 且可能改正文。
  // 写操作串行队列保护：与 compile 共享 vault 写入，避免并发写冲突（与 fix 同源理由）。
  app.post('/api/health-check/review', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { paths?: unknown };
    if (!body || !Array.isArray(body.paths) || body.paths.length === 0) {
      return void reply.code(400).send({ error: '请求体须有非空 paths 字符串数组' });
    }
    const paths = body.paths.filter((p): p is string => typeof p === 'string');
    if (paths.length === 0) {
      return void reply.code(400).send({ error: 'paths 须为字符串数组' });
    }
    try {
      const result = await withCompileLock(() => adapter.markKnowledgeReviewed(paths));
      void reply.send(result);
    } catch (err: unknown) {
      request.log.error({ err }, 'health-check review error');
      void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

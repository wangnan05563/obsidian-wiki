import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EngineAdapter, FixInput, BatchFixRequest, BatchFixProgressEvent } from '../types.js';
import { withCompileLock } from '../compile-queue.js';
import { createSSESender } from '../utils/sse.js';
import matter from 'gray-matter';
import path from 'node:path';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';

// 注册健康检查路由。
//   POST /api/health-check            体检（确定性逻辑，JSON 响应）
//   POST /api/health-check/fix        一键修复单个问题（走 LLM，SSE 流式响应）
//   POST /api/health-check/fix/batch  批量修复（串行循环调用 fix，SSE 流式响应）
//
// fix/fix/batch 均走 withCompileLock 串行队列，避免与 compile 并发写入冲突。
// SSE 写入统一用 createSSESender：客户端 abort 时 send 自动短路 + safeEnd 容错结束流，
// 避免 ERR_STREAM_DESTROYED 被 Fastify 转为 HTTP 500。
export function registerHealthCheckRoute(app: FastifyInstance, adapter: EngineAdapter, guards: IsolationGuards = createIsolationGuards()) {
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

    try {
      // 串行队列保护：fix 可能调用 write_file，与 compile 共享 vault 写入
      await withCompileLock(async () => {
        for await (const ev of adapter.healthCheckFix(body as FixInput)) {
          // 客户端已断开：提前退出迭代避免继续触发 LLM 调用与 vault 写入
          if (isAborted()) break;
          if (ev.step === 'done') {
            send('done', ev);
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

  // 批量修复：接收 items 数组，串行循环调用 adapter.healthCheckFix。
  // 每个问题的进度事件以 BatchFixProgressEvent 包装推送，前端可显示 "3/10" 进度。
  // 串行而非并发的理由同 fix 路由：vault 文件写入互斥。
  app.post('/api/health-check/fix/batch', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Partial<BatchFixRequest>;
    if (!body || !Array.isArray(body.items) || body.items.length === 0) {
      return void reply.code(400).send({ error: '请求体须有非空 items 数组' });
    }

    // 校验每个 item：issueType 合法 + target 非空
    for (const item of body.items) {
      if (!item || (item.issueType !== 'broken_link' && item.issueType !== 'orphan') || !item.target) {
        return void reply.code(400).send({
          error: 'items 中存在无效项，每项须有 issueType(broken_link|orphan) 和 target',
        });
      }
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const { send, isAborted, safeEnd } = createSSESender(reply, request);

    const items = body.items;
    const totalIssues = items.length;
    // 前端传入的 issueKey 数组（与 items 一一对应），用于日志与按钮状态联动。
    // 为什么从前端传入：前端已生成稳定 key（如 "orphan:foo.md"），后端复用避免双源不一致。
    const issueKeys = (request.body as Partial<BatchFixRequest & { issueKeys?: string[] }>)?.issueKeys
      ?? items.map((item, idx) => `${item.issueType}:${idx}`);

    // batch_start：通知前端批量任务开始，前端据此初始化进度条
    send('batch_start', { totalIssues });

    let successCount = 0;
    let failCount = 0;

    // 单问题修复流式推送：提取为局部函数降低 withCompileLock 回调认知复杂度
    // 返回值表示该问题是否失败（用于 failCount 累计）；成功计数通过闭包修改 successCount
    const streamIssueFix = async (
      item: FixInput,
      issueIndex: number,
      issueKey: string,
    ): Promise<boolean> => {
      let issueFailed = false;
      try {
        for await (const ev of adapter.healthCheckFix(item)) {
          if (isAborted()) break;
          // 包装为 BatchFixProgressEvent 推送
          const wrapped: BatchFixProgressEvent = {
            ...ev,
            issueIndex,
            totalIssues,
            issueKey,
            issueDone: ev.step === 'done',
          };
          if (ev.step === 'done') {
            if (ev.status === 'done') successCount++;
            else issueFailed = true;
            send('issue_done', wrapped);
          } else if (ev.step === 'fixed') {
            send('fixed', wrapped);
          } else {
            send('progress', wrapped);
          }
        }
      } catch (err: unknown) {
        issueFailed = true;
        request.log.error(
          { err, issueIndex, issueType: item.issueType },
          'health-check batch fix item error',
        );
        const errEv: BatchFixProgressEvent = {
          step: 'done',
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          issueIndex,
          totalIssues,
          issueKey,
          issueDone: true,
        };
        send('issue_error', errEv);
      }
      return issueFailed;
    };

    try {
      await withCompileLock(async () => {
        for (let i = 0; i < items.length; i++) {
          // 客户端断开：立即停止后续 LLM 调用与 vault 写入
          if (isAborted()) break;

          const item = items[i];
          const issueKey = issueKeys[i] ?? `${item.issueType}:${i}`;

          // issue_start：通知前端开始处理第 i 个问题
          send('issue_start', {
            issueIndex: i,
            totalIssues,
            issueKey,
            step: 'scan',
            status: 'running',
            message: `开始处理第 ${i + 1}/${totalIssues} 个问题`,
            issueDone: false,
          } satisfies BatchFixProgressEvent);

          const failed = await streamIssueFix(item, i, issueKey);
          if (failed) failCount++;
        }
      });

      // batch_done：通知前端批量任务结束，附统计信息
      send('batch_done', {
        step: 'done',
        status: 'done',
        message: `批量修复完成：成功 ${successCount}/${totalIssues}，失败 ${failCount}`,
        totalIssues,
        successCount,
        failCount,
      });
    } catch (err: unknown) {
      request.log.error({ err }, 'health-check batch fix SSE stream error');
      send('error', {
        step: 'done',
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      safeEnd();
    }
  });

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

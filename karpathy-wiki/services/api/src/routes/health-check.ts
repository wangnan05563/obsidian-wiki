import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EngineAdapter, FixInput } from '../types.js';
import { withCompileLock } from '../compile-queue.js';

// 注册健康检查路由。
//   POST /api/health-check       体检（确定性逻辑，JSON 响应）
//   POST /api/health-check/fix   一键修复（走 LLM，SSE 流式响应）
//
// fix 走 withCompileLock 串行队列，避免与 compile 并发写入冲突（§12.3-5）。
export function registerHealthCheckRoute(app: FastifyInstance, adapter: EngineAdapter) {
  app.post('/api/health-check', async (_request, reply) => {
    const report = await adapter.healthCheck();
    return reply.send(report);
  });

  // §4.6 一键修复：SSE 流式返回修复进度（L-6 事件 schema：scan/fixing/fixed/done）
  app.post('/api/health-check/fix', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Partial<FixInput>;
    if (!body || (body.issueType !== 'broken_link' && body.issueType !== 'orphan') || !body.target) {
      return reply.code(400).send({ error: '请求体须含 issueType(broken_link|orphan) 与 target' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // 串行队列保护：fix 可能调用 write_file，与 compile 共享 vault 写入
      await withCompileLock(async () => {
        for await (const ev of adapter.healthCheckFix(body as FixInput)) {
          // scan/fixing/update_log → progress；fixed → fixed；done → done
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
      // 为什么同时调用 request.log.error：SSE 错误只推前端，后端日志流需独立记录以便排障
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
      reply.raw.end();
    }
  });
}

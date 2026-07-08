import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EngineAdapter, QueryInput } from '../types.js';

// 注册 POST /api/query 路由。
// 请求体：{ question: string, history?: Array<{role, content}> }
// 响应为 SSE 流，事件格式：
//   event: answer\ndata: {"text":"..."}\n\n   答案片段
//   event: refs\ndata: {"refs":["页面名"]}\n\n  引用列表
//   event: done\ndata: {}\n\n  完成
export function registerQueryRoute(app: FastifyInstance, adapter: EngineAdapter) {
  app.post('/api/query', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { question?: string; history?: QueryInput['history'] };
    if (!body || !body.question || typeof body.question !== 'string') {
      return reply.code(400).send({ error: '请求体须含 question 字段' });
    }

    const input: QueryInput = {
      question: body.question,
      history: body.history,
    };

    // SSE headers。Connection: keep-alive 防代理断开，X-Accel-Buffering: no 防 Nginx 缓冲。
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
      for await (const chunk of adapter.query(input)) {
        if (chunk.done) {
          // done 事件单独发送，附带 refs（如果有）
          if (chunk.refs && chunk.refs.length > 0) {
            send('refs', { refs: chunk.refs });
          }
          send('done', {});
        } else if (chunk.refs && chunk.refs.length > 0) {
          // 中间也可能有 refs（当前实现只在 done 时发 refs，这里保留兼容）
          send('refs', { refs: chunk.refs });
        } else if (chunk.text) {
          send('answer', { text: chunk.text });
        }
      }
    } catch (err: unknown) {
      send('error', {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      reply.raw.end();
    }
  });
}

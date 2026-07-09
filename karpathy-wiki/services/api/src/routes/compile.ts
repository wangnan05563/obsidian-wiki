import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EngineAdapter, CompileInput } from '../types.js';
import { withCompileLock } from '../compile-queue.js';

// 注册 POST /api/compile 路由。
// 接受两种 Content-Type：
//   - multipart/form-data：file 字段上传文件
//   - application/json：{ type: 'url'|'text', content: string }
// 响应为 SSE 流，事件格式：event: <type>\ndata: <json>\n\n
export function registerCompileRoute(app: FastifyInstance, adapter: EngineAdapter) {
  app.post('/api/compile', async (request: FastifyRequest, reply: FastifyReply) => {
    let input: CompileInput;

    const contentType = request.headers['content-type'] ?? '';
    if (contentType.startsWith('multipart/form-data')) {
      // multipart 文件上传
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: '缺少 file 字段' });
      }
      const buffer = await file.toBuffer();
      // 落盘到临时目录，compile-workflow 会读取后存档到 raw/
      const tmp = path.join(os.tmpdir(), `wiki-compile-${Date.now()}-${file.filename}`);
      await fs.writeFile(tmp, buffer);
      input = { type: 'file', content: tmp };
    } else {
      // JSON：url 或 text
      const body = request.body as { type?: string; content?: string; rawPath?: string };
      if (!body || (body.type !== 'url' && body.type !== 'text') || !body.content) {
        return reply.code(400).send({ error: '请求体须含 type(url|text) 与 content' });
      }
      input = {
        type: body.type,
        content: body.content,
        rawPath: body.rawPath,
      };
    }

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
      // §12.3-5：串行队列包装，保证并发 compile 请求不产生 index.md/log.md 追加竞态。
      // withCompileLock 等待前一个 compile 完成后才开始消费本次迭代。
      await withCompileLock(async () => {
        for await (const ev of adapter.compile(input)) {
          // 区分进度事件与页面生成事件：data 含 path/title 视为 page 事件
          if (ev.step === 'done') {
            send('done', ev);
          } else if (ev.data?.path && ev.data?.title) {
            send('page', ev);
          } else {
            send('progress', ev);
          }
        }
      });
    } catch (err: unknown) {
      send('error', {
        step: 'done',
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      reply.raw.end();
    }
  });

  // §11.2 断点续传：POST /api/compile/resume/:runId
  // 从中断点恢复编译，SSE 流式返回进度事件（同 /api/compile 格式）
  app.post<{ Params: { runId: string } }>(
    '/api/compile/resume/:runId',
    async (request, reply) => {
      const { runId } = request.params;
      // 防路径穿越：只允许 UUID 格式的 runId
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
        return reply.code(400).send({ error: '无效的 runId' });
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
        await withCompileLock(async () => {
          for await (const ev of adapter.resumeCompile(runId)) {
            if (ev.step === 'done') {
              send('done', ev);
            } else if (ev.data?.path && ev.data?.title) {
              send('page', ev);
            } else {
              send('progress', ev);
            }
          }
        });
      } catch (err: unknown) {
        send('error', {
          step: 'done',
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        reply.raw.end();
      }
    },
  );
}

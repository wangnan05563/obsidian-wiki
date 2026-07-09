import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import type { EngineAdapter, QueryInput } from '../types.js';
import type { VaultService } from '../vault/vault-service.js';

// §5.1 L-7 防篡改归档：会话存储。
// 内存 Map 存储问答对，archive 路由从服务端存储取答案，不信任客户端传内容。
// 进程重启丢失（垂直切片可接受；后续可换 SQLite 持久化）。
interface QaRecord {
  question: string;
  answer: string;
  refs: string[];
  ts: string;
}
const sessions = new Map<string, QaRecord[]>();

// 注册 POST /api/query 路由。
// 请求体：{ question: string, history?: Array<{role, content}> }
// 响应为 SSE 流，done 事件附带 sessionId（供归档用）。
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

    // 为本次问答分配 sessionId，存入会话存储供 archive 防篡改取用
    const sessionId = randomUUID();
    const answerBuffer: string[] = [];
    let refs: string[] = [];

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
          if ((chunk.refs?.length ?? 0) > 0) {
            refs = chunk.refs ?? [];
            send('refs', { refs });
          }
          // 存入会话存储，供 archive 防篡改取用
          const records = sessions.get(sessionId) ?? [];
          const messageIndex = records.length;
          records.push({
            question: body.question,
            answer: answerBuffer.join(''),
            refs,
            ts: new Date().toISOString(),
          });
          sessions.set(sessionId, records);
          // done 事件附带 sessionId + messageIndex，客户端保存供归档用
          send('done', { sessionId, messageIndex });
        } else if ((chunk.refs?.length ?? 0) > 0) {
          send('refs', { refs: chunk.refs });
        } else if (chunk.text) {
          answerBuffer.push(chunk.text);
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

// 独立导出归档路由注册函数，在 index.ts 中与 query 路由一起注册。
// 拆分是因为 archive 需要 vault 注入，而 query 需要 adapter。
export function registerQueryArchiveRoute(app: FastifyInstance, vault: VaultService) {
  app.post('/api/query/archive', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { sessionId?: string; messageIndex?: number };
    if (!body || !body.sessionId || typeof body.messageIndex !== 'number') {
      return reply.code(400).send({ error: '请求体须含 sessionId 与 messageIndex' });
    }

    const records = sessions.get(body.sessionId);
    if (!records || body.messageIndex < 0 || body.messageIndex >= records.length) {
      return reply.code(404).send({ error: '会话或消息不存在（可能已过期）' });
    }

    const record = records[body.messageIndex];
    // 生成归档页面文件名：queries/qa-{timestamp}-{短随机}.md
    const shortId = body.sessionId.slice(0, 8);
    const dateStr = new Date(record.ts).toISOString().slice(0, 10);
    const relPath = `queries/qa-${dateStr}-${shortId}.md`;

    // 构造 frontmatter + 正文。type: query 符合 SCHEMA 规范
    const frontmatter = {
      title: `问答归档：${record.question.slice(0, 30)}${record.question.length > 30 ? '…' : ''}`,
      type: 'query',
      created: dateStr,
      updated: dateStr,
      source: 'qa-archive',
      tags: ['问答归档', ...record.refs],
    };

    // 提取嵌套模板到变量，降低模板复杂度（S4624）
    const refLines = record.refs.map((r) => `- [[${r}]]`).join('\n');
    const refsSection = record.refs.length > 0
      ? `\n\n## 引用页面\n${refLines}`
      : '';

    const content = matter.stringify(
      `# 问答归档\n\n## 问题\n${record.question}\n\n## 回答\n${record.answer}${refsSection}\n`,
      frontmatter,
    );

    try {
      await vault.writeFile(relPath, content);
      // 追加到 index.md
      await vault.appendIndex(
        frontmatter.title,
        `归档问答：${record.question.slice(0, 40)}`,
      );
      // 记录操作日志
      await vault.appendLog('query', [relPath], `归档问答: ${record.question.slice(0, 40)}`);
      return reply.send({ ok: true, path: relPath });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

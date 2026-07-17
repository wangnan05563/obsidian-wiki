import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import type { EngineAdapter, QueryInput } from '../types.js';
import type { VaultService } from '../vault/vault-service.js';
import { withCompileLock } from '../compile-queue.js';
// §6.0.2 per-session Lock：按 question 前 32 字符做 key 串行化
import { withSessionLock } from '../session-lock.js';

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

// LRU 上限：防止长期运行后 sessions Map 无限增长导致内存泄漏
const MAX_SESSIONS = 100;
const SESSION_TTL_MS = 60 * 60 * 1000; // 1小时

// 超限时先淘汰过期会话，仍超限则按插入顺序删除最早会话
function trimSessions(): void {
  if (sessions.size <= MAX_SESSIONS) return;
  const now = Date.now();
  for (const [key, records] of sessions) {
    const lastTs = records[records.length - 1]?.ts;
    if (lastTs && now - new Date(lastTs).getTime() > SESSION_TTL_MS) {
      sessions.delete(key);
    }
  }
  // 如果仍然超限，删除最早的（Map 保持插入顺序）
  while (sessions.size > MAX_SESSIONS) {
    const firstKey = sessions.keys().next().value;
    if (firstKey) sessions.delete(firstKey);
    else break;
  }
}

// 注册 POST /api/query 路由。
// §5.2 改造：请求体扩展 mode/webSearch/attachments/model；SSE 事件扩展 thinking/progress/followups
export function registerQueryRoute(app: FastifyInstance, adapter: EngineAdapter) {
  app.post('/api/query', {
    // 破坏性端点更严格限流：query 触发 LLM 调用，20/min 防 token 耗尽
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      question?: string;
      history?: QueryInput['history'];
      // §5.2 模式：'web' 联网搜索 / 'deep' 深度思考
      mode?: string;
      // 是否启用联网搜索工具
      webSearch?: boolean;
      // 附件 base64 列表
      attachments?: Array<{ data: string; mimeType: string; filename: string }>;
      // 当前请求使用的模型（即时切换）
      model?: string;
    };
    if (!body || !body.question || typeof body.question !== 'string') {
      return reply.code(400).send({ error: '请求体须含 question 字段' });
    }

    // 模型切换由 PUT /api/ai/config 统一处理（switchModel 时同步 adapter）
    // 不在每次问答时重复切换，避免只更新 model 不更新 baseUrl 导致不匹配
    const input: QueryInput = {
      question: body.question,
      history: body.history,
      mode: body.mode,
      webSearch: body.webSearch,
      attachments: body.attachments,
      model: body.model,
    };

    // 为本次问答分配 sessionId，存入会话存储供 archive 防篡改取用
    const sessionId = randomUUID();
    const answerBuffer: string[] = [];
    let refs: string[] = [];
    // §5.2 联网搜索外部链接：与 refs 并行发送
    let webRefs: Array<{ title: string; url: string; snippet: string }> = [];

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
      // §6.0.2 per-session Lock：同 question 的并发请求串行化，避免 LLM 重复调用浪费 token
      // 为什么包裹整个 SSE 流而非只包裹 LLM 调用：
      //   1. 同问题重复请求必须等前一次完成才允许第二次开始，否则 LLM 调用并发会浪费 token
      //   2. 第二次请求开始时复用前一次的 SSE 流式输出已无意义（用户已看到第一次答案）
      // 代价：用户同问题重复点击会卡住等前一次完成，这是 SRS 设计意图
      await withSessionLock(input.question, async () => {
        for await (const chunk of adapter.query(input)) {
          // §5.2 thinking 事件：前端 ThinkingBlock 渲染
          if (chunk.thinking) {
            send('thinking', chunk.thinking);
          }
          // §5.2 progress 事件：联网搜索进度
          if (chunk.progress) {
            send('progress', chunk.progress);
          }
          // §5.2 image 事件：多模态图片推送
          if (chunk.image) {
            send('image', chunk.image);
          }
          // §5.2 followups 事件：追问建议
          if (chunk.followups) {
            send('followups', { followups: chunk.followups });
          }
          // §5.2 联网搜索引用：缓存最新 webRefs，与 refs 一起在 done 时发送
          if (chunk.webRefs && chunk.webRefs.length > 0) {
            webRefs = chunk.webRefs;
          }

          if (chunk.done) {
            if ((chunk.refs?.length ?? 0) > 0) {
              refs = chunk.refs ?? [];
            }
            // refs 与 webRefs 一起发送：前端 RefsList 合并渲染"参考来源"
            send('refs', { refs, webRefs });
            // 存入会话存储，供 archive 防篡改取用
            const records = sessions.get(sessionId) ?? [];
            const messageIndex = records.length;
            records.push({
              question: input.question,
              answer: answerBuffer.join(''),
              refs,
              ts: new Date().toISOString(),
            });
            sessions.set(sessionId, records);
            trimSessions();
            // done 事件附带 sessionId + messageIndex，客户端保存供归档用
            send('done', { sessionId, messageIndex });
          } else if ((chunk.refs?.length ?? 0) > 0) {
            // 兜底：非 done 时收到 refs 也下发（兼容 v1 行为）
            send('refs', { refs: chunk.refs, webRefs });
          } else if (chunk.text) {
            answerBuffer.push(chunk.text);
            send('answer', { text: chunk.text });
          }
        }
      });
    } catch (err: unknown) {
      // 为什么同时调用 request.log.error：SSE 错误只推前端，后端日志流需独立记录以便排障
      request.log.error(
        { err, question: input.question, sessionId },
        'query SSE stream error',
      );
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
      // 串行化 vault 写入：与 compile 路由共用锁，避免 index.md/log.md 追加竞态
      await withCompileLock(async () => {
        await vault.writeFile(relPath, content);
        // 追加到 index.md
        await vault.appendIndex(
          frontmatter.title,
          `归档问答：${record.question.slice(0, 40)}`,
        );
        // 记录操作日志
        await vault.appendLog('query', [relPath], `归档问答: ${record.question.slice(0, 40)}`);
      });
      // 归档成功后释放会话内存，避免已归档问答长期驻留导致内存泄漏
      sessions.delete(body.sessionId);
      return reply.send({ ok: true, path: relPath });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

// ============================================================================
// 线程 / 会话 / 记忆 管理路由
// ----------------------------------------------------------------------------
// 与 ThreadMemoryStore 配套，暴露线程隔离的本地存储 REST 接口。
// 所有数据仅存于本地 data/threads/，无云端写入。
//
// 路由总览：
//   POST   /api/threads                 创建线程 → { thread }
//   GET    /api/threads                 列出线程摘要 → { threads: ThreadMeta[] }
//   GET    /api/threads/:id             读取完整线程（meta+session+memory）
//   DELETE /api/threads/:id             删除线程（连同 session/memory）
//   POST   /api/threads/:id/rename      重命名
//   POST   /api/threads/:id/pin         切换置顶
//   GET    /api/threads/:id/session     读取会话（完整 QaTurn[]）
//   DELETE /api/threads/:id/session     清空会话
//   GET    /api/threads/:id/memory      读取记忆（条目列表）
//   POST   /api/threads/:id/memory      写入/追加记忆
//   DELETE /api/threads/:id/memory      清空记忆
// ============================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ThreadMemoryStore, HistoryMessage } from '../engine/thread-memory-store.js';
import { InvalidThreadIdError } from '../engine/thread-memory-store.js';
// 上下文记忆治理：预览治理后的注入上下文（GET /context）、显式折叠记忆（POST /compact）
import { govern } from '../engine/context-governor.js';
import type { ContextGovernorConfig } from '../engine/context-governor.js';
import type { IsolationGuards } from '../middleware/auth.js';
import { createIsolationGuards } from '../middleware/auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badId(reply: FastifyReply, id: string) {
  return reply.code(400).send({ error: `非法的 threadId: ${id}` });
}

export function registerThreadsRoute(
  app: FastifyInstance,
  store: ThreadMemoryStore,
  governorConfig: ContextGovernorConfig,
  guards: IsolationGuards = createIsolationGuards(),
) {
  // 归属用户：auth 启用时取 currentUser.userId；单租户（auth 关闭）恒为 null（无隔离必要）。
  const ownerIdOf = (req: FastifyRequest): string | null =>
    guards.enabled ? (req.currentUser?.userId ?? null) : null;

  // 线程归属校验：auth 启用且 owner 与当前用户不符 → 404（不暴露存在性）；线程不存在（owner===undefined）也 404。
  // 返回 true 表示放行。单租户（guards.enabled=false）恒放行。
  const assertOwned = async (req: FastifyRequest, id: string, reply: FastifyReply): Promise<boolean> => {
    const owner = await store.getThreadOwner(id);
    if (owner === undefined) {
      reply.code(404).send({ error: '线程不存在' });
      return false;
    }
    if (guards.enabled && (owner ?? null) !== ownerIdOf(req)) {
      reply.code(404).send({ error: '线程不存在' });
      return false;
    }
    return true;
  };

  // 创建线程（盖章 owner）
  app.post('/api/threads', { preHandler: guards.requireAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string };
    const thread = await store.createThread({ title: body.title, owner: ownerIdOf(request) });
    return reply.send({ thread });
  });

  // 列出线程摘要（按归属过滤：auth 启用时仅返回本人线程）
  app.get('/api/threads', { preHandler: guards.requireAuth }, async (request, reply) => {
    const threads = await store.listThreads();
    const owner = ownerIdOf(request);
    const visible = guards.enabled ? threads.filter((t) => (t.ownerId ?? null) === owner) : threads;
    return reply.send({ threads: visible });
  });

  // 读取完整线程
  app.get<{ Params: { id: string } }>('/api/threads/:id', { preHandler: guards.requireAuth }, async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) return badId(reply, id);
    if (!(await assertOwned(request, id, reply))) return;
    const full = await store.getThreadFull(id);
    if (!full) return reply.code(404).send({ error: '线程不存在' });
    return reply.send({ thread: full });
  });

  // 删除线程（连同会话与记忆）
  app.delete<{ Params: { id: string } }>('/api/threads/:id', { preHandler: guards.requireAuth }, async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) return badId(reply, id);
    if (!(await assertOwned(request, id, reply))) return;
    await store.deleteThread(id);
    return reply.send({ ok: true });
  });

  // 重命名
  app.post<{ Params: { id: string } }>('/api/threads/:id/rename', { preHandler: guards.requireAuth }, async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) return badId(reply, id);
    if (!(await assertOwned(request, id, reply))) return;
    const body = request.body as { title?: string };
    if (!body?.title?.trim()) return reply.code(400).send({ error: '标题不能为空' });
    const meta = await store.renameThread(id, body.title);
    if (!meta) return reply.code(404).send({ error: '线程不存在' });
    return reply.send({ ok: true, title: meta.title });
  });

  // 切换置顶
  app.post<{ Params: { id: string } }>('/api/threads/:id/pin', { preHandler: guards.requireAuth }, async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) return badId(reply, id);
    if (!(await assertOwned(request, id, reply))) return;
    const meta = await store.togglePin(id);
    if (!meta) return reply.code(404).send({ error: '线程不存在' });
    return reply.send({ ok: true, isPinned: meta.isPinned });
  });

  // 读取会话
  app.get<{ Params: { id: string } }>('/api/threads/:id/session', { preHandler: guards.requireAuth }, async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) return badId(reply, id);
    if (!(await assertOwned(request, id, reply))) return;
    const session = await store.getSession(id);
    if (!session) return reply.code(404).send({ error: '会话不存在' });
    return reply.send({ session });
  });

  // 清空会话
  app.delete<{ Params: { id: string } }>('/api/threads/:id/session', { preHandler: guards.requireAuth }, async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) return badId(reply, id);
    if (!(await assertOwned(request, id, reply))) return;
    await store.clearSession(id);
    return reply.send({ ok: true });
  });

  // 读取记忆
  app.get<{ Params: { id: string } }>('/api/threads/:id/memory', { preHandler: guards.requireAuth }, async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) return badId(reply, id);
    if (!(await assertOwned(request, id, reply))) return;
    const memory = await store.getMemory(id);
    return reply.send({ memory: memory ?? { threadId: id, entries: [], updatedAt: new Date().toISOString() } });
  });

  // 写入/追加记忆
  // body: { entries: HistoryMessage[] } 或 { role, content } 单条
  app.post<{ Params: { id: string } }>('/api/threads/:id/memory', { preHandler: guards.requireAuth }, async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) return badId(reply, id);
    if (!(await assertOwned(request, id, reply))) return;
    const body = request.body as
      | { entries?: HistoryMessage[]; role?: 'user' | 'assistant'; content?: string }
      | null;
    if (!body) return reply.code(400).send({ error: '请求体为空' });

    let entries: HistoryMessage[];
    const now = new Date().toISOString();
    if (Array.isArray(body.entries)) {
      entries = body.entries.map((e) => ({
        role: e.role === 'assistant' ? 'assistant' : 'user',
        content: String(e.content ?? ''),
        ts: e.ts || now,
      }));
    } else if (body.role && typeof body.content === 'string') {
      entries = [{ role: body.role === 'assistant' ? 'assistant' : 'user', content: body.content, ts: now }];
    } else {
      return reply.code(400).send({ error: '需提供 entries 数组或 { role, content }' });
    }

    const updated = await store.appendMemory(id, entries);
    return reply.send({ ok: true, memory: updated });
  });

  // 清空记忆
  app.delete<{ Params: { id: string } }>('/api/threads/:id/memory', { preHandler: guards.requireAuth }, async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) return badId(reply, id);
    if (!(await assertOwned(request, id, reply))) return;
    await store.clearMemory(id);
    return reply.send({ ok: true });
  });

  // 预览治理后的注入上下文（非破坏性，不改写记忆）。可选 ?question= 用于相关性重组。
  // 返回：governed 消息、摘要文本、治理统计（压缩/清理/淘汰效果）。
  app.get<{ Params: { id: string }; Querystring: { question?: string } }>(
    '/api/threads/:id/context',
    { preHandler: guards.requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) return badId(reply, id);
      if (!(await assertOwned(request, id, reply))) return;
      const memory = await store.getMemory(id);
      if (!memory) return reply.code(404).send({ error: '线程不存在' });
      const existingSummary = memory.summary ?? '';
      const governed = await govern(memory.entries, {
        question: request.query.question,
        config: governorConfig,
        existingSummary: existingSummary || undefined,
      });
      return reply.send({
        context: governed.messages,
        summary: governed.summary,
        stats: governed.stats,
      });
    },
  );

  // 显式折叠记忆：把超出 keepRecent 的最旧条目压缩进 summary（存储层主动治理）。
  // body: { keepRecent?, summaryMaxChars? }；返回折叠后的记忆。
  app.post<{ Params: { id: string } }>('/api/threads/:id/compact', { preHandler: guards.requireAuth }, async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) return badId(reply, id);
    if (!(await assertOwned(request, id, reply))) return;
    const body = (request.body ?? {}) as { keepRecent?: number; summaryMaxChars?: number };
    const updated = await store.compactMemory(id, {
      keepRecent: body.keepRecent,
      summaryMaxChars: body.summaryMaxChars,
    });
    return reply.send({ ok: true, memory: updated });
  });
}

// 重新导出错误类型，便于调用方（query 路由）做类型判断
export { InvalidThreadIdError };

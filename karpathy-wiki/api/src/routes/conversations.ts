import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { IsolationGuards } from '../middleware/auth.js';
import { createIsolationGuards } from '../middleware/auth.js';

// 历史会话后端持久化路由。
// 为什么需要：前端 IndexedDB 绑定浏览器 origin（协议+域名+端口），
// 开发模式（localhost:5173）与生产模式（localhost:3000）origin 不同导致会话"丢失"。
// 改为后端落盘到 data/conversations/，所有访问方式共享同一份数据。
//
// 存储：每个会话一个 JSON 文件，文件名 = {id}.json，id 必须为 UUID 防路径穿越。
// 与前端 ConversationRecord 字段对齐，前端直接读写，无字段转换。
//
// 路由：
//   GET    /api/conversations           列出所有会话摘要（不含 messages）
//   GET    /api/conversations/:id       读取单个会话完整内容（含 messages）
//   PUT    /api/conversations/:id       保存/更新会话（upsert）
//   DELETE /api/conversations/:id       删除会话
//   POST   /api/conversations/:id/pin   切换置顶状态
//   POST   /api/conversations/:id/rename 重命名

interface ConversationRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  isPinned: boolean;
  preview: string;
  messages: unknown[];
  // 线程隔离键：该会话关联的问答线程（本地记忆/会话上下文归属）。可选，向后兼容。
  threadId?: string;
  // 归属用户 ID：服务端按 currentUser.userId 盖章，绝不信任客户端传入。
  // 仅在 auth.enabled === true 时有意义；单租户（auth 关闭）部署恒为 null（无需隔离）。
  ownerId?: string | null;
}

// UUID v4 正则：仅允许合法 UUID 作为文件名，杜绝路径穿越
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerConversationsRoute(
  app: FastifyInstance,
  dataDir: string,
  guards: IsolationGuards = createIsolationGuards(),
) {
  // 会话存储目录：dataDir/conversations/
  // 为什么放在 data 下：与 vault 同级，遵循"运行时数据与源码分离"约定
  const conversationsDir = path.resolve(dataDir, 'conversations');

  // 启动时确保目录存在
  fsSync.mkdirSync(conversationsDir, { recursive: true });

  // 安全读取会话文件：校验 id 为合法 UUID，避免路径穿越
  async function readConversation(id: string): Promise<ConversationRecord | null> {
    if (!UUID_RE.test(id)) return null;
    const file = path.join(conversationsDir, `${id}.json`);
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw) as ConversationRecord;
    } catch {
      return null;
    }
  }

  // 安全写入会话文件
  async function writeConversation(record: ConversationRecord): Promise<void> {
    if (!UUID_RE.test(record.id)) {
      throw new Error('无效的会话 ID');
    }
    const file = path.join(conversationsDir, `${record.id}.json`);
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
  }

  // GET /api/conversations：列出当前用户会话摘要（不含 messages，减少响应体积）。
  // 归属隔离（BR-ISOLATION-01）：auth 启用时仅返回 ownerId === currentUser 的会话；
  // 单租户（auth 关闭）时返回全部（无隔离必要）。
  app.get('/api/conversations', { preHandler: guards.requireAuth }, async (request, reply) => {
    const owner = guards.enabled ? (request.currentUser?.userId ?? null) : null;
    try {
      const files = await fs.readdir(conversationsDir);
      const summaries: Omit<ConversationRecord, 'messages'>[] = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(conversationsDir, f), 'utf8');
          const record = JSON.parse(raw) as ConversationRecord;
          // 归属校验：auth 启用且仅展示本人会话，越界记录跳过（等同不存在）
          if (guards.enabled && (record.ownerId ?? null) !== owner) continue;
          // 摘要不含 messages，前端列表渲染无需完整消息
          summaries.push({
            id: record.id,
            title: record.title,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            messageCount: record.messageCount,
            isPinned: record.isPinned,
            preview: record.preview,
          });
        } catch {
          // 单个文件损坏跳过，不影响整体列表
        }
      }
      // 置顶优先，再按 updatedAt 倒序
      summaries.sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
      return void reply.send({ conversations: summaries });
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /api/conversations/:id：读取完整会话（含 messages）。
  // 归属隔离：auth 启用且记录 ownerId 与当前用户不符 → 404（不暴露他人会话存在性）。
  app.get<{ Params: { id: string } }>(
    '/api/conversations/:id',
    { preHandler: guards.requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      const record = await readConversation(id);
      if (!record) {
        return void reply.code(404).send({ error: '会话不存在' });
      }
      if (guards.enabled && (record.ownerId ?? null) !== (request.currentUser?.userId ?? null)) {
        return void reply.code(404).send({ error: '会话不存在' });
      }
      return void reply.send({ conversation: record });
    },
  );

  // PUT /api/conversations/:id：保存/更新会话（upsert）
  // 前端每轮问答完成后调用，body 为完整 ConversationRecord
  app.put<{ Params: { id: string } }>(
    '/api/conversations/:id',
    { preHandler: guards.requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return void reply.code(400).send({ error: '无效的会话 ID' });
      }
      const body = request.body as Partial<ConversationRecord>;
      if (!body) {
        return void reply.code(400).send({ error: '请求体为空' });
      }

      // 服务端归属：auth 启用时用 currentUser.userId 盖章；单租户为 null。
      // 绝不采用客户端传入的 ownerId（防止越权认领他人会话）。
      const owner = guards.enabled ? (request.currentUser?.userId ?? null) : null;

      // 读取已有记录用于合并（保留 createdAt 等）
      const existing = await readConversation(id);
      const record: ConversationRecord = {
        id,
        title: body.title ?? existing?.title ?? '新会话',
        createdAt: body.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
        updatedAt: body.updatedAt ?? new Date().toISOString(),
        messageCount: body.messageCount ?? body.messages?.length ?? 0,
        isPinned: body.isPinned ?? existing?.isPinned ?? false,
        preview: body.preview ?? existing?.preview ?? '',
        messages: body.messages ?? existing?.messages ?? [],
        // 线程隔离键透传：会话与问答线程的关联在此落盘，重开会话时可续接本地记忆
        threadId: body.threadId ?? existing?.threadId,
        // 归属：新建归属当前用户；已存在则保留原 owner（客户端不可改）。
        ownerId: owner ?? existing?.ownerId ?? null,
      };

      try {
        await writeConversation(record);
        return void reply.send({ ok: true, conversation: record });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return void reply.code(500).send({ error: msg });
      }
    },
  );

  // DELETE /api/conversations/:id：删除会话。
  // 归属隔离：auth 启用且 owner 不符 → 404（删除操作同样不可越权）。
  app.delete<{ Params: { id: string } }>(
    '/api/conversations/:id',
    { preHandler: guards.requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return void reply.code(400).send({ error: '无效的会话 ID' });
      }
      const record = await readConversation(id);
      if (!record) {
        return void reply.code(404).send({ error: '会话不存在' });
      }
      if (guards.enabled && (record.ownerId ?? null) !== (request.currentUser?.userId ?? null)) {
        return void reply.code(404).send({ error: '会话不存在' });
      }
      const file = path.join(conversationsDir, `${id}.json`);
      try {
        await fs.unlink(file);
        return void reply.send({ ok: true });
      } catch (err: unknown) {
        // 文件不存在视为已删除
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return void reply.send({ ok: true });
        }
        const msg = err instanceof Error ? err.message : String(err);
        return void reply.code(500).send({ error: msg });
      }
    },
  );

  // POST /api/conversations/:id/pin：切换置顶状态。
  // 归属隔离：auth 启用且 owner 不符 → 404。
  app.post<{ Params: { id: string } }>(
    '/api/conversations/:id/pin',
    { preHandler: guards.requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      const record = await readConversation(id);
      if (!record) {
        return void reply.code(404).send({ error: '会话不存在' });
      }
      if (guards.enabled && (record.ownerId ?? null) !== (request.currentUser?.userId ?? null)) {
        return void reply.code(404).send({ error: '会话不存在' });
      }
      record.isPinned = !record.isPinned;
      await writeConversation(record);
      return void reply.send({ ok: true, isPinned: record.isPinned });
    },
  );

  // POST /api/conversations/:id/rename：重命名。
  // 归属隔离：auth 启用且 owner 不符 → 404。
  app.post<{ Params: { id: string } }>(
    '/api/conversations/:id/rename',
    { preHandler: guards.requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as { title?: string };
      if (!body?.title?.trim()) {
        return void reply.code(400).send({ error: '标题不能为空' });
      }
      const record = await readConversation(id);
      if (!record) {
        return void reply.code(404).send({ error: '会话不存在' });
      }
      if (guards.enabled && (record.ownerId ?? null) !== (request.currentUser?.userId ?? null)) {
        return void reply.code(404).send({ error: '会话不存在' });
      }
      record.title = body.title.trim();
      await writeConversation(record);
      return void reply.send({ ok: true, title: record.title });
    },
  );
}

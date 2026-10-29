import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import type { IsolationGuards } from '../middleware/auth.js';
import type { UploadRecord, UploadStore } from '../uploads/upload-store.js';
import { buildAttachmentHeader } from '../utils/attachment.js';

// 投递原始文档（T03611）：
//   GET /api/uploads                  列出「我投递的」原始文档（按投递时间倒序）
//   GET /api/uploads/:id/download     下载原始字节（Content-Disposition: attachment）
//
// 权限模型与 data/conversations 一致：auth 启用时按 currentUser.userId 归属过滤，
//   他人的 id 一律 404（不暴露存在性）；单租户（auth 关闭）不隔离，保持既有部署可用性。
// 为什么列表不含 ownerId/路径：前端只需要展示名/大小/时间/来源，服务端内部字段不外泄。

const READ_RATE_LIMIT = { max: 300, timeWindow: '1 minute' };
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export interface UploadListItem {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  source: UploadRecord['source'];
}

function toListItem(r: UploadRecord): UploadListItem {
  return {
    id: r.id,
    originalName: r.originalName,
    size: r.size,
    mimeType: r.mimeType,
    uploadedAt: r.uploadedAt,
    source: r.source,
  };
}

// limit 解析：非法值回退默认；上限封顶，避免一次拉整个目录。
export function parseListLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(n), MAX_LIST_LIMIT);
}

export function registerUploadsRoute(
  app: FastifyInstance,
  store: UploadStore,
  guards: IsolationGuards,
) {
  // 归属过滤键：auth 关闭时 null（不隔离），启用时取当前登录用户（守卫已保证存在）。
  function ownerFilter(request: FastifyRequest): string | null {
    return guards.enabled ? (request.currentUser?.userId ?? null) : null;
  }

  app.get('/api/uploads', {
    config: { rateLimit: READ_RATE_LIMIT },
    preHandler: guards.requireAuth,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { limit?: string };
    const uploads = await store.list(ownerFilter(request), parseListLimit(query.limit));
    return void reply.send({ uploads: uploads.map(toListItem) });
  });

  app.get('/api/uploads/:id/download', {
    config: { rateLimit: READ_RATE_LIMIT },
    preHandler: guards.requireAuth,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const record = await store.get(id);
    // 不存在 / 非本人：统一 404，避免通过状态码探测他人投递是否存在
    if (!record || (guards.enabled && record.ownerId !== (request.currentUser?.userId ?? null))) {
      return void reply.code(404).send({ error: '原始文档不存在' });
    }
    const blob = store.blobPath(record.id);
    let data: Buffer;
    try {
      // 投递上限 10MB（multipart 限制），一次性读入内存与 /api/files/download 同策略；
      // 流式 send 在 Fastify inject/压缩钩子下会丢响应体，统一按 buffer 返回更可靠。
      data = await fs.readFile(blob);
    } catch {
      // meta 存在但 blob 被手工删除：按 404 处理（不 500）
      return void reply.code(404).send({ error: '原始文档不存在' });
    }
    reply.header('Content-Type', record.mimeType || 'application/octet-stream');
    reply.header('Content-Disposition', buildAttachmentHeader(record.originalName, 'uploaded-file'));
    reply.header('Content-Length', String(data.length));
    return void reply.send(data);
  });
}

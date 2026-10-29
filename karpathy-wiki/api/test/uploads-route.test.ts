// T03611：投递原始文档留存与下载。
// 覆盖点：单文件/批量投递的留存、列表与下载、归属隔离（他人 404）、未登录 401、
// 非法 id 404、单租户（auth 关闭）不隔离、留存失败不阻断编译。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerCompileRoute } from '../src/routes/compile.js';
import { registerUploadsRoute } from '../src/routes/uploads.js';
import { UploadStore } from '../src/uploads/upload-store.js';
import { setupAuthMiddleware, createIsolationGuards } from '../src/middleware/auth.js';
import { createSession, clearAllSessions } from '../src/auth/session.js';
import { clearPermissionCache } from '../src/auth/permission-cache.js';
import type { EngineAdapter, ProgressEvent, BatchCompileConfig } from '../src/types.js';

const SECRET = 'test-uploads-route-secret-16ch';

const BATCH: BatchCompileConfig = {
  allowedExtensions: ['md', 'txt', 'pdf'],
  maxBatchSize: 5,
  maxFileSizeMb: 1,
};

const OK_EVENTS: ProgressEvent[] = [
  { step: 'archive', status: 'done', message: '原始资料已存档', data: { path: 'raw/a.md' } },
  { step: 'done', status: 'done', message: '编译完成', data: { path: 'raw/a.md' } },
];

function createAdapter(): EngineAdapter {
  return {
    compile: vi.fn(async function* (): AsyncIterable<ProgressEvent> {
      for (const ev of OK_EVENTS) yield ev;
    }),
    resumeCompile: vi.fn(async function* (): AsyncIterable<ProgressEvent> { yield OK_EVENTS[1]; }),
    compileFromRaw: vi.fn(async function* (): AsyncIterable<ProgressEvent> { yield OK_EVENTS[1]; }),
    query: async function* () { /* 不使用 */ },
    healthCheck: async () => ({}) as never,
    healthCheckFix: async function* () { /* 不使用 */ },
    updateConfig: () => { /* 不使用 */ },
  } as unknown as EngineAdapter;
}

function buildMultipartPayload(
  parts: Array<{ field: string; filename: string; content: string }>,
): { body: Buffer; boundary: string } {
  const boundary = `----vitest${process.hrtime.bigint().toString()}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${p.field}"; filename="${p.filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    ));
    chunks.push(Buffer.from(p.content, 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

async function buildApp(opts: {
  rootDir: string;
  authEnabled: boolean;
  uploadStore?: UploadStore;
}): Promise<{ app: FastifyInstance }> {
  const app = Fastify({ logger: false });
  setupAuthMiddleware(app, {
    enabled: opts.authEnabled,
    sessionSecret: SECRET,
    permissionCacheTtlMs: 300_000,
    publicPaths: [],
  });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  const store = opts.uploadStore ?? new UploadStore(path.join(opts.rootDir, 'uploads'));
  const guards = createIsolationGuards({ enabled: opts.authEnabled, permissionCacheTtlSec: 300 });
  registerCompileRoute(app, createAdapter(), BATCH, undefined, store);
  registerUploadsRoute(app, store, guards);
  await app.ready();
  return { app };
}

async function uploadFile(
  app: FastifyInstance,
  filename: string,
  content: string,
  token?: string,
  url = '/api/compile',
  field = 'file',
): Promise<ReturnType<FastifyInstance['inject']>> {
  const { body, boundary } = buildMultipartPayload([{ field, filename, content }]);
  return app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: body,
  });
}

async function listUploads(app: FastifyInstance, token?: string): Promise<any[]> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/uploads',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { uploads: any[] }).uploads;
}

describe('投递原始文档留存与下载（T03611）', () => {
  let rootDir: string;
  let app: FastifyInstance | null = null;
  let tokenA = '';
  let tokenB = '';

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-uploads-test-'));
    clearAllSessions();
    clearPermissionCache();
    tokenA = createSession({ userId: 'user-a', username: '甲', role: 'user', secret: SECRET }).token;
    tokenB = createSession({ userId: 'user-b', username: '乙', role: 'user', secret: SECRET }).token;
  });

  afterEach(async () => {
    await app?.close().catch(() => {});
    app = null;
    clearAllSessions();
    clearPermissionCache();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('单文件投递后留存，列表可见，下载字节与文件名正确', async () => {
    ({ app } = await buildApp({ rootDir, authEnabled: true }));
    const content = '%PDF-1.4 票据说明';
    const res = await uploadFile(app, '票据说明（附件一）.pdf', content, tokenA);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: done');

    const list = await listUploads(app, tokenA);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      originalName: '票据说明（附件一）.pdf',
      size: Buffer.byteLength(content),
      mimeType: 'application/pdf',
      source: 'file',
    });

    // 原件目录内容可用于事后追溯（blob 逐字节一致）
    const blob = await fs.readFile(path.join(rootDir, 'uploads', list[0].id, 'blob'), 'utf8');
    expect(blob).toBe(content);

    const dl = await app.inject({
      method: 'GET',
      url: `/api/uploads/${list[0].id}/download`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['content-disposition']).toContain("attachment;");
    expect(dl.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('票据说明（附件一）.pdf')}`,
    );
    expect(dl.body).toBe(content);
  });

  it('归属隔离：他人列表不可见、下载一律 404', async () => {
    ({ app } = await buildApp({ rootDir, authEnabled: true }));
    await uploadFile(app, '甲的资料.pdf', 'aaa', tokenA);

    expect(await listUploads(app, tokenB)).toHaveLength(0);

    const [item] = await listUploads(app, tokenA);
    const dl = await app.inject({
      method: 'GET',
      url: `/api/uploads/${item.id}/download`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    // 404 而不是 403：不暴露他人投递是否存在
    expect(dl.statusCode).toBe(404);
  });

  it('未登录 401；非法 id 404', async () => {
    ({ app } = await buildApp({ rootDir, authEnabled: true }));
    const list = await app.inject({ method: 'GET', url: '/api/uploads' });
    expect(list.statusCode).toBe(401);

    const dl = await app.inject({ method: 'GET', url: '/api/uploads/not-a-uuid/download' });
    expect(dl.statusCode).toBe(401);

    const dlAuthed = await app.inject({
      method: 'GET',
      url: '/api/uploads/not-a-uuid/download',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(dlAuthed.statusCode).toBe(404);
  });

  it('批量投递只为通过白名单的文件留存', async () => {
    ({ app } = await buildApp({ rootDir, authEnabled: true }));
    const { body, boundary } = buildMultipartPayload([
      { field: 'files', filename: '合法.pdf', content: 'legal' },
      { field: 'files', filename: '危险.exe', content: 'nope' },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/compile/batch',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        authorization: `Bearer ${tokenA}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    const list = await listUploads(app, tokenA);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ originalName: '合法.pdf', source: 'batch' });
  });

  it('单租户（auth 关闭）：无 token 可列出并下载全部留存', async () => {
    ({ app } = await buildApp({ rootDir, authEnabled: false }));
    await uploadFile(app, 'single-tenant.pdf', 'tenant-content');
    const list = await listUploads(app);
    expect(list).toHaveLength(1);

    const dl = await app.inject({ method: 'GET', url: `/api/uploads/${list[0].id}/download` });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('tenant-content');
  });

  it('留存写盘失败不阻断编译', async () => {
    const failingStore = {
      save: vi.fn(async () => { throw new Error('disk full'); }),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      blobPath: vi.fn(() => ''),
    } as unknown as UploadStore;
    ({ app } = await buildApp({ rootDir, authEnabled: true, uploadStore: failingStore }));

    const res = await uploadFile(app, '仍然编译.pdf', 'still-compiles', tokenA);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: done');
    expect(failingStore.save).toHaveBeenCalledTimes(1);
  });
});

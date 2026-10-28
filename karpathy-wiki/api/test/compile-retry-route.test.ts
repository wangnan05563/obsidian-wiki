// T03591 编译重试与路由层幂等：/api/compile、/api/compile/batch、/api/compile/retry。
// 范式沿用 routes-compile.test.ts（Fastify + inject + SSE 解析）；仅 mock EngineAdapter 边界。
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { registerCompileRoute } from '../src/routes/compile.js';
import type { EngineAdapter, ProgressEvent, CompileInput, BatchCompileConfig } from '../src/types.js';

function parseSSEEvents(payload: string): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = [];
  for (const block of payload.split('\n\n')) {
    if (!block.trim()) continue;
    let event = '';
    let dataStr = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataStr += line.slice(6);
    }
    if (event) {
      try { events.push({ event, data: JSON.parse(dataStr) }); }
      catch { events.push({ event, data: dataStr }); }
    }
  }
  return events;
}

function buildMultipartPayload(parts: Array<{ field: string; filename?: string; content: string }>): { body: Buffer; boundary: string } {
  const boundary = `----vitest${process.hrtime.bigint().toString()}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = p.filename !== undefined
      ? `Content-Disposition: form-data; name="${p.field}"; filename="${p.filename}"\r\n`
      : `Content-Disposition: form-data; name="${p.field}"\r\n`;
    chunks.push(Buffer.from(`--${boundary}\r\n${disposition}\r\n`));
    chunks.push(Buffer.from(p.content, 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

const OK_EVENTS: ProgressEvent[] = [
  { step: 'archive', status: 'done', message: '原始资料已存档', data: { path: 'raw/a.md' } },
  { step: 'done', status: 'done', message: '编译完成', data: { path: 'raw/a.md' } },
];

function createAdapter(overrides: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    compile: vi.fn(async function* (): AsyncIterable<ProgressEvent> {
      for (const ev of OK_EVENTS) yield ev;
    }),
    resumeCompile: vi.fn(async function* (): AsyncIterable<ProgressEvent> {
      yield { step: 'done', status: 'done', message: 'resume done' };
    }),
    compileFromRaw: vi.fn(async function* (): AsyncIterable<ProgressEvent> {
      for (const ev of OK_EVENTS) yield ev;
    }),
    query: async function* () { /* 不使用 */ },
    healthCheck: async () => ({}) as never,
    healthCheckFix: async function* () { /* 不使用 */ },
    updateConfig: () => { /* 不使用 */ },
    ...overrides,
  } as unknown as EngineAdapter;
}

const defaultBatch: BatchCompileConfig = {
  allowedExtensions: ['md', 'txt'],
  maxBatchSize: 5,
  maxFileSizeMb: 1,
};

let currentApp: FastifyInstance | null = null;

async function buildApp(adapter: EngineAdapter, batch: BatchCompileConfig = defaultBatch): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  registerCompileRoute(app, adapter, batch);
  await app.ready();
  currentApp = app;
  return app;
}

afterEach(async () => {
  if (currentApp) { await currentApp.close(); currentApp = null; }
});

describe('POST /api/compile/retry', () => {
  it('从 rawPath 重编译并流式返回 progress/done', async () => {
    const adapter = createAdapter();
    const app = await buildApp(adapter);
    const res = await app.inject({
      method: 'POST',
      url: '/api/compile/retry',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ rawPath: 'raw/中国票据业务系统接口规范V1.4.md' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(adapter.compileFromRaw).toHaveBeenCalledWith('raw/中国票据业务系统接口规范V1.4.md');
    const events = parseSSEEvents(res.payload);
    expect(events.map((e) => e.event)).toEqual(['progress', 'done']);
  });

  it('非 raw/ 下的路径或非 .md 一律 400（防路径穿越）', async () => {
    const adapter = createAdapter();
    const app = await buildApp(adapter);
    for (const rawPath of ['raw/../SCHEMA.md', '/etc/passwd.md', 'raw/x.txt', 'pages/a.md', 'raw/sub/a.md', 'raw\\a.md']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile/retry',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ rawPath }),
      });
      expect(res.statusCode, rawPath).toBe(400);
    }
    expect(adapter.compileFromRaw).not.toHaveBeenCalled();
  });

  it('引擎未实现 compileFromRaw 时返回 501', async () => {
    const adapter = createAdapter({ compileFromRaw: undefined });
    const app = await buildApp(adapter);
    const res = await app.inject({
      method: 'POST',
      url: '/api/compile/retry',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ rawPath: 'raw/a.md' }),
    });
    expect(res.statusCode).toBe(501);
  });

  it('失败事件保留 retryable 语义（429 后可再试）', async () => {
    const adapter = createAdapter({
      compileFromRaw: vi.fn(async function* (): AsyncIterable<ProgressEvent> {
        yield {
          step: 'done',
          status: 'error',
          message: '编译失败: LLM API 请求被限流（429）',
          data: { path: 'raw/a.md', rawPath: 'raw/a.md' },
          retryable: true,
        };
      }),
    });
    const app = await buildApp(adapter);
    const res = await app.inject({
      method: 'POST',
      url: '/api/compile/retry',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ rawPath: 'raw/a.md' }),
    });
    const done = parseSSEEvents(res.payload).find((e) => e.event === 'done');
    expect(done!.data.status).toBe('error');
    expect(done!.data.retryable).toBe(true);
  });

  it('带 fileIndex 时按批量语义回推 file_error / file_done', async () => {
    const failing = createAdapter({
      compileFromRaw: vi.fn(async function* (): AsyncIterable<ProgressEvent> {
        yield {
          step: 'done',
          status: 'error',
          message: '编译失败: 429',
          data: { rawPath: 'raw/b.md' },
          retryable: true,
        };
      }),
    });
    const app = await buildApp(failing);
    const res = await app.inject({
      method: 'POST',
      url: '/api/compile/retry',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ rawPath: 'raw/b.md', fileIndex: 3, fileCount: 5, fileName: 'b.md' }),
    });
    const err = parseSSEEvents(res.payload).find((e) => e.event === 'file_error');
    expect(err).toBeTruthy();
    expect(err!.data.retryable).toBe(true);
    expect(err!.data.data.fileIndex).toBe(3);
    expect(err!.data.data.fileCount).toBe(5);
    expect(err!.data.data.rawPath).toBe('raw/b.md');

    const okApp = await buildApp(createAdapter());
    const okRes = await okApp.inject({
      method: 'POST',
      url: '/api/compile/retry',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ rawPath: 'raw/c.md', fileIndex: 1, fileCount: 2, fileName: 'c.md' }),
    });
    const done = parseSSEEvents(okRes.payload).find((e) => e.event === 'file_done');
    expect(done!.data.data.fileIndex).toBe(1);
  });

  it('编译异常应转成 error 事件且流正常结束', async () => {
    const adapter = createAdapter({
      compileFromRaw: vi.fn(async function* (): AsyncIterable<ProgressEvent> {
        throw new Error('raw 文件读取失败');
      }),
    });
    const app = await buildApp(adapter);
    const res = await app.inject({
      method: 'POST',
      url: '/api/compile/retry',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ rawPath: 'raw/missing.md' }),
    });
    expect(res.statusCode).toBe(200);
    const err = parseSSEEvents(res.payload).find((e) => e.event === 'error');
    expect(err!.data.message).toBe('raw 文件读取失败');
  });

  it('同一 rawPath 并发重试：第二个请求回 deduped 并带进度快照', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const adapter = createAdapter({
      compileFromRaw: vi.fn(async function* (): AsyncIterable<ProgressEvent> {
        entered();
        yield { step: 'archive', status: 'done', message: '原始资料已存档', data: { path: 'raw/a.md' } };
        await gate;
        yield { step: 'done', status: 'done', message: '编译完成' };
      }),
    });
    const app = await buildApp(adapter);

    const first = app.inject({
      method: 'POST',
      url: '/api/compile/retry',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ rawPath: 'raw/a.md' }),
    });
    await enteredPromise;

    const dup = await app.inject({
      method: 'POST',
      url: '/api/compile/retry',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ rawPath: 'raw/a.md' }),
    });
    const dupEvents = parseSSEEvents(dup.payload);
    expect(dupEvents[0].event).toBe('deduped');
    expect(dupEvents[0].data.data.state).toBe('running');
    expect(dupEvents[0].data.data.step).toBe('archive');

    release();
    const firstRes = await first;
    expect(parseSSEEvents(firstRes.payload).some((e) => e.event === 'done')).toBe(true);
    expect(adapter.compileFromRaw).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/compile 幂等', () => {
  it('同内容并发提交：第二次回 deduped，不重复执行编译', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const adapter = createAdapter({
      compile: vi.fn(async function* (): AsyncIterable<ProgressEvent> {
        entered();
        yield { step: 'extract', status: 'running', message: '抽取要点' };
        await gate;
        yield { step: 'done', status: 'done', message: '编译完成' };
      }),
    });
    const app = await buildApp(adapter);
    const payload = JSON.stringify({ type: 'text', content: '同一份资料' });

    const first = app.inject({
      method: 'POST',
      url: '/api/compile',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    await enteredPromise;

    const dup = await app.inject({
      method: 'POST',
      url: '/api/compile',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    const dupEvents = parseSSEEvents(dup.payload);
    expect(dupEvents[0].event).toBe('deduped');
    expect(dupEvents[0].data.data.step).toBe('extract');

    release();
    await first;
    expect(adapter.compile).toHaveBeenCalledTimes(1);
  });

  it('内容不同的提交不互相拦截', async () => {
    const adapter = createAdapter();
    const app = await buildApp(adapter);
    for (const content of ['资料 A', '资料 B']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'text', content }),
      });
      expect(parseSSEEvents(res.payload).some((e) => e.event === 'done')).toBe(true);
    }
    expect(adapter.compile).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/compile/batch 幂等', () => {
  it('同一文件集合并发提交：第二次回 batch_deduped', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const adapter = createAdapter({
      compile: vi.fn(async function* (): AsyncIterable<ProgressEvent> {
        entered();
        await gate;
        yield { step: 'done', status: 'done', message: '编译完成' };
      }),
    });
    const app = await buildApp(adapter);
    const { body, boundary } = buildMultipartPayload([{ field: 'files', filename: 'a.md', content: '# A' }]);
    const opts = {
      method: 'POST' as const,
      url: '/api/compile/batch',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    };

    const first = app.inject(opts);
    await enteredPromise;

    const dup = await app.inject(opts);
    const dupEvents = parseSSEEvents(dup.payload);
    expect(dupEvents[0].event).toBe('batch_deduped');
    expect(dupEvents[0].data.data.fileCount).toBe(1);

    release();
    await first;
    expect(adapter.compile).toHaveBeenCalledTimes(1);
  });
});

describe('批量失败事件回带重试信息', () => {
  it('file_error 携带 rawPath 与 retryable，供前端显示重试入口', async () => {
    const adapter = createAdapter({
      compile: vi.fn(async function* (_input: CompileInput): AsyncIterable<ProgressEvent> {
        yield { step: 'archive', status: 'done', message: '存档', data: { path: 'raw/bad.md' } };
        yield {
          step: 'done',
          status: 'error',
          message: '编译失败: 429',
          data: { path: 'raw/bad.md', rawPath: 'raw/bad.md' },
          retryable: true,
        };
      }),
    });
    const app = await buildApp(adapter);
    const { body, boundary } = buildMultipartPayload([{ field: 'files', filename: 'bad.md', content: 'B' }]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/compile/batch',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    const err = parseSSEEvents(res.payload).find((e) => e.event === 'file_error');
    expect(err!.data.retryable).toBe(true);
    expect(err!.data.data.rawPath).toBe('raw/bad.md');
  });
});

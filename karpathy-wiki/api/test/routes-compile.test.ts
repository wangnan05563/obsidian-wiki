// 编译路由层测试（T01552 覆盖率治理）
// 范式与 qq-ingest-routes.test.ts 一致：Fastify + multipart + inject，SSE 响应解析后断言事件序列。
// mock 仅用于外部边界：EngineAdapter（LLM 工作流）；临时文件走 os.tmpdir() 属路由真实行为（finally 会清理，
//   测试额外断言清理结果）。compile-queue 是纯内存串行队列，用真实实现。
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs/promises';
import { registerCompileRoute } from '../src/routes/compile.js';
import type { EngineAdapter, ProgressEvent, CompileInput, BatchCompileConfig } from '../src/types.js';

// 解析 SSE 响应文本为事件数组（与 qq-ingest-routes.test.ts 同法）
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

function buildMultipartPayload(parts: Array<{ field: string; filename?: string; content: string | Buffer }>): { body: Buffer; boundary: string } {
  const boundary = `----vitest${process.hrtime.bigint().toString()}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = p.filename !== undefined
      ? `Content-Disposition: form-data; name="${p.field}"; filename="${p.filename}"\r\n`
      : `Content-Disposition: form-data; name="${p.field}"\r\n`;
    chunks.push(Buffer.from(`--${boundary}\r\n${disposition}\r\n`));
    chunks.push(Buffer.isBuffer(p.content) ? p.content : Buffer.from(p.content, 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

// 构造 mock adapter：compile 默认产出 progress → page → done 三种事件，覆盖路由的事件分类分支
function createAdapter(events?: ProgressEvent[]): EngineAdapter {
  const compileEvents = events ?? [
    { step: 'archive', status: 'running', message: '存档原始资料' },
    { step: 'generate_page', status: 'running', message: '生成页面', data: { path: 'qa/a.md', title: 'Page A' } },
    { step: 'done', status: 'done', message: '编译完成', data: { path: 'qa/a.md', title: 'Page A' } },
  ];
  return {
    compile: vi.fn(async function* (): AsyncIterable<ProgressEvent> {
      for (const ev of compileEvents) yield ev;
    }),
    resumeCompile: vi.fn(async function* (): AsyncIterable<ProgressEvent> {
      yield { step: 'progress', status: 'running', message: 'resume step' };
      yield { step: 'done', status: 'done', message: 'resume done' };
    }),
    query: async function* () { /* 不使用 */ },
    healthCheck: async () => ({}) as never,
    healthCheckFix: async function* () { /* 不使用 */ },
    updateConfig: () => { /* 不使用 */ },
  } as unknown as EngineAdapter;
}

const defaultBatch: BatchCompileConfig = {
  allowedExtensions: ['md', 'txt', 'pdf'],
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

describe('routes/compile.ts 编译路由', () => {
  // ==========================================================================
  // POST /api/compile — multipart 单文件
  // ==========================================================================
  describe('POST /api/compile (multipart)', () => {
    it('上传文件应流式返回 progress/page/done 事件并清理临时文件', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      const { body, boundary } = buildMultipartPayload([{ field: 'file', filename: 'note.md', content: '# hello' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      const events = parseSSEEvents(res.payload);
      expect(events.map((e) => e.event)).toEqual(['progress', 'page', 'done']);
      // 事件分类：data 含 path+title 的中间事件归 page，step=done 归 done
      expect(events[2].data.step).toBe('done');

      // adapter 收到 file 类型输入与 sanitize 后的原始名
      const callArg = (adapter.compile as ReturnType<typeof vi.fn>).mock.calls[0][0] as CompileInput;
      expect(callArg.type).toBe('file');
      expect(callArg.originalName).toBe('note.md');
      // finally 中已 unlink 临时文件
      await expect(fs.stat(callArg.content)).rejects.toThrow();
    });

    it('中文文件名应保留（Unicode 白名单 sanitize），非法字符替换为下划线', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      const { body, boundary } = buildMultipartPayload([{ field: 'file', filename: '../../测试 资料(1).md', content: '中文内容' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const callArg = (adapter.compile as ReturnType<typeof vi.fn>).mock.calls[0][0] as CompileInput;
      // basename 剥离目录前缀 + 空格/括号替换，中文保留
      expect(callArg.originalName).toBe('测试_资料_1_.md');
    });

    it('multipart 中缺少 file 字段应 400', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      const { body, boundary } = buildMultipartPayload([{ field: 'other', content: 'not a file' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('file');
      expect(adapter.compile).not.toHaveBeenCalled();
    });

    it('工作流抛错应发 error 事件且流正常结束', async () => {
      const adapter = createAdapter();
      (adapter.compile as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
        yield { step: 'archive', status: 'running', message: 'start' };
        throw new Error('LLM timeout');
      });
      const app = await buildApp(adapter);
      const { body, boundary } = buildMultipartPayload([{ field: 'file', filename: 'x.md', content: 'x' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const events = parseSSEEvents(res.payload);
      const errEvent = events.find((e) => e.event === 'error');
      expect(errEvent).toBeTruthy();
      expect(errEvent!.data.message).toBe('LLM timeout');
      expect(errEvent!.data.step).toBe('finalize');
    });
  });

  // ==========================================================================
  // POST /api/compile — JSON url/text
  // ==========================================================================
  describe('POST /api/compile (json)', () => {
    it('type=text 应透传给 adapter 并返回 SSE', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'text', content: '一段纯文本资料', rawPath: 'raw/x.md' }),
      });
      expect(res.statusCode).toBe(200);
      const callArg = (adapter.compile as ReturnType<typeof vi.fn>).mock.calls[0][0] as CompileInput;
      expect(callArg).toEqual({ type: 'text', content: '一段纯文本资料', rawPath: 'raw/x.md' });
      expect(parseSSEEvents(res.payload).some((e) => e.event === 'done')).toBe(true);
    });

    it('type 非法或缺 content 应 400', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'file', content: '' }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('type');
      expect(adapter.compile).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POST /api/compile/resume/:runId
  // ==========================================================================
  describe('POST /api/compile/resume/:runId', () => {
    it('合法 UUID 应流式返回 resumeCompile 事件', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      const runId = '11111111-2222-3333-4444-555555555555';
      const res = await app.inject({ method: 'POST', url: `/api/compile/resume/${runId}` });
      expect(res.statusCode).toBe(200);
      expect(adapter.resumeCompile).toHaveBeenCalledWith(runId);
      const events = parseSSEEvents(res.payload);
      expect(events.map((e) => e.event)).toEqual(['progress', 'done']);
    });

    it('非 UUID runId（路径穿越尝试）应被拒绝', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      const res = await app.inject({ method: 'POST', url: '/api/compile/resume/..%2Fevil' });
      // 校验失败即 400 JSON 并 return：不再继续写 SSE 头
      expect(res.statusCode).toBe(400);
      expect(res.payload).toContain('无效的 runId');
      expect(adapter.resumeCompile).not.toHaveBeenCalled();
    });

    it('前端请求形态：无 body 时不得声明 JSON content-type（Fastify 空 JSON body 直接 400）', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      const runId = '11111111-2222-3333-4444-555555555555';
      // 旧前端实现：POST 带 Content-Type: application/json 但不发 body，
      // Fastify 在进路由前就以 FST_ERR_CTP_EMPTY_JSON_BODY 拒绝——用户侧表现为「点击恢复报 HTTP 400」
      const withJsonHeader = await app.inject({
        method: 'POST',
        url: `/api/compile/resume/${runId}`,
        headers: { 'content-type': 'application/json' },
      });
      expect(withJsonHeader.statusCode).toBe(400);
      expect(withJsonHeader.json().code).toBe('FST_ERR_CTP_EMPTY_JSON_BODY');

      // 修复后的形态：无 body 就不带 content-type
      const plain = await app.inject({ method: 'POST', url: `/api/compile/resume/${runId}` });
      expect(plain.statusCode).toBe(200);
      expect(adapter.resumeCompile).toHaveBeenCalledWith(runId);
    });

    it('resume 过程抛错应发 error 事件', async () => {
      const adapter = createAdapter();
      (adapter.resumeCompile as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
        throw new Error('state file missing');
      });
      const app = await buildApp(adapter);
      const res = await app.inject({ method: 'POST', url: '/api/compile/resume/11111111-2222-3333-4444-555555555555' });
      expect(res.statusCode).toBe(200);
      const events = parseSSEEvents(res.payload);
      const errEvent = events.find((e) => e.event === 'error');
      expect(errEvent!.data.message).toBe('state file missing');
    });
  });

  // ==========================================================================
  // POST /api/compile/batch
  // ==========================================================================
  describe('POST /api/compile/batch', () => {
    it('多个合法文件应串行编译并输出 batch_start/file_start/file_done/file_complete/batch_done', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      const { body, boundary } = buildMultipartPayload([
        { field: 'files', filename: 'a.md', content: '# A' },
        { field: 'files', filename: 'b.txt', content: 'B text' },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile/batch',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const events = parseSSEEvents(res.payload);
      expect(events[0].event).toBe('batch_start');
      expect(events[0].data.data.fileCount).toBe(2);
      expect(events[0].data.data.rejected).toEqual([]);

      const names = events.map((e) => e.event);
      expect(names.filter((n) => n === 'file_start')).toHaveLength(2);
      expect(names.filter((n) => n === 'file_complete')).toHaveLength(2);
      // fileIndex/fileName 注入到每个事件 data，前端按分组渲染
      const firstFileDone = events.find((e) => e.event === 'file_done');
      expect(firstFileDone!.data.data.fileIndex).toBe(0);
      expect(firstFileDone!.data.data.fileName).toBe('a.md');
      expect(firstFileDone!.data.data.fileCount).toBe(2);

      const batchDone = events[events.length - 1];
      expect(batchDone.event).toBe('batch_done');
      expect(batchDone.data.status).toBe('done');
      expect(batchDone.data.message).toContain('共处理 2 个文件');
      expect(adapter.compile).toHaveBeenCalledTimes(2);
    });

    it('非法扩展名/缺扩展名/超大文件应被拒绝；全部拒绝时 400 并回传 rejected', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      const { body, boundary } = buildMultipartPayload([
        { field: 'files', filename: 'virus.exe', content: 'binary' },
        { field: 'files', filename: 'noext', content: 'text' },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile/batch',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('没有符合白名单的文件');
      const reasons = res.json().rejected.map((r: { reason: string }) => r.reason);
      expect(reasons).toContain('不支持的扩展名: exe');
      expect(reasons).toContain('缺少扩展名');
      expect(adapter.compile).not.toHaveBeenCalled();
    });

    it('部分文件被拒绝时 batch_start 应携带 rejected 列表', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      const big = 'x'.repeat(2 * 1024 * 1024); // 2MB > maxFileSizeMb=1
      const { body, boundary } = buildMultipartPayload([
        { field: 'files', filename: 'good.md', content: '# ok' },
        { field: 'files', filename: 'big.md', content: big },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile/batch',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const events = parseSSEEvents(res.payload);
      expect(events[0].event).toBe('batch_start');
      expect(events[0].data.data.fileCount).toBe(1);
      expect(events[0].data.data.rejected[0].reason).toContain('超过 1MB 上限');
    });

    it('有效文件数超过 maxBatchSize 应 400', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter, { ...defaultBatch, maxBatchSize: 1 });
      const { body, boundary } = buildMultipartPayload([
        { field: 'files', filename: 'a.md', content: 'A' },
        { field: 'files', filename: 'b.md', content: 'B' },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile/batch',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('超过上限 1');
    });

    it('缺少 files 字段应 400', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      // 纯字段 part（无 filename，不产生文件流），路由收集后 uploaded 为空
      const { body, boundary } = buildMultipartPayload([{ field: 'other', content: 'A' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile/batch',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('files');
    });

    it('非 multipart 请求应触发解析错误分支返回 400', async () => {
      const adapter = createAdapter();
      const app = await buildApp(adapter);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile/batch',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('文件解析失败');
    });

    it('单文件编译失败（done status=error）应发 file_error 且 batch_done 标记 error', async () => {
      const adapter = createAdapter([
        { step: 'archive', status: 'running', message: 'archiving' },
        { step: 'done', status: 'error', message: '页面生成失败' },
      ]);
      const app = await buildApp(adapter);
      const { body, boundary } = buildMultipartPayload([{ field: 'files', filename: 'bad.md', content: 'B' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile/batch',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const events = parseSSEEvents(res.payload);
      const fileError = events.find((e) => e.event === 'file_error');
      expect(fileError).toBeTruthy();
      expect(fileError!.data.message).toBe('页面生成失败');
      expect(fileError!.data.data.fileName).toBe('bad.md');
      // 失败文件不应出现 file_complete
      expect(events.some((e) => e.event === 'file_complete')).toBe(false);
      const batchDone = events[events.length - 1];
      expect(batchDone.event).toBe('batch_done');
      expect(batchDone.data.status).toBe('error');
      expect(batchDone.data.data.hasError).toBe(true);
    });

    it('单文件编译抛异常应转成 file_error 事件并继续 batch_done', async () => {
      const adapter = createAdapter();
      (adapter.compile as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
        throw new Error('workflow crashed');
      });
      const app = await buildApp(adapter);
      const { body, boundary } = buildMultipartPayload([{ field: 'files', filename: 'c.md', content: 'C' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/compile/batch',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      const events = parseSSEEvents(res.payload);
      const fileError = events.find((e) => e.event === 'file_error');
      expect(fileError!.data.message).toContain('c.md 编译失败: workflow crashed');
      expect(events[events.length - 1].event).toBe('batch_done');
    });
  });
});

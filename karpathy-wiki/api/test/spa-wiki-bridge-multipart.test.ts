// T03612 回归：/wiki/* → /api/* 注入桥对 multipart 请求体的透传。
//
// 现场缺陷：打包/生产形态入口在 /wiki/，前端 API_BASE='/wiki/api'，于是所有上传都走
//   spa-static.ts 的 app.all('/wiki/*') 桥。该桥用 app.inject({ body: request.body }) 转发，
//   而 /wiki/* 路由上没有 multipart 解析器 ⇒ request.body 为 undefined，整个上传体在注入时被丢弃，
//   下游路由只能报「缺少 files 字段或文件为空」。经 /api/* 直连的调用不受影响，
//   所以既有单测（都直连 /api）从未暴露这个问题。
//
// 本用例刻意走「真实桥 + 真实 compile 路由」，只在 LLM 边界（EngineAdapter）打桩。
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupSpaStatic } from '../src/spa-static.js';
import { registerCompileRoute } from '../src/routes/compile.js';
import type { EngineAdapter, ProgressEvent, CompileInput, BatchCompileConfig } from '../src/types.js';

const defaultBatch: BatchCompileConfig = {
  allowedExtensions: ['md', 'txt', 'pdf', 'docx'],
  maxBatchSize: 5,
  maxFileSizeMb: 1,
};

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

// 按 Buffer 拼 multipart 体：字节原样交给 inject，不经字符串编码往返
function multipartBody(
  boundary: string,
  files: Array<{ field: string; filename: string; content: Buffer; mimeType: string }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n`
      + `Content-Type: ${f.mimeType}\r\n\r\n`,
      'utf8',
    ));
    chunks.push(f.content);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function createAdapter(capture?: (input: CompileInput) => Promise<void>): EngineAdapter {
  const events: ProgressEvent[] = [
    { step: 'archive', status: 'done', message: '原始资料已存档: raw/x.md' },
    { step: 'generate_page', status: 'done', message: '生成页面', data: { path: 'concepts/x.md', title: 'X' } },
    { step: 'done', status: 'done', message: '编译完成，共 3 步' },
  ];
  return {
    compile: vi.fn(async function* (input: CompileInput): AsyncIterable<ProgressEvent> {
      // 路由在流结束后删除临时文件，字节只能在编译进行中断言
      if (capture) await capture(input);
      for (const ev of events) yield ev;
    }),
    resumeCompile: vi.fn(async function* (): AsyncIterable<ProgressEvent> { /* 不使用 */ }),
    query: async function* () { /* 不使用 */ },
    healthCheck: async () => ({}) as never,
    healthCheckFix: async function* () { /* 不使用 */ },
    updateConfig: () => { /* 不使用 */ },
  } as unknown as EngineAdapter;
}

let currentApp: FastifyInstance | null = null;
let spaRootDir: string | null = null;

// 桥只在「能找到 SPA 产物」时注册（resolveSpaRoot 探测），故用例注入一个临时根：
// 既不依赖本地是否已构建 SPA，测的又是同一段真实转发代码。
async function buildBridgedApp(adapter: EngineAdapter): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  registerCompileRoute(app, adapter, defaultBatch);
  spaRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 't03612-spa-'));
  await fs.writeFile(path.join(spaRootDir, 'index.html'), '<!doctype html><html><body>spa</body></html>', 'utf8');
  await setupSpaStatic(app, { spaRoot: spaRootDir });
  await app.ready();
  currentApp = app;
  return app;
}

afterEach(async () => {
  if (currentApp) { await currentApp.close(); currentApp = null; }
  if (spaRootDir) { await fs.rm(spaRootDir, { recursive: true, force: true }); spaRootDir = null; }
});

const PDF_BYTES = Buffer.from('%PDF-1.4\n' + 'A'.repeat(2048) + '\n%%EOF\n', 'utf8');

describe('T03612 /wiki/api 注入桥的 multipart 透传', () => {
  it('经 /wiki/ 的批量上传（≥2 个文件）应进入编译并回带 batch_start，而不是「缺少 files 字段」', async () => {
    const adapter = createAdapter();
    const app = await buildBridgedApp(adapter);
    const boundary = '----t03612batch';
    const body = multipartBody(boundary, [
      { field: 'files', filename: '票据归档-测试.pdf', content: PDF_BYTES, mimeType: 'application/pdf' },
      { field: 'files', filename: '需求说明.md', content: Buffer.from('# 需求\n正文', 'utf8'), mimeType: 'text/markdown' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/wiki/api/compile/batch',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('缺少 files 字段或文件为空');
    const events = parseSSEEvents(res.body);
    const start = events.find((e) => e.event === 'batch_start');
    expect(start).toBeTruthy();
    expect(start.data.data.fileCount).toBe(2);
    expect(events.filter((e) => e.event === 'file_start')).toHaveLength(2);
    expect(events.some((e) => e.event === 'batch_done')).toBe(true);
  });

  it('经 /wiki/ 的单文件上传：文件名字节与正文完整到达下游（不是空体）', async () => {
    let receivedName = '';
    let received: Buffer | null = null;
    const adapter = createAdapter(async (input) => {
      receivedName = String(input.originalName ?? '');
      received = await fs.readFile(input.content);
    });
    const app = await buildBridgedApp(adapter);
    const boundary = '----t03612single';
    const body = multipartBody(boundary, [
      { field: 'file', filename: '合同扫描件（终版）.pdf', content: PDF_BYTES, mimeType: 'application/pdf' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/wiki/api/compile',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('缺少 file 字段');
    expect(parseSSEEvents(res.body).map((e) => e.event)).toEqual(['progress', 'page', 'done']);
    // 路由对文件名做白名单 sanitize（全角括号→下划线），这里断言中文字符与字节都保住了
    expect(receivedName).toContain('合同扫描件');
    expect(received).not.toBeNull();
    expect(received!.length).toBe(PDF_BYTES.length);
    expect(received!.equals(PDF_BYTES)).toBe(true);
  });

  it('透传不绕过下游护栏：超限文件仍被批量校验拒绝', async () => {
    const adapter = createAdapter();
    const app = await buildBridgedApp(adapter);
    const boundary = '----t03612big';
    // 2MB > maxFileSizeMb(1MB)：应作为 rejected 出现，而不是被当成「没有上传文件」
    const body = multipartBody(boundary, [
      { field: 'files', filename: 'big.md', content: Buffer.alloc(2 * 1024 * 1024, 0x41), mimeType: 'text/markdown' },
      { field: 'files', filename: 'ok.md', content: Buffer.from('x', 'utf8'), mimeType: 'text/markdown' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/wiki/api/compile/batch',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) },
      payload: body,
    });

    const start = parseSSEEvents(res.body).find((e) => e.event === 'batch_start');
    expect(start.data.data.rejected).toHaveLength(1);
    expect(start.data.data.rejected[0].name).toBe('big.md');
    expect(start.data.data.fileCount).toBe(1);
  });

  it('非 multipart 仍走原 body 分支：经 /wiki/ 的 JSON 投递正常编译', async () => {
    const adapter = createAdapter();
    const app = await buildBridgedApp(adapter);
    const res = await app.inject({
      method: 'POST',
      url: '/wiki/api/compile',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'text', content: '# 直接粘贴的文本资料' }),
    });
    expect(res.statusCode).toBe(200);
    expect(parseSSEEvents(res.body).map((e) => e.event)).toEqual(['progress', 'page', 'done']);
    const input = (adapter.compile as ReturnType<typeof vi.fn>).mock.calls[0][0] as CompileInput;
    expect(input.type).toBe('text');
    expect(input.content).toContain('直接粘贴的文本资料');
  });

  it('经 /wiki/ 的 JSON 校验失败仍返回 400 语义（桥不吞状态码）', async () => {
    const adapter = createAdapter();
    const app = await buildBridgedApp(adapter);
    const res = await app.inject({
      method: 'POST',
      url: '/wiki/api/compile',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'nope' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

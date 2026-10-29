// T03646（由 T03612 派生）：/wiki/api* 注入桥的**响应侧**。
//
// 缺陷实测（修复前）：
//   - 同一个图片接口：直连 /api 1,960,929 B，经 /wiki/api 3,573,762 B，sha256 不同
//     （inject 把二进制解码成 utf8 字符串再回编码，内容与体积都变了）
//   - SSE：直连 469,676.20 ms 收到最后一帧，经桥 469,678.72 ms 才一次性收到全部内容
//     （inject 等整条响应结束才 resolve，进度/日志不再增量到达）
//   - 只回传 content-type：content-disposition 等下载所需头全部丢失
//
// 修复后监听态走 127.0.0.1 回环转发：请求体按原字节发出，响应体 pipe 直通。
// 本文件用真实 HTTP（app.listen）验证：字节相等、响应头保留、SSE 增量到达、请求体透传。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';

import { setupSpaStatic } from '../src/spa-static.js';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

// 覆盖 0x00-0xFF 全字节，任何 utf8 往返都会改变它
function binaryFixture(size = 1_500_000): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = i % 256;
  return buf;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  firstChunkAt: number;
  endedAt: number;
}

function request(
  port: number,
  method: string,
  pathname: string,
  options: { headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let firstChunkAt = 0;
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          if (!firstChunkAt) firstChunkAt = Date.now() - startedAt;
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            firstChunkAt,
            endedAt: Date.now() - startedAt,
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.end(options.body);
    else req.end();
  });
}

interface StreamHandle {
  /** 首个数据块到达（整条流被缓冲时永远不会提前兑现） */
  firstChunk: Promise<string>;
  done: Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; firstChunkAt: number; endedAt: number }>;
}

/**
 * 读取「边到边看」的客户端：一次 data 事件就能兑现 firstChunk，用于区分流式与整体缓冲。
 * 不用定时器判定——SSE 夹具由 /api/sse/advance 逐帧放行（见 beforeAll）。
 */
function openStream(port: number, pathname: string): StreamHandle {
  const startedAt = Date.now();
  let firstChunkAt = 0;
  let settleFirst: ((chunk: string) => void) | null = null;
  const chunks: Buffer[] = [];
  const firstChunk = new Promise<string>((resolve) => {
    settleFirst = resolve;
  });
  const done = new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; firstChunkAt: number; endedAt: number }>(
    (resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathname }, (res) => {
        res.on('data', (chunk: Buffer) => {
          if (!firstChunkAt) {
            firstChunkAt = Date.now() - startedAt;
            settleFirst?.(chunk.toString('utf8'));
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            firstChunkAt,
            endedAt: Date.now() - startedAt,
          }),
        );
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    },
  );
  return { firstChunk, done };
}

describe('T03646 /wiki/api 桥：响应侧字节与流式', () => {
  let app: FastifyInstance;
  let port = 0;
  let tmpDir = '';
  let pendingAdvance: (() => void) | null = null;
  const fixture = binaryFixture();

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 't03646-'));
    await fs.writeFile(path.join(tmpDir, 'index.html'), '<!doctype html><title>spa</title>');
    app = Fastify({ logger: false });
    // 二进制请求体：以 Buffer 形式拿到，验证「已解析 body 重新取字节」也不失真
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    // 中文文件名必须按 RFC 5987 编码：Node 的 header 只允许 latin1，直接写中文会 ERR_INVALID_CHAR
    app.get('/api/binary', (_req, reply) =>
      reply
        .header('Content-Type', 'image/png')
        .header(
          'Content-Disposition',
          "attachment; filename=\"export.png\"; filename*=UTF-8''%E5%9B%BE%E8%A1%A8%E5%AF%BC%E5%87%BA.png",
        )
        .send(fixture),
    );
    // SSE 夹具不用定时器：首帧立即写出，其余 3 帧等 /api/sse/advance 放行。
    // 若桥把整条响应缓冲起来，首帧就只能在流结束后才可见，而流又要等测试放行 → 用例超时失败，
    // 这正是「不再增量到达」的回归信号（区别于点名断言，这里用「测试能否推进」本身作判据）。
    app.get('/api/sse', async (_req, reply) => {
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      reply.raw.write('data: {"step":0}\n\n');
      for (let i = 1; i <= 3; i += 1) {
        await new Promise<void>((resolve) => {
          pendingAdvance = resolve;
        });
        reply.raw.write(`data: {"step":${i}}\n\n`);
      }
      reply.raw.end();
    });
    app.post('/api/sse/advance', async () => {
      const release = pendingAdvance;
      pendingAdvance = null;
      release?.();
      return { released: release !== null };
    });
    app.post('/api/echo', async (req) => ({ received: req.body }));
    app.post('/api/upload', async (req) => {
      const body = req.body as Buffer;
      return { length: body.length, sha256: sha256(body), head: body.subarray(0, 4).toString('hex') };
    });
    app.get('/api/missing', (_req, reply) => reply.code(404).send({ error: 'nope' }));

    await setupSpaStatic(app, { spaRoot: tmpDir });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }, 30_000);

  // 1.5MB 二进制跨两条连接 + 磁盘写盘，默认 5s 在慢机上不够
  it('二进制下载字节完全相等，且保留 content-disposition', async () => {
    const direct = await request(port, 'GET', '/api/binary');
    const bridged = await request(port, 'GET', '/wiki/api/binary');

    expect(bridged.status).toBe(200);
    expect(bridged.headers['content-type']).toBe('image/png');
    expect(bridged.headers['content-disposition']).toContain('attachment');
    expect(bridged.headers['content-disposition']).toContain('filename*=');
    expect(bridged.body.length).toBe(direct.body.length);
    expect(sha256(bridged.body)).toBe(sha256(direct.body));
    // 直接与夹具比对，确保不是「两边一起坏」
    expect(bridged.body.length).toBe(fixture.length);
    expect(sha256(bridged.body)).toBe(sha256(fixture));
  }, 30_000);

  // 逐帧放行：首帧在流未结束时就能拿到，才是「增量到达」；缓冲式转发会让首帧永远等不到（用例超时）
  it('SSE 增量到达：首帧在流结束前送达，后续帧逐帧可见', async () => {
    const stream = openStream(port, '/wiki/api/sse');
    const first = await stream.firstChunk;
    expect(first).toContain('{"step":0}');
    expect(first).not.toContain('{"step":3}');

    for (let i = 1; i <= 3; i += 1) {
      const advance = await request(port, 'POST', '/api/sse/advance');
      expect(advance.status).toBe(200);
      expect(JSON.parse(advance.body.toString('utf8'))).toEqual({ released: true });
    }

    const final = await stream.done;
    expect(final.status).toBe(200);
    expect(final.headers['content-type']).toContain('text/event-stream');
    expect(final.body).toContain('{"step":3}');
    expect(final.firstChunkAt).toBeLessThan(final.endedAt);
  }, 20_000);

  it('JSON 请求体经桥转发后内容不变', async () => {
    const payload = JSON.stringify({ hello: '世界', n: 42, nested: { a: [1, 2, 3] } });
    const res = await request(port, 'POST', '/wiki/api/echo', {
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ received: JSON.parse(payload) });
  });

  it('二进制请求体经桥转发字节不变（全 0x00-0xFF）', async () => {
    const body = binaryFixture(65_536);
    const res = await request(port, 'POST', '/wiki/api/upload', {
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.body.toString('utf8')) as { length: number; sha256: string; head: string };
    expect(echoed.length).toBe(body.length);
    expect(echoed.sha256).toBe(sha256(body));
    expect(echoed.head).toBe('00010203');
  });

  it('错误状态码与 JSON 错误体原样透传', async () => {
    const res = await request(port, 'GET', '/wiki/api/missing');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'nope' });
  });

  it('未监听时退回 inject 兜底（本进程冒烟路径仍可用）', async () => {
    const offline = Fastify({ logger: false });
    offline.get('/api/ping', async () => ({ ok: true }));
    await setupSpaStatic(offline, { spaRoot: tmpDir });
    const res = await offline.inject({ method: 'GET', url: '/wiki/api/ping' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await offline.close();
  });
});

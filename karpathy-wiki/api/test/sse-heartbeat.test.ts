import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createSSESender } from '../src/utils/sse.js';

// T03438：编译链路在步与步之间可能沉默数分钟（LLM 调用），中间代理按空闲超时会切断
// 一条「看起来还活着」但一直没写字节的 SSE 连接。客户端只看到「干净结束」而没有终止事件，
// 进度页就永久停在当前计数。心跳注释行是唯一的存活信号，本用例锁定它的开关与收尾。

interface FakeRaw extends EventEmitter {
  destroyed: boolean;
  writableEnded: boolean;
  writes: string[];
}

function makeStream(): { raw: FakeRaw; reply: FastifyReply; request: FastifyRequest } {
  const raw = new EventEmitter() as FakeRaw;
  raw.destroyed = false;
  raw.writableEnded = false;
  raw.writes = [];
  raw.write = ((chunk: string) => {
    raw.writes.push(chunk);
    return true;
  }) as FakeRaw['write'];
  raw.end = (() => {
    raw.writableEnded = true;
    raw.writes.push('END');
  }) as FakeRaw['end'];
  return {
    raw,
    reply: { raw } as unknown as FastifyReply,
    request: { raw: new EventEmitter() } as unknown as FastifyRequest,
  };
}

function pings(raw: FakeRaw): number {
  return raw.writes.filter((w) => w === ': ping\n\n').length;
}

describe('createSSESender 心跳（T03438）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('开启心跳后按间隔写注释行，且不干扰正常事件', () => {
    vi.useFakeTimers();
    const { raw, reply, request } = makeStream();
    const { send, safeEnd } = createSSESender(reply, request, { heartbeatMs: 1000 });

    send('progress', { step: 'extract' });
    vi.advanceTimersByTime(2500);

    expect(pings(raw)).toBe(2);
    expect(raw.writes.join('')).toContain('event: progress');
    // 注释行只有 `: ` 前缀，没有 event/data，前端解析器不会误当成业务事件
    expect(raw.writes.every((w) => w === ': ping\n\n' || w.startsWith('event: ') || w.startsWith('data: '))).toBe(true);

    safeEnd();
    raw.emit('close');
  });

  it('safeEnd 停掉心跳：不会对已结束的流继续写', () => {
    vi.useFakeTimers();
    const { raw, reply, request } = makeStream();
    const { safeEnd } = createSSESender(reply, request, { heartbeatMs: 1000 });

    vi.advanceTimersByTime(1000);
    expect(pings(raw)).toBe(1);

    safeEnd();
    const afterEnd = raw.writes.length;
    vi.advanceTimersByTime(5000);

    expect(raw.writes.length).toBe(afterEnd);
    expect(raw.writes.at(-1)).toBe('END');
    raw.emit('close');
  });

  it('客户端断开时停掉心跳并让 send 短路', () => {
    vi.useFakeTimers();
    const { raw, reply, request } = makeStream();
    const { send } = createSSESender(reply, request, { heartbeatMs: 1000 });

    raw.emit('close');
    vi.advanceTimersByTime(5000);

    expect(pings(raw)).toBe(0);
    expect(send('progress', {})).toBe(false);
  });

  it('缺省不开启心跳：既有 SSE 路由行为不变', () => {
    vi.useFakeTimers();
    const { raw, reply, request } = makeStream();
    const { safeEnd } = createSSESender(reply, request);

    vi.advanceTimersByTime(10_000);

    expect(pings(raw)).toBe(0);
    safeEnd();
    raw.emit('close');
  });
});

describe('compile 路由心跳接线（T03438）', () => {
  it('单文件、断点续传、批量三条 SSE 路由都开启心跳', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/compile.ts'), 'utf8');
    // 漏接任何一条，对应入口在长时间 LLM 静默时又会被代理掐断且前端无从得知
    expect(src.match(/heartbeatMs: SSE_HEARTBEAT_MS/g)).toHaveLength(3);
  });
});

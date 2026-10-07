// health-check.ts 的客户端断开（isAborted 短路）分支测试。
// 为什么单独成文件并 mock utils/sse：注入版（test/health-check-route.test.ts）走真实
//   createSSESender，但 inject 下无法确定性地模拟「流中途客户端断开」——
//   这里替换 createSSESender 为可编程 send/isAborted/safeEnd：
//   - send：记录 (event, data) 到数组，事件短路判断可直接断言；
//   - isAborted：由测试/假 adapter 翻转的标志位，确定性触发 break 分支（无毫秒级 sleep）；
//   - safeEnd：真正 end 掉 reply.raw，保证 inject 能收到完整响应而不挂起。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthCheckRoute } from '../src/routes/health-check.js';
import type { EngineAdapter, FixProgressEvent } from '../src/types.js';

const h = vi.hoisted(() => ({
  sent: [] as Array<{ event: string; data: unknown }>,
  abort: false,
}));

vi.mock('../src/utils/sse.js', () => ({
  createSSESender: (reply: { raw: { writableEnded?: boolean; end: () => void } }) => ({
    send: (event: string, data: unknown) => {
      h.sent.push({ event, data });
      return true;
    },
    isAborted: () => h.abort,
    safeEnd: () => {
      try {
        if (!reply.raw.writableEnded) reply.raw.end();
      } catch {
        /* 已销毁 */
      }
    },
  }),
  setupSSE: () => undefined,
  sendSSE: () => undefined,
  SSE_HEADERS: {},
}));

const ev = (step: string, status: FixProgressEvent['status'], message = step): FixProgressEvent =>
  ({ step, status, message });

function makeAdapter(fixImpl: (input: unknown) => AsyncIterable<FixProgressEvent>) {
  const fix = vi.fn(fixImpl);
  const adapter = {
    healthCheck: vi.fn(async () => ({})),
    healthCheckFix: fix,
    markKnowledgeReviewed: vi.fn(async (paths: string[]) => ({ ok: true, paths, message: '' })),
  } as unknown as EngineAdapter;
  return { adapter, fix };
}

async function* iterEvents(events: FixProgressEvent[]): AsyncGenerator<FixProgressEvent> {
  for (const e of events) yield e;
}

beforeEach(() => {
  h.sent = [];
  h.abort = false;
});

describe('fix 路由：客户端断开的短路行为', () => {
  it('断开发生在首事件前 → 一个事件都不推（isAborted 于 send 前短路）', async () => {
    h.abort = true;
    const { adapter } = makeAdapter(() => iterEvents([ev('scan', 'running'), ev('done', 'done')]));
    const app = Fastify({ logger: false });
    registerHealthCheckRoute(app, adapter);
    const res = await app.inject({
      method: 'POST',
      url: '/api/health-check/fix',
      payload: { issueType: 'orphan', target: 'x.md' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.sent).toEqual([]);
    await app.close();
  });

  it('迭代中途断开 → 已发的第一条保留，第二条（done）被丢弃', async () => {
    const gen = (async function* (): AsyncGenerator<FixProgressEvent> {
      yield ev('scan', 'running');
      h.abort = true; // 模拟第一条发出后客户端断开
      yield ev('done', 'done');
    })();
    const { adapter } = makeAdapter(() => gen);
    const app = Fastify({ logger: false });
    registerHealthCheckRoute(app, adapter);
    const res = await app.inject({
      method: 'POST',
      url: '/api/health-check/fix',
      payload: { issueType: 'broken_link', target: { from: 'a', to: 'b' } },
    });
    expect(res.statusCode).toBe(200);
    expect(h.sent).toEqual([{ event: 'progress', data: { step: 'scan', status: 'running', message: 'scan' } }]);
    await app.close();
  });
});

describe('fix/batch 路由：客户端断开的短路行为', () => {
  const items = [
    { issueType: 'broken_link', target: { from: 'a', to: 'b' } },
    { issueType: 'orphan', target: 'c.md' },
  ];

  it('进入循环前已断开 → 仅 batch_start + batch_done（0 成功 0 失败），adapter 未被调用', async () => {
    h.abort = true;
    const { adapter, fix } = makeAdapter(() => iterEvents([ev('done', 'done')]));
    const app = Fastify({ logger: false });
    registerHealthCheckRoute(app, adapter);
    const res = await app.inject({ method: 'POST', url: '/api/health-check/fix/batch', payload: { items } });
    expect(res.statusCode).toBe(200);
    expect(fix).not.toHaveBeenCalled();
    expect(h.sent.map((s) => s.event)).toEqual(['batch_start', 'batch_done']);
    expect(h.sent[1].data).toMatchObject({ successCount: 0, failCount: 0, totalIssues: 2 });
    await app.close();
  });

  it('第一个问题迭代中断开 → issue_start+progress 已发、issue_done 不发、第二个问题不再处理', async () => {
    const gen = (async function* (): AsyncGenerator<FixProgressEvent> {
      yield ev('scan', 'running');
      h.abort = true;
      yield ev('done', 'done');
    })();
    const { adapter, fix } = makeAdapter(() => gen);
    const app = Fastify({ logger: false });
    registerHealthCheckRoute(app, adapter);
    const res = await app.inject({ method: 'POST', url: '/api/health-check/fix/batch', payload: { items } });
    expect(res.statusCode).toBe(200);
    expect(fix).toHaveBeenCalledTimes(1); // 第二项因 isAborted break，不再触发 LLM 修复
    const names = h.sent.map((s) => s.event);
    expect(names).toEqual(['batch_start', 'issue_start', 'progress', 'batch_done']);
    expect(h.sent[3].data).toMatchObject({ successCount: 0, failCount: 0 });
    await app.close();
  });
});

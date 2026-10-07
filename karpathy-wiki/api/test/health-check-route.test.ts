// health-check.ts 路由层测试：真实 Fastify 实例 + app.inject()，adapter 用可编程桩注入。
// 为什么可行：registerHealthCheckRoute(app, adapter, guards?) 的两个外部依赖都是入参——
//   adapter 直接注入假实现（EngineAdapter 有 healthCheck/healthCheckFix/markKnowledgeReviewed），
//   guards 缺省（createIsolationGuards() 未启用 → requireAdmin 放行），无需 mock 鉴权链路。
// SSE 断言方式与 test/qq-ingest-routes.test.ts 一致：inject 下 writeHead/write 被缓冲为完整
//   payload，解析 'event:/data:' 帧后逐事件断言。abort 短路分支需要控制 isAborted，
//   见 test/health-check-abort.test.ts（mock utils/sse）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthCheckRoute } from '../src/routes/health-check.js';
import type { EngineAdapter, FixProgressEvent, HealthReport } from '../src/types.js';

const REPORT: HealthReport = {
  orphans: ['a.md'],
  brokenLinks: [{ from: 'b.md', to: 'missing.md' }],
  stale: ['c.md'],
  knowledgeStale: ['d.md'],
};

// ===== 可编程 adapter 桩 =====
interface AdapterStub {
  adapter: EngineAdapter;
  healthCheck: ReturnType<typeof vi.fn>;
  fix: ReturnType<typeof vi.fn>;
  markReviewed: ReturnType<typeof vi.fn>;
}

/** fixFor(eventsMap): 按 target 键返回不同事件序列/异常，覆盖多问题批处理 */
function makeAdapter(
  fixImpl: (input: { issueType: string; target: unknown }) => AsyncIterable<FixProgressEvent>,
): AdapterStub {
  const healthCheck = vi.fn(async () => REPORT);
  const fix = vi.fn(fixImpl);
  const markReviewed = vi.fn(async (paths: string[]) => ({ ok: true, paths, message: `reviewed ${paths.length}` }));
  const adapter = {
    healthCheck,
    healthCheckFix: fix,
    markKnowledgeReviewed: markReviewed,
  } as unknown as EngineAdapter;
  return { adapter, healthCheck, fix, markReviewed };
}

async function* iterEvents(events: FixProgressEvent[]): AsyncGenerator<FixProgressEvent> {
  for (const e of events) yield e;
}

async function* throwAfter(events: FixProgressEvent[], err: unknown): AsyncGenerator<FixProgressEvent> {
  for (const e of events) yield e;
  throw err;
}

async function buildApp(stub: AdapterStub): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // 不传 guards：走默认参数 createIsolationGuards()（未启用 → 放行），与单租户部署形态一致
  registerHealthCheckRoute(app, stub.adapter);
  return app;
}

// 解析 SSE 响应体为事件数组（同 qq-ingest-routes.test.ts 的约定）
function parseSSE(payload: string): Array<{ event: string; data: Record<string, unknown> }> {
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of payload.split('\n\n')) {
    if (!block.trim()) continue;
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (event) out.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  }
  return out;
}

const ev = (step: string, status: FixProgressEvent['status'], message = step): FixProgressEvent =>
  ({ step, status, message });

let app: FastifyInstance | null = null;
beforeEach(() => {
  app = null;
});

async function withApp(stub: AdapterStub): Promise<FastifyInstance> {
  const a = await buildApp(stub);
  app = a;
  return a;
}

describe('POST /api/health-check（体检 JSON）', () => {
  it('返回 adapter.healthCheck 的报告且只调用一次', async () => {
    const stub = makeAdapter(() => iterEvents([]));
    const a = await withApp(stub);
    const res = await a.inject({ method: 'POST', url: '/api/health-check' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(REPORT);
    expect(stub.healthCheck).toHaveBeenCalledTimes(1);
    await a.close();
  });
});

describe('POST /api/health-check/fix（单问题 SSE）', () => {
  const valid = { issueType: 'broken_link', target: { from: 'a.md', to: 'b.md' } };

  it('请求体校验：空体 / 非法 issueType / 缺 target → 400 且不调用 adapter', async () => {
    const stub = makeAdapter(() => iterEvents([]));
    const a = await withApp(stub);
    for (const payload of [{}, { issueType: 'broken_link' }, { issueType: 'wrong', target: 'x' }, { target: 'x' }] as const) {
      const res = await a.inject({ method: 'POST', url: '/api/health-check/fix', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('issueType');
    }
    expect(stub.fix).not.toHaveBeenCalled();
    await a.close();
  });

  it('事件映射：scan/fixing→progress、fixed→fixed、done→done，并透传事件体', async () => {
    const events = [ev('scan', 'running'), ev('fixing', 'running'), ev('fixed', 'done'), ev('done', 'done')];
    const stub = makeAdapter(() => iterEvents(events));
    const a = await withApp(stub);
    const res = await a.inject({ method: 'POST', url: '/api/health-check/fix', payload: valid });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const frames = parseSSE(res.body);
    expect(frames.map((f) => f.event)).toEqual(['progress', 'progress', 'fixed', 'done']);
    expect(frames[0].data).toEqual(events[0]);
    expect(frames[3].data).toEqual(events[3]);
    // adapter 收到完整 FixInput
    expect(stub.fix).toHaveBeenCalledWith(valid);
    await a.close();
  });

  it('adapter 抛 Error → SSE error 事件带 message，流正常结束（HTTP 200）', async () => {
    const stub = makeAdapter(() => throwAfter([ev('scan', 'running')], new Error('boom')));
    const a = await withApp(stub);
    const res = await a.inject({ method: 'POST', url: '/api/health-check/fix', payload: valid });
    const frames = parseSSE(res.body);
    expect(frames.map((f) => f.event)).toEqual(['progress', 'error']);
    expect(frames[1].data).toEqual({ step: 'done', status: 'error', message: 'boom' });
    await a.close();
  });

  it('抛出非 Error（字符串）→ error 事件 message 为 String(err)', async () => {
    const stub = makeAdapter(() => throwAfter([], 'oops-string'));
    const a = await withApp(stub);
    const res = await a.inject({ method: 'POST', url: '/api/health-check/fix', payload: { issueType: 'orphan', target: 'x.md' } });
    const frames = parseSSE(res.body);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ event: 'error', data: { step: 'done', status: 'error', message: 'oops-string' } });
    await a.close();
  });
});

describe('POST /api/health-check/fix/batch（批量 SSE）', () => {
  const itemBroken = { issueType: 'broken_link', target: { from: 'a.md', to: 'b.md' } };
  const itemOrphan = { issueType: 'orphan', target: 'c.md' };

  it('请求体校验：缺 items / 空数组 / 项非法 → 400', async () => {
    const stub = makeAdapter(() => iterEvents([]));
    const a = await withApp(stub);
    for (const payload of [{}, { items: [] }, { items: 'not-array' }, { items: [{ issueType: 'bad', target: 1 }] }, { items: [null] }] as const) {
      const res = await a.inject({ method: 'POST', url: '/api/health-check/fix/batch', payload: payload as never });
      expect(res.statusCode).toBe(400);
    }
    expect(stub.fix).not.toHaveBeenCalled();
    await a.close();
  });

  it('两项全成功：batch_start/issue_start/进度/issue_done/batch_done，issueKey 缺省按下标生成', async () => {
    const stub = makeAdapter(() => iterEvents([]));
    stub.fix.mockImplementation(({ target }: { target: unknown }) =>
      target === 'c.md'
        ? iterEvents([ev('done', 'done', 'orphan-ok')])
        : iterEvents([ev('scan', 'running'), ev('fixed', 'done'), ev('done', 'done', 'fix-ok')]),
    );
    const a = await withApp(stub);
    const res = await a.inject({
      method: 'POST',
      url: '/api/health-check/fix/batch',
      payload: { items: [itemBroken, itemOrphan] },
    });
    const frames = parseSSE(res.body);
    expect(frames[0]).toEqual({ event: 'batch_start', data: { totalIssues: 2 } });

    const issueStarts = frames.filter((f) => f.event === 'issue_start');
    expect(issueStarts.map((f) => f.data.issueKey)).toEqual(['broken_link:0', 'orphan:1']);
    expect(issueStarts[0].data.message).toBe('开始处理第 1/2 个问题');
    expect(issueStarts[0].data).toMatchObject({ step: 'scan', status: 'running', issueDone: false });

    const doneFrames = frames.filter((f) => f.event === 'issue_done');
    expect(doneFrames).toHaveLength(2);
    expect(doneFrames[0].data).toMatchObject({ issueIndex: 0, totalIssues: 2, issueKey: 'broken_link:0', issueDone: true, message: 'fix-ok' });

    // fixed 步骤包装为 fixed 事件
    expect(frames.filter((f) => f.event === 'fixed').map((f) => f.data.issueIndex)).toEqual([0]);

    const batchDone = frames[frames.length - 1];
    expect(batchDone.event).toBe('batch_done');
    expect(batchDone.data).toMatchObject({ totalIssues: 2, successCount: 2, failCount: 0, status: 'done' });
    expect(batchDone.data.message).toBe('批量修复完成：成功 2/2，失败 0');
    await a.close();
  });

  it('issueKeys 前端传入时优先使用，缺位下标回退自动生成', async () => {
    const stub = makeAdapter(() => iterEvents([ev('done', 'done')]));
    const a = await withApp(stub);
    const res = await a.inject({
      method: 'POST',
      url: '/api/health-check/fix/batch',
      payload: { items: [itemBroken, itemOrphan], issueKeys: ['broken:a->b'] },
    });
    const starts = parseSSE(res.body).filter((f) => f.event === 'issue_start');
    expect(starts.map((f) => f.data.issueKey)).toEqual(['broken:a->b', 'orphan:1']);
    await a.close();
  });

  it('混合结果：成功 1、done-error 1、抛异常 1 → 统计与 issue_error/issue_done 事件', async () => {
    let call = 0;
    const stub = makeAdapter(() => {
      call++;
      if (call === 1) return iterEvents([ev('done', 'done', 'ok')]);
      if (call === 2) return iterEvents([ev('done', 'error', 'failed-by-engine')]);
      return throwAfter([ev('fixing', 'running')], new Error('item-boom'));
    });
    const a = await withApp(stub);
    const res = await a.inject({
      method: 'POST',
      url: '/api/health-check/fix/batch',
      payload: { items: [itemBroken, itemOrphan, itemBroken] },
    });
    const frames = parseSSE(res.body);
    const doneOk = frames.find((f) => f.event === 'issue_done' && f.data.message === 'failed-by-engine');
    expect(doneOk).toBeDefined(); // done 但 status!==done → 计入失败
    const issueErr = frames.find((f) => f.event === 'issue_error');
    expect(issueErr?.data).toMatchObject({ status: 'error', message: 'item-boom', issueIndex: 2, issueDone: true });
    const batchDone = frames[frames.length - 1];
    expect(batchDone.data).toMatchObject({ successCount: 1, failCount: 2 });
    expect(batchDone.data.message).toBe('批量修复完成：成功 1/3，失败 2');
    await a.close();
  });
});

describe('POST /api/health-check/review（时效复核 JSON）', () => {
  it('缺 paths / 空数组 / 非数组 → 400 且不调用 adapter', async () => {
    const stub = makeAdapter(() => iterEvents([]));
    const a = await withApp(stub);
    for (const payload of [{}, { paths: [] }, { paths: 'x.md' }] as const) {
      const res = await a.inject({ method: 'POST', url: '/api/health-check/review', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('paths');
    }
    expect(stub.markReviewed).not.toHaveBeenCalled();
    await a.close();
  });

  it('非字符串项被过滤后传给 adapter；全非字符串 → 400 二次校验', async () => {
    const stub = makeAdapter(() => iterEvents([]));
    const a = await withApp(stub);
    const res = await a.inject({ method: 'POST', url: '/api/health-check/review', payload: { paths: ['x.md', 42, null, 'y.md'] } });
    expect(res.statusCode).toBe(200);
    expect(stub.markReviewed).toHaveBeenCalledWith(['x.md', 'y.md']);
    expect(res.json()).toEqual({ ok: true, paths: ['x.md', 'y.md'], message: 'reviewed 2' });

    const res2 = await a.inject({ method: 'POST', url: '/api/health-check/review', payload: { paths: [1, 2, 3] } });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error).toBe('paths 须为字符串数组');
    await a.close();
  });

  it('adapter 抛错 → 500 + Error message；非 Error → String(err)', async () => {
    const stub = makeAdapter(() => iterEvents([]));
    stub.markReviewed.mockRejectedValueOnce(new Error('vault down'));
    stub.markReviewed.mockRejectedValueOnce('plain-string-err');
    const a = await withApp(stub);
    const r1 = await a.inject({ method: 'POST', url: '/api/health-check/review', payload: { paths: ['a.md'] } });
    expect(r1.statusCode).toBe(500);
    expect(r1.json()).toEqual({ error: 'vault down' });
    const r2 = await a.inject({ method: 'POST', url: '/api/health-check/review', payload: { paths: ['b.md'] } });
    expect(r2.statusCode).toBe(500);
    expect(r2.json()).toEqual({ error: 'plain-string-err' });
    await a.close();
  });
});

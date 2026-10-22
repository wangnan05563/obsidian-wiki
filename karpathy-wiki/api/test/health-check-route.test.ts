// health-check.ts 路由层测试：真实 Fastify 实例 + app.inject()，adapter 用可编程桩注入。
// 为什么可行：registerHealthCheckRoute(app, adapter, guards?, jobsDir?) 的外部依赖都是入参——
//   adapter 直接注入假实现（EngineAdapter 有 healthCheck/healthCheckFix/markKnowledgeReviewed），
//   guards 缺省（createIsolationGuards() 未启用 → 放行），jobsDir 指向临时目录，无需 mock 鉴权链路。
// SSE 断言方式与 test/qq-ingest-routes.test.ts 一致：inject 下 writeHead/write 被缓冲为完整
//   payload，解析 'event:/data:' 帧后逐事件断言。abort 短路分支需要控制 isAborted，
//   见 test/health-check-abort.test.ts（mock utils/sse）。
// T02466 起批量修复改为后台作业：POST 返回 202+jobId，执行与请求解耦，故断言改为
//   「先拿 jobId → 轮询快照到终态 → 再读事件端点」，事件序列与改造前保持一致语义。
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthCheckRoute } from '../src/routes/health-check.js';
import type { EngineAdapter, FixProgressEvent, HealthReport } from '../src/types.js';
// T02836：等待口径统一走公共工具（本文件原先自带 `function waitFor`：10ms 轮询 + 3s 绝对超时）。
// 清点（卡面登记 1 处 = 本文件自带 waitFor，实际 6 个调用点）：终点都可观测（后台作业快照的 status
// 字段 / /current 的 jobId 指向）→ pollUntil 读真实状态，进展签名取 status（状态在变就一直等），
// 预算 NO_TIMER_CHAIN（cap 3000 与旧实现 3000ms 绝对超时同严，不是放松）。
import { NO_TIMER_CHAIN, pollUntil } from './helpers/waitForProgress.js';

const REPORT: HealthReport = {
  orphans: ['a.md'],
  brokenLinks: [{ from: 'b.md', to: 'missing.md' }],
  stale: ['c.md'],
  knowledgeStale: ['d.md'],
};

// ===== 可编程 adapter 桩 =====
// 字段用 Mock<any, any>：具体签名的 mock（如 Mock<[], Promise<HealthReport>>）
// 对 Mock<any[], unknown> 不可赋（mockImplementation 参数逆变），any 双向兼容。
interface AdapterStub {
  adapter: EngineAdapter;
  healthCheck: Mock<any, any>;
  fix: Mock<any, any>;
  markReviewed: Mock<any, any>;
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
  // jobsDir 指向临时目录：批量作业会把快照与耗时统计落盘，测试绝不能写进真实 data 目录
  registerHealthCheckRoute(app, stub.adapter, undefined, tempJobsDir());
  return app;
}

function tempJobsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'batch-fix-route-test-'));
}

// 后台作业的执行与 HTTP 请求解耦，断言前需等它自然收敛。
// T02836：原先本文件自带 `function waitFor`（10ms 轮询 + 3000ms 绝对超时）——判据是「等够就失败」，
// 与链路是否仍在推进无关，且各文件各写一份必然漂移。现统一走 helpers/waitForProgress 的 pollUntil：
// 进展签名取快照里的 status，状态在变就一直等，状态僵住才红；预算 NO_TIMER_CHAIN（cap 3000
// 与旧实现的 3000ms 绝对超时同严，不是放松）。
function readStatus(r: { statusCode: number; json: <T>() => T }): string {
  if (r.statusCode !== 200) return `http:${r.statusCode}`;
  return String((r.json() as { status?: string } | null)?.status ?? 'none');
}

// 返回「读取器」而非 Promise：轮询需要可重复调用的函数（读快照直到终态）
function readSnapshot(a: FastifyInstance, jobId: string) {
  return () => a.inject({ method: 'GET', url: `/api/health-check/fix/batch/${jobId}` });
}

type SnapshotReader = ReturnType<typeof readSnapshot>;

async function untilCompleted(label: string, read: SnapshotReader) {
  const seen = { status: '' };
  const { value } = await pollUntil(
    label,
    read,
    (r) => {
      seen.status = readStatus(r);
      return r.statusCode === 200 && seen.status === 'completed';
    },
    { ...NO_TIMER_CHAIN, progress: () => `status=${seen.status}` },
  );
  return value;
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

describe('POST /api/health-check/fix/batch（T02466：后台作业）', () => {
  const itemBroken = { issueType: 'broken_link', target: { from: 'a.md', to: 'b.md' } };
  const itemOrphan = { issueType: 'orphan', target: 'c.md' };

  it('请求体校验：缺 items / 空数组 / 项非法 → 400 且不调用 adapter', async () => {
    const stub = makeAdapter(() => iterEvents([]));
    const a = await withApp(stub);
    for (const payload of [{}, { items: [] }, { items: 'not-array' }, { items: [{ issueType: 'bad', target: 1 }] }, { items: [null] }] as const) {
      const res = await a.inject({ method: 'POST', url: '/api/health-check/fix/batch', payload: payload as never });
      expect(res.statusCode).toBe(400);
    }
    expect(stub.fix).not.toHaveBeenCalled();
    await a.close();
  });

  it('POST 立即返回 202 + jobId + 估算，不再绑定本次请求（响应不再是 SSE）', async () => {
    const stub = makeAdapter(() => iterEvents([ev('done', 'done', 'ok')]));
    const a = await withApp(stub);
    const res = await a.inject({
      method: 'POST',
      url: '/api/health-check/fix/batch',
      payload: { items: [itemBroken, itemOrphan] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.headers['content-type']).not.toContain('text/event-stream');
    const body = res.json() as { jobId: string; total: number; status: string; estimate: Record<string, unknown> };
    expect(typeof body.jobId).toBe('string');
    expect(body.total).toBe(2);
    expect(body.status).toBe('running');
    // 估算：无实测样本时显式标 basis=default，并给出 LLM 调用次数
    expect(body.estimate).toMatchObject({ count: 2, llmCalls: 2, basis: 'default' });
    await a.close();
  });

  it('作业后台跑完：快照给出成功/失败/已完成 key，且响应裁掉 items 大数组', async () => {
    const stub = makeAdapter(({ target }: { target: unknown }) =>
      target === 'c.md'
        ? iterEvents([ev('done', 'done', 'orphan-ok')])
        : iterEvents([ev('scan', 'running'), ev('fixed', 'done'), ev('done', 'done', 'fix-ok')]),
    );
    const a = await withApp(stub);
    const started = await a.inject({
      method: 'POST',
      url: '/api/health-check/fix/batch',
      payload: { items: [itemBroken, itemOrphan], issueKeys: ['broken:a.md->b.md'] },
    });
    const jobId = (started.json() as { jobId: string }).jobId;
    const snap = await untilCompleted('批量作业快照进入 completed 终态', readSnapshot(a, jobId));
    const snapshot = snap.json() as Record<string, unknown>;
    expect(snapshot).toMatchObject({ jobId, status: 'completed', total: 2, doneCount: 2, successCount: 2, failCount: 0, nextIndex: 2 });
    // issueKeys：前端传入优先，缺位按下标回退
    expect(snapshot.doneKeys).toEqual(['broken:a.md->b.md', 'orphan:1']);
    // 瘦身：剩余项由作业自身持有，不随快照/轮询来回搬
    expect(snapshot.items).toBeUndefined();
    await a.close();
  });

  it('事件端点回放完整事件序列（batch_start→issue_start→fixed→issue_done→batch_done）', async () => {
    const stub = makeAdapter(() => iterEvents([ev('scan', 'running'), ev('fixed', 'done'), ev('done', 'done', 'ok')]));
    const a = await withApp(stub);
    const started = await a.inject({
      method: 'POST',
      url: '/api/health-check/fix/batch',
      payload: { items: [itemBroken] },
    });
    const jobId = (started.json() as { jobId: string }).jobId;
    await untilCompleted('批量作业快照进入 completed 终态', readSnapshot(a, jobId));
    const events = await a.inject({ method: 'GET', url: `/api/health-check/fix/batch/${jobId}/events` });
    const frames = parseSSE(events.body);
    expect(frames.map((f) => f.event)).toEqual(['batch_start', 'issue_start', 'progress', 'fixed', 'issue_done', 'batch_done']);
    expect(frames[0].data).toEqual({ jobId, totalIssues: 1 });
    expect(frames[1].data).toMatchObject({ issueKey: 'broken_link:0', issueIndex: 0, totalIssues: 1 });
    expect(frames[5].data).toMatchObject({ successCount: 1, failCount: 0, message: '批量修复完成：成功 1/1，失败 0' });
    await a.close();
  });

  it('fromSeq 续传：只回放该序号之后的事件（重连不重复计数）', async () => {
    const stub = makeAdapter(() => iterEvents([ev('done', 'done', 'ok')]));
    const a = await withApp(stub);
    const started = await a.inject({ method: 'POST', url: '/api/health-check/fix/batch', payload: { items: [itemBroken] } });
    const jobId = (started.json() as { jobId: string }).jobId;
    await untilCompleted('批量作业快照进入 completed 终态', readSnapshot(a, jobId));
    // 事件序号：batch_start=1、issue_start=2、issue_done=3、batch_done=4
    // fromSeq=3 → 只回放 seq>=3，客户端已收到的前两条不再重复推送
    const res = await a.inject({ method: 'GET', url: `/api/health-check/fix/batch/${jobId}/events?fromSeq=3` });
    expect(parseSSE(res.body).map((f) => f.event)).toEqual(['issue_done', 'batch_done']);
    const res2 = await a.inject({ method: 'GET', url: `/api/health-check/fix/batch/${jobId}/events?fromSeq=2` });
    expect(parseSSE(res2.body).map((f) => f.event)).toEqual(['issue_start', 'issue_done', 'batch_done']);
    await a.close();
  });

  it('订阅端断开不杀作业：事件流提前结束后，作业仍把每一项跑完', async () => {
    const stub = makeAdapter(() => iterEvents([ev('done', 'done', 'ok')]));
    const a = await withApp(stub);
    const started = await a.inject({
      method: 'POST',
      url: '/api/health-check/fix/batch',
      payload: { items: [itemBroken, itemOrphan, itemBroken] },
    });
    const jobId = (started.json() as { jobId: string }).jobId;
    // inject 的 GET 在响应结束时即「断开」，等价于关页/刷新
    await a.inject({ method: 'GET', url: `/api/health-check/fix/batch/${jobId}/events` });
    await untilCompleted('批量作业快照进入 completed 终态', readSnapshot(a, jobId));
    expect(stub.fix).toHaveBeenCalledTimes(3);
    await a.close();
  });

  it('混合结果：done-error 与抛异常都计入失败，失败清单带 issueKey', async () => {
    let call = 0;
    const stub = makeAdapter(() => {
      call++;
      if (call === 1) return iterEvents([ev('done', 'done', 'ok')]);
      if (call === 2) return iterEvents([ev('done', 'error', 'failed-by-engine')]);
      return throwAfter([ev('fixing', 'running')], new Error('item-boom'));
    });
    const a = await withApp(stub);
    const started = await a.inject({
      method: 'POST',
      url: '/api/health-check/fix/batch',
      payload: { items: [itemBroken, itemOrphan, itemBroken] },
    });
    const jobId = (started.json() as { jobId: string }).jobId;
    const snap = await untilCompleted('混合结果作业进入 completed 终态', readSnapshot(a, jobId));
    const snapshot = snap.json() as { successCount: number; failCount: number; doneKeys: string[]; failed: Array<{ issueKey: string; message: string }> };
    expect(snapshot).toMatchObject({ successCount: 1, failCount: 2 });
    expect(snapshot.doneKeys).toEqual(['broken_link:0']);
    expect(snapshot.failed.map((f) => f.message)).toEqual(['failed-by-engine', 'item-boom']);
    await a.close();
  });

  it('GET /current 返回最近一次作业快照（无作业时为 null）', async () => {
    const stub = makeAdapter(() => iterEvents([ev('done', 'done', 'ok')]));
    const a = await withApp(stub);
    expect((await a.inject({ method: 'GET', url: '/api/health-check/fix/batch/current' })).json()).toBeNull();
    const started = await a.inject({ method: 'POST', url: '/api/health-check/fix/batch', payload: { items: [itemOrphan] } });
    const jobId = (started.json() as { jobId: string }).jobId;
    const readCurrent = () => a.inject({ method: 'GET', url: '/api/health-check/fix/batch/current' });
    // 终点可观测（/current 里的 jobId 就是本次作业）→ 轮询真实状态；无固定时长、无本地 waitFor
    const { value: current } = await pollUntil(
      '/current 指向本次作业',
      readCurrent,
      (r) => (r.json() as { jobId?: string }).jobId === jobId,
      NO_TIMER_CHAIN,
    );
    expect((current.json() as { total: number }).total).toBe(1);
    await a.close();
  });

  it('GET /estimate：count 非法 → 400；超上限按 5000 收敛', async () => {
    const stub = makeAdapter(() => iterEvents([]));
    const a = await withApp(stub);
    for (const q of ['', 'abc', '0', '-3']) {
      expect((await a.inject({ method: 'GET', url: `/api/health-check/fix/batch/estimate?count=${q}` })).statusCode).toBe(400);
    }
    const res = await a.inject({ method: 'GET', url: '/api/health-check/fix/batch/estimate?count=99999' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { count: number }).count).toBe(5000);
    await a.close();
  });

  it('控制端点：缺 jobId → 400，未知 jobId → 404', async () => {
    const stub = makeAdapter(() => iterEvents([]));
    const a = await withApp(stub);
    for (const action of ['pause', 'resume', 'cancel']) {
      expect((await a.inject({ method: 'POST', url: `/api/health-check/fix/batch/${action}`, payload: {} })).statusCode).toBe(400);
      expect((await a.inject({ method: 'POST', url: `/api/health-check/fix/batch/${action}`, payload: { jobId: 'nope' } })).statusCode).toBe(404);
    }
    expect((await a.inject({ method: 'GET', url: '/api/health-check/fix/batch/nope' })).statusCode).toBe(404);
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

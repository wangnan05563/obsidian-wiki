import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EngineAdapter, FixInput, FixProgressEvent } from '../types.js';
import { BatchFixJobManager, type BatchFixItem, type BatchFixSnapshot } from './batch-fix-job.js';

// T02466（PRD R-F2 / H2）批量修复作业管理器单测：
// 覆盖「逐项落盘可恢复 / 暂停后只跑剩余项 / 取消保留已完成 / 估算基于真实样本」四条核心语义。

function fakeAdapter(behaviour: (input: FixInput) => FixProgressEvent[]): EngineAdapter {
  return {
    healthCheckFix: async function* (input: FixInput): AsyncIterable<FixProgressEvent> {
      for (const ev of behaviour(input)) yield ev;
    },
  } as unknown as EngineAdapter;
}

// 带耗时的假 adapter：让批量循环慢到足以在中途下达暂停/取消指令
function slowAdapter(sink: string[], ms = 30): EngineAdapter {
  return {
    healthCheckFix: async function* (input: FixInput): AsyncIterable<FixProgressEvent> {
      await new Promise((r) => setTimeout(r, ms));
      sink.push(String(input.target));
      yield { step: 'done', status: 'done', message: 'ok' };
    },
  } as unknown as EngineAdapter;
}

function itemsOf(paths: string[]): BatchFixItem[] {
  return paths.map((p) => ({ issueKey: `orphan:${p}`, input: { issueType: 'orphan' as const, target: p } }));
}

// 作业状态推进靠真实落盘驱动，等待预算必须按「FS 延迟」而不是「逻辑耗时」标定。
// 3000ms 是历史值，本机空载时就只剩几百 ms 余量，一旦有并发（跑第二条 vitest、build）同一条
// 用例会从 3.3s 涨到 12.7s，直接抛「waitFor 超时：作业未达预期状态」——这是 T02478 全量里
// 那两条红色的真因，与被测逻辑无关。放宽到 30s，并把最后快照打进错误信息，避免下次又靠猜。
async function waitFor(
  fn: () => Promise<BatchFixSnapshot | null>,
  predicate: (s: BatchFixSnapshot) => boolean,
  timeoutMs = 30_000,
): Promise<BatchFixSnapshot> {
  const started = Date.now();
  let last: BatchFixSnapshot | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 20));
  }
  const digest = last
    ? JSON.stringify({ status: last.status, nextIndex: last.nextIndex, doneCount: last.doneCount })
    : 'null';
  throw new Error(`waitFor 超时（${timeoutMs}ms）：作业未达预期状态，最后快照=${digest}`);
}

// 本文件每条用例都要 mkdtemp + 真实落盘 + rm 清场，耗时由 FS 延迟主导，不是逻辑慢。
// 2026-10-20 T02478 实测：空载单跑 8 条用例 1.1~13.2s；与另一条 vitest 并发时同一条「跑完全部问题」
// 从 3.3s 涨到 12.7s。默认 testTimeout 5000ms 下多条贴顶，全量并发必然假失败。
// 取 waitFor 预算（30s）+ FS 清场余量设整文件超时，只影响本文件，不动全局 testTimeout
// （放宽全局会掩盖真实的慢）。
const FS_HEAVY_TIMEOUT_MS = 60_000;

describe('BatchFixJobManager', { timeout: FS_HEAVY_TIMEOUT_MS }, () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-fix-test-'));
  });

  afterEach(async () => {
    // Windows 下 rm 会撞上一个刚 rename 完、句柄尚未释放的文件（ENOTEMPTY）——
    // 与生产无关，属测试清场竞态，重试即可。
    let lastErr: unknown;
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw lastErr;
  });

  it('跑完全部问题后落 completed，doneKeys 与快照文件一致', async () => {
    const manager = new BatchFixJobManager(dir, fakeAdapter(() => [{ step: 'done', status: 'done', message: '已补回链' }]));
    const started = await manager.start(itemsOf(['a.md', 'b.md', 'c.md']));
    expect(started.status).toBe('running');
    expect(started.total).toBe(3);

    const done = await waitFor(() => manager.getSnapshot(started.jobId), (s) => s.status === 'completed');
    await manager.flush(); // 内存终态早于磁盘可见，读文件前必须收口落盘队列
    expect(done.doneCount).toBe(3);
    expect(done.successCount).toBe(3);
    expect(done.failCount).toBe(0);
    expect(done.doneKeys).toEqual(['orphan:a.md', 'orphan:b.md', 'orphan:c.md']);

    // 落盘验证：重启后（新实例）仍能读到同一快照
    const reopened = new BatchFixJobManager(dir, fakeAdapter(() => []));
    const restored = await reopened.getSnapshot(started.jobId);
    expect(restored?.status).toBe('completed');
    expect(restored?.nextIndex).toBe(3);
  });

  it('暂停只停在当前项之后，继续只跑剩余项', async () => {
    const calls: string[] = [];
    const manager = new BatchFixJobManager(dir, slowAdapter(calls));
    const started = await manager.start(itemsOf(['a.md', 'b.md', 'c.md', 'd.md']));

    // 第一项跑完即请求暂停：循环在下一轮迭代开头退出
    await waitFor(() => manager.getSnapshot(started.jobId), (s) => s.doneCount >= 1);
    await manager.pause(started.jobId);
    const paused = await waitFor(() => manager.getSnapshot(started.jobId), (s) => s.status === 'paused');
    const processedAtPause = paused.doneCount;
    expect(processedAtPause).toBeLessThan(4);
    expect(paused.nextIndex).toBe(processedAtPause);

    await new Promise((r) => setTimeout(r, 120));
    expect(calls.length).toBe(processedAtPause); // 暂停后不再产生新的 LLM 调用

    const resumed = await manager.resume(started.jobId);
    expect(resumed?.status).toBe('running');
    const done = await waitFor(() => manager.getSnapshot(started.jobId), (s) => s.status === 'completed');
    expect(done.doneCount).toBe(4);
    expect(done.doneKeys).toEqual(['orphan:a.md', 'orphan:b.md', 'orphan:c.md', 'orphan:d.md']);
    // 续跑从暂停位置继续，顺序与全集一致（没有重跑已完成项）
    expect(calls).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
  });

  it('取消保留已完成项，且已完成项不会被重跑', async () => {
    const calls: string[] = [];
    const manager = new BatchFixJobManager(dir, slowAdapter(calls));
    const started = await manager.start(itemsOf(['a.md', 'b.md', 'c.md']));
    await waitFor(() => manager.getSnapshot(started.jobId), (s) => s.doneCount >= 1);
    await manager.cancel(started.jobId);
    const canceled = await waitFor(() => manager.getSnapshot(started.jobId), (s) => s.status === 'canceled');
    const kept = [...canceled.doneKeys];
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.length).toBeLessThan(3);

    calls.length = 0;
    await manager.resume(started.jobId);
    const done = await waitFor(() => manager.getSnapshot(started.jobId), (s) => s.status === 'completed');
    expect(done.doneKeys.length).toBe(3);
    // 续跑只处理未完成项
    expect(calls.every((c) => !kept.includes(`orphan:${c}`))).toBe(true);
  });

  // T02922 口径：失败项也消耗了真实 LLM 时间，必须计入耗时样本（不排除），
  // 否则估算只看到成功项、越跑越乐观。此处锁「进 failed 清单」与「进样本」两件事。
  it('失败项计入 failed 清单，同时仍计入耗时样本（T02922 口径）', async () => {
    const manager = new BatchFixJobManager(dir, fakeAdapter((input) =>
      String(input.target) === 'bad.md'
        ? [{ step: 'done', status: 'error', message: '模型返回异常' }]
        : [{ step: 'done', status: 'done', message: 'ok' }],
    ));
    const started = await manager.start(itemsOf(['ok.md', 'bad.md']));
    const done = await waitFor(() => manager.getSnapshot(started.jobId), (s) => s.status === 'completed');
    expect(done.successCount).toBe(1);
    expect(done.failCount).toBe(1);
    expect(done.failed).toEqual([{ issueKey: 'orphan:bad.md', message: '模型返回异常' }]);
    expect(done.doneKeys).toEqual(['orphan:ok.md']);
    await manager.flush();
    const stats = JSON.parse(await fs.readFile(path.join(dir, 'stats.json'), 'utf8')) as { samples: number };
    expect(stats.samples).toBe(2);
  });

  it('估算：无历史样本时用标定兜底值并标注 basis=default，1~4 样本为 measured-low', async () => {
    const manager = new BatchFixJobManager(dir, fakeAdapter(() => [{ step: 'done', status: 'done', message: 'ok' }]));
    const cold = await manager.estimate(10);
    expect(cold.basis).toBe('default');
    // T02924：llmCalls 按 step 计（10 × 5.7 = 57），不再写死 1 项 1 次
    expect(cold.avgStepsPerIssue).toBe(5.7);
    expect(cold.llmCalls).toBe(57);
    expect(cold.avgMsPerIssue).toBe(115_000);
    expect(cold.estimatedMs).toBe(cold.avgMsPerIssue * 10);
    expect(cold.estimatedMinMs).toBe(575_000);
    expect(cold.estimatedMaxMs).toBe(1_725_000);

    await manager.recordDuration(10_000);
    await manager.recordDuration(30_000);
    const warm = await manager.estimate(2);
    expect(warm.basis).toBe('measured-low');
    expect(warm.samples).toBe(2);
    expect(warm.avgMsPerIssue).toBe(20_000);
    // ±1σ：样本 10s/30s → σ=10s，区间 20s~60s（count=2）
    expect(warm.estimatedMinMs).toBe(20_000);
    expect(warm.estimatedMaxMs).toBe(60_000);
    expect(warm.estimatedMinutes).toBe(1);
  });

  it('进程重启后把遗留的 running 快照归一为 paused，交回用户决定', async () => {
    const first = new BatchFixJobManager(dir, fakeAdapter(() => [{ step: 'done', status: 'done', message: 'ok' }]));
    const started = await first.start(itemsOf(['a.md']));
    // 先等后台作业真正落终态，再改写磁盘快照，避免与收尾落盘竞争
    await waitFor(() => first.getSnapshot(started.jobId), (s) => s.status === 'completed');
    await first.flush();
    const file = path.join(dir, `${started.jobId}.json`);
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as BatchFixSnapshot;
    raw.status = 'running';
    raw.nextIndex = 0;
    raw.doneCount = 0;
    raw.doneKeys = [];
    await fs.writeFile(file, JSON.stringify(raw), 'utf8');

    const reopened = new BatchFixJobManager(dir, fakeAdapter(() => [{ step: 'done', status: 'done', message: 'ok' }]));
    const snap = await reopened.getSnapshot(started.jobId);
    expect(snap?.status).toBe('paused');
    expect(snap?.pauseRequested).toBe(false);
  });

  // T02478（P0 H2 断线恢复链）回归发现的缺陷守护：
  // 快照原先就地截断重写，读侧（重启恢复 / 页面重进）有概率拿到半截 JSON → parse 抛错被
  // catch 吞成「快照不存在」，可恢复的作业被判成丢历史。改为「临时文件 + rename」原子落盘后，
  // 读侧只会看到上一份或下一份完整快照。
  it('落盘原子性：作业进行中反复直读快照文件，永不出现半截 JSON', async () => {
    const paths = Array.from({ length: 16 }, (_, i) => `p${i}.md`);
    const manager = new BatchFixJobManager(dir, slowAdapter([], 8));
    const started = await manager.start(itemsOf(paths));
    const file = path.join(dir, `${started.jobId}.json`);

    // 采样窗口按「次数」而不是墙钟时长驱动：本机临时目录上一次读盘约 0.4s、每项原子落盘（.tmp +
    // rename）同量级，16 项作业实际要跑 8~13s，采样会自然覆盖整段写入期。早期版本写死 4000ms 轮询
    // 窗口 + 默认 5000ms 用例超时，只剩 1s 余量，全量并发时被 IO 排队一顶就假失败
    // （T02478 实测：空载单跑 5.4s、并发跑 >5s 直接红）。
    let parsed = 0;
    let partial = 0;
    for (let i = 0; i < 40; i++) {
      try {
        const raw = await fs.readFile(file, 'utf8');
        JSON.parse(raw) as BatchFixSnapshot;
        parsed++;
      } catch (err) {
        // 首帧还没落盘（ENOENT）属正常；JSON 语法错误（半截文件）即回归
        const name = (err as { code?: string; name?: string }) ?? {};
        if (name.code === 'ENOENT') continue;
        if (name.name !== 'SyntaxError') throw err;
        partial++;
      }
      if (manager.get(started.jobId)?.status !== 'running') break;
    }
    expect(partial).toBe(0);
    expect(parsed).toBeGreaterThan(0);
    // 收口前等作业真正落终态：残留的 rename 会和 afterEach 的 rm 抢目录（ENOTEMPTY 假失败）
    await waitFor(() => manager.getSnapshot(started.jobId), (s) => s.status !== 'running', 15_000);
    await manager.flush();
  });

  // 耗时样本同样走原子落盘：读到半截 stats.json 会被 catch 归零，ETA 莫名退回兜底值
  it('耗时统计连续写入不丢样本、读取恒为完整 JSON', async () => {
    const manager = new BatchFixJobManager(dir, fakeAdapter(() => [{ step: 'done', status: 'done', message: 'ok' }]));
    await Promise.all([1000, 2000, 3000, 4000].map((ms) => manager.recordDuration(ms)));
    await manager.flush();
    const statsFile = path.join(dir, 'stats.json');
    const stats = JSON.parse(await fs.readFile(statsFile, 'utf8')) as { samples: number; totalMs: number; avgMs: number };
    expect(stats.samples).toBe(4);
    expect(stats.totalMs).toBe(10_000);
    expect(stats.avgMs).toBe(2500);
  });
});

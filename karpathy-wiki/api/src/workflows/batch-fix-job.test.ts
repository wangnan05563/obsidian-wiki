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

async function waitFor(
  fn: () => Promise<BatchFixSnapshot | null>,
  predicate: (s: BatchFixSnapshot) => boolean,
  timeoutMs = 3000,
): Promise<BatchFixSnapshot> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snap = await fn();
    if (snap && predicate(snap)) return snap;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor 超时：作业未达预期状态');
}

describe('BatchFixJobManager', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-fix-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('跑完全部问题后落 completed，doneKeys 与快照文件一致', async () => {
    const manager = new BatchFixJobManager(dir, fakeAdapter(() => [{ step: 'done', status: 'done', message: '已补回链' }]));
    const started = await manager.start(itemsOf(['a.md', 'b.md', 'c.md']));
    expect(started.status).toBe('running');
    expect(started.total).toBe(3);

    const done = await waitFor(() => manager.getSnapshot(started.jobId), (s) => s.status === 'completed');
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

  it('失败项计入 failed 清单且不污染耗时样本', async () => {
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
  });

  it('估算：无历史样本时用兜底均值并标注 basis=default，有样本后按实测均值', async () => {
    const manager = new BatchFixJobManager(dir, fakeAdapter(() => [{ step: 'done', status: 'done', message: 'ok' }]));
    const cold = await manager.estimate(10);
    expect(cold.basis).toBe('default');
    expect(cold.llmCalls).toBe(10);
    expect(cold.estimatedMs).toBe(cold.avgMsPerIssue * 10);

    await manager.recordDuration(10_000);
    await manager.recordDuration(30_000);
    const warm = await manager.estimate(2);
    expect(warm.basis).toBe('measured');
    expect(warm.samples).toBe(2);
    expect(warm.avgMsPerIssue).toBe(20_000);
    expect(warm.estimatedMinutes).toBe(1);
  });

  it('进程重启后把遗留的 running 快照归一为 paused，交回用户决定', async () => {
    const first = new BatchFixJobManager(dir, fakeAdapter(() => [{ step: 'done', status: 'done', message: 'ok' }]));
    const started = await first.start(itemsOf(['a.md']));
    // 先等后台作业真正落终态，再改写磁盘快照，避免与收尾落盘竞争
    await waitFor(() => first.getSnapshot(started.jobId), (s) => s.status === 'completed');
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
});

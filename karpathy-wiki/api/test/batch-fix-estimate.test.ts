// T02924：批量修复启动前估算口径守护。
// ------------------------------------------------------------------
// 背景（T02605 真实 LLM 实测）：旧估算把 llmCalls 写成「项数」，3 项实际产生 17 个 harness step
// （5.7 次/项，低估 5.7 倍）；兜底耗时 45s/项 对实测 115s/项 低估 2.6 倍。
// 本文件锁四件事：
//   A 无样本：basis=default，默认值来自实测标定，区间 ±50%（不是单点假精确）
//   B 1~4 样本：basis=measured-low（页面标「仅供参考」）；≥5 转 measured
//   C step/token 只按「带 usage 的样本」求均值，旧样本（只有耗时）不拉低分母
//   D 失败/未消解项只要 LLM 流程跑过就计入样本（与 T02922 裁决一致），并累计 usage
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BatchFixJobManager, type BatchFixItem, type BatchFixSnapshot } from '../src/workflows/batch-fix-job.js';
import type { EngineAdapter, FixInput, FixProgressEvent } from '../src/types.js';
import { NO_TIMER_CHAIN, pollUntil } from './helpers/waitForProgress.js';

function manager(dir: string, adapter: EngineAdapter = emptyAdapter()): BatchFixJobManager {
  return new BatchFixJobManager(dir, adapter);
}

function emptyAdapter(): EngineAdapter {
  return {
    healthCheckFix: async function* (): AsyncIterable<FixProgressEvent> {},
  } as unknown as EngineAdapter;
}

function itemsOf(paths: string[]): BatchFixItem[] {
  return paths.map((p) => ({ issueKey: `orphan:${p}`, input: { issueType: 'orphan' as const, target: p } }));
}

async function waitTerminal(mgr: BatchFixJobManager, jobId: string): Promise<BatchFixSnapshot> {
  const snap = await mgr.getSnapshot(jobId);
  if (snap?.status === 'completed') return snap;
  const { value } = await pollUntil(
    'T02924 批量作业进入 completed',
    () => mgr.getSnapshot(jobId),
    (s) => s?.status === 'completed',
    { ...NO_TIMER_CHAIN, capMs: 20_000 },
  );
  if (!value) throw new Error('作业快照丢失');
  return value;
}

describe('T02924 估算口径', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 't02924-estimate-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('无样本：default + 实测标定默认值（5.7 次/项、115s/项、1.72 万 tokens/项），区间 ±50%', async () => {
    const est = await manager(dir).estimate(3);
    expect(est.basis).toBe('default');
    expect(est.samples).toBe(0);
    expect(est.avgStepsPerIssue).toBe(5.7);
    // 3 × 5.7 = 17.1 → 17，与 T02605 实测 3 项 17 步同量级
    expect(est.llmCalls).toBe(17);
    expect(est.avgMsPerIssue).toBe(115_000);
    expect(est.avgTokensPerIssue).toBe(17_200);
    expect(est.tokens).toBe(51_600);
    expect(est.estimatedMs).toBe(345_000);
    expect(est.estimatedMinutes).toBe(6);
    expect(est.estimatedMinMs).toBe(172_500);
    expect(est.estimatedMaxMs).toBe(517_500);
  });

  it('单样本：measured-low + ±50% 区间；2~4 样本改按 ±1σ，仍为 measured-low', async () => {
    const mgr = manager(dir);
    await mgr.recordDuration(100_000, { steps: 4, tokens: 20_000 });
    const one = await mgr.estimate(3);
    expect(one.basis).toBe('measured-low');
    expect(one.avgStepsPerIssue).toBe(4);
    expect(one.llmCalls).toBe(12);
    expect(one.tokens).toBe(60_000);
    expect(one.estimatedMinMs).toBe(150_000);
    expect(one.estimatedMaxMs).toBe(450_000);

    await mgr.recordDuration(30_000);
    const two = await mgr.estimate(2);
    expect(two.basis).toBe('measured-low');
    expect(two.samples).toBe(2);
    expect(two.avgMsPerIssue).toBe(65_000);
    // 总体标准差：样本 100s/30s → 均值 65s、σ=35s；count=2 → 60s ~ 200s
    expect(two.estimatedMinMs).toBe(60_000);
    expect(two.estimatedMaxMs).toBe(200_000);
    // step 均值不会被无 usage 的旧样本拉低（分母只算带 usage 的 1 个样本）
    expect(two.avgStepsPerIssue).toBe(4);
  });

  it('样本 ≥5：basis 切到 measured', async () => {
    const mgr = manager(dir);
    for (const ms of [10_000, 20_000, 30_000, 40_000, 50_000]) await mgr.recordDuration(ms);
    const est = await mgr.estimate(1);
    expect(est.samples).toBe(5);
    expect(est.basis).toBe('measured');
    expect(est.avgMsPerIssue).toBe(30_000);
  });

  it('旧格式 stats.json（无 sumSqMs/step 字段）：沿用样本数与均值，新维度回落标定默认值、区间 ±50%', async () => {
    await fs.writeFile(path.join(dir, 'stats.json'), JSON.stringify({ samples: 2, totalMs: 40_000, avgMs: 20_000 }), 'utf8');
    const est = await manager(dir).estimate(2);
    expect(est.basis).toBe('measured-low');
    expect(est.avgMsPerIssue).toBe(20_000);
    expect(est.avgStepsPerIssue).toBe(5.7);
    // 旧样本没有二阶矩 → 不报宽度为 0 的假精确区间
    expect(est.estimatedMinMs).toBe(20_000);
    expect(est.estimatedMaxMs).toBe(60_000);
  });

  it('失败 / 未消解项只要跑过 LLM 流程就计入样本，usage 一并累计', async () => {
    const usage = (steps: number, tokens: number) => ({ harnessSteps: steps, tokens });
    const adapter = {
      healthCheckFix: async function* (input: FixInput): AsyncIterable<FixProgressEvent> {
        const target = String(input.target);
        if (target === 'bad.md') {
          yield { step: 'done', status: 'error', message: '模型返回异常', data: usage(5, 9_000) };
          return;
        }
        yield { step: 'done', status: 'done', message: 'ok', data: usage(3, 6_000) };
      },
      // 未消解项：流程成功但复检说问题还在
      recheckIssueResolved: async (input: FixInput) => String(input.target) !== 'ineffective.md',
    } as unknown as EngineAdapter;

    const mgr = manager(dir, adapter);
    const started = await mgr.start(itemsOf(['ok.md', 'bad.md', 'ineffective.md']));
    const snap = await waitTerminal(mgr, started.jobId);
    expect(snap.successCount).toBe(1);
    expect(snap.failCount).toBe(1);
    expect(snap.ineffectiveCount).toBe(1);
    await mgr.flush();

    const stats = JSON.parse(await fs.readFile(path.join(dir, 'stats.json'), 'utf8')) as {
      samples: number;
      totalSteps: number;
      stepSamples: number;
      totalTokens: number;
      tokenSamples: number;
    };
    // 三项都消耗了真实 LLM 往返：失败与未消解不得被排除
    expect(stats.samples).toBe(3);
    expect(stats.stepSamples).toBe(3);
    expect(stats.totalSteps).toBe(11);
    expect(stats.tokenSamples).toBe(3);
    expect(stats.totalTokens).toBe(21_000);
    // 快照里的 step 均值同步刷新，供作业面板显示
    expect(snap.avgStepsPerIssue).toBe(3.7);
  });
});

// T02922：前端作业面板口径守护——「已处理」与「已消解」不得混为一谈。
// 背景：后端把流程成功与复检消解拆成 successCount/ineffectiveCount 两套字段后，
// 前端镜像若仍只看 issue_done，就会把「未消解」当成功高亮，问题在列表里明明还在。
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useHealthStore } from '../src/stores/health';
import type { BatchFixJobSnapshot } from '../src/types';

function snapshot(overrides: Partial<BatchFixJobSnapshot> = {}): BatchFixJobSnapshot {
  return {
    jobId: 'job-1',
    status: 'completed',
    total: 2,
    doneCount: 2,
    successCount: 1,
    failCount: 0,
    ineffectiveCount: 1,
    ineffective: [{ issueKey: 'orphan:b.md', message: '流程完成但问题未消解' }],
    currentIssueKey: '',
    pauseRequested: false,
    startedAt: 0,
    updatedAt: 0,
    elapsedMs: 1000,
    avgMsPerIssue: 500,
    avgStepsPerIssue: 5.7,
    doneKeys: ['orphan:a.md'],
    failed: [],
    nextIndex: 2,
    ...overrides,
  };
}

describe('health store · T02922 已消解 / 未消解分列', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('issue_ineffective：计入未消解、不进 doneKeys、不增 successCount', () => {
    const store = useHealthStore();
    store.handleBatchEvent('batch_start', { jobId: 'job-1', totalIssues: 2 });
    store.handleBatchEvent('issue_start', {
      issueKey: 'orphan:a.md',
      issueIndex: 0,
      totalIssues: 2,
    });
    store.handleBatchEvent('issue_ineffective', {
      issueKey: 'orphan:a.md',
      issueIndex: 0,
      totalIssues: 2,
      issueDone: true,
      status: 'done',
      message: '流程完成但问题未消解',
    });

    expect(store.job?.ineffectiveCount).toBe(1);
    expect(store.job?.successCount).toBe(0);
    expect(store.job?.doneCount).toBe(1);
    expect(store.batchDoneKeys.has('orphan:a.md')).toBe(false);
    expect(store.batchIneffective.map((f) => f.issueKey)).toEqual(['orphan:a.md']);
    expect(store.batchIneffectiveCount).toBe(1);
  });

  it('issue_done 只记已消解；failed / ineffective 走各自清单，互不串味', () => {
    const store = useHealthStore();
    store.handleBatchEvent('batch_start', { jobId: 'job-1', totalIssues: 3 });
    store.handleBatchEvent('issue_done', {
      issueKey: 'orphan:ok.md',
      issueIndex: 0,
      totalIssues: 3,
      issueDone: true,
      status: 'done',
      message: '已修复',
    });
    store.handleBatchEvent('issue_ineffective', {
      issueKey: 'orphan:still.md',
      issueIndex: 1,
      totalIssues: 3,
      issueDone: true,
      status: 'done',
      message: '流程完成但问题未消解',
    });
    store.handleBatchEvent('issue_error', {
      issueKey: 'broken:a.md->b.md',
      issueIndex: 2,
      totalIssues: 3,
      issueDone: true,
      status: 'error',
      message: '修复失败',
    });

    expect(store.batchDoneKeys.has('orphan:ok.md')).toBe(true);
    expect(store.batchDoneKeys.has('orphan:still.md')).toBe(false);
    expect(store.batchIneffective.map((f) => f.issueKey)).toEqual(['orphan:still.md']);
    expect(store.batchFailed.map((f) => f.issueKey)).toEqual(['broken:a.md->b.md']);
    expect(store.job).toMatchObject({ successCount: 1, ineffectiveCount: 1, failCount: 1, doneCount: 3 });
  });

  it('applySnapshot 用服务端快照校准：未消解清单与失败清单分别回填', () => {
    const store = useHealthStore();
    store.applySnapshot(snapshot());

    expect(store.batchDoneKeys.has('orphan:a.md')).toBe(true);
    expect(store.batchIneffective).toEqual([
      { issueKey: 'orphan:b.md', message: '流程完成但问题未消解' },
    ]);
    expect(store.batchFailed).toEqual([]);
    expect(store.batchIneffectiveCount).toBe(1);
  });

  it('旧快照缺字段时按空兜底（升级前落盘的作业仍可恢复）', () => {
    const store = useHealthStore();
    const legacy = snapshot() as Partial<BatchFixJobSnapshot>;
    delete legacy.ineffectiveCount;
    delete legacy.ineffective;
    store.applySnapshot(legacy as BatchFixJobSnapshot);
    expect(store.batchIneffective).toEqual([]);
    expect(store.batchIneffectiveCount).toBe(0);
  });

  it('batch_start 重置未消解镜像（不把上一批结局带进新作业）', () => {
    const store = useHealthStore();
    store.applySnapshot(snapshot());
    store.handleBatchEvent('batch_start', { jobId: 'job-2', totalIssues: 1 });
    expect(store.batchIneffective).toEqual([]);
    expect(store.job?.ineffectiveCount).toBe(0);
    expect(store.batchDoneKeys.size).toBe(0);
  });
});

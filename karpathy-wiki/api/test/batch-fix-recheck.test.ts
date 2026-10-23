// T02922：批量修复「流程完成 ≠ 问题消解」的口径守护。
// ------------------------------------------------------------------
// 背景：修复工作流的 done 事件只反映「agent 循环结束且无异常」。T02605 实测 3 项批量修复
// 全部报成功（successCount=3），但复跑体检孤立页 112→112——问题一条没消解。
// 本文件锁三件事：
//   A 定点复检本身：HarnessAdapter.recheckIssueResolved 确定性、零 LLM、写后立即可见
//     （用会抛错的 Proxy 兜住 harnessConfig：一旦复检碰 LLM 配置立即红）
//   B 作业层：流程成功但复检未消解 → ineffective（不进 doneKeys）；复检消解 → doneKeys
//   C 耗时样本口径：无效/失败项只要 LLM 流程跑过也计入 stats.json（否则估算越跑越乐观）
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { VaultService } from '../src/vault/vault-service.js';
import { HarnessAdapter } from '../src/engine/harness-adapter.js';
import { BatchFixJobManager } from '../src/workflows/batch-fix-job.js';
import type { EngineAdapter, FixInput, FixProgressEvent } from '../src/types.js';
import { NO_TIMER_CHAIN, pollUntil } from './helpers/waitForProgress.js';

const DONE_OK: FixProgressEvent = { step: 'done', status: 'done', message: 'flow-ok' };

async function* iterEvents(events: FixProgressEvent[]): AsyncGenerator<FixProgressEvent> {
  for (const e of events) yield e;
}

// 任何对 harnessConfig 的属性访问都抛错：复检若误走 LLM 配置，用例立即红
function llmForbiddenConfig(): never {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('定点复检不应触碰 LLM 配置');
      },
    },
  ) as never;
}

async function makeVault(): Promise<{ dir: string; vault: VaultService }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't02922-vault-'));
  const vault = new VaultService(dir);
  await vault.init();
  return { dir, vault };
}

describe('A · recheckIssueResolved：确定性定点复检（零 LLM，写后立即可见）', () => {
  let dir = '';
  let vault: VaultService;
  let adapter: HarnessAdapter;

  beforeEach(async () => {
    ({ dir, vault } = await makeVault());
    adapter = new HarnessAdapter(llmForbiddenConfig(), vault);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('孤立页：无入链判未消解；补回链后立即判消解（不被 30s 链接图缓存挡住）', async () => {
    await vault.writeFile('entities/target.md', '---\ntitle: 目标页\n---\n\n内容。\n');
    const input: FixInput = { issueType: 'orphan', target: 'entities/target.md' };
    expect(await adapter.recheckIssueResolved(input)).toBe(false);

    await vault.writeFile('concepts/hub.md', '---\ntitle: 枢纽\n---\n\n见 [[target]]。\n');
    expect(await adapter.recheckIssueResolved(input)).toBe(true);
  });

  it('断链：目标页建出后判消解；来源页不再链接也判消解；原地不动判未消解', async () => {
    await vault.writeFile('concepts/source.md', '---\ntitle: 来源\n---\n\n见 [[missing-page]]。\n');
    const input: FixInput = {
      issueType: 'broken_link',
      target: { from: 'concepts/source.md', to: 'missing-page' },
    };
    expect(await adapter.recheckIssueResolved(input)).toBe(false);

    // 修法一：补建目标页
    await vault.writeFile('entities/missing-page.md', '---\ntitle: 补建\n---\n\n内容。\n');
    expect(await adapter.recheckIssueResolved(input)).toBe(true);

    // 修法二：改写来源页去掉链接 → 断链对不再存在
    const input2: FixInput = {
      issueType: 'broken_link',
      target: { from: 'concepts/source.md', to: 'another-missing' },
    };
    await vault.writeFile('concepts/source.md', '---\ntitle: 来源\n---\n\n见 [[another-missing]]。\n');
    expect(await adapter.recheckIssueResolved(input2)).toBe(false);
    await vault.writeFile('concepts/source.md', '---\ntitle: 来源\n---\n\n已人工改写为普通文本。\n');
    expect(await adapter.recheckIssueResolved(input2)).toBe(true);
  });

  it('来源页被删除 → 断链对不再存在，按消解（与体检列表口径一致）', async () => {
    await vault.writeFile('concepts/source.md', '---\ntitle: 来源\n---\n\n见 [[ghost]]。\n');
    const input: FixInput = {
      issueType: 'broken_link',
      target: { from: 'concepts/source.md', to: 'ghost' },
    };
    expect(await adapter.recheckIssueResolved(input)).toBe(false);
    await fs.rm(path.join(vault.getVaultPath(), 'concepts/source.md'));
    expect(await adapter.recheckIssueResolved(input)).toBe(true);
  });
});

describe('B/C · BatchFixJobManager：复检裁定 + 耗时样本口径', () => {
  let jobsDir = '';
  let vaultDir = '';
  let vault: VaultService;

  beforeEach(async () => {
    jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 't02922-jobs-'));
    ({ dir: vaultDir, vault } = await makeVault());
  });

  afterEach(async () => {
    await fs.rm(jobsDir, { recursive: true, force: true });
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  // 可编程作业适配器：healthCheckFix 产出给定流程事件，recheck 由用例指定
  function jobAdapter(opts: {
    flow: FixProgressEvent[];
    recheck: (input: FixInput) => Promise<boolean>;
    onFlow?: () => Promise<void>;
  }): { adapter: EngineAdapter; recheck: Mock<any, any> } {
    const recheck: Mock<any, any> = vi.fn(opts.recheck);
    const adapter = {
      async *healthCheckFix() {
        if (opts.onFlow) await opts.onFlow();
        yield* iterEvents(opts.flow);
      },
      recheckIssueResolved: recheck,
    } as unknown as EngineAdapter;
    return { adapter, recheck };
  }

  async function runJob(
    adapter: EngineAdapter,
    items: Array<{ issueKey: string; input: FixInput }>,
  ): Promise<{ events: string[]; snapshot: Awaited<ReturnType<BatchFixJobManager['getSnapshot']>> }> {
    const manager = new BatchFixJobManager(jobsDir, adapter);
    const started = await manager.start(items);
    const events: string[] = [];
    manager.subscribe(started.jobId, {
      onEvent: (event) => events.push(event),
      isAborted: () => false,
      end: () => undefined,
    });
    const { value } = await pollUntil(
      '批量作业进入 completed 终态',
      () => manager.getSnapshot(started.jobId),
      (s) => s?.status === 'completed',
      NO_TIMER_CHAIN,
    );
    await manager.flush();
    return { events, snapshot: value };
  }

  async function readStats(): Promise<{ samples: number; avgMs: number }> {
    const raw = await fs.readFile(path.join(jobsDir, 'stats.json'), 'utf8');
    return JSON.parse(raw) as { samples: number; avgMs: number };
  }

  it('流程成功但复检未消解 → ineffective、不进 doneKeys，且耗时样本照计', async () => {
    const { adapter, recheck } = jobAdapter({
      flow: [DONE_OK],
      recheck: async () => false,
    });
    const input: FixInput = { issueType: 'orphan', target: 'entities/target.md' };
    const { events, snapshot } = await runJob(adapter, [{ issueKey: 'orphan:entities/target.md', input }]);

    expect(snapshot).toMatchObject({
      status: 'completed',
      doneCount: 1,
      successCount: 0,
      failCount: 0,
      ineffectiveCount: 1,
    });
    expect(snapshot?.doneKeys).toEqual([]);
    expect(snapshot?.ineffective).toEqual([
      { issueKey: 'orphan:entities/target.md', message: '流程完成但问题未消解' },
    ]);
    // 事件口径：有 issue_ineffective、没有 issue_done（「流程完成」不再等同于「修复成功」）
    expect(events).toContain('issue_ineffective');
    expect(events).not.toContain('issue_done');
    expect(recheck).toHaveBeenCalledWith(input);
    // 样本口径：无效项白跑了 LLM，必须计入均值
    expect((await readStats()).samples).toBe(1);
  });

  it('流程成功且复检消解 → doneKeys 收下该 key（正常路径不被误伤）', async () => {
    const { adapter } = jobAdapter({
      flow: [DONE_OK],
      recheck: async () => true,
    });
    const input: FixInput = { issueType: 'orphan', target: 'entities/target.md' };
    const { events, snapshot } = await runJob(adapter, [{ issueKey: 'orphan:entities/target.md', input }]);

    expect(snapshot).toMatchObject({ successCount: 1, ineffectiveCount: 0, failCount: 0 });
    expect(snapshot?.doneKeys).toEqual(['orphan:entities/target.md']);
    expect(snapshot?.ineffective).toEqual([]);
    expect(events).toContain('issue_done');
    expect(events).not.toContain('issue_ineffective');
  });

  it('流程本身失败 → 不进复检，失败项同样计入耗时样本（口径一致）', async () => {
    const { adapter, recheck } = jobAdapter({
      flow: [{ step: 'done', status: 'error', message: 'engine-failed' }],
      recheck: async () => true,
    });
    const input: FixInput = { issueType: 'orphan', target: 'entities/target.md' };
    const { events, snapshot } = await runJob(adapter, [{ issueKey: 'orphan:entities/target.md', input }]);

    expect(snapshot).toMatchObject({ successCount: 0, ineffectiveCount: 0, failCount: 1 });
    expect(events).toContain('issue_error');
    // 流程没成功就不该消耗复检
    expect(recheck).not.toHaveBeenCalled();
    expect((await readStats()).samples).toBe(1);
  });

  it('真实 vault 闭环：流程写了回链 → 复检消解；流程只回「成功」没写 → 复检未消解', async () => {
    const harness = new HarnessAdapter(llmForbiddenConfig(), vault);
    const target = 'entities/target.md';
    await vault.writeFile(target, '---\ntitle: 目标页\n---\n\n内容。\n');

    // 场景一：LLM 声称成功但什么都没写（复刻 T02605 实测的失效复现）
    const noop = jobAdapter({ flow: [DONE_OK], recheck: (i) => harness.recheckIssueResolved(i) });
    const first = await runJob(noop.adapter, [{ issueKey: `orphan:${target}`, input: { issueType: 'orphan', target } }]);
    expect(first.snapshot).toMatchObject({ successCount: 0, ineffectiveCount: 1 });

    // 场景二：流程真的写入回链 → 复检确认消解
    const writing = jobAdapter({
      flow: [DONE_OK],
      recheck: (i) => harness.recheckIssueResolved(i),
      onFlow: () => vault.writeFile('concepts/hub.md', '---\ntitle: 枢纽\n---\n\n见 [[target]]。\n'),
    });
    const second = await runJob(writing.adapter, [
      { issueKey: `orphan:${target}`, input: { issueType: 'orphan', target } },
    ]);
    expect(second.snapshot).toMatchObject({ successCount: 1, ineffectiveCount: 0 });
    expect(second.snapshot?.doneKeys).toEqual([`orphan:${target}`]);
  });
});

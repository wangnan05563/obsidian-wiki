// T02772 之二：run-state 分布在多个目录时，清理与读取都必须覆盖到。
// ------------------------------------------------------------------
// 本机实测：`api/.harness/state` 有 107 个状态文件，`data/.harness/state` 目录不存在，
// 而 `GET /api/cleanup/status` 的 `runState.fileCount` 返回 0——「运行状态」卡显示
// 「无需清理」，用户以为清掉了，实际一个都没删（且「无可清对象置灰」把缺陷伪装成正常态）。
// 本文件用「规范目录 + 遗留目录」两处的真实临时目录复现该场景并锁住修复：
//   A) 状态计数/体积/最早时间跨目录合并，且与独立 readdir 重算结果相等（防再次口径失真）；
//   B) 预览与真实删除都覆盖两处，遗留目录的条目标注来源（用户得知道自己清的是历史产物）；
//   C) 读取侧（中断任务列表 / 步骤追踪）跨目录合并，同名 runId 以规范目录为准——
//      换了写入目录不能让历史运行从面板上消失。
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerCleanupRoute } from '../src/routes/cleanup.js';
import { registerRunsRoute } from '../src/routes/runs.js';
import {
  getCanonicalRunStateDir,
  getCanonicalRunStateDirFromVault,
  getRunStateDirs,
} from '../src/utils/run-state-dirs.js';
import { __resetActivitiesForTest } from '../src/activity.js';
import type { VaultService } from '../src/vault/vault-service.js';

const BYTES_PER_MB = 1024 * 1024;
function toMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 100) / 100;
}

function stubVault(vaultPath: string): VaultService {
  return { getVaultPath: () => vaultPath } as unknown as VaultService;
}
const passThrough: preHandlerHookHandler = (_req, _reply, done) => done();
function stubGuards() {
  return { enabled: false, requireAuth: passThrough, requireAdmin: passThrough };
}

const RUN_C1 = '11111111-1111-4111-8111-111111111111';
const RUN_C2 = '22222222-2222-4222-8222-222222222222';
const RUN_C3 = '33333333-3333-4333-8333-333333333333';
const RUN_L1 = '44444444-4444-4444-8444-444444444444';
const RUN_L2 = '55555555-5555-4555-8555-555555555555';
// 同名跨目录：规范目录里是新数据，遗留目录里是历史副本
const RUN_DUP = '66666666-6666-4666-8666-666666666666';

/** 造一个符合 harness RunState 形状的状态文件（体积可控，便于断言释放量） */
async function writeState(dir: string, runId: string, bytes: number, status = 'done'): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  const padding = Math.max(0, bytes - 32);
  await fs.writeFile(
    file,
    JSON.stringify({
      runId,
      task: '自测用例',
      events: [],
      step: 1,
      tokenUsed: 10,
      status,
      startedAt: '2026-10-09T16:39:05.122Z',
      timings: [{ step: 1, llmMs: 1200, toolMs: 300, tokens: 10, toolNames: ['read_page'] }],
      padding: 'x'.repeat(padding),
    }),
    'utf8',
  );
  return file;
}

describe('T02772 清理与读取跨 run-state 目录', () => {
  let tempRoot = '';
  let vaultPath = '';
  let canonical = '';
  let legacy = '';
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    __resetActivitiesForTest();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-run-state-dirs-'));
    vaultPath = path.join(tempRoot, 'data', 'vault');
    const harnessDir = path.join(tempRoot, 'data', '.harness');
    canonical = path.join(harnessDir, 'state');
    // 遗留目录：改写入规范目录之前，状态文件按进程 CWD 落点（开发模式即 api/.harness/state）
    legacy = path.join(tempRoot, 'api', '.harness', 'state');
    await fs.mkdir(path.join(vaultPath, 'raw'), { recursive: true });
    await fs.mkdir(path.join(harnessDir, 'logs'), { recursive: true });
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  async function boot(dirs?: string[]): Promise<void> {
    app = Fastify();
    registerCleanupRoute(app, stubVault(vaultPath), stubGuards(), dirs);
    registerRunsRoute(app, canonical, stubGuards(), dirs);
    await app.ready();
  }

  /** 独立重算：与实现无关地数一遍两目录的 .json，用作「口径与实际必须相等」的对照 */
  async function recount(): Promise<{ fileCount: number; sizeBytes: number }> {
    let fileCount = 0;
    let sizeBytes = 0;
    for (const dir of [canonical, legacy]) {
      let names: string[] = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        const stat = await fs.stat(path.join(dir, name));
        fileCount += 1;
        sizeBytes += stat.size;
      }
    }
    return { fileCount, sizeBytes };
  }

  async function status(): Promise<Record<string, any>> {
    if (!app) throw new Error('路由未注册');
    const res = await app.inject({ method: 'GET', url: '/api/cleanup/status' });
    return res.json() as Record<string, any>;
  }

  async function postCleanup(payload: Record<string, unknown>): Promise<Record<string, any>> {
    if (!app) throw new Error('路由未注册');
    const res = await app.inject({ method: 'POST', url: '/api/cleanup', payload });
    return res.json() as Record<string, any>;
  }

  it('状态计数 = 规范目录 + 遗留目录之和，且与独立重算逐字相等（防「显示 0 实际 107」复发）', async () => {
    await writeState(canonical, RUN_C1, 1000);
    await writeState(canonical, RUN_C2, 2000);
    await writeState(legacy, RUN_L1, 3000);
    await writeState(legacy, RUN_L2, 4000);
    await boot([canonical, legacy]);

    const body = await status();
    const truth = await recount();
    expect(body.runState.fileCount).toBe(truth.fileCount);
    expect(body.runState.fileCount).toBe(4);
    expect(body.runState.sizeMb).toBe(toMb(truth.sizeBytes));
  });

  it('规范目录为空/不存在时也必须报出遗留目录的数量（本单的原始症状：显示 0 个）', async () => {
    await writeState(legacy, RUN_L1, 1000);
    await writeState(legacy, RUN_L2, 1000);
    await boot([canonical, legacy]);

    const body = await status();
    expect(body.runState.fileCount).toBe(2);
    // 反证：不传合并清单（只认规范目录）时才会是 0——这条把「必须传清单」的因果锁住
    const naive = Fastify();
    registerCleanupRoute(naive, stubVault(vaultPath), stubGuards());
    await naive.ready();
    const naiveBody = (await naive.inject({ method: 'GET', url: '/api/cleanup/status' })).json() as Record<string, any>;
    await naive.close();
    expect(naiveBody.runState.fileCount).toBe(0);
  });

  it('预览列出两处并把遗留条目标注出来，且不删任何文件', async () => {
    await writeState(canonical, RUN_C1, 1000);
    await writeState(legacy, RUN_L1, 1000);
    await boot([canonical, legacy]);

    const body = await postCleanup({ target: 'run_state', dry_run: true });
    expect(body.cleaned).toHaveLength(2);
    expect(body.cleaned.filter((s: string) => s.includes('（旧存放位置）'))).toHaveLength(1);
    expect(body.total_freed_mb).toBeUndefined();
    await expect(fs.stat(path.join(canonical, `${RUN_C1}.json`))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(legacy, `${RUN_L1}.json`))).resolves.toBeTruthy();
  });

  it('真实删除把两处都清掉，释放量覆盖遗留目录（验收：计数 N → dry_run 列出 → 删除后消失）', async () => {
    await writeState(canonical, RUN_C1, 2 * 1024 * 1024);
    await writeState(legacy, RUN_L1, 1024 * 1024);
    await boot([canonical, legacy]);

    const before = await status();
    expect(before.runState.fileCount).toBe(2);

    const body = await postCleanup({ target: 'run_state', dry_run: false });
    expect(body.count).toBe(2);
    // 释放量必须等于删除前统计到的总体积（口径同源，不由测试猜字节数）
    expect(body.total_freed_mb).toBe(before.runState.sizeMb);
    await expect(fs.stat(path.join(canonical, `${RUN_C1}.json`))).rejects.toThrow();
    await expect(fs.stat(path.join(legacy, `${RUN_L1}.json`))).rejects.toThrow();

    const after = await status();
    expect(after.runState.fileCount).toBe(0);
  });

  it('target=all 同样覆盖遗留目录（用户不会只在单卡上踩到这个坑）', async () => {
    await writeState(legacy, RUN_L1, 1024 * 1024);
    await boot([canonical, legacy]);

    const body = await postCleanup({ target: 'all', dry_run: false });
    expect(body.cleaned.filter((s: string) => s.includes('旧存放位置'))).toHaveLength(1);
    await expect(fs.stat(path.join(legacy, `${RUN_L1}.json`))).rejects.toThrow();
  });

  it('步骤追踪列表跨目录合并：历史运行不因换了写入目录而从面板消失', async () => {
    await writeState(canonical, RUN_C1, 500);
    await writeState(legacy, RUN_L1, 500);
    await writeState(legacy, RUN_L2, 500);
    await boot([canonical, legacy]);

    if (!app) throw new Error('路由未注册');
    const res = await app.inject({ method: 'GET', url: '/api/query/runs' });
    const ids = (res.json() as { runs: Array<{ runId: string }> }).runs.map((r) => r.runId).sort();
    expect(ids).toEqual([RUN_C1, RUN_L1, RUN_L2].sort());
  });

  it('遗留目录里的单条 trace 仍可下钻读取；未知 runId 仍 404', async () => {
    await writeState(legacy, RUN_L1, 500, 'paused');
    await boot([canonical, legacy]);
    if (!app) throw new Error('路由未注册');

    const hit = await app.inject({ method: 'GET', url: `/api/query/runs/${RUN_L1}` });
    expect(hit.statusCode).toBe(200);
    const detail = hit.json() as Record<string, any>;
    expect(detail.status).toBe('paused');
    expect(detail.totalMs).toBe(1500);

    const miss = await app.inject({ method: 'GET', url: `/api/query/runs/${RUN_C3}` });
    expect(miss.statusCode).toBe(404);
  });

  it('同名 runId：读取以规范目录为准（新数据不被旧副本盖掉），清理仍把两处文件都算上', async () => {
    await writeState(canonical, RUN_DUP, 500, 'paused');
    await writeState(legacy, RUN_DUP, 500, 'done');
    await boot([canonical, legacy]);
    if (!app) throw new Error('路由未注册');

    const res = await app.inject({ method: 'GET', url: '/api/query/runs' });
    const runs = (res.json() as { runs: Array<{ runId: string; status: string }> }).runs;
    expect(runs.filter((r) => r.runId === RUN_DUP)).toHaveLength(1);
    expect(runs.find((r) => r.runId === RUN_DUP)?.status).toBe('paused');

    const body = await postCleanup({ target: 'run_state', dry_run: true });
    expect(body.count).toBe(2);
  });

  it('中断任务列表（/api/compile/runs）同样合并两处目录', async () => {
    await writeState(canonical, RUN_C1, 500);
    await writeState(legacy, RUN_L1, 500);
    await boot([canonical, legacy]);
    if (!app) throw new Error('路由未注册');

    const res = await app.inject({ method: 'GET', url: '/api/compile/runs' });
    const ids = (res.json() as { runs: Array<{ runId: string }> }).runs.map((r) => r.runId).sort();
    expect(ids).toEqual([RUN_C1, RUN_L1].sort());
  });
});

// 只读复核：拿本机真实目录跑一次不变量断言（临时目录里的用例证明不了「口径与实际相符」）。
// 为什么不断言具体数字：真实数量随用户使用情况变化；这里锁的是
// 「接口报的数 = 独立重算的数」这条不变量——修复前它必然不成立（接口只数规范目录，
// 本机实测那里是 0，而遗留目录有 107 个）。全程只 GET，不 POST，绝不删用户文件。
describe('T02772 真实目录只读复核（不写不删）', () => {
  it('GET /api/cleanup/status 的 runState 计数等于真实目录独立重算结果', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const realDataDir = path.join(repoRoot, 'data');
    const realVault = path.join(realDataDir, 'vault');
    const dirs = getRunStateDirs({
      primaryDirs: [getCanonicalRunStateDir(realDataDir), getCanonicalRunStateDirFromVault(realVault)],
      // 遗留候选用真实值：这台机器上 api/.harness/state 才是 107 个文件的实际位置
    });
    expect(dirs.length).toBeGreaterThan(1);

    let expected = 0;
    for (const dir of dirs) {
      try {
        const names = await fs.readdir(dir);
        expected += names.filter((n) => n.endsWith('.json')).length;
      } catch {
        // 目录不存在 = 0 个
      }
    }

    const app = Fastify();
    registerCleanupRoute(app, stubVault(realVault), stubGuards(), dirs);
    await app.ready();
    try {
      const body = (await app.inject({ method: 'GET', url: '/api/cleanup/status' })).json() as Record<string, any>;
      expect(body.runState.fileCount).toBe(expected);
    } finally {
      await app.close();
    }
  });
});

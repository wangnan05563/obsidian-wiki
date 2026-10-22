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
import { compileCacheFileIn } from '../src/utils/harness-dirs.js';
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

  // T02808：把「到底扫了哪几个位置」随状态返回，页面才能列出与后端逐字一致的清单。
  // 断言全部用注入的目录清单（boot([canonical, legacy, …])），不碰真实 CWD——
  // 那正是本单验收要求的「用例可复用注入方式」。
  it('runState.dirs 逐字等于注入的目录清单：路径、计数、角色、是否存在一一对应', async () => {
    const missing = path.join(tempRoot, 'nowhere', 'state');
    await writeState(canonical, RUN_C1, 1024 * 1024);
    await writeState(legacy, RUN_L1, 1024 * 1024);
    await writeState(legacy, RUN_L2, 1024 * 1024);
    await boot([canonical, legacy, missing]);

    const body = await status();
    const dirs = body.runState.dirs as Array<Record<string, unknown>>;
    // 顺序也不改：首项必须是写入侧规范目录，前端据此标「当前存放位置」
    expect(dirs.map((d) => d.path)).toEqual([canonical, legacy, missing]);
    expect(dirs.map((d) => d.fileCount)).toEqual([1, 2, 0]);
    expect(dirs.map((d) => d.role)).toEqual(['canonical', 'legacy', 'legacy']);
    expect(dirs.map((d) => d.exists)).toEqual([true, true, false]);
    expect(dirs.map((d) => d.sizeMb)).toEqual([1, 2, 0]);
    // 验收：「运行状态」卡计数 = 高级面板各目录计数之和
    expect(dirs.reduce((n, d) => n + (d.fileCount as number), 0)).toBe(body.runState.fileCount);
    expect(body.runState.sizeMb).toBe(dirs.reduce((n, d) => n + (d.sizeMb as number), 0));
  });

  it('规范目录为空、遗留目录有文件时，dirs 仍把空位置列出来（用户要能看出「清完不会再来自这里」）', async () => {
    await writeState(legacy, RUN_L1, 1000);
    await boot([canonical, legacy]);

    const dirs = (await status()).runState.dirs as Array<Record<string, unknown>>;
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toEqual({ path: canonical, fileCount: 0, sizeMb: 0, role: 'canonical', exists: false });
    expect(dirs[1].fileCount).toBe(1);
    expect(dirs[1].exists).toBe(true);
  });

  it('只认单目录（漏传清单的 fail-safe 默认）时 dirs 也只有一项，且标为当前存放位置', async () => {
    await writeState(legacy, RUN_L1, 1000);
    await boot();

    const body = await status();
    expect(body.runState.dirs).toEqual([
      { path: canonical, fileCount: 0, sizeMb: 0, role: 'canonical', exists: false },
    ]);
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

// T02887：编译缓存/运行日志/原始资料补目录清单后，「卡面计数 = 各目录计数之和」
// 这条恒等式要逐卡成立，清单的路径/角色/存在性也要逐字可对。
describe('T02887 四类目标的目录清单与计数恒等式', () => {
  let tempRoot = '';
  let vaultPath = '';
  let harness = '';
  let legacyHarness = '';
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    __resetActivitiesForTest();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-cleanup-dirs-'));
    vaultPath = path.join(tempRoot, 'data', 'vault');
    harness = path.join(tempRoot, 'data', '.harness');
    legacyHarness = path.join(tempRoot, 'api', '.harness');
    await fs.mkdir(path.join(vaultPath, 'raw'), { recursive: true });
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  async function boot(harnessDirs?: string[]): Promise<void> {
    app = Fastify();
    registerCleanupRoute(app, stubVault(vaultPath), stubGuards(), undefined, harnessDirs);
    await app.ready();
  }

  async function status(): Promise<Record<string, any>> {
    if (!app) throw new Error('路由未注册');
    const res = await app.inject({ method: 'GET', url: '/api/cleanup/status' });
    return res.json() as Record<string, any>;
  }

  it('compileCache：entryCount = 各根缓存条目之和，遗留根标 legacy', async () => {
    await fs.mkdir(harness, { recursive: true });
    await fs.writeFile(compileCacheFileIn(harness), JSON.stringify({ a: 1, b: 2 }), 'utf8');
    await fs.mkdir(legacyHarness, { recursive: true });
    await fs.writeFile(compileCacheFileIn(legacyHarness), JSON.stringify({ c: 3 }), 'utf8');
    await boot([harness, legacyHarness]);

    const body = await status();
    expect(body.compileCache.entryCount).toBe(3);
    const dirs = body.compileCache.dirs as Array<Record<string, unknown>>;
    expect(dirs.map((d) => d.path)).toEqual([harness, legacyHarness]);
    expect(dirs.map((d) => d.fileCount)).toEqual([2, 1]);
    expect(dirs.map((d) => d.role)).toEqual(['canonical', 'legacy']);
    expect(dirs.map((d) => d.exists)).toEqual([true, true]);
    expect(dirs.reduce((n, d) => n + (d.fileCount as number), 0)).toBe(body.compileCache.entryCount);
  });

  it('compileCache：还没生成缓存的根 exists=false 且计 0（目录在 ≠ 缓存在）', async () => {
    await fs.mkdir(harness, { recursive: true });
    await boot();

    const body = await status();
    expect(body.compileCache.exists).toBe(false);
    expect(body.compileCache.dirs).toEqual([
      { path: harness, fileCount: 0, sizeMb: 0, role: 'canonical', exists: false },
    ]);
  });

  it('runLogs：fileCount = 各根日志文件数之和，缺失根列出且计 0', async () => {
    await fs.mkdir(path.join(harness, 'logs'), { recursive: true });
    await fs.writeFile(path.join(harness, 'logs', 'run-a.log'), 'a', 'utf8');
    await fs.mkdir(path.join(legacyHarness, 'logs'), { recursive: true });
    await fs.writeFile(path.join(legacyHarness, 'logs', 'run-b.log'), 'b', 'utf8');
    const missing = path.join(tempRoot, 'nowhere', '.harness');
    await boot([harness, legacyHarness, missing]);

    const body = await status();
    expect(body.runLogs.fileCount).toBe(2);
    const dirs = body.runLogs.dirs as Array<Record<string, unknown>>;
    expect(dirs.map((d) => d.path)).toEqual([
      path.join(harness, 'logs'),
      path.join(legacyHarness, 'logs'),
      path.join(missing, 'logs'),
    ]);
    expect(dirs.map((d) => d.fileCount)).toEqual([1, 1, 0]);
    expect(dirs.map((d) => d.role)).toEqual(['canonical', 'legacy', 'legacy']);
    expect(dirs.map((d) => d.exists)).toEqual([true, true, false]);
    expect(dirs.reduce((n, d) => n + (d.fileCount as number), 0)).toBe(body.runLogs.fileCount);
  });

  it('rawArchive：单一 canonical 项，fileCount 与该项相等（用户命名的源文件不计入）', async () => {
    await fs.writeFile(path.join(vaultPath, 'raw', 'input-1.md'), 'a', 'utf8');
    await fs.writeFile(path.join(vaultPath, 'raw', 'input-2.md'), 'b', 'utf8');
    await fs.writeFile(path.join(vaultPath, 'raw', '用户自己命名的文件.md'), 'keep', 'utf8');
    await boot();

    const body = await status();
    expect(body.rawArchive.fileCount).toBe(2);
    expect(body.rawArchive.dirs).toEqual([
      {
        path: path.join(vaultPath, 'raw'),
        fileCount: 2,
        sizeMb: body.rawArchive.sizeMb,
        role: 'canonical',
        exists: true,
      },
    ]);
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
      // T02808：真实机器上，接口给的目录清单必须与 getRunStateDirs() 逐字同值同序——
      // 高级面板显示的就是这份清单，任何「前端自己再算一遍目录」的写法都会在这里露出来。
      expect(body.runState.dirs.map((d: Record<string, any>) => d.path)).toEqual(dirs);
      expect(body.runState.dirs.map((d: Record<string, any>) => d.fileCount).reduce((a: number, b: number) => a + b, 0)).toBe(expected);
      expect(body.runState.dirs[0].role).toBe('canonical');
      expect(body.runState.dirs.filter((d: Record<string, any>) => d.role === 'legacy').length).toBe(dirs.length - 1);
      // T02887：四类目标的恒等式在真实数据上同样成立（compile-cache 的 fileCount 口径是条目数）
      expect(body.compileCache.entryCount).toBe(body.compileCache.dirs.reduce((n: number, d: Record<string, any>) => n + d.fileCount, 0));
      expect(body.runLogs.fileCount).toBe(body.runLogs.dirs.reduce((n: number, d: Record<string, any>) => n + d.fileCount, 0));
      expect(body.runLogs.dirs.length).toBeGreaterThan(0);
      expect(body.rawArchive.dirs).toHaveLength(1);
      expect(body.rawArchive.dirs[0].role).toBe('canonical');
      expect(body.rawArchive.fileCount).toBe(body.rawArchive.dirs[0].fileCount);
    } finally {
      await app.close();
    }
  });
});

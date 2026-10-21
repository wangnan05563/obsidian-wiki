// T02772 之一：run-state 目录口径与写入合流。
// ------------------------------------------------------------------
// 缺陷形态：「缓存与日志清理」页的「运行状态」卡永远显示 0 个 / 无需清理，
// 而磁盘上真实有 107 个 query-run 状态文件在积累（本机实测）。根因不是漏扫一个目录，
// 而是**写入位置由进程 CWD 决定**（harness 默认 FileStateStore 的目录是相对路径
// `.harness/state`），清理与读取却按「与 vault 同级 / 与 api 同级」两套不同口径去找。
// 本文件锁三件事：
//   A) 目录清单计算本身（顺序、去重、可注入、遗留候选）；
//   B) 两条规范目录推导必须同值——清理按 vaultPath 推、写入按 dataDir 推，
//      不同值就等于「清了个不存在的目录」，正是本单的原始症状；
//   C) 写入合流的行为（写规范目录 + 读回退遗留 + 列表并集）与生产接线。
//      装配点用类型系统查不出来（stateStore 传不传都能过编译），只能源码级锁死。
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunState } from '@wiki/harness';
import {
  getCanonicalRunStateDir,
  getCanonicalRunStateDirFromVault,
  getLegacyRunStateDirs,
  getRunStateDirs,
} from '../src/utils/run-state-dirs.js';
import { createRunStateStore } from '../src/engine/run-state-store.js';

const RUN_A = '015d4750-1360-4da7-bde5-d221195f92e0';
const RUN_B = '0b7c2135-7516-4373-aa29-ebb2ee907d1c';

function runState(runId: string, status: RunState['status'] = 'done'): RunState {
  return {
    runId,
    task: '自测用例',
    events: [],
    step: 1,
    tokenUsed: 10,
    status,
    startedAt: '2026-10-09T16:39:05.122Z',
    timings: [{ step: 1, llmMs: 100, toolMs: 50, tokens: 10, toolNames: [] }],
  };
}

describe('T02772 run-state 目录清单计算', () => {
  it('默认清单首项是规范目录，且遗留候选（api 目录 / 进程 CWD）都在清单里', () => {
    const dirs = getRunStateDirs();
    expect(dirs[0]).toBe(getCanonicalRunStateDir());
    const [apiLegacy, cwdLegacy] = getLegacyRunStateDirs();
    expect(dirs).toContain(apiLegacy);
    expect(dirs).toContain(cwdLegacy);
  });

  it('可注入 legacyDirs：传空数组即「只认 primary」，测试不会把真实用户目录算进删除清单', () => {
    const dirs = getRunStateDirs({ primaryDirs: [path.resolve('state-x')], legacyDirs: [] });
    expect(dirs).toEqual([path.resolve('state-x')]);
  });

  it('保持 primary 顺序，并按大小写不敏感去重（Windows 同一目录有多种写法）', () => {
    const base = path.resolve(os.tmpdir(), 'wiki-run-state-dedupe');
    const first = path.join(base, 'state');
    const second = path.join(base, 'other');
    const dirs = getRunStateDirs({
      primaryDirs: [first, second, first.toUpperCase()],
      legacyDirs: [second.toUpperCase(), first],
    });
    expect(dirs).toEqual([first, second]);
  });

  it('规范目录的两条推导必须同值：写入侧按 dataDir，清理侧按 vaultPath', () => {
    const dataDir = path.resolve(os.tmpdir(), 'wiki-run-state-agree', 'data');
    const vaultPath = path.join(dataDir, 'vault');
    expect(getCanonicalRunStateDirFromVault(vaultPath)).toBe(getCanonicalRunStateDir(dataDir));
    // 与 routes/cleanup.ts 历史上的推导（resolve(vaultPath,'..','.harness')/state）同值
    expect(path.join(path.resolve(vaultPath, '..', '.harness'), 'state')).toBe(getCanonicalRunStateDir(dataDir));
  });
});

describe('T02772 写入合流 + 读取回退（createRunStateStore）', () => {
  let tempRoot = '';
  let canonical = '';
  let legacy = '';

  async function seed(): Promise<void> {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-run-state-store-'));
    canonical = path.join(tempRoot, 'data', '.harness', 'state');
    legacy = path.join(tempRoot, 'api', '.harness', 'state');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, `${RUN_B}.json`), JSON.stringify(runState(RUN_B)), 'utf8');
  }

  afterEach(async () => {
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  it('save 只写规范目录，遗留目录不再新增文件（清完即自然收敛为空）', async () => {
    await seed();
    const store = createRunStateStore([canonical, legacy]);
    await store.save(RUN_A, runState(RUN_A));

    expect(await fs.readFile(path.join(canonical, `${RUN_A}.json`), 'utf8')).toContain(RUN_A);
    await expect(fs.stat(path.join(legacy, `${RUN_A}.json`))).rejects.toThrow();
  });

  it('load 先查规范目录、查不到回退遗留目录：升级前的存量运行仍可断点续传', async () => {
    await seed();
    const store = createRunStateStore([canonical, legacy]);

    const legacyHit = await store.load(RUN_B);
    expect(legacyHit?.runId).toBe(RUN_B);

    await store.save(RUN_B, { ...runState(RUN_B), status: 'paused' });
    expect((await store.load(RUN_B))?.status).toBe('paused');
    // 回退不等于覆盖：规范目录命中后，遗留目录里的同名旧文件不参与读取、也不被改写
    expect(await fs.readFile(path.join(legacy, `${RUN_B}.json`), 'utf8')).toMatch(/"status":\s*"done"/);
  });

  it('runId 校验沿用 FileStateStore 的 UUID 白名单（防路径穿越，不自己另写一份）', async () => {
    await seed();
    const store = createRunStateStore([canonical, legacy]);
    await expect(store.load('../../escape')).rejects.toThrow(/Invalid runId/);
  });

  it('list 取并集：中断任务入口能同时看到新写入的与历史遗留的', async () => {
    await seed();
    const store = createRunStateStore([canonical, legacy]);
    await store.save(RUN_A, runState(RUN_A));

    const ids = await store.list();
    expect([...ids].sort()).toEqual([RUN_A, RUN_B].sort());
  });

  it('目录清单为空时回退默认清单，不会把 undefined 留到运行期才炸', async () => {
    await seed();
    const store = createRunStateStore([]);
    expect(await store.load('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('T02772 生产接线（源码级锁）', () => {
  const indexSrc = readFileSync(path.resolve(__dirname, '..', 'src', 'index.ts'), 'utf8');

  it('harness 配置注入了 stateStore，且用的是合并清单（不传就退回 CWD 相对目录）', () => {
    expect(indexSrc).toMatch(/stateStore:\s*createRunStateStore\(runStateDirs\)/);
  });

  it('run-state 清单在 index.ts 一次组装，写入与读取/清理共用同一份', () => {
    expect(indexSrc).toMatch(
      /const runStateDirs = getRunStateDirs\(\{[\s\S]*?primaryDirs: \[getCanonicalRunStateDir\(\), getCanonicalRunStateDirFromVault\(vault\.getVaultPath\(\)\)\]/,
    );
    expect(indexSrc).toMatch(/const stateDir = runStateDirs\[0\];/);
    expect(indexSrc).toMatch(/registerRunsRoute\(app, stateDir, isolationGuards, runStateDirs\)/);
    // T02809：清理路由同时收到 `.harness` 根清单——漏传那一参，编译缓存/日志仍只清一个根
    expect(indexSrc).toMatch(/registerCleanupRoute\(app, vault, isolationGuards, runStateDirs, harnessDirs\)/);
  });

  it('路由侧默认仍是「只认传入目录」，漏传清单不会误碰真实用户目录', () => {
    const cleanupSrc = readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'cleanup.ts'), 'utf8');
    const runsSrc = readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'runs.ts'), 'utf8');
    expect(cleanupSrc).toMatch(/const runStateDirs = runStateDirsOverride \?\? \[stateDir\];/);
    expect(runsSrc).toMatch(/const dirs = runStateDirsOverride \?\? \[stateDir\];/);
  });

  it('T02808：目录角色判定复用 isLegacyStateDir，不再另写一份「哪个是规范目录」', () => {
    // 清单随状态返回后，「规范/遗留」就有了第二个消费方。两处各算一套的话，
    // 高级面板标「当前存放位置」而清理预览标「旧存放位置」会同屏矛盾（T02843 同族症状）。
    const cleanupSrc = readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'cleanup.ts'), 'utf8');
    expect(cleanupSrc).toMatch(/role: isLegacyStateDir\(dir\) \? 'legacy' : 'canonical'/);
    // 目录清单里的路径必须是 getRunStateDirs 的返回项原文（不 resolve 成别的写法、不相对化）
    expect(cleanupSrc).toMatch(/path: dir,/);
  });
});

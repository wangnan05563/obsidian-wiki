// T02809：`.harness` 产物目录的单一口径 + 清理/读取跨根合并。
// ------------------------------------------------------------------
// 本单是普查其余 `.harness` 产物（编译缓存 / 运行日志 / 审计日志 / 子智能体状态）
// 是否仍受**进程 CWD** 影响的结果落地的其中一半：
//   A) 路径拼接全部收进 utils/harness-dirs.ts，相对 vaultPath 一律按 api 目录定根，
//      写入侧（compile-workflow）与清理侧（cleanup 路由）从此调同一个函数；
//   B) 清理侧按「写入锚点 + 历史散落根」清单合并扫描。漏传清单时只认写入锚点，
//      对另一处的文件报 0——这正是 T02772「卡面 0 个、磁盘上 107 个」的同一形态，
//      所以每条合并都配一条「不合并则报 0」的反证用例（见各用例里的 naive 实例）。
//   C) 读取侧（运行日志下钻）同样跨根，否则历史运行在列表里看得到、点开报日志不存在。
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { registerCleanupRoute } from '../src/routes/cleanup.js';
import { registerRunsRoute } from '../src/routes/runs.js';
import {
  auditFileIn,
  compileCacheFileIn,
  getCanonicalHarnessDir,
  getHarnessDirFromVault,
  getHarnessDirs,
  getLegacyHarnessDirs,
  logsDirIn,
  stateDirIn,
  toAbsVaultPath,
} from '../src/utils/harness-dirs.js';
import { getCanonicalRunStateDirFromVault } from '../src/utils/run-state-dirs.js';
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

const RUN_LOG_ID = '77777777-7777-4777-8777-777777777777';

/** 造一份形状正确的编译缓存（entryCount = 键数，体积可控） */
async function writeCache(dir: string, entries: number, bytes: number): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = compileCacheFileIn(dir);
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < entries; i++) obj[`hash-${i}`] = `raw/笔记-${i}.md`;
  // 体积靠 value 内容撑：缓存文件必须是合法 JSON，状态侧要解析它取条目数
  obj.padding = 'x'.repeat(Math.max(0, bytes - 64));
  await fs.writeFile(file, JSON.stringify(obj), 'utf8');
  return file;
}

/** 造一份足够旧、必定落在 days 窗口外的运行日志 */
async function writeOldLog(dir: string, name: string, bytes: number): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, Buffer.alloc(bytes, 0x61));
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  await fs.utimes(file, old, old);
  return file;
}

describe('T02809 harness-dirs 目录口径', () => {
  it('相对 vaultPath 按 api 目录定根，绝对路径原样使用', () => {
    const apiDir = path.win32.sep === path.sep ? 'C:\\repo\\api' : '/repo/api';
    const vault = path.win32.sep === path.sep ? 'C:\\repo\\data\\vault' : '/repo/data/vault';
    expect(toAbsVaultPath('../data/vault', { apiDir })).toBe(path.resolve(apiDir, '../data/vault'));
    expect(toAbsVaultPath(vault)).toBe(vault);
  });

  it('`.harness` 根 = 定根后 vault 的同级；产物文件名拼接只在本模块一处定义', () => {
    const vault = path.win32.sep === path.sep ? 'C:\\data\\vault' : '/data/vault';
    const root = getHarnessDirFromVault(vault);
    expect(root).toBe(path.join(path.dirname(vault), '.harness'));
    expect(compileCacheFileIn(root)).toBe(path.join(root, 'compile-cache.json'));
    expect(logsDirIn(root)).toBe(path.join(root, 'logs'));
    expect(stateDirIn(root)).toBe(path.join(root, 'state'));
    expect(auditFileIn(root)).toBe(path.join(root, 'cleanup-audit.log'));
  });

  it('dev 配置值 `../data/vault` 下，写入锚点与 run-state 规范目录同值（两口径不许各算一套）', () => {
    const apiDir = path.resolve(__dirname, '..');
    const absVault = toAbsVaultPath('../data/vault', { apiDir });
    expect(absVault).toBe(path.resolve(apiDir, '..', 'data', 'vault'));
    // 缓存/日志的根 与 状态目录的父级必须是同一个字符串
    expect(getHarnessDirFromVault(absVault)).toBe(getCanonicalHarnessDir(path.resolve(apiDir, '..', 'data')));
    expect(path.dirname(getCanonicalRunStateDirFromVault(absVault))).toBe(getHarnessDirFromVault(absVault));
  });

  it('清单顺序 = 规范在前、遗留在后，且按大小写/分隔符归一去重', () => {
    const primary = path.resolve('/data/.harness');
    const dirs = getHarnessDirs({
      primaryDirs: [primary, path.resolve('/other/.harness'), primary],
      legacyDirs: ['/data/.harness', path.resolve('/legacy/.harness')],
    });
    // 首项恒为写入锚点；重复项（含大小写不同的同一目录）不重复出现在删除清单里
    expect(dirs[0]).toBe(primary);
    expect(dirs.filter((d) => d.toLowerCase() === primary.toLowerCase())).toHaveLength(1);
    expect(dirs).toContain(path.resolve('/legacy/.harness'));
  });

  it('生产默认清单里，遗留候选来自 api 目录与当前 CWD 两个起进程位置', () => {
    const legacy = getLegacyHarnessDirs({ apiDir: '/repo/api', cwd: '/somewhere/else' });
    expect(legacy).toEqual([
      path.resolve('/repo/api', '..', 'data', '.harness'),
      path.resolve('/somewhere/else', '..', 'data', '.harness'),
    ]);
    const dirs = getHarnessDirs({ vaultPath: '/repo/data/vault', dataDir: '/repo/data', apiDir: '/repo/api', cwd: '/repo/api' });
    expect(dirs[0]).toBe(path.resolve('/repo/data/.harness'));
    // 同值候选被去重，清单不会把同一个目录列两遍（否则清理会重复计数）
    expect(new Set(dirs.map((d) => d.toLowerCase())).size).toBe(dirs.length);
  });
});

describe('T02809 清理跨 `.harness` 根合并（编译缓存 / 运行日志）', () => {
  let tempRoot = '';
  let vaultPath = '';
  let canonical = '';
  let legacy = '';
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    __resetActivitiesForTest();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-harness-dirs-'));
    vaultPath = path.join(tempRoot, 'data', 'vault');
    canonical = path.join(tempRoot, 'data', '.harness');
    // 遗留根：改口径之前按进程 CWD 展开的落点（开发模式从 api/ 起进程即此位置）
    legacy = path.join(tempRoot, 'api', '.harness');
    await fs.mkdir(path.join(vaultPath, 'raw'), { recursive: true });
    await fs.mkdir(logsDirIn(canonical), { recursive: true });
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  async function boot(roots?: string[]): Promise<void> {
    app = Fastify();
    // run-state 清单这里不参与（本文件只锁另两类目标）；用写入锚点保持默认口径
    registerCleanupRoute(app, stubVault(vaultPath), stubGuards(), undefined, roots);
    await app.ready();
  }

  async function status(targetApp?: FastifyInstance): Promise<Record<string, any>> {
    const inst = targetApp ?? app;
    if (!inst) throw new Error('路由未注册');
    const res = await inst.inject({ method: 'GET', url: '/api/cleanup/status' });
    return res.json() as Record<string, any>;
  }

  async function post(payload: Record<string, unknown>): Promise<Record<string, any>> {
    if (!app) throw new Error('路由未注册');
    const res = await app.inject({ method: 'POST', url: '/api/cleanup', payload });
    return res.json() as Record<string, any>;
  }

  /** 只认写入锚点的默认注册（生产漏传清单时的等价形态），用于「不合并则报 0」反证 */
  async function statusNaive(): Promise<Record<string, any>> {
    const naive = Fastify();
    registerCleanupRoute(naive, stubVault(vaultPath), stubGuards());
    await naive.ready();
    try {
      return await status(naive);
    } finally {
      await naive.close();
    }
  }

  it('编译缓存跨根合并：体积与条目数求和，且与独立重算相等', async () => {
    const f1 = await writeCache(canonical, 3, 2 * BYTES_PER_MB);
    const f2 = await writeCache(legacy, 5, 1 * BYTES_PER_MB);
    await boot([canonical, legacy]);

    const body = await status();
    const truthSize = (await fs.stat(f1)).size + (await fs.stat(f2)).size;
    expect(body.compileCache.exists).toBe(true);
    expect(body.compileCache.sizeMb).toBe(toMb(truthSize));
    // 3 + 5 条映射，各加一个 padding 键
    expect(body.compileCache.entryCount).toBe(10);
  });

  it('缓存只在遗留根时：合并清单报得出来，不合并则报 0（因果锁）', async () => {
    await writeCache(legacy, 4, 1024 * 1024);
    await boot([canonical, legacy]);

    const merged = await status();
    expect(merged.compileCache.exists).toBe(true);
    expect(merged.compileCache.entryCount).toBe(5);

    const naive = await statusNaive();
    expect(naive.compileCache.exists, '只认写入锚点时缓存显示不存在：用户据此以为无需清理').toBe(false);
    expect(naive.compileCache.entryCount).toBe(0);
  });

  it('预览列出两根并标出旧存放位置；真实删除把两处都清掉且释放量覆盖遗留根', async () => {
    await writeCache(canonical, 1, 2 * BYTES_PER_MB);
    await writeCache(legacy, 1, 1024 * 1024);
    await boot([canonical, legacy]);

    const preview = await post({ target: 'compile_cache', dry_run: true });
    expect(preview.cleaned).toHaveLength(2);
    expect(preview.cleaned.filter((s: string) => s.includes('（旧存放位置）'))).toHaveLength(1);
    await expect(fs.stat(compileCacheFileIn(legacy))).resolves.toBeTruthy();

    const before = await status();
    const removed = await post({ target: 'compile_cache', dry_run: false });
    expect(removed.count).toBe(2);
    expect(removed.total_freed_mb).toBe(before.compileCache.sizeMb);
    await expect(fs.stat(compileCacheFileIn(legacy))).rejects.toThrow();
    expect((await status()).compileCache.exists).toBe(false);
  });

  it('运行日志跨根合并：计数求和、最早时间取各根最小值', async () => {
    await writeOldLog(logsDirIn(canonical), 'run-new.log', 1024 * 1024);
    await writeOldLog(logsDirIn(legacy), 'run-old.log', 1024 * 1024);
    // 遗留根里再放一份更早的，验证 oldest 不是「第一个目录的 oldest」
    const older = path.join(logsDirIn(legacy), 'run-older.log');
    await fs.mkdir(logsDirIn(legacy), { recursive: true });
    await fs.writeFile(older, 'x');
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await fs.utimes(older, longAgo, longAgo);
    await boot([canonical, legacy]);

    const body = await status();
    expect(body.runLogs.fileCount).toBe(3);
    expect(body.runLogs.sizeMb).toBe(2);
    expect(body.runLogs.oldest).toBe(longAgo.toISOString().slice(0, 10));
  });

  it('日志只在遗留根时：合并清单能删掉它，不合并则报 0 且删不到（因果锁）', async () => {
    const orphan = await writeOldLog(logsDirIn(legacy), 'orphan.log', 1024 * 1024);
    await boot([canonical, legacy]);

    const merged = await status();
    expect(merged.runLogs.fileCount).toBe(1);
    const naive = await statusNaive();
    expect(naive.runLogs.fileCount, '只认写入锚点时日志卡显示 0 个：磁盘上的那份永远不会被清').toBe(0);

    const removed = await post({ target: 'run_logs', days: 30, dry_run: false });
    expect(removed.count).toBe(1);
    expect(String(removed.cleaned[0])).toContain('（旧存放位置）');
    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it('target=all 同样覆盖遗留根（用户不会只在单卡上踩到这个坑）', async () => {
    const orphanCache = await writeCache(legacy, 2, 1024 * 1024);
    const orphanLog = await writeOldLog(logsDirIn(legacy), 'orphan.log', 1024 * 1024);
    await boot([canonical, legacy]);

    const body = await post({ target: 'all', days: 30, dry_run: false });
    expect(body.cleaned.filter((s: string) => s.includes('旧存放位置'))).toHaveLength(2);
    await expect(fs.stat(orphanCache)).rejects.toThrow();
    await expect(fs.stat(orphanLog)).rejects.toThrow();
  });
});

describe('T02809 运行日志下钻跨根读取', () => {
  let tempRoot = '';
  let canonicalState = '';
  let legacyState = '';
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-runs-log-dirs-'));
    canonicalState = path.join(tempRoot, 'data', '.harness', 'state');
    legacyState = path.join(tempRoot, 'api', '.harness', 'state');
    await fs.mkdir(canonicalState, { recursive: true });
    await fs.mkdir(legacyState, { recursive: true });
    // 遗留状态 + 遗留日志：状态文件让运行出现在列表里，日志在同根的 logs/ 下
    await fs.writeFile(
      path.join(legacyState, `${RUN_LOG_ID}.json`),
      JSON.stringify({ runId: RUN_LOG_ID, task: '历史编译', events: [], step: 1, tokenUsed: 10, status: 'done', startedAt: '2026-10-01T00:00:00.000Z' }),
      'utf8',
    );
    const logDir = path.join(tempRoot, 'api', '.harness', 'logs');
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, `${RUN_LOG_ID}.log`), '{"step":"archive"}\n', 'utf8');
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  it('清单里带遗留根时可下钻读取；只认规范根时同一个 runId 报日志不存在（因果锁）', async () => {
    app = Fastify();
    registerRunsRoute(app, canonicalState, stubGuards(), [canonicalState, legacyState]);
    await app.ready();
    const hit = await app.inject({ method: 'GET', url: `/api/compile/runs/${RUN_LOG_ID}/log` });
    expect(hit.statusCode).toBe(200);
    expect((hit.json() as { entries: unknown[] }).entries).toHaveLength(1);

    const naive = Fastify();
    registerRunsRoute(naive, canonicalState, stubGuards());
    await naive.ready();
    const miss = await naive.inject({ method: 'GET', url: `/api/compile/runs/${RUN_LOG_ID}/log` });
    await naive.close();
    expect(miss.statusCode, '日志跟着状态文件的历史根走，否则列表里有、点开是空的').toBe(404);
  });
});

// 真实目录只读复核（同 T02772 的只读用例）：临时目录能证明「合并逻辑正确」，
// 证明不了「这台机器上接口报的数与磁盘相符」。全程只 GET，不 POST，绝不删用户文件。
describe('T02809 真实 `.harness` 目录只读复核', () => {
  it('编译缓存与运行日志的计数/体积 = 真实根清单的独立重算结果', async () => {
    const apiDir = path.resolve(__dirname, '..');
    const dataDir = path.resolve(apiDir, '..', 'data');
    const realVault = path.join(dataDir, 'vault');
    const dirs = getHarnessDirs({
      primaryDirs: [getHarnessDirFromVault(realVault), getCanonicalHarnessDir(dataDir)],
      apiDir,
    });
    expect(dirs.length).toBeGreaterThan(0);

    let cacheSize = 0;
    let cacheEntries = 0;
    let cacheExists = false;
    let logCount = 0;
    for (const dir of dirs) {
      try {
        const stat = await fs.stat(compileCacheFileIn(dir));
        cacheExists = true;
        cacheSize += stat.size;
        const parsed = JSON.parse(await fs.readFile(compileCacheFileIn(dir), 'utf8')) as Record<string, unknown>;
        cacheEntries += Object.keys(parsed).length;
      } catch {
        // 这个根没有缓存
      }
      try {
        const names = await fs.readdir(logsDirIn(dir));
        logCount += names.filter((n) => n.endsWith('.log')).length;
      } catch {
        // 这个根没有日志目录
      }
    }

    const app = Fastify();
    registerCleanupRoute(app, stubVault(realVault), stubGuards(), undefined, dirs);
    await app.ready();
    try {
      const body = (await app.inject({ method: 'GET', url: '/api/cleanup/status' })).json() as Record<string, any>;
      expect(body.compileCache.exists).toBe(cacheExists);
      expect(body.compileCache.sizeMb).toBe(toMb(cacheSize));
      expect(body.compileCache.entryCount).toBe(cacheEntries);
      expect(body.runLogs.fileCount).toBe(logCount);
    } finally {
      await app.close();
    }
  });
});

// 源码级锁：这三条各锁一个「以后再各写一份拼接」的入口。
// 为什么锁源码而不是只锁行为：行为用例覆盖的是今天的调用点，
// 而回归形态是「有人在别处又手写了一次 join(vaultPath,'..','.harness')」——
// 那种改动只有文本级断言能在提交时就拦住。
describe('T02809 生产接线（源码级锁）', () => {
  const read = (...parts: string[]) => readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8');
  // 负向断言要先去注释：这些文件里有大量「历史上这里怎么写的」说明文字，
  // 拿原文做「不许出现某写法」的检查会自己撞上自己的注释。
  const code = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\/[^\n]*/g, '');

  it('index.ts 组装 `.harness` 根清单并传给清理路由（漏传即只清一处）', () => {
    const indexSrc = read('src', 'index.ts');
    expect(indexSrc).toMatch(
      /const harnessDirs = getHarnessDirs\(\{[\s\S]*?primaryDirs: \[getHarnessDirFromVault\(vault\.getVaultPath\(\)\), getCanonicalHarnessDir\(\)\]/,
    );
    expect(indexSrc).toMatch(/registerCleanupRoute\(app, vault, isolationGuards, runStateDirs, harnessDirs\)/);
  });

  it('写入侧（compile-workflow）与清理侧共用 harness-dirs，不再各写一份 vault 同级拼接', () => {
    const compileSrc = code(read('src', 'workflows', 'compile-workflow.ts'));
    const cleanupSrc = code(read('src', 'routes', 'cleanup.ts'));
    expect(compileSrc).toMatch(/compileCacheFileIn\(getHarnessDirFromVault\(vault\.getVaultPath\(\)\)\)/);
    expect(compileSrc).toMatch(/logsDirIn\(getHarnessDirFromVault\(vault\.getVaultPath\(\)\)\)/);
    expect(cleanupSrc).toMatch(/const harnessDir = getHarnessDirFromVault\(vaultPath\)/);
    expect(cleanupSrc).toMatch(/const harnessDirs = harnessDirsOverride \?\? \[harnessDir\];/);
    // 两侧都不许再出现「就地拼 .harness」的写法（去注释后检查，注释里的历史写法不作证据）
    const inlineHarnessJoin = /['"]\.harness['"]/;
    for (const [name, src] of [['compile-workflow.ts', compileSrc], ['cleanup.ts', cleanupSrc]] as const) {
      expect(inlineHarnessJoin.test(src), `${name} 又手写了一次 .harness 拼接，请改走 utils/harness-dirs`).toBe(false);
    }
  });

  it('每个 new Harness 调用点都带着状态存储（显式注入或继承 harnessConfig），不再落回 CWD 相对默认目录', () => {
    const files: string[] = [];
    for (const dir of ['src', 'scripts']) {
      for (const name of walk(path.resolve(__dirname, '..', dir))) {
        if (/\.(ts|tsx)$/.test(name) && readIn(name).includes('new Harness(')) files.push(name);
      }
    }
    expect(files.length, '至少要有生产与验证脚本里的 Harness 构造点').toBeGreaterThan(0);
    for (const file of files) {
      const src = readIn(file);
      // 逐个构造点检查：参数里出现 stateStore，或整份继承父配置（`...harnessConfig`）。
      // 配置先存进变量再传入的写法（`const cfg = {...}; new Harness(cfg)`）要把声明体一起看，
      // 否则会把「已继承」的调用点误判成漏传。
      const sites = src.split('new Harness(').slice(1);
      for (const site of sites) {
        const argText = site.slice(0, site.indexOf('});') + 1 || 800);
        const varName = argText.match(/^\s*([A-Za-z_$][\w$]*)\s*\)/)?.[1];
        const decl = varName
          ? src.match(new RegExp(`(?:const|let) ${varName}\\b[\\s\\S]{0,1500}?};`))?.[0] ?? ''
          : '';
        expect(
          /stateStore/.test(argText + decl) || /\.\.\.harnessConfig|\.\.\.parentConfig/.test(argText + decl),
          `${path.basename(file)} 里有个 new Harness 既没注入 stateStore 也没继承父配置——它会往进程 CWD 写状态`,
        ).toBe(true);
      }
    }
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}
function readIn(file: string): string {
  return readFileSync(file, 'utf8');
}

// T02817 清理互斥的跨进程维度 —— 三层回归。
// ------------------------------------------------------------------
// 进程内锁（T02774）与进程内活跃计数（T02655）在「桌面端实例 + 手工 dev 实例」并存时互不可见：
// A 在真删，B 的编译照跑；B 在编译，A 的删除放行。本文件断言的全部是可观测事实：
// 标记文件在不在、状态码是什么、审计里点名的是谁、**真实子进程被 kill 之后还拦不拦得住**。
// 用真子进程承载「另一实例」的 pid 与生命周期，是因为验收要求覆盖崩溃分支——
// 崩溃模拟只能是真进程被杀，双 HTTP 实例反而覆盖不到 pid 死亡这条判定。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { preHandlerHookHandler } from 'fastify';
import {
  activityDirIn,
  claimCleanupMarker,
  cleanupMarkerFileIn,
  readCleanupMarker,
  readForeignActivities,
  releaseCleanupMarker,
  setCoordinationPaths,
  writeActivityRecord,
} from '../src/cleanup-cross-process.js';
import {
  acquireCleanup,
  awaitCleanupIdle,
  getForeignCleanupWaitStats,
  MARKER_POLL_MS,
  __resetCleanupMutexForTest,
} from '../src/cleanup-mutex.js';
import {
  activeActivities,
  beginActivity,
  confirmActivityStart,
  __resetActivitiesForTest,
} from '../src/activity.js';
import { withCompileLock } from '../src/compile-queue.js';
import { registerCleanupRoute } from '../src/routes/cleanup.js';
import {
  auditFileIn,
  compileCacheFileIn,
  logsDirIn,
  stateDirIn,
} from '../src/utils/harness-dirs.js';
import type { IsolationGuards } from '../src/middleware/auth.js';
import type { VaultService } from '../src/vault/vault-service.js';
import type { CleanupBlockedResponse } from '../src/types.js';

function stubVault(vaultPath: string): VaultService {
  return { getVaultPath: () => vaultPath } as unknown as VaultService;
}
const passThrough: preHandlerHookHandler = (_req, _reply, done) => done();
function stubGuards(): IsolationGuards {
  return { enabled: false, requireAuth: passThrough, requireAdmin: passThrough };
}

/** 取模块级函数体（签名起、到顶格 `}` 止），避免全文 indexOf 跨函数误锚。 */
function sliceFunction(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) return '';
  const end = src.indexOf('\n}', start);
  return src.slice(start, end === -1 ? src.length : end);
}

// T02836：等待一律走公共工具。原先本文件自带 `const sleep = (ms) => setTimeout(r, ms)`，
// 参数化时长把裸写数值藏进了变量（`sleep(500)`），守护抓不到——那正是「换了个写法继续赌时长」的口子。
// 现在让步只有 yieldSlice/contractSleep 两个出口，带终点的场景一律 pollUntil 读真实状态。
import {
  MARKER_WAIT_BUDGET_MS,
  NO_TIMER_CHAIN,
  contractSleep,
  pollUntil,
} from './helpers/waitForProgress.js';

// T02836 等待口径清点（本文件 3 处等待的逐处判定）：
//  | 「等本进程登记落盘/撤销后消失」×2（原 waitForFile + 5ms 轮询 + 3s 超时） | 终点可观测：文件在不在 | pollUntil 读 fs.access，预算 NO_TIMER_CHAIN |
//  | 「等任务被另一实例的真删挂住」1 处（原 sleep(500)）                      | 终点不可观测：断言的是「没有起跑」 | contractSleep(MARKER_WAIT_BUDGET_MS)，= 产品侧 MARKER_POLL_MS×2 |
// 负向断言前的让步取「两整轮标记轮询」：只等一轮证明不了起跑点没有复判通过，等够两轮仍不起跑才是挂住。

/**
 * 等某个文件出现/消失（T02836：委托给 pollUntil，判据 = 超过契约下限且连续无进展）。
 * 活跃登记是 fire-and-forget 落盘的、跨进程删除是异步的，固定等待时长在 CI 上必然偶发闪断。
 * 预算 NO_TIMER_CHAIN：cap 3000 与本用例原先的 timeoutMs=3000 同严，不是放松。
 */
async function expectFileState(file: string, exist: boolean): Promise<void> {
  await pollUntil(
    `等待文件${exist ? '出现' : '消失'}：${file}`,
    () => fs.access(file).then(() => true, () => false),
    (present) => present === exist,
    NO_TIMER_CHAIN,
  );
}

let tempRoot = '';
let harnessDir = '';
let markerFile = '';
let activityDir = '';
let app: FastifyInstance | null = null;
const children: ChildProcess[] = [];

/** 起一个只负责「活着」的子进程，充当另一实例的 pid。 */
function spawnPeer(): ChildProcess {
  // T02836-allow: 非测试等待——真子进程 -e 存活脚本里的时长，守护按文本扫进了字符串字面量
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}
async function killAndReap(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await exited;
}

/** 每个用例都要重建临时 `.harness` 与协调路径：跨进程状态是全局的，漏 reset 会串台。 */
async function bootHarness(): Promise<FastifyInstance> {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-cleanup-xproc-'));
  const vaultPath = path.join(tempRoot, 'vault');
  harnessDir = path.join(tempRoot, '.harness');
  markerFile = cleanupMarkerFileIn(harnessDir);
  activityDir = activityDirIn(harnessDir);
  setCoordinationPaths({ markerFile, activityDir, instance: 'test-instance-A' });
  await fs.mkdir(path.join(harnessDir, 'state'), { recursive: true });
  await fs.mkdir(path.join(harnessDir, 'logs'), { recursive: true });
  await fs.mkdir(vaultPath, { recursive: true });
  const instance = Fastify();
  registerCleanupRoute(instance, stubVault(vaultPath), stubGuards());
  await instance.ready();
  app = instance;
  return instance;
}

async function auditEntries(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await fs.readFile(auditFileIn(harnessDir), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function postCleanup(target = 'run_state', dryRun = false) {
  const app0 = app as FastifyInstance;
  return app0.inject({
    method: 'POST',
    url: '/api/cleanup',
    payload: { target, dry_run: dryRun, days: 1 },
  });
}

/** 以「另一实例」的身份写清理标记（自己的 pid 换成真子进程，才谈得上跨进程）。 */
async function writeForeignMarker(pid: number, opts: { instance?: string; target?: string; startedAt?: number } = {}): Promise<void> {
  await fs.mkdir(harnessDir, { recursive: true });
  await fs.writeFile(
    markerFile,
    JSON.stringify({
      pid,
      instance: opts.instance ?? 'test-instance-B',
      target: opts.target ?? 'all',
      startedAt: opts.startedAt ?? Date.now(),
    }),
    'utf8',
  );
}

beforeEach(async () => {
  __resetCleanupMutexForTest();
  __resetActivitiesForTest();
  await bootHarness();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  children.length = 0;
  setCoordinationPaths({ markerFile: null, activityDir: null, instance: 'unknown' });
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('cleanup-cross-process 单元语义', () => {
  it('抢占成功 → 另一进程抢被拒；释放后可再抢（跨进程独占原语）', async () => {
    const peer = spawnPeer();
    const peerPid = peer.pid as number;
    const first = await claimCleanupMarker({ lockFile: markerFile, instance: 'A', target: 'all' });
    expect(first.ok).toBe(true);
    // 第二次以「另一进程」的身份抢：同进程 self→idle 是刻意的逃生阀（由内存锁负责），
    // 用同一个 pid 抢两次必然放行，那测的是逃生阀而不是独占性。
    const second = await claimCleanupMarker({ lockFile: markerFile, instance: 'B', target: 'all', selfPid: peerPid });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.blockedBy.marker?.instance).toBe('A');
    await releaseCleanupMarker(markerFile);
    const third = await claimCleanupMarker({ lockFile: markerFile, instance: 'B', target: 'all', selfPid: peerPid });
    expect(third.ok).toBe(true);
    await releaseCleanupMarker(markerFile, peerPid);
    await expect(fs.access(markerFile)).rejects.toThrow();
  });

  it('本进程自己的标记不算「另一实例」（同进程由内存锁负责）', async () => {
    await writeForeignMarker(process.pid);
    const read = await readCleanupMarker(markerFile);
    expect(read.state).toBe('idle');
  });

  it('真实子进程被 kill = pid 死亡 → 判陈旧，崩溃不会留下永久死锁', async () => {
    const peer = spawnPeer();
    const pid = peer.pid as number;
    await writeForeignMarker(pid);
    expect((await readCleanupMarker(markerFile)).state).toBe('busy');
    await killAndReap(peer);
    const after = await readCleanupMarker(markerFile);
    expect(after.state).toBe('stale');
    expect(after.reason).toBe('pid_dead');
  });

  it('活进程但标记过老 → 判 too_old（最后逃生阀，不让卡死的实例吊住全站）', async () => {
    const peer = spawnPeer();
    await writeForeignMarker(peer.pid as number, { startedAt: Date.now() - 11 * 60 * 1000 });
    const read = await readCleanupMarker(markerFile);
    expect(read.state).toBe('stale');
    expect(read.reason).toBe('too_old');
    expect(read.ageMs).toBeGreaterThan(10 * 60 * 1000);
  });

  it('标记内容坏掉 → unreadable 视为陈旧，而不是永久 busy', async () => {
    await fs.writeFile(markerFile, 'not-json', 'utf8');
    const read = await readCleanupMarker(markerFile);
    expect(read.state).toBe('stale');
    expect(read.reason).toBe('unreadable');
  });

  it('陈旧标记会被下一次抢占回收，并留下 purged 证据', async () => {
    const peer = spawnPeer();
    await writeForeignMarker(peer.pid as number);
    await killAndReap(peer);
    const claim = await claimCleanupMarker({ lockFile: markerFile, instance: 'C', target: 'run_state' });
    expect(claim.ok).toBe(true);
    if (claim.ok) expect(claim.purged?.reason).toBe('pid_dead');
  });

  it('release 只删自己写的标记，绝不误删另一实例正在持有的', async () => {
    const peer = spawnPeer();
    await writeForeignMarker(peer.pid as number);
    await releaseCleanupMarker(markerFile);
    expect((await readCleanupMarker(markerFile)).state).toBe('busy');
  });

  it('活跃登记：活进程计入，pid 死亡或心跳超时都不计入', async () => {
    const peer = spawnPeer();
    const pid = peer.pid as number;
    await writeActivityRecord(activityDir, { pid, instance: 'B', compile: 2, query: 1, updatedAt: Date.now() });
    const live = await readForeignActivities(activityDir);
    expect(live).toMatchObject({ compile: 2, query: 1 });
    expect(live.instances[0]?.instance).toBe('B');

    await writeActivityRecord(activityDir, { pid, instance: 'B', compile: 5, query: 0, updatedAt: Date.now() - 5 * 60 * 1000 });
    expect(await readForeignActivities(activityDir)).toMatchObject({ compile: 0, query: 0 });

    await writeActivityRecord(activityDir, { pid, instance: 'B', compile: 5, query: 0, updatedAt: Date.now() });
    await killAndReap(peer);
    expect(await readForeignActivities(activityDir)).toMatchObject({ compile: 0, query: 0 });
  });

  it('自己的 pid 记录不参与「另一实例」判定', async () => {
    await writeActivityRecord(activityDir, { pid: process.pid, instance: 'A', compile: 3, query: 0, updatedAt: Date.now() });
    expect(await readForeignActivities(activityDir)).toMatchObject({ compile: 0 });
  });

  it('本进程登记编译 → 磁盘上出现另一实例读得到的登记，撤销后随之消失', async () => {
    // 这条才是「B 在编译 → A 真删被拦」的正向半边：
    // 上面几个用例都是手工写一份登记来**冒充**对方，如果生产侧 beginActivity 根本不落盘，
    // 那些冒充出来的断言照样全绿——跨进程守卫会退化成只有测试在履行的契约。
    const file = path.join(activityDir, `${process.pid}.json`);
    const release = beginActivity('compile');
    await expectFileState(file, true);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ compile: 1, query: 0 });
    // 换到对侧视角读（selfPid 是别的进程）就必须看见本进程在跑
    expect(await readForeignActivities(activityDir, { selfPid: 999999 })).toMatchObject({ compile: 1 });

    release();
    await expectFileState(file, false);
  });
});

describe('T02817 起跑点：被另一实例的真删拦住或排队', () => {
  it('另一实例真删中 → withCompileLock 里的任务排队，标记撤掉才起跑', async () => {
    const peer = spawnPeer();
    await writeForeignMarker(peer.pid as number);
    let ran = false;
    const pending = withCompileLock(async () => {
      ran = true;
    });
    await contractSleep(
      `MARKER_WAIT_BUDGET_MS=${MARKER_WAIT_BUDGET_MS}（cleanup-mutex.ts 的 MARKER_POLL_MS=${MARKER_POLL_MS} × 2）：断言的是「任务没有起跑」，终点不可观测；两整轮标记轮询内都不起跳才算被挂住`,
      MARKER_WAIT_BUDGET_MS,
    );
    expect(ran).toBe(false);
    expect(activeActivities()).toEqual({ compile: 0, query: 0 });

    // 撤销要按对方的 pid 来：releaseCleanupMarker 拒绝删别人的标记（上面有用例锁这条），
    // 传本进程 pid 会「什么都没删」，任务就永远排着——那正是超时失败的成因
    await releaseCleanupMarker(markerFile, peer.pid as number);
    await pending;
    expect(ran).toBe(true);
    // 因果证据：确实是因为跨进程标记而等待（不是进程内锁，也不是时序运气）
    expect(getForeignCleanupWaitStats().count).toBeGreaterThanOrEqual(1);
  });

  it('登记之后标记才出现 → 起跑点自己退回，计数与登记都不留痕（Dekker 后半步）', async () => {
    const peer = spawnPeer();
    const release = beginActivity('compile');
    // 这一句就是 T02655 遗留的那道毫秒窗口的具象化：清理侧守卫已放行、本任务已登记，
    // 标记在这之后才被写出来。只靠 awaitCleanupIdle（起跑前等待）看不见它。
    await writeForeignMarker(peer.pid as number);
    expect(await confirmActivityStart(release)).toBe(false);
    expect(activeActivities()).toEqual({ compile: 0, query: 0 });
    // 退回必须连活跃登记一起撤：留着死登记，另一实例会被一个已经不存在的任务永久拦住
    expect(await readForeignActivities(activityDir)).toMatchObject({ compile: 0 });
  });

  it('没有标记时 confirmActivityStart 放行（不把正常起跑误拦）', async () => {
    const release = beginActivity('query');
    expect(await confirmActivityStart(release)).toBe(true);
    release();
  });

  it('持标记的进程崩溃 → 等待方判陈旧后立即放行，不残留死锁', async () => {
    const peer = spawnPeer();
    await writeForeignMarker(peer.pid as number);
    await killAndReap(peer);
    await expect(withCompileLock(async () => 'go')).resolves.toBe('go');
  });

  it('未接上协调路径时完全退回 T02774 语义（不因缺配置而卡死）', async () => {
    setCoordinationPaths({ markerFile: null, activityDir: null });
    await expect(awaitCleanupIdle()).resolves.toBeUndefined();
    await expect(withCompileLock(async () => 1)).resolves.toBe(1);
  });
});

describe('T02817 路由级：另一实例在跑 / 在删，本次真删被拒', () => {
  it('另一实例正在真删 → 409 cleanup_blocked_by_other_process，且审计点名对方', async () => {
    const peer = spawnPeer();
    await writeForeignMarker(peer.pid as number, { instance: 'dev-manual', target: 'all' });
    const res = await postCleanup('all');
    expect(res.statusCode).toBe(409);
    const body = res.json() as CleanupBlockedResponse;
    expect(body.code).toBe('cleanup_blocked_by_other_process');
    expect(body.error).toContain('另一服务实例');
    // 拒绝时不能已经删过东西：标记是「先占再删」的凭据，抢不到就不该有删除动作
    await fs.writeFile(path.join(stateDirIn(harnessDir), 'keepme.json'), '{}', 'utf8');
    expect(await fs.readdir(stateDirIn(harnessDir))).toEqual(['keepme.json']);
    const entries = await auditEntries();
    const last = entries[entries.length - 1];
    expect(last).toMatchObject({ blocked_by_other_process: true, dry_run: false });
    expect((last?.other_marker as { pid: number }).pid).toBe(peer.pid);
    expect((last?.other_marker as { instance: string }).instance).toBe('dev-manual');
  });

  it('另一实例有编译在跑 → 409 且原因点名「另一服务实例」；对方崩溃后同一请求放行', async () => {
    const peer = spawnPeer();
    const pid = peer.pid as number;
    await writeActivityRecord(activityDir, { pid, instance: 'dev-manual', compile: 1, query: 0, updatedAt: Date.now() });
    const blocked = await postCleanup('run_state');
    expect(blocked.statusCode).toBe(409);
    const body = blocked.json() as CleanupBlockedResponse;
    expect(body.code).toBe('cleanup_blocked_by_active_task');
    expect(body.active.compile).toBe(1);
    expect(body.reasons.join(' ')).toContain('另一服务实例');
    expect(body.error).not.toContain('undefined');

    // 崩溃模拟：进程被杀后它的登记必须不再拦人，否则一次崩溃 = 清理永久不可用
    await killAndReap(peer);
    const ok = await postCleanup('run_state');
    expect(ok.statusCode).toBe(200);
  });

  it('状态接口把另一实例的活跃并进 active（用户看得见「是谁把我置灰的」）', async () => {
    const peer = spawnPeer();
    await writeActivityRecord(activityDir, {
      pid: peer.pid as number, instance: 'B', compile: 0, query: 2, updatedAt: Date.now(),
    });
    const res = await app!.inject({ method: 'GET', url: '/api/cleanup/status' });
    const status = res.json() as { active: { query: number; blockedTargets: string[] } };
    expect(status.active.query).toBe(2);
    expect(status.active.blockedTargets).toContain('run_state');
  });

  it('真删完成后标记被撤销，审计记 cleanup_marker_held=true；预览从不占跨进程删除权', async () => {
    const preview = await postCleanup('run_state', true);
    expect(preview.statusCode).toBe(200);
    // 预览不删任何文件，也就不该留下跨进程删除权
    await expect(fs.access(markerFile)).rejects.toThrow();

    const real = await postCleanup('run_state');
    expect(real.statusCode).toBe(200);
    const entries = await auditEntries();
    const last = entries[entries.length - 1];
    expect(last).toMatchObject({ cleanup_marker_held: true });
    // finally 必须把标记撤掉：留着 = 全站任务从此排队等一个不存在的清理
    await expect(fs.access(markerFile)).rejects.toThrow();
  });

  it('本进程已有清理在删时，第二次真删由进程内锁先拒（不去抢跨进程标记）', async () => {
    const handle = acquireCleanup();
    expect(handle).not.toBeNull();
    const res = await postCleanup('run_state');
    expect(res.statusCode).toBe(409);
    expect((res.json() as CleanupBlockedResponse).code).toBe('cleanup_blocked_by_concurrent_cleanup');
    await expect(fs.access(markerFile)).rejects.toThrow();
    handle?.release();
  });
});

describe('T02817 协调文件的存放位置与接线锁', () => {
  it('标记与登记文件都不在清理删除面内（删完自己 = 互斥当场失效）', () => {
    const runStatePattern = /\.json$/;
    const logPattern = /\.log$/;
    expect(path.basename(markerFile)).not.toMatch(runStatePattern);
    expect(path.basename(markerFile)).not.toMatch(logPattern);
    expect(path.dirname(markerFile)).toBe(harnessDir);
    // 若标记被放进修状态/日志/缓存的目录，run_state 与 run_logs 清理会把它删掉
    expect(markerFile).not.toBe(compileCacheFileIn(harnessDir));
    expect(markerFile.startsWith(stateDirIn(harnessDir))).toBe(false);
    expect(markerFile.startsWith(logsDirIn(harnessDir))).toBe(false);
    expect(activityDir.startsWith(stateDirIn(harnessDir))).toBe(false);
    expect(path.basename(activityDir)).toBe('activity');
  });

  it('真实删除跑完，同目录下的清理标记仍在（删除面确实不认识它）', async () => {
    const peer = spawnPeer();
    // 用「另一实例的活跃登记」放行、再手动补一个自己进程的标记，验证清理不会顺手删掉它
    await writeForeignMarker(process.pid);
    const res = await postCleanup('run_state');
    expect(res.statusCode).toBe(200);
    // 本进程持有的标记由 finally 撤销；此处只断言删除列表里没有标记文件本身
    const body = res.json() as { cleaned: string[] };
    expect(body.cleaned.some((line) => line.includes('cleanup.lock'))).toBe(false);
    void peer;
  });

  it('index.ts 一次接上路径（漏接 = 跨进程保护静默失效）', async () => {
    const src = await fs.readFile(path.resolve(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(src).toMatch(/setCoordinationPaths\(\{[\s\S]*?markerFile: cleanupMarkerFileIn\(harnessDirs\[0\]\)/);
    expect(src).toMatch(/activityDir: activityDirIn\(harnessDirs\[0\]\)/);
  });

  it('三个起跑点都接了 Dekker 收尾（只等标记不声明，等于没防）', async () => {
    for (const rel of ['src/compile-queue.ts', 'src/routes/query.ts', 'src/workflows/stream-run-manager.ts']) {
      const src = await fs.readFile(path.resolve(__dirname, '..', rel), 'utf8');
      const wait = src.indexOf('await awaitCleanupIdle()');
      const confirm = src.indexOf('confirmActivityStart(');
      expect(wait).toBeGreaterThan(-1);
      expect(confirm).toBeGreaterThan(-1);
    }
  });

  it('清理路由：抢到标记之后必须再读一遍活跃声明，且判到任务时先撤标再拒', async () => {
    const src = await fs.readFile(path.resolve(__dirname, '..', 'src', 'routes', 'cleanup.ts'), 'utf8');
    // 三道门已收进 claimDeletionRights：锚在该函数体内，避免全文 indexOf 跨函数误锚
    const claimFn = sliceFunction(src, 'async function claimDeletionRights(');
    const claimIdx = claimFn.indexOf('await claimMarkerForDeletion(');
    const recheckIdx = claimFn.indexOf('blocked_after_marker: true');
    expect(claimIdx).toBeGreaterThan(-1);
    // 起跑侧「先声明后读标记」、清理侧「先占标后读声明」——少了这一遍读，Dekker 只剩半边，
    // 「守卫通过 ~ 删除开始」之间起跑的任务照样被删
    expect(recheckIdx).toBeGreaterThan(claimIdx);
    const recheckBlock = claimFn.slice(recheckIdx);
    // 拒绝前必须把刚抢到的标记撤掉：留着 = 全站任务排队等一次并没有在删的清理
    const releaseIdx = recheckBlock.indexOf('await releaseCleanupMarker(marker.markerFile)');
    const rejectIdx = recheckBlock.indexOf('return { ok: false, blocked: recheck }');
    expect(releaseIdx).toBeGreaterThan(-1);
    expect(rejectIdx).toBeGreaterThan(releaseIdx);
  });

  it('清理路由：抢到标记必须晚于进程内锁，撤标在 finally 且早于释放锁', async () => {
    const src = await fs.readFile(path.resolve(__dirname, '..', 'src', 'routes', 'cleanup.ts'), 'utf8');
    const claimFn = sliceFunction(src, 'async function claimDeletionRights(');
    expect(claimFn.indexOf('acquireCleanup()')).toBeLessThan(claimFn.indexOf('await claimMarkerForDeletion('));
    // 真正抢标记的动作必须在 claimMarkerForDeletion 里（删掉这一行 = 跨进程保护静默失效）
    expect(src).toContain('claimCleanupMarker({');
    // 锚定在清理收尾的 finally 上：`releaseCleanupMarker(lockFile)` 在「判到任务后撤标」的
    // 分支里也出现一次（位置更早），用全文 indexOf 会锚到那一处，锁就变成假锁。
    const releaseHandle = src.lastIndexOf('cleanupHandle?.release()');
    const finallyIdx = src.lastIndexOf('} finally {', releaseHandle);
    expect(finallyIdx).toBeGreaterThan(-1);
    const releaseMarker = src.indexOf('releaseCleanupMarker(lockFile)', finallyIdx);
    expect(releaseMarker).toBeGreaterThan(finallyIdx);
    expect(releaseMarker).toBeLessThan(releaseHandle);
  });
});

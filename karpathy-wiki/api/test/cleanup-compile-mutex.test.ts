// T02774 清理与编译/问答互斥 —— 把「守卫通过 ~ 删除完成」的残留窗口封成机制上的零。
// ------------------------------------------------------------------
// T02655 已经做到「有任务在跑就别删」，但它读的是瞬时快照：判定通过后删除才异步进行，
// 正好落在这段窗口里起跑的任务，它的续传基准仍会被抹掉。本单补的是这最后一段，
// 所以断言不能只看「功能跑通了」，必须看到三件可观测事实：
//  1) 清理持锁期间，任务**没有起跑**（活跃计数为 0、adapter 从未进入）；
//  2) 第二次真实清理被拒（同进程同时只允许一次删除），预览不受影响；
//  3) 台账能区分「被拦的真实删除」与「清理完成时曾有任务排队」。
// 另外附一组源码接线锁：这套互斥靠「每个起跑点都先等」成立，
// 任何一处漏接线就等于没有——而漏接线在功能测试里未必暴露（那条链可能压根没被走到）。
//
// T02835 时序依赖清点（本文件每一个「等一会儿再看」的处置，逐例口径）：
//  - 路由级「真实清理完成时确有任务排队」：原先 400×1ms 轮询抢删除窗口 + seed 300 个文件。
//    已改为 routes/cleanup.ts 的 beforeDelete 屏障（锁与标记均持有、尚未 unlink 时被 await），
//    窗口由测试掌控；文件数降为 12，只承担「真实删除路径跑得通」。
//  - 路由级「编译既不起跑也不登记活跃」：原先 60ms 抢窗口 + 200×10ms 等起跑。
//    已改为「等 waiters 入队」+「等 adapter entered 事件」，正负向结论都挂在机制事实上。
//  - 单元语义 / withCompileLock 各例的「让步一拍」：全部保留，但前面补了
//    「等待者确实入队」这一步——直接调 awaitCleanupIdle 时入队是同步的（断言 waiters 即可），
//    经 withCompileLock 时 run 挂在 chain.then 上要等一个微任务（改为等 waiters>=1 的事件）。
//    先证明任务真的挂着，让步之后的 `passed/started === false` 才是有内容的负向断言
//    （否则负载高时那几毫秒里它压根没被调度到，等于没检查）。
//  - 「放行后又被新清理抢锁」的第二次让步：刻意保留且不可换成同步断言，
//    它是该用例的检测手段（有缺陷的实现需要续延真的跑过才暴露）。
//  - 不用 retry / skip 抹平：那会把回归防线改成噪声过滤器（卡面明令）。
//
// T02836 等待口径清点（本文件 5 处等待的逐处判定，写法一律走 helpers/waitForProgress）：
//  | 位置 | 原判据 | 现判据 |
//  | 单元语义 4 例的 tick()（5ms 自带实现） | 固定 5ms 让步 | yieldSlice(来源说明)：TEST_SLICE_MS=5ms，前面都有 waiters 机制事实 |
//  | withCompileLock 两例的 waitFor()（5ms 轮询 + 10s 绝对超时） | 等够就往下 | waitForProgress + NO_TIMER_CHAIN，progress 签名带 waiters/held/started |
//  | 串行队列任务体内的 setTimeout(r,5) | 裸写 5ms | yieldSlice(占住串行链，使「不并发」可观测) |
//  | 路由级「编译挂起」waitFor() | 同上 | waitForProgress(等 waiters 入队) + await enteredEvent（事件，不是时长） |
//  | 路由级「删除前屏障」waitFor() | 同上 | 改为 await barrierHit（钩子命中即事件），断言锁持有态 |
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { preHandlerHookHandler } from 'fastify';
import { activeActivities, beginActivity, __resetActivitiesForTest } from '../src/activity.js';
import { withCompileLock, queuedCompileCount } from '../src/compile-queue.js';
import {
  acquireCleanup,
  awaitCleanupIdle,
  cleanupQueueStats,
  isCleanupInProgress,
  __resetCleanupMutexForTest,
} from '../src/cleanup-mutex.js';
import { registerCleanupRoute, type CleanupTestHooks } from '../src/routes/cleanup.js';
import { registerCompileRoute } from '../src/routes/compile.js';
import type { IsolationGuards } from '../src/middleware/auth.js';
import type { VaultService } from '../src/vault/vault-service.js';
import type { CleanupBlockedResponse, CleanupResult } from '../src/types.js';
// T02836：等待原语统一走公共工具（本文件原先自带 `const tick`（5ms）与 `async function waitFor`（5ms 轮询 + 10s 绝对超时））。
// 口径与 frontend/test/helpers/waitForProgress.ts 一致：判据是「超过契约下限且连续无进展」，
// 让步预算集中在 TEST_SLICE_MS 一处并写明来源。
import { NO_TIMER_CHAIN, waitForProgress, yieldSlice } from './helpers/waitForProgress.js';

const srcDir = path.resolve(fileURLToPath(import.meta.url), '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(srcDir, rel), 'utf8');
}

function stubVault(vaultPath: string): VaultService {
  return { getVaultPath: () => vaultPath } as unknown as VaultService;
}

const passThrough: preHandlerHookHandler = (_req, _reply, done) => done();
function stubGuards(): IsolationGuards {
  return { enabled: false, requireAuth: passThrough, requireAdmin: passThrough };
}

/** 读取 .harness/cleanup-audit.log 的全部 JSON 行（不存在则空数组）。 */
async function readAudit(harnessDir: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await fs.readFile(path.join(harnessDir, 'cleanup-audit.log'), 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe('T02774 cleanup-mutex 单元语义', () => {
  beforeEach(() => {
    __resetCleanupMutexForTest();
  });
  afterEach(() => {
    __resetCleanupMutexForTest();
  });

  it('同一时刻只允许一个清理：第二次 acquire 返回 null 而不是排队', () => {
    const first = acquireCleanup();
    expect(first).not.toBeNull();
    expect(isCleanupInProgress()).toBe(true);
    // 排队语义会让第二个清理把整站任务一起拖住（它等锁时，任务又在等它）→ 必须是拒绝
    expect(acquireCleanup()).toBeNull();
    first?.release();
    expect(isCleanupInProgress()).toBe(false);
    const third = acquireCleanup();
    expect(third).not.toBeNull();
    third?.release();
    expect(isCleanupInProgress()).toBe(false);
  });

  it('release 幂等：重复释放不会把持有数减成负值（负值 = 永久持锁 = 全站任务排队）', () => {
    const handle = acquireCleanup();
    handle?.release();
    handle?.release();
    expect(isCleanupInProgress()).toBe(false);
    expect(acquireCleanup()).not.toBeNull();
    __resetCleanupMutexForTest();
  });

  it('空闲时 awaitCleanupIdle 立即放行，且不计入推迟数', async () => {
    expect(isCleanupInProgress()).toBe(false);
    await expect(awaitCleanupIdle()).resolves.toBeUndefined();
  });

  it('清理持锁时任务挂起：释放那一刻才放行，并计入 deferredTasks', async () => {
    const handle = acquireCleanup();
    expect(handle).not.toBeNull();
    let passed = false;
    const waiting = awaitCleanupIdle().then(() => {
      passed = true;
    });
    // T02835：等待者入队是同步发生的（awaitCleanupIdle 在第一个 await 前就 push），
    // 所以这里断言的是机制而不是时序；随后的 passed===false 才有内容。
    expect(cleanupQueueStats().waiters).toBe(1);
    await yieldSlice('给 awaitCleanupIdle 的续延一次执行机会，好证明它真的没被放行');
    expect(passed).toBe(false);
    // 计数只能在 release 之后读——写在删除循环里恒为 0，台账口径就没了意义
    expect(handle?.deferredTasks()).toBe(0);

    handle?.release();
    await waiting;
    expect(passed).toBe(true);
    expect(handle?.deferredTasks()).toBe(1);
    expect(handle?.heldMs()).toBeGreaterThanOrEqual(0);
  });

  it('多个排队任务一次全放行（不做公平队列，避免任务饿死）', async () => {
    const handle = acquireCleanup();
    const waiters = [awaitCleanupIdle(), awaitCleanupIdle(), awaitCleanupIdle()];
    expect(cleanupQueueStats().waiters).toBe(3);
    await yieldSlice('给三个续延执行机会，好证明 deferredTasks 在释放前仍为 0');
    expect(handle?.deferredTasks()).toBe(0);
    handle?.release();
    await Promise.all(waiters);
    expect(handle?.deferredTasks()).toBe(3);
  });

  it('放行后又被新清理抢锁：等待者重新挂起，不会带着「已放行」的错觉往下跑', async () => {
    const first = acquireCleanup();
    let passed = false;
    const waiting = awaitCleanupIdle().then(() => {
      passed = true;
    });
    expect(cleanupQueueStats().waiters).toBe(1);
    await yieldSlice('给放行续延执行机会，好证明「还没释放」时它确实没被放行');
    expect(passed).toBe(false);
    // 同步释放再立刻抢锁：续延（微任务）真正跑 while 复判时，锁已在第二个人手里。
    // 若 awaitCleanupIdle 用「if 判断 + 单次 await」实现，这里就会带着放行错觉继续起跑。
    first?.release();
    const second = acquireCleanup();
    expect(second).not.toBeNull();
    // 这一次让步是本用例的检测手段，不能换成同步断言：
    // 有缺陷的实现要给它一个「续延真的跑过了却没重新挂起」的机会，才能观察到 passed 变 true。
    await yieldSlice('让被放行的续延真的跑过 while 复判（本用例的检测手段）');
    expect(cleanupQueueStats().waiters).toBe(1);
    expect(passed).toBe(false);
    second?.release();
    await waiting;
    expect(passed).toBe(true);
  });

  it('__resetCleanupMutexForTest 清场并放行 pending，返回原状态供断言', async () => {
    const handle = acquireCleanup();
    const waiting = awaitCleanupIdle();
    expect(cleanupQueueStats().waiters).toBe(1);
    await yieldSlice('证明清场前它真的还挂在队列上（而不是恰好没被调度）');
    const prev = __resetCleanupMutexForTest();
    expect(prev.held).toBe(1);
    expect(prev.waiters).toBe(1);
    await waiting;
    expect(isCleanupInProgress()).toBe(false);
    handle?.release();
  });
});

describe('T02774 withCompileLock 与清理的单向优先级', () => {
  beforeEach(() => {
    __resetActivitiesForTest();
    __resetCleanupMutexForTest();
  });
  afterEach(() => {
    __resetActivitiesForTest();
    __resetCleanupMutexForTest();
  });

  it('清理持锁期间任务既不登记活跃也不触碰文件；释放后照常执行', async () => {
    const handle = acquireCleanup();
    let started = false;
    const job = withCompileLock(async () => {
      started = true;
      // 起跑时必须是「已登记活跃」的状态：先等清理、再登记，顺序反了就会让
      // 一个还没碰文件的任务把后续清理误拦成 409
      expect(activeActivities().compile).toBe(1);
      return 'ok';
    });
    // T02835：先确认「它确实挂在了等待队列上」这个机制事实，再断言它没起跑。
    // 原先只 `await tick()` 然后看 started 还是 false——负载高时那 5ms 里任务根本没被调度到，
    // 断言等于什么都没检查（假绿）。注意 withCompileLock 是 chain.then(run) 起跑的，
    // run 里的 awaitCleanupIdle 要到微任务之后才执行，所以这里等的是入队事件而非固定时长。
    await waitForProgress(
      '任务挂进清理等待队列',
      () => cleanupQueueStats().waiters >= 1,
      { ...NO_TIMER_CHAIN, progress: () => `waiters=${cleanupQueueStats().waiters} held=${cleanupQueueStats().held} started=${started}` },
    );
    expect(started).toBe(false);
    expect(activeActivities().compile).toBe(0);
    handle?.release();
    await expect(job).resolves.toBe('ok');
    expect(started).toBe(true);
    expect(activeActivities().compile).toBe(0);
  });

  it('queuedCompileCount 只数「已入队未起跑」的部分（T02622 重启守卫）', async () => {
    // 背景：activity.ts 只统计已起跑任务，重启若只看 active 计数，会把排队中的编译请求
    // 悄悄丢掉。这里断言差值的两端都对：队头在跑时不把队头算成排队，后来者必须算进排队。
    let releaseHead: () => void = () => {};
    const headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    const head = withCompileLock(async () => {
      await headGate;
      return 'head';
    });
    await waitForProgress(
      '队头任务已起跑',
      () => activeActivities().compile === 1,
      { ...NO_TIMER_CHAIN, progress: () => `compile=${activeActivities().compile} queued=${queuedCompileCount()}` },
    );
    expect(queuedCompileCount()).toBe(0);

    const second = withCompileLock(async () => 'second');
    // 第二个请求已同步挂在 chain 上（inFlight 已加），但尚未起跑
    expect(activeActivities().compile).toBe(1);
    expect(queuedCompileCount()).toBe(1);

    releaseHead();
    await Promise.all([head, second]);
    expect(queuedCompileCount()).toBe(0);
  });

  it('排队仍串行：清理放行后多个任务按到达顺序执行，不并发', async () => {
    const handle = acquireCleanup();
    const order: number[] = [];
    const jobs = [1, 2, 3].map((n) =>
      withCompileLock(async () => {
        // 占住串行链一小段时间，使「后两个任务只能排队」这件事可被观测
        await yieldSlice('让队头任务占住 compile 链，本例要断言的正是后来者不并发');
        order.push(n);
        return n;
      }),
    );
    // compile 链本身是串行的：只有队头会走到 awaitCleanupIdle 并挂住，后两个还排在 chain 上
    // （waiters 因此是 1 而不是 3）。等这个 1 出现，才证明「order 仍为空」是真检查过了。
    await waitForProgress(
      '队头任务挂进清理等待队列',
      () => cleanupQueueStats().waiters >= 1,
      { ...NO_TIMER_CHAIN, progress: () => `waiters=${cleanupQueueStats().waiters} order=${JSON.stringify(order)}` },
    );
    expect(order).toEqual([]);
    handle?.release();
    await Promise.all(jobs);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('T02774 路由级：真实清理 / 编译并发', () => {
  let tempRoot = '';
  let vaultPath = '';
  let harnessDir = '';
  let stateDir = '';
  let app: FastifyInstance;

  async function seed(opts?: { stateFiles?: number; hooks?: CleanupTestHooks }): Promise<void> {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-cleanup-mutex-'));
    vaultPath = path.join(tempRoot, 'data', 'vault');
    harnessDir = path.join(tempRoot, 'data', '.harness');
    stateDir = path.join(harnessDir, 'state');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(vaultPath, { recursive: true });
    if (opts?.stateFiles === undefined) {
      await fs.writeFile(path.join(stateDir, 'run-a.json'), '{"status":"done"}', 'utf8');
    } else {
      for (let i = 0; i < opts.stateFiles; i++) {
        await fs.writeFile(path.join(stateDir, `run-${i}.json`), '{"status":"done"}', 'utf8');
      }
    }
    app = Fastify();
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
    registerCompileRoute(app, gatedAdapter().adapter);
    registerCleanupRoute(
      app,
      stubVault(vaultPath),
      stubGuards(),
      undefined,
      undefined,
      opts?.hooks,
    );
    await app.ready();
  }

  // 默认注册的 adapter 只用于「清理被拒」这类不触发编译的用例：立刻 done，不会卡住测试
  // T02835：额外导出 entered——用例要等「adapter 真的进入了」这一事实，而不是等够 2s 再猜它进了没
  function gatedAdapter(onEnter?: () => void) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const adapter = {
      compile: async function* () {
        onEnter?.();
        markEntered();
        await gate;
        yield { step: 'done', status: 'done', message: 'ok', data: { path: 'qa/x.md', title: 'X' } };
      },
    } as unknown as Parameters<typeof registerCompileRoute>[1];
    return { adapter, release, entered };
  }

  function multipartPayload(): { body: Buffer; boundary: string } {
    const boundary = '----t02774';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.md"\r\n\r\n`),
      Buffer.from('# hello\r\n'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { body, boundary };
  }

  // 不 await：让编译保持在途（锁未释放时它应当连起跑都没起跑）
  function fireCompile(): { statusCode: number } | PromiseLike<{ statusCode: number }> {
    const { body, boundary } = multipartPayload();
    return app.inject({
      method: 'POST',
      url: '/api/compile',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    }) as unknown as PromiseLike<{ statusCode: number }>;
  }

  beforeEach(async () => {
    __resetActivitiesForTest();
    __resetCleanupMutexForTest();
    await seed();
  });

  afterEach(async () => {
    __resetActivitiesForTest();
    __resetCleanupMutexForTest();
    await app?.close();
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('清理持锁 → 编译既不起跑也不登记活跃；释放后编译才进入并完成', async () => {
    await app.close();
    let entered = 0;
    // T02835：entered 事件化。原先「release 后最多再等 2s，然后断言它进了」——
    // 高负载下 2s 可以不够（假红），而 60ms 的抢跑窗口又只是「大概来不及」（假绿）。
    // 现在正向结论等事件，负向结论等「已挂进等待队列」这个机制事实。
    const { adapter, release, entered: enteredEvent } = gatedAdapter(() => {
      entered += 1;
    });
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-cleanup-mutex-e2e-'));
    vaultPath = path.join(tempRoot, 'data', 'vault');
    harnessDir = path.join(tempRoot, 'data', '.harness');
    stateDir = path.join(harnessDir, 'state');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(vaultPath, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'run-a.json'), '{"status":"done"}', 'utf8');
    app = Fastify();
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
    registerCompileRoute(app, adapter);
    registerCleanupRoute(app, stubVault(vaultPath), stubGuards());
    await app.ready();

    const handle = acquireCleanup();
    expect(handle).not.toBeNull();

    const compileRequest = fireCompile();
    await waitForProgress(
      '编译挂进清理等待队列',
      () => cleanupQueueStats().waiters >= 1,
      {
        ...NO_TIMER_CHAIN,
        progress: () => `waiters=${cleanupQueueStats().waiters} held=${cleanupQueueStats().held} entered=${entered}`,
      },
    );
    // 关键断言：窗口内任务根本没起跑 —— 「活跃计数为 0」证明它不会污染守卫口径，
    // 「entered 为 0」证明它也没触碰任何文件
    expect(entered).toBe(0);
    expect(activeActivities().compile).toBe(0);
    await expect(fs.readFile(path.join(stateDir, 'run-a.json'), 'utf8')).resolves.toBe('{"status":"done"}');

    handle?.release();
    await enteredEvent;
    expect(entered).toBe(1);
    expect(activeActivities().compile).toBe(1);
    expect(isCleanupInProgress()).toBe(false);

    release();
    const res = await compileRequest;
    expect(res.statusCode).toBe(200);
    expect(activeActivities().compile).toBe(0);
  });

  it('第二次真实清理被拒 409（cleanup_blocked_by_concurrent_cleanup），文件不动且落审计', async () => {
    const handle = acquireCleanup();
    const res = await app.inject({ method: 'POST', url: '/api/cleanup', payload: { target: 'run_state', dry_run: false } });
    expect(res.statusCode).toBe(409);
    const body = res.json() as CleanupBlockedResponse;
    expect(body.code).toBe('cleanup_blocked_by_concurrent_cleanup');
    // blocked 为空是刻意的：这不是「目标被活跃任务拦」，前端不能套用置灰文案
    expect(body.blocked).toEqual([]);
    expect(body.error).toContain('清理');
    await expect(fs.readdir(stateDir)).resolves.toEqual(['run-a.json']);

    const audit = await readAudit(harnessDir);
    expect(audit.some((e) => e.blocked_by_concurrent_cleanup === true)).toBe(true);
    handle?.release();
  });

  it('预览不参与互斥：同一把锁下 dry_run 仍 200，且审计 cleanup_locked=false', async () => {
    const handle = acquireCleanup();
    const res = await app.inject({ method: 'POST', url: '/api/cleanup', payload: { target: 'run_state', dry_run: true } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as CleanupResult).cleaned[0]).toContain('[预览]');
    await expect(fs.readdir(stateDir)).resolves.toEqual(['run-a.json']);
    handle?.release();

    const audit = await readAudit(harnessDir);
    const last = audit[audit.length - 1];
    expect(last.cleanup_locked).toBe(false);
    expect(last.cleanup_deferred_tasks).toBe(0);
  });

  it('守卫优先于并发清理锁：有任务在跑时报 active_task 而不是 concurrent_cleanup', async () => {
    // 顺序很重要：先判活跃再抢锁，否则「任务在跑」这个更有信息量的原因会被并发提示盖掉
    const handle = acquireCleanup();
    const releaseTask = beginActivity('compile');
    const res = await app.inject({ method: 'POST', url: '/api/cleanup', payload: { target: 'run_state', dry_run: false } });
    expect(res.statusCode).toBe(409);
    expect((res.json() as CleanupBlockedResponse).code).toBe('cleanup_blocked_by_active_task');
    releaseTask();
    handle?.release();
  });

  it('真实清理完成时确有任务排队：台账 cleanup_locked/deferred 记录在案，删除照常完成', async () => {
    await app.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
    // T02835：删除量不再负责「把窗口拉大到来得及观测」——那只是把概率往后推（原先塞 300 个文件
    // + 400 次 1ms 轮询，高负载下轮询还没跑完删除就结束了，红的是时序不是机制）。
    // 现在用真实删除前屏障：钩子在进程内锁与跨进程标记都已持有、尚未 unlink 时被 await，
    // 窗口由测试掌控，文件数回归到「够覆盖真实删除路径」即可。
    let barrierHits = 0;
    let markBarrierHit: () => void = () => {};
    const barrierHit = new Promise<void>((resolve) => {
      markBarrierHit = resolve;
    });
    let openBarrier: () => void = () => {};
    const barrierOpen = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    await seed({
      stateFiles: 12,
      hooks: {
        beforeDelete: async ({ target }) => {
          barrierHits += 1;
          expect(target).toBe('run_state');
          markBarrierHit();
          await barrierOpen;
        },
      },
    });

    const cleanupPending = app.inject({ method: 'POST', url: '/api/cleanup', payload: { target: 'run_state', dry_run: false } });
    await barrierHit;
    // 断言的是机制：屏障被命中的那一刻，锁必然处于持有态
    expect(isCleanupInProgress()).toBe(true);

    let started = false;
    const job = withCompileLock(async () => {
      started = true;
      return 'ran';
    });
    await waitForProgress(
      '任务挂进清理等待队列',
      () => cleanupQueueStats().waiters >= 1,
      {
        ...NO_TIMER_CHAIN,
        progress: () =>
          `waiters=${cleanupQueueStats().waiters} held=${cleanupQueueStats().held} started=${started} barrierHits=${barrierHits}`,
      },
    );
    // 清理还在删（屏障未开），任务已挂起 —— 这正是被 T02655 认定为「不活跃」的那类任务
    expect(started).toBe(false);
    expect(activeActivities().compile).toBe(0);

    openBarrier();
    const res = await cleanupPending;
    expect(res.statusCode).toBe(200);
    expect((res.json() as CleanupResult).count).toBe(12);
    // 锁已释放（在 finally 里），任务此刻应已起跑并完成
    expect(isCleanupInProgress()).toBe(false);
    await expect(job).resolves.toBe('ran');
    expect(started).toBe(true);
    expect(barrierHits).toBe(1);

    const audit = await readAudit(harnessDir);
    const last = audit[audit.length - 1];
    expect(last.cleanup_locked).toBe(true);
    expect(Number(last.cleanup_deferred_tasks)).toBeGreaterThanOrEqual(1);
    expect(Number(last.cleanup_held_ms)).toBeGreaterThanOrEqual(0);
    expect(last.blocked_by_active_task ?? false).toBe(false);
    await expect(fs.readdir(stateDir)).resolves.toEqual([]);
  }, 20000); // 屏障后单例实测 <1s；留 20s 只兜「沙箱磁盘极端慢」，不再靠它掩盖时序问题
});

describe('T02774 起跑点接线锁（漏接一处等于整套互斥失效）', () => {
  // 互斥不靠「大家都记得等」，靠的是每个会读写被清理对象的起跑点在**登记活跃之前**先等清理。
  // 这三处入口（编译队列 / 内联问答 / 流式问答）少任何一处，功能测试未必能暴露——
  // 那条链路可能压根没被走到，但线上就是那个窗口还在。
  it('withCompileLock：await awaitCleanupIdle() 严格早于 beginActivity', () => {
    const src = readSrc('src/compile-queue.ts');
    const wait = src.indexOf('await awaitCleanupIdle()');
    const begin = src.indexOf("beginActivity('compile')");
    expect(wait).toBeGreaterThan(-1);
    expect(begin).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(begin);
  });

  it('内联问答路由：先等清理再登记 query 活跃', () => {
    const src = readSrc('src/routes/query.ts');
    const wait = src.indexOf('await awaitCleanupIdle()');
    const begin = src.indexOf("beginActivity('query')");
    expect(wait).toBeGreaterThan(-1);
    expect(begin).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(begin);
  });

  it('流式问答：登记发生在 runTask 内部（起跑时），不在 start() 同步段', () => {
    const src = readSrc('src/workflows/stream-run-manager.ts');
    const wait = src.indexOf('await awaitCleanupIdle()');
    const begin = src.indexOf("beginActivity('query')");
    expect(wait).toBeGreaterThan(-1);
    expect(begin).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(begin);
    // start() 里同步登记会让「还在排队等清理」的 run 被误判成活跃任务 → 后续清理被 409 误拦
    const startIdx = src.indexOf('  start(');
    expect(startIdx).toBeGreaterThan(-1);
    expect(src.slice(startIdx, wait).indexOf('beginActivity(')).toBe(-1);
  });

  it('清理路由：删除前屏障只在真实删除路径上，且晚于抢锁、早于删除分发', () => {
    const src = readSrc('src/routes/cleanup.ts');
    const barrier = src.indexOf('await testHooks.beforeDelete(');
    const acquire = src.indexOf('acquireCleanup()');
    const dispatch = src.indexOf('// 按目标分发');
    expect(barrier).toBeGreaterThan(-1);
    expect(acquire).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    expect(barrier).toBeGreaterThan(acquire);
    expect(barrier).toBeLessThan(dispatch);
    // 预览绝不能被屏障挂住：否则「先看会删哪些」会变成要等测试钩子，
    // 且把 dry_run 也拉进互斥语义（与 T02774「预览不参与互斥」直接矛盾）
    const guardIdx = src.lastIndexOf('if (!dryRun && testHooks?.beforeDelete)', barrier);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(barrier - guardIdx).toBeLessThan(200);
  });

  it('清理路由：守卫判定与抢锁之间没有 await（窗口不靠运气闭合）', () => {
    const src = readSrc('src/routes/cleanup.ts');
    // T02817 起判定输入是「本进程 + 其它进程」合并的快照；仍锁死这一点，
    // 否则有人会把守卫改回只读进程内计数，跨进程那半边保护当场失效且无人报警。
    expect(src.indexOf('const active0 = await activeStateAcrossProcesses();')).toBeLessThan(
      src.indexOf('evaluateCleanupGuard(target, active0)'),
    );
    const guardIdx = src.indexOf('evaluateCleanupGuard(target, active0)');
    const acquireIdx = src.indexOf('acquireCleanup()');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeGreaterThan(guardIdx);
    // 去掉被拦分支（里面的 writeAudit 是 409 前的收尾，不在主路径上）再看有无 await
    const segment = src.slice(guardIdx, acquireIdx);
    expect(stripIfBlock(segment, 'if (verdict.blocked.length > 0)').includes('await')).toBe(false);
  });

  it('清理路由：release 位于 finally（异常路径不得把锁留在持有态）', () => {
    const src = readSrc('src/routes/cleanup.ts');
    // 用 lastIndexOf：T02817 之后「抢标记失败」和「抢到标记后判到任务」两个分支也各自
    // 提前释放锁（那里必须放，否则拒绝一次就把锁永久留着），全文首个 release 不再是 finally 那一个。
    const releaseIdx = src.lastIndexOf('cleanupHandle?.release()');
    expect(releaseIdx).toBeGreaterThan(-1);
    // release 必须在 finally 而不是 try 尾部：500 兜底分支若绕过释放，
    // 这把锁会永久持有，从此全站编译/问答都排队 —— 比没有互斥更糟
    expect(src.slice(Math.max(0, releaseIdx - 300), releaseIdx)).toContain('finally {');
  });
});

/** 从 segment 中删掉 `if (cond) { ... }` 整块（花括号配对），用于主路径静默性检查。 */
function stripIfBlock(segment: string, cond: string): string {
  const start = segment.indexOf(cond);
  if (start === -1) return segment;
  const braceStart = segment.indexOf('{', start + cond.length);
  if (braceStart === -1) return segment;
  let depth = 0;
  for (let i = braceStart; i < segment.length; i++) {
    if (segment[i] === '{') depth += 1;
    else if (segment[i] === '}') {
      depth -= 1;
      if (depth === 0) return segment.slice(0, start) + segment.slice(i + 1);
    }
  }
  return segment;
}

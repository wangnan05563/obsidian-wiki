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
import { withCompileLock } from '../src/compile-queue.js';
import {
  acquireCleanup,
  awaitCleanupIdle,
  isCleanupInProgress,
  __resetCleanupMutexForTest,
} from '../src/cleanup-mutex.js';
import { registerCleanupRoute } from '../src/routes/cleanup.js';
import { registerCompileRoute } from '../src/routes/compile.js';
import type { IsolationGuards } from '../src/middleware/auth.js';
import type { VaultService } from '../src/vault/vault-service.js';
import type { CleanupBlockedResponse, CleanupResult } from '../src/types.js';

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

const tick = () => new Promise((r) => setTimeout(r, 5));

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
    await tick();
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
    await tick();
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
    await tick();
    expect(passed).toBe(false);
    // 同步释放再立刻抢锁：续延（微任务）真正跑 while 复判时，锁已在第二个人手里。
    // 若 awaitCleanupIdle 用「if 判断 + 单次 await」实现，这里就会带着放行错觉继续起跑。
    first?.release();
    const second = acquireCleanup();
    expect(second).not.toBeNull();
    await tick();
    expect(passed).toBe(false);
    second?.release();
    await waiting;
    expect(passed).toBe(true);
  });

  it('__resetCleanupMutexForTest 清场并放行 pending，返回原状态供断言', async () => {
    const handle = acquireCleanup();
    const waiting = awaitCleanupIdle();
    await tick();
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
    await tick();
    expect(started).toBe(false);
    expect(activeActivities().compile).toBe(0);
    handle?.release();
    await expect(job).resolves.toBe('ok');
    expect(started).toBe(true);
    expect(activeActivities().compile).toBe(0);
  });

  it('排队仍串行：清理放行后多个任务按到达顺序执行，不并发', async () => {
    const handle = acquireCleanup();
    const order: number[] = [];
    const jobs = [1, 2, 3].map((n) =>
      withCompileLock(async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(n);
        return n;
      }),
    );
    await tick();
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

  async function seed(opts?: { stateFiles?: number }): Promise<void> {
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
    registerCleanupRoute(app, stubVault(vaultPath), stubGuards());
    await app.ready();
  }

  // 默认注册的 adapter 只用于「清理被拒」这类不触发编译的用例：立刻 done，不会卡住测试
  function gatedAdapter(onEnter?: () => void) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = {
      compile: async function* () {
        onEnter?.();
        await gate;
        yield { step: 'done', status: 'done', message: 'ok', data: { path: 'qa/x.md', title: 'X' } };
      },
    } as unknown as Parameters<typeof registerCompileRoute>[1];
    return { adapter, release };
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
    const { adapter, release } = gatedAdapter(() => {
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
    await new Promise((r) => setTimeout(r, 60));
    // 关键断言：窗口内任务根本没起跑 —— 「活跃计数为 0」证明它不会污染守卫口径，
    // 「entered 为 0」证明它也没触碰任何文件
    expect(entered).toBe(0);
    expect(activeActivities().compile).toBe(0);
    await expect(fs.readFile(path.join(stateDir, 'run-a.json'), 'utf8')).resolves.toBe('{"status":"done"}');

    handle?.release();
    // 等任务真的起跑（否则 release 与 adapter 进入之间有微任务间隙）
    for (let i = 0; i < 200 && entered === 0; i++) await new Promise((r) => setTimeout(r, 10));
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
    // 多塞几个文件，把删除过程拉长到足以让并发起跑点真的挂到等待队列上
    await seed({ stateFiles: 300 });

    const cleanupPending = app.inject({ method: 'POST', url: '/api/cleanup', payload: { target: 'run_state', dry_run: false } });
    for (let i = 0; i < 400 && !isCleanupInProgress(); i++) await new Promise((r) => setTimeout(r, 1));
    expect(isCleanupInProgress()).toBe(true);

    let started = false;
    const job = withCompileLock(async () => {
      started = true;
      return 'ran';
    });
    await tick();
    // 清理还在删，任务已挂起 —— 这正是被 T02655 认定为「不活跃」的那类任务
    expect(started).toBe(false);
    expect(activeActivities().compile).toBe(0);

    const res = await cleanupPending;
    expect(res.statusCode).toBe(200);
    expect((res.json() as CleanupResult).count).toBe(300);
    // 锁已释放（在 finally 里），任务此刻应已起跑并完成
    expect(isCleanupInProgress()).toBe(false);
    await expect(job).resolves.toBe('ran');
    expect(started).toBe(true);

    const audit = await readAudit(harnessDir);
    const last = audit[audit.length - 1];
    expect(last.cleanup_locked).toBe(true);
    expect(Number(last.cleanup_deferred_tasks)).toBeGreaterThanOrEqual(1);
    expect(Number(last.cleanup_held_ms)).toBeGreaterThanOrEqual(0);
    expect(last.blocked_by_active_task ?? false).toBe(false);
    await expect(fs.readdir(stateDir)).resolves.toEqual([]);
  }, 30000); // 沙箱磁盘慢：300 个文件的真实删除 + 400 次 1ms 轮询，默认 5s 在本机间歇性超时（实测单例 5~9s）
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

  it('清理路由：守卫判定与抢锁之间没有 await（窗口不靠运气闭合）', () => {
    const src = readSrc('src/routes/cleanup.ts');
    const guardIdx = src.indexOf('evaluateCleanupGuard(target)');
    const acquireIdx = src.indexOf('acquireCleanup()');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeGreaterThan(guardIdx);
    // 去掉被拦分支（里面的 writeAudit 是 409 前的收尾，不在主路径上）再看有无 await
    const segment = src.slice(guardIdx, acquireIdx);
    expect(stripIfBlock(segment, 'if (verdict.blocked.length > 0)').includes('await')).toBe(false);
  });

  it('清理路由：release 位于 finally（异常路径不得把锁留在持有态）', () => {
    const src = readSrc('src/routes/cleanup.ts');
    const releaseIdx = src.indexOf('cleanupHandle?.release()');
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

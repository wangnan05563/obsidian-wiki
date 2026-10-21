// T02655 真实删除前的活跃任务硬拦截 —— 三层回归。
// ------------------------------------------------------------------
// 这一单的风险不是「功能没做」，而是「看起来做了但没拦住」，所以断言全部落在
// 可观测事实上：文件是否还在、状态码是什么、审计是否留痕。
//  1) activity：计数与释放（含异常路径与幂等 release）——泄漏会让清理永久 409。
//  2) cleanup-guard：拦截口径的纯函数分支穷举（拦哪两类、为什么不拦另两类）。
//  3) 路由级：真实 Fastify + 临时目录，验证 409 时文件确实没被删、放行后确实被删。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { preHandlerHookHandler } from 'fastify';
import {
  activeActivities,
  beginActivity,
  hasAnyActiveActivity,
  isActivityBusy,
  __resetActivitiesForTest,
} from '../src/activity.js';
import { withCompileLock } from '../src/compile-queue.js';
import { evaluateCleanupGuard } from '../src/cleanup-guard.js';
import { registerCleanupRoute } from '../src/routes/cleanup.js';
import { registerCompileRoute } from '../src/routes/compile.js';
import { streamRunManager } from '../src/workflows/stream-run-manager.js';
import type { IsolationGuards } from '../src/middleware/auth.js';
import type { VaultService } from '../src/vault/vault-service.js';
import type {
  CleanupActiveState,
  CleanupBlockedResponse,
  CleanupResult,
  CleanupStorageStatus,
} from '../src/types.js';

// 路由只用 vault.getVaultPath()，其余方法在这条链路上不会被调用。
// 用 stub 而不是真实 VaultService：真实构造会起 chokidar 监听，测试要的是清理语义不是 vault 语义。
function stubVault(vaultPath: string): VaultService {
  return { getVaultPath: () => vaultPath } as unknown as VaultService;
}

// 守卫在测试里必须放行：本单测的是「活跃任务拦截」，不是 RBAC（那部分由
// user-admin-guard.test.ts 覆盖）。签名沿用 Fastify done 回调风格（与 auth.ts 同法）。
const passThrough: preHandlerHookHandler = (_req, _reply, done) => done();
function stubGuards(): IsolationGuards {
  return { enabled: false, requireAuth: passThrough, requireAdmin: passThrough };
}

/**
 * 等到某一类活跃计数达到期望值。
 * 为什么需要它（T02774）：起跑点现在先 `await awaitCleanupIdle()` 再 `beginActivity(...)`
 * ——顺序是这套互斥成立的前提（先登记的化，一个还没碰文件、只是排队等清理的任务会把后续清理误拦成 409）。
 * 代价是「登记」不再发生在调用帧内，本文件原先靠单帧微任务的时序假设因此不再成立。
 * 这里等的是「机制生效」，不是「等一个大概」：超时即抛错，计数不对照样红。
 */
async function waitActive(kind: 'compile' | 'query', expected: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (activeActivities()[kind] === expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `等待 ${kind} 活跃计数变为 ${expected} 超时（当前 ${JSON.stringify(activeActivities())}）`,
  );
}

describe('T02655 activity 计数', () => {
  beforeEach(() => {
    __resetActivitiesForTest();
  });

  it('登记后计入，释放后归零；两种 kind 互不干扰', () => {
    const releaseCompile = beginActivity('compile');
    expect(activeActivities()).toEqual({ compile: 1, query: 0 });
    const releaseQuery = beginActivity('query');
    expect(isActivityBusy('compile')).toBe(true);
    expect(isActivityBusy('query')).toBe(true);
    expect(hasAnyActiveActivity()).toBe(true);
    releaseQuery();
    expect(activeActivities()).toEqual({ compile: 1, query: 0 });
    releaseCompile();
    expect(activeActivities()).toEqual({ compile: 0, query: 0 });
    expect(hasAnyActiveActivity()).toBe(false);
  });

  it('release 幂等：重复调用不会把计数减成负数（负值会永久放行）', () => {
    const release = beginActivity('compile');
    release();
    release();
    release();
    expect(activeActivities().compile).toBe(0);
  });

  it('withCompileLock 只统计"已在执行"的编译：排队中的请求不计入', async () => {
    let releaseFirst: (() => void) | null = null;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    const p1 = withCompileLock(async () => {
      // 编译体仍在执行 → 必须计入活跃
      expect(activeActivities().compile).toBe(1);
      await first;
    });
    const p2 = withCompileLock(async () => {
      secondStarted = true;
    });

    // 第一个还在跑：活跃数必须是 1（不是 2——p2 只是排队，没碰任何文件）
    await waitActive('compile', 1);
    expect(activeActivities().compile).toBe(1);
    expect(secondStarted).toBe(false);

    releaseFirst?.();
    await Promise.all([p1, p2]);
    expect(secondStarted).toBe(true);
    expect(activeActivities().compile).toBe(0);
  });

  it('编译抛错也必须释放（异常泄漏 = 清理永久被拦）', async () => {
    await expect(
      withCompileLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(activeActivities().compile).toBe(0);
  });
});

describe('T02655 cleanup-guard 拦截口径', () => {
  // 纯函数只读 compile/query 两个计数，blockedTargets/blockedReasons 是出参不是入参
  const snapshot = (compile: number, query: number): CleanupActiveState => ({
    compile,
    query,
    blockedTargets: [],
    blockedReasons: [],
  });

  it('编译进行中：拦 run_state 与 raw_archive，放行 compile_cache 与 run_logs', () => {
    const active = snapshot(1, 0);
    expect(evaluateCleanupGuard('run_state', active).blocked).toEqual(['run_state']);
    expect(evaluateCleanupGuard('raw_archive', active).blocked).toEqual(['raw_archive']);
    expect(evaluateCleanupGuard('compile_cache', active).blocked).toEqual([]);
    expect(evaluateCleanupGuard('run_logs', active).blocked).toEqual([]);
  });

  it('问答进行中：只拦 run_state', () => {
    const active = snapshot(0, 1);
    expect(evaluateCleanupGuard('run_state', active).blocked).toEqual(['run_state']);
    expect(evaluateCleanupGuard('raw_archive', active).blocked).toEqual([]);
  });

  it('target=all：展开后任一子目标被拦即命中，并列出被拦子目标', () => {
    const verdict = evaluateCleanupGuard('all', snapshot(2, 1));
    expect(verdict.blocked).toEqual(['run_state', 'raw_archive']);
    // 原因去重且不泄露无关目标
    expect(verdict.reasons.length).toBeGreaterThan(0);
    expect(verdict.reasons.filter((r) => r.includes('原始资料'))).toHaveLength(1);
  });

  it('无活跃任务：四类全部放行', () => {
    for (const target of ['compile_cache', 'run_state', 'run_logs', 'raw_archive', 'all']) {
      expect(evaluateCleanupGuard(target, snapshot(0, 0)).blocked).toEqual([]);
    }
  });

  it('未知 target 不抛错（交由路由分发出错信息），也不误拦', () => {
    expect(evaluateCleanupGuard('bogus', snapshot(1, 1)).blocked).toEqual([]);
  });
});

describe('T02655 问答 run 的活跃登记（streamRunManager 接线）', () => {
  // 只验接线，不重跑 FR-22 的终止语义（那部分在 stream-run-manager.test.ts）。
  // 为什么必须验：问答这一路的拦截依据就挂在 start()/finishRun() 上，
  // 接线漏了不会报错——只会让「有问答在跑时清 run_state」重新变成无人拦截。
  async function waitReleased(runId: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (activeActivities().query === 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`run ${runId} 结束后 query 活跃计数未归零（泄漏会永久拦截清理）`);
  }

  it('run 起跑计入 1 个 query，终态后释放', async () => {
    __resetActivitiesForTest();
    const runId = 't02655-query-active';
    const controller = new AbortController();
    streamRunManager.start(runId, {
      producer: () =>
        (async function* () {
          for (let i = 0; i < 50; i++) {
            if (controller.signal.aborted) throw new Error('已由用户停止');
            yield { runId, text: `c${i}` };
            await new Promise((r) => setTimeout(r, 10));
          }
          yield { runId, done: true, refs: [], webRefs: [] };
        })(),
      onDone: async () => ({ threadId: 't', sessionId: 's', messageIndex: 0 }),
      governor: null,
      cancelSignal: controller,
    });
    // T02774：登记改在 runTask 内「等清理结束」之后发生（start() 的同步段不再登记，
    // 否则排队等清理的 run 会被当成活跃任务、把后续清理误拦）→ 等它真的计上再断言。
    await waitActive('query', 1);
    expect(activeActivities().query).toBe(1);
    expect(isActivityBusy('query')).toBe(true);

    expect(streamRunManager.cancel(runId)).toBe(true);
    await waitReleased(runId);
    expect(activeActivities().query).toBe(0);
  });

  it('自然跑完（非取消）同样释放', async () => {
    __resetActivitiesForTest();
    const runId = 't02655-query-natural';
    const controller = new AbortController();
    streamRunManager.start(runId, {
      producer: () =>
        (async function* () {
          yield { runId, text: 'only' };
          // 留一个「已登记但还没结束」的可观测窗口：这条 run 若一帧内就跑完，
          // 计数从 0 到 0，「登记过」这件事根本没法断言（T02774 后登记不再同步发生在 start() 帧内）
          await new Promise((r) => setTimeout(r, 30));
          yield { runId, done: true, refs: [], webRefs: [] };
        })(),
      onDone: async () => ({ threadId: 't', sessionId: 's', messageIndex: 0 }),
      governor: null,
      cancelSignal: controller,
    });
    await waitActive('query', 1);
    expect(activeActivities().query).toBe(1);
    await waitReleased(runId);
    expect(activeActivities().query).toBe(0);
  });
});

describe('T02655 真链路：编译进行中 → 清理被拦 → 编译结束后放行', () => {
  // 这一条是整单的收口证据：前面几层各自成立还不算，必须证明
  // 「真实编译请求 → withCompileLock → activity 计数 → 清理 409 → 文件幸存」整条链无断点。
  // 用假 adapter（不让真 LLM 参与），但走的是真的 compile 路由与真的清理路由。
  let tempRoot = '';
  let stateFile = '';
  let app: FastifyInstance;

  afterEach(async () => {
    __resetActivitiesForTest();
    await app?.close();
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function gatedAdapter(onEnter: () => void) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = {
      compile: async function* () {
        onEnter();
        await gate; // 卡在这里 = 编译仍在执行（与真 LLM 流式产出等价占位）
        yield { step: 'done', status: 'done', message: 'ok', data: { path: 'qa/x.md', title: 'X' } };
      },
    } as unknown as Parameters<typeof registerCompileRoute>[1];
    return { adapter, release };
  }

  function multipartPayload(): { body: Buffer; boundary: string } {
    const boundary = '----t02655';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.md"\r\n\r\n`),
      Buffer.from('# hello\r\n'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { body, boundary };
  }

  async function buildApp(): Promise<FastifyInstance> {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-cleanup-e2e-'));
    const vaultPath = path.join(tempRoot, 'data', 'vault');
    const stateDir = path.join(tempRoot, 'data', '.harness', 'state');
    stateFile = path.join(stateDir, 'run-a.json');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(vaultPath, { recursive: true });
    await fs.writeFile(stateFile, '{"status":"done"}', 'utf8');

    const instance = Fastify();
    await instance.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
    return instance;
  }

  it('编译在跑的整个窗口内，run_state 真实删除一律 409 且文件不动', async () => {
    let entered = 0;
    const { adapter, release } = gatedAdapter(() => {
      entered += 1;
    });
    app = await buildApp();
    registerCompileRoute(app, adapter);
    registerCleanupRoute(app, stubVault(path.join(tempRoot, 'data', 'vault')), stubGuards());
    await app.ready();

    const { body, boundary } = multipartPayload();
    // 不 await：让编译保持在途
    const compilePending = app.inject({
      method: 'POST',
      url: '/api/compile',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    // 等到真的进了 withCompileLock（否则可能还在解析 multipart，断言会假通过）
    for (let i = 0; i < 200 && (entered === 0 || activeActivities().compile === 0); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(entered).toBe(1);
    expect(activeActivities().compile).toBe(1);

    const blocked = await app.inject({ method: 'POST', url: '/api/cleanup', payload: { target: 'run_state', dry_run: false } });
    expect(blocked.statusCode).toBe(409);
    await expect(fs.readFile(stateFile, 'utf8')).resolves.toBe('{"status":"done"}');

    release();
    await compilePending;
    expect(activeActivities().compile).toBe(0);

    const allowed = await app.inject({ method: 'POST', url: '/api/cleanup', payload: { target: 'run_state', dry_run: false } });
    expect(allowed.statusCode).toBe(200);
    await expect(fs.stat(stateFile)).rejects.toThrow();
  });
});

describe('T02655 清理路由级硬拦截', () => {
  let tempRoot = '';
  let app: FastifyInstance;
  let stateDir = '';
  let rawDir = '';

  async function seed(): Promise<void> {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-cleanup-guard-'));
    const vaultPath = path.join(tempRoot, 'data', 'vault');
    const harnessDir = path.join(tempRoot, 'data', '.harness');
    stateDir = path.join(harnessDir, 'state');
    rawDir = path.join(vaultPath, 'raw');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(rawDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'run-a.json'), '{"status":"done"}', 'utf8');
    await fs.writeFile(path.join(rawDir, 'input-1.md'), 'raw', 'utf8');

    app = Fastify();
    registerCleanupRoute(app, stubVault(vaultPath), stubGuards());
    await app.ready();
  }

  beforeEach(async () => {
    __resetActivitiesForTest();
    await seed();
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function postCleanup(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/cleanup', payload });
  }

  it('status 返回 active 快照（前端置灰依据）', async () => {
    const release = beginActivity('compile');
    const res = await app.inject({ method: 'GET', url: '/api/cleanup/status' });
    expect(res.statusCode).toBe(200);
    const status = res.json() as CleanupStorageStatus;
    expect(status.active.compile).toBe(1);
    expect(status.active.blockedTargets).toEqual(['run_state', 'raw_archive']);
    expect(status.active.blockedReasons.every((r) => r.reason.length > 0)).toBe(true);
    release();
  });

  it('有编译在跑 + 关掉预览 → 409，且状态文件一个都没少', async () => {
    const release = beginActivity('compile');
    const res = await postCleanup({ target: 'run_state', dry_run: false });
    expect(res.statusCode).toBe(409);
    const body = res.json() as CleanupBlockedResponse;
    expect(body.code).toBe('cleanup_blocked_by_active_task');
    expect(body.blocked).toEqual(['run_state']);
    expect(body.reasons[0]).toContain('编译');
    expect(body.active.compile).toBe(1);
    await expect(fs.readdir(stateDir)).resolves.toEqual(['run-a.json']);
    release();
  });

  it('拦截解除后同样请求真实删除成功（证明拦的是活跃态而不是功能坏了）', async () => {
    const release = beginActivity('compile');
    expect((await postCleanup({ target: 'run_state', dry_run: false })).statusCode).toBe(409);
    release();
    const res = await postCleanup({ target: 'run_state', dry_run: false });
    expect(res.statusCode).toBe(200);
    expect((res.json() as CleanupResult).count).toBe(1);
    await expect(fs.readdir(stateDir)).resolves.toEqual([]);
  });

  it('预览模式不受拦截影响：有任务时也照常只列出不删除', async () => {
    const release = beginActivity('compile');
    const res = await postCleanup({ target: 'run_state', dry_run: true });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CleanupResult;
    expect(body.cleaned[0]).toContain('[预览]');
    await expect(fs.readdir(stateDir)).resolves.toEqual(['run-a.json']);
    release();
  });

  it('问答在跑时 raw_archive 不在拦截范围（问答不读存档）', async () => {
    const release = beginActivity('query');
    const res = await postCleanup({ target: 'raw_archive', dry_run: false, days: 1 });
    expect(res.statusCode).toBe(200);
    release();
  });

  it('target=all 在有任务时同样被拦，避免"整页清理"绕过单类拦截', async () => {
    const release = beginActivity('query');
    const res = await postCleanup({ target: 'all', dry_run: false });
    expect(res.statusCode).toBe(409);
    const body = res.json() as CleanupBlockedResponse;
    expect(body.blocked).toEqual(['run_state']);
    // 未被拦的子目标也不能执行：整个请求在入口就返回
    await expect(fs.readdir(rawDir)).resolves.toEqual(['input-1.md']);
    release();
  });

  it('被拦的尝试也要落审计（这是"用户试图在有任务时真删"的唯一留痕）', async () => {
    const release = beginActivity('compile');
    await postCleanup({ target: 'run_state', dry_run: false });
    release();
    const audit = await fs.readFile(path.join(tempRoot, 'data', '.harness', 'cleanup-audit.log'), 'utf8');
    const entries = audit
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const blockedEntry = entries.find((e) => e.blocked_by_active_task === true);
    expect(blockedEntry).toBeTruthy();
    expect(blockedEntry?.target).toBe('run_state');
    expect(blockedEntry?.dry_run).toBe(false);
  });
});

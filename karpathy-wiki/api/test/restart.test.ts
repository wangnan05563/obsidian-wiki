// T02622 受控重启通道 —— 三层回归。
// 这一单的风险不是「按钮点不动」，而是「看起来重启了其实没有」或「有任务在跑也被切断」，
// 所以断言落在可观测事实上：状态码、拒绝码、拉起动作是否恰好发生一次、afterRestart 是否被调用。
//  1) 纯函数：空闲判定 / 形态分派。
//  2) 端口等待：旧实例还在监听时必须等到超时，释放后必须立刻放行。
//  3) 路由：confirm 门、活跃任务门、202 响应形状。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import net from 'node:net';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { preHandlerHookHandler } from 'fastify';
import { __resetActivitiesForTest, beginActivity } from '../src/activity.js';
import { setCoordinationPaths } from '../src/cleanup-cross-process.js';
import { registerConfigRoute, type RestartController } from '../src/routes/config.js';
import type { IsolationGuards } from '../src/middleware/auth.js';
import type { CleanupActiveState } from '../src/types.js';
import type { HarnessAdapter } from '../src/engine/harness-adapter.js';
import {
  performRestart,
  restartRefusal,
  waitPortFree,
  RESTART_EXIT_DELAY_MS,
  type RestartMode,
} from '../src/restart.js';

const passThrough: preHandlerHookHandler = (_req, _reply, done) => done();
const guards: IsolationGuards = { enabled: false, requireAuth: passThrough, requireAdmin: passThrough };

function activeState(compile: number, query: number): CleanupActiveState {
  return { compile, query, blockedTargets: [], blockedReasons: [] };
}

describe('restartRefusal：有活跃任务就不许重启', () => {
  it('空闲时放行', () => {
    expect(restartRefusal(activeState(0, 0))).toBeNull();
    expect(restartRefusal(activeState(0, 0), 0)).toBeNull();
  });

  it('编译任务在跑时拒绝，并带上计数', () => {
    const refusal = restartRefusal(activeState(2, 0));
    expect(refusal?.code).toBe('restart_blocked_by_active_task');
    expect(refusal?.active).toEqual({ compile: 2, query: 0, queuedCompile: 0, blockedReasons: [] });
    expect(refusal?.error).toContain('已拒绝重启');
    expect(refusal?.error).toContain('2 个编译');
  });

  it('问答在跑时同样拒绝', () => {
    const refusal = restartRefusal(activeState(0, 1));
    expect(refusal?.error).toContain('1 个问答');
  });

  it('只有排队中的编译也拒绝：它还没起跑，但重启同样会丢掉这次提交', () => {
    const refusal = restartRefusal(activeState(0, 0), 2);
    expect(refusal).not.toBeNull();
    expect(refusal?.active).toEqual({ compile: 0, query: 0, queuedCompile: 2, blockedReasons: [] });
    expect(refusal?.error).toContain('2 个编译在排队');
  });

  it('正在跑 + 排队同时存在时两项都点出来', () => {
    const refusal = restartRefusal(activeState(1, 1), 3);
    expect(refusal?.error).toContain('1 个编译');
    expect(refusal?.error).toContain('1 个问答');
    expect(refusal?.error).toContain('3 个编译在排队');
  });

  it('跨进程拦下时保留「来自另一实例」的归属', () => {
    const active = activeState(0, 1);
    active.blockedReasons = [{ target: 'run_state', reason: '有问答任务正在进行（来自另一服务实例：pid 999）' }];
    const refusal = restartRefusal(active);
    expect(refusal?.error).toContain('另一服务实例：pid 999');
    expect(refusal?.active.blockedReasons).toEqual(['有问答任务正在进行（来自另一服务实例：pid 999）']);
  });

  it('文案不复用清理守卫的「已拦截真实删除」措辞', () => {
    expect(restartRefusal(activeState(1, 0))?.error).not.toContain('删除');
  });
});

describe('performRestart：按形态分派，且只走一条通道', () => {
  it('打包形态只做自复制，不碰源码', () => {
    const spawnSelf = vi.fn();
    const touchEntry = vi.fn();
    expect(performRestart({ packaged: true, spawnSelf, touchEntry })).toBe('packaged');
    expect(spawnSelf).toHaveBeenCalledTimes(1);
    expect(touchEntry).not.toHaveBeenCalled();
  });

  it('开发形态只触碰 watch 入口，不自复制', () => {
    const spawnSelf = vi.fn();
    const touchEntry = vi.fn();
    expect(performRestart({ packaged: false, spawnSelf, touchEntry })).toBe('dev-watch');
    expect(touchEntry).toHaveBeenCalledTimes(1);
    expect(spawnSelf).not.toHaveBeenCalled();
  });
});

describe('waitPortFree：子实例不能抢在旧实例退出前 listen', () => {
  it('端口仍被占用时不放行（短超时），释放后立即放行', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    expect(await waitPortFree(port, 300, 50)).toBe(false);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await waitPortFree(port, 2000, 50)).toBe(true);
  });
});

describe('POST /api/restart：三道门', () => {
  let app: FastifyInstance;
  let perform: ReturnType<typeof vi.fn>;
  let afterRestart: ReturnType<typeof vi.fn>;

  async function build(performImpl: () => RestartMode = () => 'packaged'): Promise<void> {
    perform = vi.fn(performImpl);
    afterRestart = vi.fn();
    app = Fastify({ logger: false });
    const controller: RestartController = {
      bootId: () => 'boot-test',
      afterRestart,
      perform: perform as unknown as () => RestartMode,
    };
    registerConfigRoute(app, {} as HarnessAdapter, guards, controller);
    await app.ready();
  }

  beforeEach(async () => {
    __resetActivitiesForTest();
    // 协调目录置空：本例只验证进程内计数与路由语义，不往仓库写活跃声明文件
    setCoordinationPaths({ markerFile: null, activityDir: null, instance: 'test' });
    await build();
  });

  afterEach(async () => {
    __resetActivitiesForTest();
    await app.close();
  });

  it('没有 confirm 一律 400，且不产生任何拉起动作', async () => {
    for (const payload of [{}, { confirm: 'true' }, { confirm: 1 }]) {
      const res = await app.inject({ method: 'POST', url: '/api/restart', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('restart_confirm_required');
    }
    expect(perform).not.toHaveBeenCalled();
    expect(afterRestart).not.toHaveBeenCalled();
  });

  it('有编译在跑 → 409，列出被拦原因，不拉起也不关停旧实例', async () => {
    const release = beginActivity('compile');
    try {
      const res = await app.inject({ method: 'POST', url: '/api/restart', payload: { confirm: true } });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.code).toBe('restart_blocked_by_active_task');
      expect(body.active.compile).toBe(1);
      expect(body.error).toContain('1 个编译');
      expect(perform).not.toHaveBeenCalled();
      expect(afterRestart).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('空闲 + confirm → 202，先回响应再拉起，并带上 bootId 供前端轮询', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/restart', payload: { confirm: true } });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({
      ok: true,
      mode: 'packaged',
      bootId: 'boot-test',
      delayMs: RESTART_EXIT_DELAY_MS,
    });
    expect(typeof body.pid).toBe('number');
    expect(perform).toHaveBeenCalledTimes(1);
    expect(afterRestart).toHaveBeenCalledWith('packaged');
  });

  it('dev 形态同样回 202，但让调用方知道走的是 watch 通道', async () => {
    await app.close();
    await build(() => 'dev-watch');
    const res = await app.inject({ method: 'POST', url: '/api/restart', payload: { confirm: true } });
    expect(res.statusCode).toBe(202);
    expect(res.json().mode).toBe('dev-watch');
    expect(afterRestart).toHaveBeenCalledWith('dev-watch');
  });
});

describe('启动装配：/wiki/health 必须是 JSON 别名', () => {
  // 前端 HEALTH_URL = BASE_URL + 'health' = /wiki/health；但 setupSpaStatic 注册了 /wiki/* 通配，
  // 未命中磁盘文件的路径会回 index.html。少了这个别名，前端永远解析不到 bootId，
  // 表现是「重启成功也报 15 秒未检测到重启」——只在装机版才复现，故用源码守卫锁住。
  it("index.ts 显式注册 app.get('/wiki/health')", () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
    expect(src).toContain("app.get('/wiki/health'");
  });
});

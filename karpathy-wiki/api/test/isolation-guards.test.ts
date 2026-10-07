import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createIsolationGuards, setupAuthMiddleware } from '../src/middleware/auth.js';
import { createSession, clearAllSessions } from '../src/auth/session.js';
import { clearPermissionCache } from '../src/auth/permission-cache.js';
import { initAuditLog, resetAuditLog, flushAuditLog } from '../src/auth/audit-log.js';

// 隔离守卫（createIsolationGuards）端到端回归测试
//
// 为什么单独成文件：middleware-auth.test.ts 用 mock request/reply 测 promise 风格守卫，
// 而本项目的 86 处 `preHandler: guards.requireAuth / requireAdmin` 走的是 done 回调桥接
// （SonarQube S6544 修复）。桥接写法是否正确，只有用「真实 Fastify 实例 + inject」才能验证：
//  ① 未登录必须真正截断请求（返回 401 且业务 handler 绝不执行）——否则越权写入仍会发生；
//  ② send() 之后调用 done() 不能触发二次 send（FST_ERR_REP_ALREADY_SENT → 进程崩溃）；
//  ③ 单租户（auth.enabled=false）必须无 token 放行，保持既有部署形态。
// ①②是本次重排守卫签名引入的最大风险，故逐路由、逐角色断言 handlerInvoked。

const SECRET = 'test-isolation-guard-secret-16ch';

// 会话上下文：记录 handler 是否被调用（守卫截断的核心证据）
interface Probe {
  handlerInvoked: boolean;
}

function makeProbe(): Probe {
  return { handlerInvoked: false };
}

// 组装一个真实 Fastify 实例：全局 token 解析中间件 + 隔离守卫
// 与 src/index.ts 的接线一致：setupAuthMiddleware(app, config) + createIsolationGuards(config.auth)
async function buildApp(opts: {
  authEnabled: boolean;
  guardsEnabled: boolean;
  permissionCacheTtlSec?: number;
}): Promise<{ app: FastifyInstance; guards: ReturnType<typeof createIsolationGuards> }> {
  const app = Fastify({ logger: false });
  setupAuthMiddleware(app, {
    enabled: opts.authEnabled,
    sessionSecret: SECRET,
    permissionCacheTtlMs: 300000,
    publicPaths: [],
  });
  const guards = createIsolationGuards({
    enabled: opts.guardsEnabled,
    permissionCacheTtlSec: opts.permissionCacheTtlSec ?? 300,
  });
  // 不在这里 ready()：ready 后实例进入 started，追加路由会抛 FST_ERR_INSTANCE_ALREADY_LISTENING。
  // 各用例在注册完路由后由 inject() 自行触发 ready。
  return { app, guards };
}

describe('createIsolationGuards（真实 Fastify 生命周期）', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-guards-test-'));
    clearAllSessions();
    clearPermissionCache();
    resetAuditLog();
    await initAuditLog(path.join(tempDir, 'audit.log'));
  });

  afterEach(async () => {
    clearAllSessions();
    clearPermissionCache();
    // 先排空审计写入队列再重置：resetAuditLog 会把 logFilePath 置 null，
    // 队列中尚未执行的 appendFile 会因此报 ERR_INVALID_ARG_TYPE（测试噪声，非产品缺陷）
    await flushAuditLog();
    resetAuditLog();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言
    }
  });

  describe('requireAuth（auth 启用）', () => {
    it('未登录 → 401 UNAUTHORIZED 且业务 handler 未被调用', async () => {
      const { app, guards } = await buildApp({ authEnabled: true, guardsEnabled: true });
      const probe = makeProbe();
      app.get('/guarded', { preHandler: guards.requireAuth }, async () => {
        probe.handlerInvoked = true;
        return { ok: true };
      });

      const res = await app.inject({ method: 'GET', url: '/guarded' });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('UNAUTHORIZED');
      expect(probe.handlerInvoked).toBe(false);
      await app.close();
    });

    it('无效 token → 401 且 handler 未被调用（不得凭残缺凭据放行）', async () => {
      const { app, guards } = await buildApp({ authEnabled: true, guardsEnabled: true });
      const probe = makeProbe();
      app.get('/guarded', { preHandler: guards.requireAuth }, async () => {
        probe.handlerInvoked = true;
        return { ok: true };
      });

      const res = await app.inject({
        method: 'GET',
        url: '/guarded',
        headers: { authorization: 'Bearer not.a.real.token' },
      });
      expect(res.statusCode).toBe(401);
      expect(probe.handlerInvoked).toBe(false);
      await app.close();
    });

    it('有效 token → 200 且 handler 正常执行', async () => {
      const { app, guards } = await buildApp({ authEnabled: true, guardsEnabled: true });
      const probe = makeProbe();
      app.get('/guarded', { preHandler: guards.requireAuth }, async () => {
        probe.handlerInvoked = true;
        return { ok: true };
      });
      const session = createSession({ userId: 'u1', username: 'alice', role: 'user', secret: SECRET });

      const res = await app.inject({
        method: 'GET',
        url: '/guarded',
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(probe.handlerInvoked).toBe(true);
      await app.close();
    });

    it('Cookie 形式 token 同样受守卫保护（与 extractToken 双通道一致）', async () => {
      const { app, guards } = await buildApp({ authEnabled: true, guardsEnabled: true });
      const probe = makeProbe();
      app.get('/guarded', { preHandler: guards.requireAuth }, async () => {
        probe.handlerInvoked = true;
        return { ok: true };
      });
      const session = createSession({ userId: 'u2', username: 'bob', role: 'user', secret: SECRET });

      const res = await app.inject({ method: 'GET', url: '/guarded', headers: { cookie: `session=${session.token}` } });
      expect(res.statusCode).toBe(200);
      expect(probe.handlerInvoked).toBe(true);
      await app.close();
    });

    it('写方法（POST/DELETE）同样被拦截：守卫与 HTTP 方法无关', async () => {
      const { app, guards } = await buildApp({ authEnabled: true, guardsEnabled: true });
      const probe = makeProbe();
      app.post('/write', { preHandler: guards.requireAuth }, async () => {
        probe.handlerInvoked = true;
        return { deleted: true };
      });

      const res = await app.inject({ method: 'POST', url: '/write', payload: { a: 1 } });
      expect(res.statusCode).toBe(401);
      expect(probe.handlerInvoked).toBe(false);
      await app.close();
    });
  });

  describe('requireAdmin（auth 启用）', () => {
    it('未登录 → 401 + 审计 permission_denied + handler 未被调用', async () => {
      const { app, guards } = await buildApp({ authEnabled: true, guardsEnabled: true });
      const probe = makeProbe();
      app.get('/admin-only', { preHandler: guards.requireAdmin }, async () => {
        probe.handlerInvoked = true;
        return { ok: true };
      });

      const res = await app.inject({ method: 'GET', url: '/admin-only' });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('UNAUTHORIZED');
      expect(probe.handlerInvoked).toBe(false);
      await flushAuditLog();
      const auditContent = await fs.readFile(path.join(tempDir, 'audit.log'), 'utf8');
      expect(auditContent).toContain('permission_denied');
      await app.close();
    });

    it('普通用户 → 403 FORBIDDEN（required=users）+ handler 未被调用', async () => {
      const { app, guards } = await buildApp({ authEnabled: true, guardsEnabled: true });
      const probe = makeProbe();
      app.get('/admin-only', { preHandler: guards.requireAdmin }, async () => {
        probe.handlerInvoked = true;
        return { ok: true };
      });
      const session = createSession({ userId: 'u3', username: 'carol', role: 'user', secret: SECRET });

      const res = await app.inject({
        method: 'GET',
        url: '/admin-only',
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FORBIDDEN');
      expect(res.json().required).toBe('users');
      expect(probe.handlerInvoked).toBe(false);
      await app.close();
    });

    it('管理员 → 200 且 handler 执行', async () => {
      const { app, guards } = await buildApp({ authEnabled: true, guardsEnabled: true });
      const probe = makeProbe();
      app.get('/admin-only', { preHandler: guards.requireAdmin }, async () => {
        probe.handlerInvoked = true;
        return { ok: true };
      });
      const session = createSession({ userId: 'u4', username: 'root', role: 'admin', secret: SECRET });

      const res = await app.inject({
        method: 'GET',
        url: '/admin-only',
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(probe.handlerInvoked).toBe(true);
      await app.close();
    });
  });

  describe('单租户形态（auth.enabled=false）', () => {
    it('两个守卫都无 token 放行：保持「关闭认证 = 全部管理员」既有行为', async () => {
      // authEnabled=false：全局中间件不注入 currentUser；guardsEnabled=false：守卫放行
      const { app, guards } = await buildApp({ authEnabled: false, guardsEnabled: false });
      expect(guards.enabled).toBe(false);
      const authProbe = makeProbe();
      const adminProbe = makeProbe();
      app.get('/by-auth', { preHandler: guards.requireAuth }, async () => {
        authProbe.handlerInvoked = true;
        return { ok: true };
      });
      app.get('/by-admin', { preHandler: guards.requireAdmin }, async () => {
        adminProbe.handlerInvoked = true;
        return { ok: true };
      });

      const r1 = await app.inject({ method: 'GET', url: '/by-auth' });
      const r2 = await app.inject({ method: 'GET', url: '/by-admin' });
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      expect(authProbe.handlerInvoked).toBe(true);
      expect(adminProbe.handlerInvoked).toBe(true);
      await app.close();
    });

    it('缺省入参（undefined）视为未启用：不得意外锁死本地部署', async () => {
      const guards = createIsolationGuards();
      expect(guards.enabled).toBe(false);
      const { app } = await buildApp({ authEnabled: false, guardsEnabled: false });
      const probe = makeProbe();
      app.get('/default', { preHandler: guards.requireAuth }, async () => {
        probe.handlerInvoked = true;
        return { ok: true };
      });
      const res = await app.inject({ method: 'GET', url: '/default' });
      expect(res.statusCode).toBe(200);
      expect(probe.handlerInvoked).toBe(true);
      await app.close();
    });
  });

  describe('守卫串联 / 响应唯一性', () => {
    it('两个守卫串联且未登录 → 仅一个响应（无 FST_ERR_REP_ALREADY_SENT，不返回 500）', async () => {
      const { app, guards } = await buildApp({ authEnabled: true, guardsEnabled: true });
      const probe = makeProbe();
      app.get(
        '/chained',
        { preHandler: [guards.requireAuth, guards.requireAdmin] },
        async () => {
          probe.handlerInvoked = true;
          return { ok: true };
        },
      );

      const res = await app.inject({ method: 'GET', url: '/chained' });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('UNAUTHORIZED');
      expect(probe.handlerInvoked).toBe(false);
      await app.close();
    });

    it('串联守卫 + 普通用户 → 由管理员守卫给出 403（前一个守卫不得吞掉后一个）', async () => {
      const { app, guards } = await buildApp({ authEnabled: true, guardsEnabled: true });
      const probe = makeProbe();
      app.get(
        '/chained',
        { preHandler: [guards.requireAuth, guards.requireAdmin] },
        async () => {
          probe.handlerInvoked = true;
          return { ok: true };
        },
      );
      const session = createSession({ userId: 'u5', username: 'dave', role: 'user', secret: SECRET });

      const res = await app.inject({
        method: 'GET',
        url: '/chained',
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(probe.handlerInvoked).toBe(false);
      await app.close();
    });

    it('管理员通过串联守卫 → 200', async () => {
      const { app, guards } = await buildApp({ authEnabled: true, guardsEnabled: true });
      const probe = makeProbe();
      app.get(
        '/chained',
        { preHandler: [guards.requireAuth, guards.requireAdmin] },
        async () => {
          probe.handlerInvoked = true;
          return { ok: true };
        },
      );
      const session = createSession({ userId: 'u6', username: 'eve', role: 'admin', secret: SECRET });

      const res = await app.inject({
        method: 'GET',
        url: '/chained',
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(probe.handlerInvoked).toBe(true);
      await app.close();
    });
  });

  describe('权限缓存 TTL 接线', () => {
    it('permissionCacheTtlSec 以秒传入并按毫秒生效（普通用户始终 403）', async () => {
      const { app, guards } = await buildApp({ authEnabled: true, guardsEnabled: true, permissionCacheTtlSec: 1 });
      const probe = makeProbe();
      app.get('/admin-only', { preHandler: guards.requireAdmin }, async () => {
        probe.handlerInvoked = true;
        return { ok: true };
      });
      const session = createSession({ userId: 'u7', username: 'frank', role: 'user', secret: SECRET });

      const first = await app.inject({
        method: 'GET',
        url: '/admin-only',
        headers: { authorization: `Bearer ${session.token}` },
      });
      // 第二次读取命中缓存，结论必须一致
      const second = await app.inject({
        method: 'GET',
        url: '/admin-only',
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(first.statusCode).toBe(403);
      expect(second.statusCode).toBe(403);
      expect(probe.handlerInvoked).toBe(false);
      await app.close();
    });
  });
});

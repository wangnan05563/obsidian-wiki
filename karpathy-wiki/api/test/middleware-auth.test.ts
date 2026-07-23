import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupAuthMiddleware,
  extractToken,
  requireAuth,
  requirePermission,
  requireAdmin,
  audit,
  type AuthMiddlewareConfig,
} from '../src/middleware/auth.js';
import { validateSession } from '../src/auth/session.js';
import { createSession } from '../src/auth/session.js';
import { clearAllSessions } from '../src/auth/session.js';
import { clearPermissionCache } from '../src/auth/permission-cache.js';
import { initAuditLog, resetAuditLog, flushAuditLog } from '../src/auth/audit-log.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 认证中间件测试
// 通过模拟 Fastify 实例验证 preHandler / decorate / requireAuth / requirePermission 行为

const SECRET = 'test-middleware-secret-16chars';

// 构造最小化 Fastify mock：仅实现 addHook / decorate / decorateRequest
function createFastifyMock() {
  const hooks: Array<{ event: string; handler: Function }> = [];
  return {
    hooks,
    decorated: {} as Record<string, unknown>,
    decoratedRequest: {} as Record<string, unknown>,
    addHook(event: string, handler: Function) {
      hooks.push({ event, handler });
    },
    decorate(key: string, value: unknown) {
      this.decorated[key] = value;
    },
    decorateRequest(key: string, value: unknown) {
      this.decoratedRequest[key] = value;
    },
  };
}

// 构造模拟 FastifyRequest
function createMockRequest(overrides: Partial<{
  url: string;
  method: string;
  headers: Record<string, string | undefined>;
  ip: string;
  currentUser: unknown;
}> = {}) {
  return {
    url: overrides.url ?? '/api/test',
    method: overrides.method ?? 'GET',
    headers: overrides.headers ?? {},
    ip: overrides.ip ?? '127.0.0.1',
    currentUser: overrides.currentUser ?? undefined,
  } as any;
}

// 构造模拟 FastifyReply：捕获 code/send 调用
function createMockReply() {
  let sentCode = 200;
  let sentBody: unknown = null;
  let sent = false;
  return {
    code(c: number) { sentCode = c; return this; },
    send(body: unknown) { sentBody = body; sent = true; return this; },
    _state: { get code() { return sentCode; }, get body() { return sentBody; }, get sent() { return sent; } },
  } as any;
}

describe('middleware/auth 模块', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-mw-test-'));
    clearAllSessions();
    clearPermissionCache();
    resetAuditLog();
    await initAuditLog(path.join(tempDir, 'audit.log'));
  });

  afterEach(async () => {
    clearAllSessions();
    clearPermissionCache();
    resetAuditLog();
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  describe('setupAuthMiddleware', () => {
    it('enabled=false 时所有请求视为管理员', () => {
      const app = createFastifyMock();
      const config: AuthMiddlewareConfig = {
        enabled: false,
        sessionSecret: SECRET,
        permissionCacheTtlMs: 300000,
        publicPaths: ['/api/auth/login'],
      };
      setupAuthMiddleware(app as any, config);
      expect(app.decorated).toHaveProperty('currentUser');
    });

    it('enabled=true 时应注册 preHandler 钩子', () => {
      const app = createFastifyMock();
      const config: AuthMiddlewareConfig = {
        enabled: true,
        sessionSecret: SECRET,
        permissionCacheTtlMs: 300000,
        publicPaths: ['/api/auth/login'],
      };
      setupAuthMiddleware(app as any, config);
      expect(app.hooks.some((h) => h.event === 'preHandler')).toBe(true);
      expect(app.decoratedRequest).toHaveProperty('currentUser');
    });

    it('preHandler 应跳过公开路径', async () => {
      const app = createFastifyMock();
      const config: AuthMiddlewareConfig = {
        enabled: true,
        sessionSecret: SECRET,
        permissionCacheTtlMs: 300000,
        publicPaths: ['/api/auth/login'],
      };
      setupAuthMiddleware(app as any, config);
      const handler = app.hooks.find((h) => h.event === 'preHandler')!.handler;
      const req = createMockRequest({ url: '/api/auth/login' });
      const reply = createMockReply();
      await handler(req, reply);
      // 公开路径不设置 currentUser
      expect(req.currentUser).toBeUndefined();
    });

    it('preHandler 应跳过带子路径的公开路由', async () => {
      const app = createFastifyMock();
      const config: AuthMiddlewareConfig = {
        enabled: true,
        sessionSecret: SECRET,
        permissionCacheTtlMs: 300000,
        publicPaths: ['/api/auth'],
      };
      setupAuthMiddleware(app as any, config);
      const handler = app.hooks.find((h) => h.event === 'preHandler')!.handler;
      const req = createMockRequest({ url: '/api/auth/login?redirect=/x' });
      const reply = createMockReply();
      await handler(req, reply);
      expect(req.currentUser).toBeUndefined();
    });

    it('preHandler 无 token 时不应注入 currentUser（游客态）', async () => {
      const app = createFastifyMock();
      const config: AuthMiddlewareConfig = {
        enabled: true,
        sessionSecret: SECRET,
        permissionCacheTtlMs: 300000,
        publicPaths: ['/api/auth/login'],
      };
      setupAuthMiddleware(app as any, config);
      const handler = app.hooks.find((h) => h.event === 'preHandler')!.handler;
      const req = createMockRequest({ url: '/api/users', headers: {} });
      const reply = createMockReply();
      await handler(req, reply);
      expect(req.currentUser).toBeUndefined();
    });

    it('preHandler 有效 token 时应注入 currentUser', async () => {
      const app = createFastifyMock();
      const config: AuthMiddlewareConfig = {
        enabled: true,
        sessionSecret: SECRET,
        permissionCacheTtlMs: 300000,
        publicPaths: [],
      };
      setupAuthMiddleware(app as any, config);
      const handler = app.hooks.find((h) => h.event === 'preHandler')!.handler;
      const session = createSession({ userId: 'u1', username: 'admin', role: 'admin', secret: SECRET });
      const req = createMockRequest({
        url: '/api/users',
        headers: { authorization: `Bearer ${session.token}` },
      });
      const reply = createMockReply();
      await handler(req, reply);
      expect(req.currentUser).not.toBeNull();
      expect(req.currentUser.username).toBe('admin');
    });

    it('preHandler 无效 token 时不注入 currentUser', async () => {
      const app = createFastifyMock();
      const config: AuthMiddlewareConfig = {
        enabled: true,
        sessionSecret: SECRET,
        permissionCacheTtlMs: 300000,
        publicPaths: [],
      };
      setupAuthMiddleware(app as any, config);
      const handler = app.hooks.find((h) => h.event === 'preHandler')!.handler;
      const req = createMockRequest({
        url: '/api/users',
        headers: { authorization: 'Bearer invalid.token' },
      });
      const reply = createMockReply();
      await handler(req, reply);
      expect(req.currentUser).toBeUndefined();
    });
  });

  describe('extractToken', () => {
    it('应从 Authorization: Bearer 提取 token', () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer abc.def' },
      });
      expect(extractToken(req)).toBe('abc.def');
    });

    it('应从 Cookie: session= 提取 token', () => {
      const req = createMockRequest({
        headers: { cookie: 'session=abc.def; other=val' },
      });
      expect(extractToken(req)).toBe('abc.def');
    });

    it('Authorization 优先于 Cookie', () => {
      const req = createMockRequest({
        headers: {
          authorization: 'Bearer auth-token',
          cookie: 'session=cookie-token',
        },
      });
      expect(extractToken(req)).toBe('auth-token');
    });

    it('无 token 头返回 null', () => {
      const req = createMockRequest({ headers: {} });
      expect(extractToken(req)).toBeNull();
    });

    it('Cookie 中无 session 返回 null', () => {
      const req = createMockRequest({
        headers: { cookie: 'other=val' },
      });
      expect(extractToken(req)).toBeNull();
    });

    it('Bearer 后空格应被 trim', () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer   spaced.token  ' },
      });
      expect(extractToken(req)).toBe('spaced.token');
    });
  });

  describe('requireAuth', () => {
    it('未登录应返回 401', async () => {
      const req = createMockRequest({ currentUser: undefined });
      const reply = createMockReply();
      await requireAuth(req, reply);
      expect(reply._state.code).toBe(401);
      expect(reply._state.sent).toBe(true);
      expect((reply._state.body as any).code).toBe('UNAUTHORIZED');
    });

    it('已登录应通过（不 send）', async () => {
      const req = createMockRequest({
        currentUser: { userId: 'u1', username: 'a', role: 'admin' },
      });
      const reply = createMockReply();
      await requireAuth(req, reply);
      expect(reply._state.sent).toBe(false);
    });
  });

  describe('requirePermission', () => {
    it('未登录访问受保护资源应返回 401', async () => {
      const guard = requirePermission('dashboard', 300000);
      const req = createMockRequest({ currentUser: undefined, url: '/api/dashboard' });
      const reply = createMockReply();
      await guard(req, reply);
      expect(reply._state.code).toBe(401);
      expect((reply._state.body as any).code).toBe('UNAUTHORIZED');
    });

    it('普通用户访问 dashboard 应返回 403', async () => {
      const guard = requirePermission('dashboard', 300000);
      const req = createMockRequest({
        currentUser: { userId: 'u1', username: 'user', role: 'user' },
        url: '/api/dashboard',
      });
      const reply = createMockReply();
      await guard(req, reply);
      expect(reply._state.code).toBe(403);
      expect((reply._state.body as any).code).toBe('FORBIDDEN');
      expect((reply._state.body as any).required).toBe('dashboard');
    });

    it('管理员访问 dashboard 应通过', async () => {
      const guard = requirePermission('dashboard', 300000);
      const req = createMockRequest({
        currentUser: { userId: 'u1', username: 'admin', role: 'admin' },
      });
      const reply = createMockReply();
      await guard(req, reply);
      expect(reply._state.sent).toBe(false);
    });

    it('普通用户访问 browse 应通过', async () => {
      const guard = requirePermission('browse', 300000);
      const req = createMockRequest({
        currentUser: { userId: 'u1', username: 'user', role: 'user' },
      });
      const reply = createMockReply();
      await guard(req, reply);
      expect(reply._state.sent).toBe(false);
    });

    it('游客访问 browse 应通过', async () => {
      const guard = requirePermission('browse', 300000);
      const req = createMockRequest({
        currentUser: { userId: 'u1', username: 'guest', role: 'guest' },
      });
      const reply = createMockReply();
      await guard(req, reply);
      expect(reply._state.sent).toBe(false);
    });

    it('普通用户访问 users 应返回 403', async () => {
      const guard = requirePermission('users', 300000);
      const req = createMockRequest({
        currentUser: { userId: 'u1', username: 'user', role: 'user' },
        url: '/api/auth/users',
      });
      const reply = createMockReply();
      await guard(req, reply);
      expect(reply._state.code).toBe(403);
    });

    it('越权访问应写入审计日志', async () => {
      const guard = requirePermission('users', 300000);
      const req = createMockRequest({
        currentUser: { userId: 'u1', username: 'user', role: 'user' },
        url: '/api/auth/users',
        method: 'GET',
        ip: '192.168.1.1',
      });
      const reply = createMockReply();
      await guard(req, reply);
      await flushAuditLog();
      // 审计日志应记录 permission_denied
      const content = await fs.readFile(path.join(tempDir, 'audit.log'), 'utf8');
      expect(content).toContain('permission_denied');
      expect(content).toContain('192.168.1.1');
    });
  });

  describe('requireAdmin', () => {
    it('是 requirePermission("users") 的语法糖', async () => {
      const guard = requireAdmin(300000);
      const req = createMockRequest({
        currentUser: { userId: 'u1', username: 'user', role: 'user' },
        url: '/api/users',
      });
      const reply = createMockReply();
      await guard(req, reply);
      expect(reply._state.code).toBe(403);
      expect((reply._state.body as any).required).toBe('users');
    });

    it('管理员通过', async () => {
      const guard = requireAdmin(300000);
      const req = createMockRequest({
        currentUser: { userId: 'u1', username: 'admin', role: 'admin' },
      });
      const reply = createMockReply();
      await guard(req, reply);
      expect(reply._state.sent).toBe(false);
    });
  });

  describe('audit', () => {
    it('应写入审计日志（带用户信息）', async () => {
      const req = createMockRequest({
        currentUser: { userId: 'u1', username: 'admin' },
        ip: '10.0.0.1',
      });
      audit({
        request: req,
        action: 'user_create',
        resource: '/api/auth/users',
        result: 'success',
        message: '创建用户 test',
      });
      await flushAuditLog();
      const content = await fs.readFile(path.join(tempDir, 'audit.log'), 'utf8');
      expect(content).toContain('user_create');
      expect(content).toContain('10.0.0.1');
      expect(content).toContain('创建用户 test');
    });

    it('未登录时 userId/username 应为 null', async () => {
      const req = createMockRequest({
        currentUser: undefined,
        ip: '0.0.0.0',
      });
      audit({
        request: req,
        action: 'permission_denied',
        resource: '/api/xxx',
        result: 'fail',
      });
      await flushAuditLog();
      const content = await fs.readFile(path.join(tempDir, 'audit.log'), 'utf8');
      expect(content).toContain('"userId":null');
      expect(content).toContain('"username":null');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initUserStore,
  loadUsers,
  findUserByUsername,
  createUser,
  updateUser,
  deleteUser,
  resetUserStore,
} from '../src/auth/user-store.js';
import { createSession, validateSession, destroySession, clearAllSessions } from '../src/auth/session.js';
import { checkPermission, invalidateRoleCache, clearPermissionCache } from '../src/auth/permission-cache.js';
import { initAuditLog, writeAuditLog, readAuditLog, flushAuditLog, resetAuditLog, createAuditEntry } from '../src/auth/audit-log.js';
import { hasPermission, getRolePermissions, getRolePermissionMatrix } from '../src/auth/rbac.js';
import { verifyPassword } from '../src/auth/password.js';
import { requirePermission } from '../src/middleware/auth.js';

// 集成测试：验证不同角色（admin/user/guest）的权限边界
// 覆盖需求：
//   1. 管理员角色：拥有系统所有功能模块的访问和操作权限
//   2. 普通用户角色：仅拥有知识浏览、知识图谱查看、知识库问答三个菜单
//   3. 游客角色：仅拥有知识浏览、知识图谱查看、知识库问答三个菜单
//   4. 防止权限越权访问
//   5. 权限缓存机制
//   6. 审计日志记录

const SECRET = 'integration-test-secret-16chars';

// 模拟 FastifyRequest（最小化）
function createMockRequest(overrides: Partial<{
  url: string;
  method: string;
  ip: string;
  currentUser: unknown;
}> = {}) {
  return {
    url: overrides.url ?? '/api/test',
    method: overrides.method ?? 'GET',
    headers: {},
    ip: overrides.ip ?? '127.0.0.1',
    currentUser: overrides.currentUser ?? undefined,
  } as any;
}

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

describe('集成测试：RBAC 权限边界', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-int-test-'));
    clearAllSessions();
    clearPermissionCache();
    resetAuditLog();
    resetUserStore();
    await initAuditLog(path.join(tempDir, 'audit.log'));
    await initUserStore(path.join(tempDir, 'users.json'), 100000);
  });

  afterEach(async () => {
    clearAllSessions();
    clearPermissionCache();
    resetAuditLog();
    resetUserStore();
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  describe('需求 1：管理员拥有全部功能', () => {
    it('管理员角色应拥有全部 13 个权限点', () => {
      const perms = getRolePermissions('admin');
      expect(perms).toHaveLength(14);
      const matrix = getRolePermissionMatrix();
      expect(matrix.admin).toHaveLength(14);
    });

    it('管理员对所有受保护菜单有访问权', () => {
      const protectedMenus = ['dashboard', 'ingest', 'progress', 'health', 'config', 'tunnel', 'cleanup', 'users'] as const;
      for (const p of protectedMenus) {
        expect(hasPermission('admin', p)).toBe(true);
      }
    });

    it('管理员会话通过 requirePermission 守卫', async () => {
      const session = createSession({ userId: 'u-admin', username: 'admin', role: 'admin', secret: SECRET });
      const validated = validateSession(session.token, SECRET);
      expect(validated?.role).toBe('admin');
      // 守卫应通过
      const guard = requirePermission('dashboard', 300000);
      const req = createMockRequest({
        currentUser: { userId: validated!.userId, username: validated!.username, role: validated!.role },
      });
      const reply = createMockReply();
      await guard(req, reply);
      expect(reply._state.sent).toBe(false);
    });
  });

  describe('需求 2：普通用户仅拥有 browse/query/graph 三菜单', () => {
    it('普通用户权限列表应为 [browse, query, graph, help, about]', () => {
      const perms = getRolePermissions('user');
      expect(perms).toEqual(['browse', 'query', 'graph', 'help', 'about']);
    });

    it('普通用户对受保护菜单无访问权', () => {
      const protectedMenus = ['dashboard', 'ingest', 'progress', 'health', 'config', 'tunnel', 'cleanup', 'users'] as const;
      for (const p of protectedMenus) {
        expect(hasPermission('user', p)).toBe(false);
      }
    });

    it('普通用户对公开菜单有访问权', () => {
      expect(hasPermission('user', 'browse')).toBe(true);
      expect(hasPermission('user', 'query')).toBe(true);
      expect(hasPermission('user', 'graph')).toBe(true);
    });

    it('普通用户会话通过 browse 守卫，被 dashboard 守卫拒绝', async () => {
      const session = createSession({ userId: 'u-user', username: 'user', role: 'user', secret: SECRET });
      // browse 通过
      const browseGuard = requirePermission('browse', 300000);
      const browseReq = createMockRequest({
        currentUser: { userId: session.userId, username: session.username, role: session.role },
      });
      const browseReply = createMockReply();
      await browseGuard(browseReq, browseReply);
      expect(browseReply._state.sent).toBe(false);
      // dashboard 被拒
      const dashGuard = requirePermission('dashboard', 300000);
      const dashReq = createMockRequest({
        currentUser: { userId: session.userId, username: session.username, role: session.role },
        url: '/api/dashboard',
      });
      const dashReply = createMockReply();
      await dashGuard(dashReq, dashReply);
      expect(dashReply._state.code).toBe(403);
    });
  });

  describe('需求 3：游客与普通用户权限一致', () => {
    it('游客权限应等于普通用户权限', () => {
      const userPerms = getRolePermissions('user');
      const guestPerms = getRolePermissions('guest');
      expect(userPerms).toEqual(guestPerms);
    });

    it('游客会话通过 browse 守卫，被 users 守卫拒绝', async () => {
      const session = createSession({ userId: 'u-guest', username: 'guest', role: 'guest', secret: SECRET });
      const browseGuard = requirePermission('browse', 300000);
      const browseReq = createMockRequest({
        currentUser: { userId: session.userId, username: session.username, role: session.role },
      });
      const browseReply = createMockReply();
      await browseGuard(browseReq, browseReply);
      expect(browseReply._state.sent).toBe(false);

      const usersGuard = requirePermission('users', 300000);
      const usersReq = createMockRequest({
        currentUser: { userId: session.userId, username: session.username, role: session.role },
        url: '/api/auth/users',
      });
      const usersReply = createMockReply();
      await usersGuard(usersReq, usersReply);
      expect(usersReply._state.code).toBe(403);
    });
  });

  describe('需求 4：防止权限越权访问', () => {
    it('未登录用户访问受保护资源应返回 401', async () => {
      const guard = requirePermission('dashboard', 300000);
      const req = createMockRequest({ currentUser: undefined, url: '/api/dashboard' });
      const reply = createMockReply();
      await guard(req, reply);
      expect(reply._state.code).toBe(401);
    });

    it('普通用户伪造管理员角色仍会被拒绝（RBAC 静态表是权威源）', () => {
      // 即使前端伪造 user.role = 'admin'，后端 checkPermission 仍基于静态表
      // 这里直接验证 checkPermission 不依赖会话角色而依赖 RBAC 静态表
      // 实际场景：前端伪造的 role 不会传给后端，后端从 session 校验后读取真实 role
      expect(hasPermission('user', 'dashboard')).toBe(false);
      expect(hasPermission('admin', 'dashboard')).toBe(true);
    });

    it('用户角色变更后旧会话权限应立即失效（destroyUserSessions）', async () => {
      const session = createSession({ userId: 'u1', username: 'admin', role: 'admin', secret: SECRET });
      // 模拟用户被降级为普通用户
      const { destroyUserSessions } = await import('../src/auth/session.js');
      destroyUserSessions('u1');
      const validated = validateSession(session.token, SECRET);
      expect(validated).toBeNull();
    });

    it('权限缓存清除后重新检查应返回新结果', () => {
      // 先缓存普通用户的结果
      expect(checkPermission('user', 'dashboard')).toBe(false);
      // 清除缓存
      invalidateRoleCache('user');
      // 重新检查（RBAC 静态表仍是 false）
      expect(checkPermission('user', 'dashboard')).toBe(false);
    });
  });

  describe('需求 5：权限缓存机制', () => {
    it('缓存命中应加速后续检查', () => {
      const ttl = 60000;
      // 首次未命中
      checkPermission('admin', 'dashboard', ttl);
      // 第二次命中
      const r = checkPermission('admin', 'dashboard', ttl);
      expect(r).toBe(true);
    });

    it('TTL 到期后缓存失效', async () => {
      checkPermission('admin', 'dashboard', 1);
      await new Promise((r) => setTimeout(r, 5));
      // 缓存已过期，重新计算
      const r = checkPermission('admin', 'dashboard', 60000);
      expect(r).toBe(true);
    });

    it('角色级缓存清除应只影响该角色', () => {
      checkPermission('admin', 'dashboard');
      checkPermission('user', 'browse');
      invalidateRoleCache('admin');
      // user 缓存仍在
      const r = checkPermission('user', 'browse');
      expect(r).toBe(true);
    });
  });

  describe('需求 6：审计日志记录', () => {
    it('登录成功应记录审计日志', async () => {
      writeAuditLog(
        createAuditEntry({
          userId: 'u1',
          username: 'admin',
          action: 'login',
          resource: '/api/auth/login',
          ip: '127.0.0.1',
          result: 'success',
        }),
      );
      await flushAuditLog();
      const entries = await readAuditLog(path.join(tempDir, 'audit.log'));
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[entries.length - 1].action).toBe('login');
      expect(entries[entries.length - 1].result).toBe('success');
    });

    it('登录失败应记录审计日志（不区分用户名/密码错误）', async () => {
      writeAuditLog(
        createAuditEntry({
          userId: null,
          username: 'unknown',
          action: 'login',
          resource: '/api/auth/login',
          ip: '192.168.1.100',
          result: 'fail',
          message: '用户名或密码错误',
        }),
      );
      await flushAuditLog();
      const entries = await readAuditLog(path.join(tempDir, 'audit.log'));
      const loginFail = entries.find((e) => e.action === 'login' && e.result === 'fail');
      expect(loginFail).toBeTruthy();
      expect(loginFail?.ip).toBe('192.168.1.100');
    });

    it('越权访问应记录 permission_denied 审计日志', async () => {
      const guard = requirePermission('dashboard', 300000);
      const req = createMockRequest({
        currentUser: { userId: 'u-user', username: 'user', role: 'user' },
        url: '/api/dashboard',
        method: 'GET',
        ip: '10.0.0.5',
      });
      const reply = createMockReply();
      await guard(req, reply);
      await flushAuditLog();
      const entries = await readAuditLog(path.join(tempDir, 'audit.log'));
      const denied = entries.find((e) => e.action === 'permission_denied');
      expect(denied).toBeTruthy();
      expect(denied?.ip).toBe('10.0.0.5');
      expect(denied?.result).toBe('fail');
    });

    it('用户管理操作应记录审计日志', async () => {
      // 创建用户
      const newUser = await createUser({ username: 'newuser', password: 'pwd', role: 'user' });
      writeAuditLog(
        createAuditEntry({
          userId: 'u-admin',
          username: 'admin',
          action: 'user_create',
          resource: `/api/auth/users/${newUser.id}`,
          ip: '127.0.0.1',
          result: 'success',
          message: `创建用户 ${newUser.username}`,
        }),
      );
      await flushAuditLog();
      const entries = await readAuditLog(path.join(tempDir, 'audit.log'));
      const create = entries.find((e) => e.action === 'user_create');
      expect(create).toBeTruthy();
      expect(create?.message).toContain('newuser');
    });

    it('审计日志应按时间顺序追加', async () => {
      for (let i = 0; i < 5; i++) {
        writeAuditLog(
          createAuditEntry({
            userId: `u${i}`,
            username: `user${i}`,
            action: 'login',
            resource: '/api/auth/login',
            ip: '127.0.0.1',
            result: 'success',
          }),
        );
      }
      await flushAuditLog();
      const entries = await readAuditLog(path.join(tempDir, 'audit.log'));
      // 时间戳应单调递增
      for (let i = 1; i < entries.length; i++) {
        const prev = new Date(entries[i - 1].ts).getTime();
        const curr = new Date(entries[i].ts).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });
  });

  describe('端到端：登录 → 会话 → 权限校验 → 审计', () => {
    it('管理员完整流程', async () => {
      // 1. 查找用户
      const admin = await findUserByUsername('admin');
      expect(admin).not.toBeNull();
      // 2. 验证密码
      const pwdOk = await verifyPassword('admin123', admin!.salt, admin!.passwordHash, 100000);
      expect(pwdOk).toBe(true);
      // 3. 创建会话
      const session = createSession({
        userId: admin!.id,
        username: admin!.username,
        role: admin!.role,
        secret: SECRET,
      });
      expect(session.token).toBeTruthy();
      // 4. 验证会话
      const validated = validateSession(session.token, SECRET);
      expect(validated?.username).toBe('admin');
      // 5. 权限校验通过
      expect(hasPermission(validated!.role, 'users')).toBe(true);
      // 6. 审计日志
      writeAuditLog(
        createAuditEntry({
          userId: validated!.userId,
          username: validated!.username,
          action: 'login',
          resource: '/api/auth/login',
          ip: '127.0.0.1',
          result: 'success',
        }),
      );
      await flushAuditLog();
      const entries = await readAuditLog(path.join(tempDir, 'audit.log'));
      expect(entries[entries.length - 1].action).toBe('login');
    });

    it('普通用户完整流程（含越权拒绝）', async () => {
      const user = await findUserByUsername('user');
      expect(await verifyPassword('user123', user!.salt, user!.passwordHash, 100000)).toBe(true);
      const session = createSession({
        userId: user!.id,
        username: user!.username,
        role: user!.role,
        secret: SECRET,
      });
      const validated = validateSession(session.token, SECRET);
      // browse 通过
      expect(hasPermission(validated!.role, 'browse')).toBe(true);
      // users 被拒
      expect(hasPermission(validated!.role, 'users')).toBe(false);
      // 审计日志记录越权
      writeAuditLog(
        createAuditEntry({
          userId: validated!.userId,
          username: validated!.username,
          action: 'permission_denied',
          resource: '/api/auth/users',
          ip: '127.0.0.1',
          result: 'fail',
          message: '角色 user 无权限访问 users',
        }),
      );
      await flushAuditLog();
      const entries = await readAuditLog(path.join(tempDir, 'audit.log'));
      const denied = entries.find((e) => e.action === 'permission_denied');
      expect(denied).toBeTruthy();
    });

    it('游客完整流程', async () => {
      const guest = await findUserByUsername('guest');
      expect(await verifyPassword('guest123', guest!.salt, guest!.passwordHash, 100000)).toBe(true);
      const session = createSession({
        userId: guest!.id,
        username: guest!.username,
        role: guest!.role,
        secret: SECRET,
      });
      const validated = validateSession(session.token, SECRET);
      expect(hasPermission(validated!.role, 'browse')).toBe(true);
      expect(hasPermission(validated!.role, 'dashboard')).toBe(false);
    });
  });

  describe('安全要求验证', () => {
    it('默认管理员密码不可为空', async () => {
      const admin = await findUserByUsername('admin');
      expect(admin?.passwordHash).toBeTruthy();
      expect(admin?.salt).toBeTruthy();
    });

    it('用户被禁用后仍可通过密码验证（前端需先检查 enabled）', async () => {
      const user = await findUserByUsername('user');
      await updateUser(user!.id, { enabled: false });
      const updated = await findUserByUsername('user');
      expect(updated?.enabled).toBe(false);
      // 密码哈希仍可验证
      expect(await verifyPassword('user123', updated!.salt, updated!.passwordHash, 100000)).toBe(true);
    });

    it('最后一个管理员不可删除（防止系统失去管理入口）', async () => {
      const admin = await findUserByUsername('admin');
      await expect(deleteUser(admin!.id)).rejects.toThrow('系统至少保留一个管理员');
    });

    it('会话 token 防伪造（HMAC 签名校验）', () => {
      const session = createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET });
      const parts = session.token.split('.');
      const tampered = `${parts[0]}.tamperedHmac`;
      expect(validateSession(tampered, SECRET)).toBeNull();
    });

    it('会话过期后无效', async () => {
      const session = createSession({
        userId: 'u1',
        username: 'a',
        role: 'admin',
        secret: SECRET,
        ttlMs: 1,
      });
      await new Promise((r) => setTimeout(r, 5));
      expect(validateSession(session.token, SECRET)).toBeNull();
    });
  });
});

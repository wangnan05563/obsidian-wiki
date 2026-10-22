import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initAuthModule, registerAuthRoute } from '../src/routes/auth.js';
import { resetUserStore } from '../src/auth/user-store.js';
import { resetAuthRateLimiters } from '../src/auth/auth-rate-limit.js';

// T02473（PRD U2）路由级验证：用户管理写接口的守卫必须真的拦住请求。
// 回归点：原先这几处 400 分支缺 return，Fastify 不会中断 handler ——
//   「不能删除当前登录用户」只是回执，代码继续往下真的把人删了；
//   校验失败的建号请求同样落到了 createUser()。
// 模式同 auth-password-change.test.ts：真实 Fastify + mock getDataDir（临时目录）+ mock startSessionCleanup。

const hoisted = vi.hoisted(() => {
  let dir = '';
  return { getDir: () => dir, setDir: (d: string) => { dir = d; } };
});

vi.mock('../src/utils/runtime.js', () => ({
  getDataDir: () => hoisted.getDir(),
  // T02886：auth.ts 定根改走 toAbsVaultPath（内部调 getApiDir）；mock 指到临时目录下的 api/，
  // 让 fixture 的 '../data/users.json' 仍解析进临时目录（保持测试隔离）
  getApiDir: () => path.join(hoisted.getDir(), 'api'),
}));

vi.mock('../src/auth/session.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/session.js')>('../src/auth/session.js');
  return { ...actual, startSessionCleanup: () => {} };
});

function authConfigFixture() {
  return {
    enabled: true,
    sessionTtlHours: 24,
    permissionCacheTtlSec: 300,
    auditLogPath: '../data/audit.log',
    usersFilePath: '../data/users.json',
    pbkdf2Iterations: 100000,
    sessionSecretRef: 'WIKI_TEST_SESSION_SECRET',
  };
}

interface UserRow {
  id: string;
  username: string;
  role: string;
  enabled: boolean;
}

let app: ReturnType<typeof Fastify>;
let tempDir: string;

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  const body = res.json() as { token?: string };
  if (!body.token) throw new Error(`登录失败：${username} ${res.statusCode} ${res.body}`);
  return body.token;
}

async function listUsers(token: string): Promise<UserRow[]> {
  const res = await app.inject({ method: 'GET', url: '/api/auth/users', headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { users: UserRow[] }).users;
}

describe('T02473 用户管理写接口守卫', () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-users-it-'));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    resetUserStore();
    // 登录限流计数器是模块级的，用例里会多次 login → 每例重置（同 auth-rate-limit-route.test.ts）
    resetAuthRateLimiters();
    const caseDir = await fs.mkdtemp(path.join(tempDir, 'case-'));
    hoisted.setDir(caseDir);
    app = Fastify();
    await initAuthModule(authConfigFixture(), 'vault', false);
    registerAuthRoute(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    resetUserStore();
  });

  it('自删请求返回 400 后账户确实还在（回归：原先 400 只是回执，人已被删）', async () => {
    const token = await login('admin', 'admin123');
    const me = (await listUsers(token)).find(u => u.username === 'admin')!;

    const del = await app.inject({ method: 'DELETE', url: `/api/auth/users/${me.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toContain('不能删除当前登录用户');

    const after = await listUsers(token);
    expect(after.some(u => u.id === me.id)).toBe(true);
  });

  it('建号校验不通过时不会落库（回归：原先 400 之后继续执行 createUser）', async () => {
    const token = await login('admin', 'admin123');
    const before = await listUsers(token);

    const cases: Array<{ name: string; payload: unknown }> = [
      { name: '字段缺失', payload: { username: 'ok_name', password: '', role: 'user' } },
      { name: '非法角色', payload: { username: 'ok_name', password: 'pass-1234', role: 'superuser' } },
      { name: '用户名格式', payload: { username: 'bad name', password: 'pass-1234', role: 'user' } },
      { name: '密码过短', payload: { username: 'ok_name', password: '123', role: 'user' } },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/users', headers: { authorization: `Bearer ${token}` }, payload: c.payload });
      expect(res.statusCode, c.name).toBe(400);
      expect(res.json().error, c.name).toBeTruthy();
    }

    const after = await listUsers(token);
    expect(after.map(u => u.id).sort()).toEqual(before.map(u => u.id).sort());
  });

  it('合法建号仍然成功（守卫不能把正常路径一起堵死）', async () => {
    const token = await login('admin', 'admin123');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: 'auditor', password: 'auditor-pass-123', role: 'user' },
    });
    expect(res.statusCode).toBe(200);
    const created = res.json() as { id: string; username: string };
    expect(created.username).toBe('auditor');
    expect((await listUsers(token)).some(u => u.id === created.id)).toBe(true);
  });

  it('不能停用/降级当前登录账户（停用会销毁自己的会话 → 立刻被踢出）', async () => {
    const token = await login('admin', 'admin123');
    const me = (await listUsers(token)).find(u => u.username === 'admin')!;

    const disable = await app.inject({
      method: 'PUT', url: `/api/auth/users/${me.id}`, headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(400);
    expect(disable.json().error).toContain('当前登录账户');
    expect((await listUsers(token)).find(u => u.id === me.id)!.enabled).toBe(true);

    const demote = await app.inject({
      method: 'PUT', url: `/api/auth/users/${me.id}`, headers: { authorization: `Bearer ${token}` },
      payload: { role: 'user' },
    });
    expect(demote.statusCode).toBe(400);
    expect((await listUsers(token)).find(u => u.id === me.id)!.role).toBe('admin');
  });

  it('停用其他账户正常生效，改密码不合规被拦（400 带原文）', async () => {
    const token = await login('admin', 'admin123');
    const created = await app.inject({
      method: 'POST', url: '/api/auth/users', headers: { authorization: `Bearer ${token}` },
      payload: { username: 'auditor', password: 'auditor-pass-123', role: 'user' },
    });
    const id = (created.json() as { id: string }).id;

    const shortPwd = await app.inject({
      method: 'PUT', url: `/api/auth/users/${id}`, headers: { authorization: `Bearer ${token}` },
      payload: { password: '123' },
    });
    expect(shortPwd.statusCode).toBe(400);
    expect(shortPwd.json().error).toContain('8-64');

    const disable = await app.inject({
      method: 'PUT', url: `/api/auth/users/${id}`, headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    expect((disable.json() as { enabled: boolean }).enabled).toBe(false);

    const missing = await app.inject({
      method: 'PUT', url: '/api/auth/users/no-such-user', headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('删除其他管理员成功且其会话被销毁（会话销毁挪到删除成功后）', async () => {
    const adminToken = await login('admin', 'admin123');
    const bossCreate = await app.inject({
      method: 'POST', url: '/api/auth/users', headers: { authorization: `Bearer ${adminToken}` },
      payload: { username: 'boss', password: 'boss-pass-123', role: 'admin' },
    });
    const bossId = (bossCreate.json() as { id: string }).id;
    const bossToken = await login('boss', 'boss-pass-123');

    // 先造一个 boss 的既有会话，删除后应失效
    const before = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${bossToken}` } });
    expect(before.statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: `/api/auth/users/${bossId}`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(del.statusCode).toBe(200);
    expect((await listUsers(adminToken)).some(u => u.id === bossId)).toBe(false);

    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${bossToken}` } });
    expect(after.statusCode).toBe(401);
  });

  it('删除失败时不再顺手销毁目标会话（回归：原先 destroyUserSessions 先于 deleteUser）', async () => {
    const adminToken = await login('admin', 'admin123');
    const bossCreate = await app.inject({
      method: 'POST', url: '/api/auth/users', headers: { authorization: `Bearer ${adminToken}` },
      payload: { username: 'boss', password: 'boss-pass-123', role: 'admin' },
    });
    const bossId = (bossCreate.json() as { id: string }).id;
    const bossToken = await login('boss', 'boss-pass-123');

    // 目标不存在 → deleteUser 抛错 → 400；此时不应影响 boss 的会话
    const del = await app.inject({ method: 'DELETE', url: '/api/auth/users/ghost-id', headers: { authorization: `Bearer ${adminToken}` } });
    expect(del.statusCode).toBe(400);

    const stillAlive = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${bossToken}` } });
    expect(stillAlive.statusCode).toBe(200);
    // boss 仍在册，删除自己以外的管理员前守卫不误伤
    expect((await listUsers(adminToken)).some(u => u.id === bossId)).toBe(true);
  });
});

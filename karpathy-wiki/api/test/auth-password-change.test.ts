import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initAuthModule, registerAuthRoute } from '../src/routes/auth.js';
import { resetUserStore } from '../src/auth/user-store.js';

// T02453（PRD A1）路由级验证：bootstrap 门控 / 登录响应 mustChangePassword / 自助改密端点。
// 模式同 auth-rate-limit-route.test.ts：真实 Fastify + mock getDataDir（临时目录）+ mock startSessionCleanup。

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

async function login(app: ReturnType<typeof Fastify>, username: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return { status: res.statusCode, body: res.json() as { ok: boolean; token?: string; mustChangePassword?: boolean; localOnly?: boolean; message?: string } };
}

describe('T02453 认证安全加固路由', () => {
  let tempDir: string;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-pwd-it-'));
    hoisted.setDir(tempDir);
    // 登录/注册限流不影响本组用例（每用例重置模块态）；不冻结时钟，避免跨用例干扰
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    resetUserStore();
    // 每用例一个全新用户库目录，隔离种子账号状态
    const caseDir = await fs.mkdtemp(path.join(tempDir, 'case-'));
    hoisted.setDir(caseDir);
    app = Fastify();
    await initAuthModule(authConfigFixture(), 'vault', false); // 生产模式（localOnly=false）
    registerAuthRoute(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    resetUserStore();
  });

  it('bootstrap：生产模式不返回默认账户提示', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/bootstrap' });
    expect(res.statusCode).toBe(200);
    expect(res.json().showDefaultAccountHint).toBe(false);
  });

  it('bootstrap：localOnly 模式返回默认账户提示', async () => {
    const localApp = Fastify();
    await initAuthModule(authConfigFixture(), 'vault', true); // 本地调试模式
    registerAuthRoute(localApp);
    await localApp.ready();
    const res = await localApp.inject({ method: 'GET', url: '/api/auth/bootstrap' });
    expect(res.json().showDefaultAccountHint).toBe(true);
    await localApp.close();
  });

  it('生产登录默认口令账户：返回 mustChangePassword=true', async () => {
    const { status, body } = await login(app, 'admin', 'admin123');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mustChangePassword).toBe(true);
    expect(body.localOnly).toBe(false);
  });

  it('guest 种子停用：登录返回 403 账户已禁用', async () => {
    const { status, body } = await login(app, 'guest', 'guest123');
    expect(status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.message).toContain('禁用');
  });

  it('改密：旧密码错误返回 401', async () => {
    await login(app, 'admin', 'admin123');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: '' }, // 占位，下方统一注入 token
      payload: { oldPassword: 'wrong-old', newPassword: 'new-pass-123', confirmPassword: 'new-pass-123' },
    });
    // 未带 token 的请求应被 authGuard 拦截（401），同样验证端点不可未认证访问
    expect(res.statusCode).toBe(401);
  });

  it('改密：带 token 全流程——错误旧密码 401 / 新密码过短 400 / 成功清除标记', async () => {
    const loginRes = await login(app, 'admin', 'admin123');
    const token = loginRes.body.token!;

    const wrongOld = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'not-the-password', newPassword: 'new-pass-123', confirmPassword: 'new-pass-123' },
    });
    expect(wrongOld.statusCode).toBe(401);

    const tooShort = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'admin123', newPassword: 'short', confirmPassword: 'short' },
    });
    expect(tooShort.statusCode).toBe(400);

    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'admin123', newPassword: 'new-pass-123', confirmPassword: 'different-1' },
    });
    expect(mismatch.statusCode).toBe(400);

    const sameAsOld = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'admin123', newPassword: 'admin123', confirmPassword: 'admin123' },
    });
    expect(sameAsOld.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { oldPassword: 'admin123', newPassword: 'new-pass-123', confirmPassword: 'new-pass-123' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ok).toBe(true);

    // 改密后：新密码可登录且不再要求改密；旧密码失效
    const relogin = await login(app, 'admin', 'new-pass-123');
    expect(relogin.body.ok).toBe(true);
    expect(relogin.body.mustChangePassword).toBe(false);
    const oldLogin = await login(app, 'admin', 'admin123');
    expect(oldLogin.status).toBe(401);

    // /api/auth/me 同步不再返回强制改密标记
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${relogin.body.token!}` },
    });
    expect(me.json().mustChangePassword).toBe(false);
  });
});

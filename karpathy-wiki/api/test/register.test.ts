import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initAuthModule, registerAuthRoute } from '../src/routes/auth.js';
import { validateRegistrationInput } from '../src/auth/user-store.js';

// 自助注册接口测试
// 通过真实 Fastify 实例 + initAuthModule + registerAuthRoute 验证 /api/auth/register 行为
// 为避免污染真实 data 目录与遗留会话清理定时器，mock 两处依赖：
//   1. getDataDir → 临时目录（用户/审计落盘到临时目录）
//   2. startSessionCleanup → 空操作（避免测试进程悬挂）

const hoisted = vi.hoisted(() => {
  let dir = '';
  return { getDir: () => dir, setDir: (d: string) => { dir = d; } };
});

vi.mock('../src/utils/runtime.js', () => ({
  getDataDir: () => hoisted.getDir(),
}));

vi.mock('../src/auth/session.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/session.js')>('../src/auth/session.js');
  return { ...actual, startSessionCleanup: () => {} };
});

describe('auth 路由 - 自助注册 /api/auth/register', () => {
  let tempDir: string;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-reg-it-'));
    hoisted.setDir(tempDir);
  });

  afterAll(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    app = Fastify();
    await initAuthModule(
      {
        enabled: true,
        sessionTtlHours: 24,
        permissionCacheTtlSec: 300,
        auditLogPath: '../data/audit.log',
        usersFilePath: '../data/users.json',
        pbkdf2Iterations: 100000,
        sessionSecretRef: 'WIKI_TEST_SESSION_SECRET',
      },
      'vault',
    );
    registerAuthRoute(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('合法注册应返回 200 + token + 自动登录（角色默认为 user）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'Str0ng#Pass', confirmPassword: 'Str0ng#Pass' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.user.username).toBe('alice');
    expect(body.user.role).toBe('user');
    expect(Array.isArray(body.user.permissions)).toBe(true);
  });

  it('重复用户名应返回 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'bob', password: 'Str0ng#Pass' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'bob', password: 'An0ther#Pass' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('用户名已存在');
  });

  it('非法用户名（过短）应返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'ab', password: 'Str0ng#Pass' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('弱密码（<8 位）应返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'carol', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('两次密码不一致应返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'dave', password: 'Str0ng#Pass', confirmPassword: 'Different#1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('注册用户无法通过请求体提升为 admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'eve', password: 'Str0ng#Pass', role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('user');
  });

  it('注册后可用返回 token 访问受保护接口 /api/auth/me', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'erin', password: 'Str0ng#Pass' },
    });
    const token = reg.json().token as string;
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().username).toBe('erin');
  });
});

describe('validateRegistrationInput 纯校验', () => {
  it('空用户名/密码返回 400', () => {
    expect(validateRegistrationInput({ username: '', password: '' }).ok).toBe(false);
  });

  it('非法用户名（含空格/特殊字符）返回 400', () => {
    const r = validateRegistrationInput({ username: 'bad name!', password: 'Str0ng#Pass' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('密码过短返回 400', () => {
    expect(validateRegistrationInput({ username: 'gooduser', password: '123' }).ok).toBe(false);
  });

  it('确认密码不一致返回 400', () => {
    const r = validateRegistrationInput({ username: 'gooduser', password: 'Str0ng#Pass', confirmPassword: 'Other#1234' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('合法输入返回 ok', () => {
    expect(validateRegistrationInput({ username: 'gooduser', password: 'Str0ng#Pass', confirmPassword: 'Str0ng#Pass' }).ok).toBe(true);
  });
});

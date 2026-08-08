import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initAuthModule, registerAuthRoute } from '../src/routes/auth.js';
import { resetAuthRateLimiters } from '../src/auth/auth-rate-limit.js';

// 路由级限流验证：同 IP 连续注册，第 11 次应返回 429（FR-RM-10）。
// 通过真实 Fastify 实例 + initAuthModule + registerAuthRoute 验证，
// mock getDataDir（临时目录）与 startSessionCleanup（避免悬挂）。

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

describe('auth 路由 - 注册限流 /api/auth/register（FR-RM-10）', () => {
  let tempDir: string;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-rl-it-'));
    hoisted.setDir(tempDir);
    // 冻结时钟：注册限流用固定窗口(60s)且以 Date.now() 划窗。
    // 若不冻结，整跑时若分钟边界恰好落在第 10/11 次请求之间，第 11 次会落入全新窗口而误判为 200（偶发 flaky）。
    // 冻结后 11 次请求同处一个窗口，结果确定（第 11 次必为 429）。
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    resetAuthRateLimiters();
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

  it('同 IP 注册第 11 次返回 429 且带 Retry-After 头', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: `ratelimit${i}`, password: 'Str0ng#Pass', confirmPassword: 'Str0ng#Pass' },
      });
      expect(res.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'ratelimit10', password: 'Str0ng#Pass', confirmPassword: 'Str0ng#Pass' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    const body = blocked.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('过于频繁');
    expect(body.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('不同用户名在同一 IP 下受 IP 维度 10 次/分钟约束', async () => {
    // 10 个不同用户名，耗尽 IP 维度
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: `ipcap${i}`, password: 'Str0ng#Pass', confirmPassword: 'Str0ng#Pass' },
      });
      expect(res.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'ipcapX', password: 'Str0ng#Pass', confirmPassword: 'Str0ng#Pass' },
    });
    expect(blocked.statusCode).toBe(429);
  });
});

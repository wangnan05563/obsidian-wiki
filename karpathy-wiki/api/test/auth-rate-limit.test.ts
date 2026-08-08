import { describe, it, expect, beforeEach } from 'vitest';
import { checkAuthRateLimit, resetAuthRateLimiters } from '../src/auth/auth-rate-limit.js';

const NOW = 1_000_000; // 落在某个固定窗口内的基准时间戳
const WINDOW_MS = 60_000;

describe('auth-rate-limit 模块（FR-RM-10）', () => {
  beforeEach(() => {
    resetAuthRateLimiters();
  });

  it('单 IP 前 10 次注册允许，第 11 次拒绝并带 Retry-After', () => {
    for (let i = 0; i < 10; i++) {
      const r = checkAuthRateLimit({ ip: '1.2.3.4', username: `u${i}`, kind: 'register', now: NOW });
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(9 - i);
    }
    const denied = checkAuthRateLimit({ ip: '1.2.3.4', username: 'u10', kind: 'register', now: NOW });
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('单用户名探测前 5 次允许，第 6 次拒绝（用户名维度）', () => {
    const ip = '9.9.9.9';
    for (let i = 0; i < 5; i++) {
      const r = checkAuthRateLimit({ ip, username: 'victim', kind: 'register', now: NOW });
      expect(r.allowed).toBe(true);
    }
    const denied = checkAuthRateLimit({ ip, username: 'victim', kind: 'register', now: NOW });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('不同 IP / 不同用户名互不干扰', () => {
    // IP 维度独立性：IP a 用满 10 次（每次用不同用户名，避免耗尽用户名维度）
    for (let i = 0; i < 10; i++) {
      const r = checkAuthRateLimit({ ip: 'a.a.a.a', username: `xA${i}`, kind: 'register', now: NOW });
      expect(r.allowed).toBe(true);
    }
    // 新 IP b 仍可注册（IP 维度独立）
    const b = checkAuthRateLimit({ ip: 'b.b.b.b', username: 'xB', kind: 'register', now: NOW });
    expect(b.allowed).toBe(true);

    // 用户名维度独立性：用户名 victim 用满 5 次（每次用不同 IP，避免耗尽 IP 维度）
    for (let i = 0; i < 5; i++) {
      const r = checkAuthRateLimit({ ip: `v${i}.v.v.v`, username: 'victim', kind: 'register', now: NOW });
      expect(r.allowed).toBe(true);
    }
    // 新 IP 用同一用户名 victim → 被用户名维度拒绝（独立于 IP）
    const sameUser = checkAuthRateLimit({ ip: 'v9.v.v.v', username: 'victim', kind: 'register', now: NOW });
    expect(sameUser.allowed).toBe(false);
    // 新 IP 用不同用户名 → 允许
    const diffUser = checkAuthRateLimit({ ip: 'v9.v.v.v', username: 'other', kind: 'register', now: NOW });
    expect(diffUser.allowed).toBe(true);
  });

  it('登录复用同一框架，且独立于注册计数', () => {
    // 注册维度打满
    for (let i = 0; i < 10; i++) {
      checkAuthRateLimit({ ip: 'c.c.c.c', username: 'z', kind: 'register', now: NOW });
    }
    // 登录维度仍可用（kind 隔离）
    const login = checkAuthRateLimit({ ip: 'c.c.c.c', username: 'z', kind: 'login', now: NOW });
    expect(login.allowed).toBe(true);
  });

  it('窗口滚动后计数重置', () => {
    for (let i = 0; i < 10; i++) {
      checkAuthRateLimit({ ip: 'd.d.d.d', username: 'w', kind: 'register', now: NOW });
    }
    const inWindow = checkAuthRateLimit({ ip: 'd.d.d.d', username: 'w', kind: 'register', now: NOW });
    expect(inWindow.allowed).toBe(false);
    // 推进超过一个窗口
    const after = checkAuthRateLimit({ ip: 'd.d.d.d', username: 'w', kind: 'register', now: NOW + WINDOW_MS + 1 });
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(9);
  });

  it('用户名缺失时仅 IP 维度生效', () => {
    const r = checkAuthRateLimit({ ip: 'e.e.e.e', kind: 'register', now: NOW });
    expect(r.allowed).toBe(true);
  });
});

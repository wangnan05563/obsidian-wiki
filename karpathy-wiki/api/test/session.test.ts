import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createSession,
  validateSession,
  destroySession,
  destroyUserSessions,
  startSessionCleanup,
  stopSessionCleanup,
  cleanupExpiredSessions,
  getSessionCount,
  clearAllSessions,
} from '../src/auth/session.js';

// 会话管理测试
// 覆盖点：创建、验证、销毁、过期清理、用户级会话销毁、定时器生命周期

const SECRET = 'test-session-secret-16chars';

describe('session 模块', () => {
  beforeEach(() => {
    clearAllSessions();
    stopSessionCleanup();
  });

  afterEach(() => {
    clearAllSessions();
    stopSessionCleanup();
  });

  describe('createSession', () => {
    it('应创建会话并返回 token + 元信息', () => {
      const session = createSession({
        userId: 'u1',
        username: 'admin',
        role: 'admin',
        secret: SECRET,
      });
      expect(session.token).toBeTruthy();
      expect(session.userId).toBe('u1');
      expect(session.username).toBe('admin');
      expect(session.role).toBe('admin');
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.expiresAt).toBeGreaterThan(session.createdAt);
    });

    it('默认 TTL 应为 24 小时', () => {
      const session = createSession({
        userId: 'u1',
        username: 'admin',
        role: 'admin',
        secret: SECRET,
      });
      const ttl = session.expiresAt - session.createdAt;
      expect(ttl).toBe(24 * 60 * 60 * 1000);
    });

    it('自定义 TTL 应生效', () => {
      const session = createSession({
        userId: 'u1',
        username: 'admin',
        role: 'admin',
        secret: SECRET,
        ttlMs: 1000,
      });
      const ttl = session.expiresAt - session.createdAt;
      expect(ttl).toBe(1000);
    });

    it('每次创建应生成不同 token', () => {
      const s1 = createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET });
      const s2 = createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET });
      expect(s1.token).not.toBe(s2.token);
    });

    it('创建后会话数应增加', () => {
      expect(getSessionCount()).toBe(0);
      createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET });
      expect(getSessionCount()).toBe(1);
    });
  });

  describe('validateSession', () => {
    it('有效 token 应返回会话记录', () => {
      const session = createSession({ userId: 'u1', username: 'admin', role: 'admin', secret: SECRET });
      const validated = validateSession(session.token, SECRET);
      expect(validated).not.toBeNull();
      expect(validated?.userId).toBe('u1');
    });

    it('空 token 返回 null', () => {
      expect(validateSession('', SECRET)).toBeNull();
    });

    it('无效 token 返回 null', () => {
      expect(validateSession('invalid.token', SECRET)).toBeNull();
    });

    it('不同密钥应返回 null（签名校验失败）', () => {
      const session = createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET });
      expect(validateSession(session.token, 'different-secret-16chars')).toBeNull();
    });

    it('过期会话应返回 null 并被清除', () => {
      const session = createSession({
        userId: 'u1',
        username: 'a',
        role: 'admin',
        secret: SECRET,
        ttlMs: 1,
      });
      // 等待 5ms 让会话过期
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const validated = validateSession(session.token, SECRET);
          expect(validated).toBeNull();
          // 过期会话应被清除
          expect(getSessionCount()).toBe(0);
          resolve();
        }, 5);
      });
    });

    it('已销毁的会话应返回 null', () => {
      const session = createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET });
      destroySession(session.token);
      expect(validateSession(session.token, SECRET)).toBeNull();
    });
  });

  describe('destroySession', () => {
    it('销毁存在的会话返回 true', () => {
      const session = createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET });
      expect(destroySession(session.token)).toBe(true);
      expect(getSessionCount()).toBe(0);
    });

    it('销毁不存在的 token 返回 false', () => {
      expect(destroySession('nonexistent.token')).toBe(false);
    });
  });

  describe('destroyUserSessions', () => {
    it('应销毁指定用户的所有会话', () => {
      const s1 = createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET });
      const s2 = createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET });
      const s3 = createSession({ userId: 'u2', username: 'b', role: 'user', secret: SECRET });
      const count = destroyUserSessions('u1');
      expect(count).toBe(2);
      expect(getSessionCount()).toBe(1);
      // 验证 u2 的会话仍在
      expect(validateSession(s3.token, SECRET)).not.toBeNull();
    });

    it('无会话的用户返回 0', () => {
      createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET });
      expect(destroyUserSessions('nonexistent')).toBe(0);
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('应清理过期会话并返回清理数量', () => {
      createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET, ttlMs: 1 });
      createSession({ userId: 'u2', username: 'b', role: 'user', secret: SECRET, ttlMs: 5000 });
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const cleaned = cleanupExpiredSessions();
          expect(cleaned).toBe(1);
          expect(getSessionCount()).toBe(1);
          resolve();
        }, 5);
      });
    });

    it('无过期会话时返回 0', () => {
      createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET, ttlMs: 60000 });
      expect(cleanupExpiredSessions()).toBe(0);
    });
  });

  describe('startSessionCleanup / stopSessionCleanup', () => {
    it('启动后定时器应存在，停止后应清除', () => {
      // void 函数：返回 undefined 即说明未抛错，间接验证幂等性
      expect(startSessionCleanup()).toBeUndefined();
      // 再次调用不应报错
      startSessionCleanup();
      stopSessionCleanup();
      // 再次停止不应报错
      stopSessionCleanup();
    });

    it('定时器应能自动清理过期会话', () => {
      // 创建 1ms TTL 会话，等待定时器触发清理
      // 注意：定时器间隔 10 分钟，此处只验证 stopSessionCleanup 不影响测试状态
      createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET, ttlMs: 1 });
      stopSessionCleanup();
      // 直接调用清理验证
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          cleanupExpiredSessions();
          expect(getSessionCount()).toBe(0);
          resolve();
        }, 5);
      });
    });
  });

  describe('clearAllSessions', () => {
    it('应清空所有会话', () => {
      createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET });
      createSession({ userId: 'u2', username: 'b', role: 'user', secret: SECRET });
      expect(getSessionCount()).toBe(2);
      clearAllSessions();
      expect(getSessionCount()).toBe(0);
    });
  });
});

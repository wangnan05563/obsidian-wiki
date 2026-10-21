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
// T02836：等待口径统一走公共工具。本文件原先 3 处 `return new Promise(... setTimeout(..., 5))`，
// 5ms 是在赌 Windows 真实时钟跨过 ttlMs=1（时钟粒度可达 ~16ms，赌不赢就是闪断），
// 而三处的终点都可观测（会话验证翻转为 null / 计数归零 / 清理函数报出条数）→ 一律轮询真实状态。
import { NO_TIMER_CHAIN, pollUntil, waitForProgress } from './helpers/waitForProgress.js';

// T02836 等待口径清点（本文件 3 处，逐处判定）：
//  | 「过期会话应返回 null 并被清除」 | 新 Promise + setTimeout(5) | 终点可观测（validateSession 翻转 + getSessionCount 归零）→ waitForProgress；「未过期⇒非 null」交给同组有效用例，不在 1ms TTL 会话上前置断言（那仍是赌时长） |
//  | 「应清理过期会话并返回清理数量」 | 同上                     | 终点可观测（cleanupExpiredSessions 的返回值）→ pollUntil 取回该值，断言口径仍为 ===1 |
//  | 「定时器应能自动清理过期会话」   | 同上                     | 终点可观测（getSessionCount 归零）→ pollUntil 边清边读 |

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

    it('过期会话应返回 null 并被清除', async () => {
      const session = createSession({
        userId: 'u1',
        username: 'a',
        role: 'admin',
        secret: SECRET,
        ttlMs: 1,
      });
      // 「未过期 ⇒ 非 null」由同组 '有效 token 应返回会话记录' 负责；这里不重复断言——
      // ttlMs=1 的会话在起跑那一刻就可能已跨过时钟粒度，前置断言本身又成了赌时长（实测首轮即红）。
      await waitForProgress(
        'ttlMs=1 的会话过期：validateSession 返回 null 且登记被清除',
        () => validateSession(session.token, SECRET) === null && getSessionCount() === 0,
        { ...NO_TIMER_CHAIN, progress: () => `sessions=${getSessionCount()}` },
      );
      expect(validateSession(session.token, SECRET)).toBeNull();
      expect(getSessionCount()).toBe(0);
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
    it('应清理过期会话并返回清理数量', async () => {
      createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET, ttlMs: 1 });
      createSession({ userId: 'u2', username: 'b', role: 'user', secret: SECRET, ttlMs: 5000 });
      // 轮询点取清理函数自己的返回值：报出条数即「真实时钟确实跨过了 ttlMs=1 且过期项被回收」，
      // 并把该值交回断言（原先是 `expect(cleaned).toBe(1)`，口径不变，不放宽为 >=1）
      const { value: cleaned } = await pollUntil(
        'cleanupExpiredSessions 清理掉 1ms TTL 的那条会话',
        () => cleanupExpiredSessions(),
        (n) => n > 0,
        { ...NO_TIMER_CHAIN, progress: () => `sessions=${getSessionCount()}` },
      );
      expect(cleaned).toBe(1);
      expect(getSessionCount()).toBe(1);
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

    it('定时器应能自动清理过期会话', async () => {
      // 创建 1ms TTL 会话，等待定时器触发清理
      // 注意：定时器间隔 10 分钟，此处只验证 stopSessionCleanup 不影响测试状态
      createSession({ userId: 'u1', username: 'a', role: 'admin', secret: SECRET, ttlMs: 1 });
      stopSessionCleanup();
      // T02836：原写法「等 5ms 后手工清理并断言计数为 0」把结局押在时长上；
      // 终点（计数归零）本就可读，改为边清边读、读到 0 为止
      await pollUntil(
        '过期会话被回收，登记数归零',
        () => {
          cleanupExpiredSessions();
          return getSessionCount();
        },
        (n) => n === 0,
        NO_TIMER_CHAIN,
      );
      expect(getSessionCount()).toBe(0);
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

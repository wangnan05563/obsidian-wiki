import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkPermission,
  checkPermissions,
  invalidateRoleCache,
  clearPermissionCache,
  getCacheStats,
  resetCacheStats,
  checkPermissionWithStats,
} from '../src/auth/permission-cache.js';
import type { AuthRole, AuthPermission } from '../src/auth/types.js';

// 权限缓存测试
// 覆盖点：缓存命中/未命中、TTL 失效、角色级缓存清除、批量检查、统计

describe('permission-cache 模块', () => {
  beforeEach(() => {
    clearPermissionCache();
    resetCacheStats();
  });

  describe('checkPermission', () => {
    it('管理员对所有权限返回 true', () => {
      expect(checkPermission('admin', 'dashboard')).toBe(true);
      expect(checkPermission('admin', 'users')).toBe(true);
      expect(checkPermission('admin', 'config')).toBe(true);
    });

    it('普通用户对 browse 返回 true', () => {
      expect(checkPermission('user', 'browse')).toBe(true);
    });

    it('普通用户对 dashboard 返回 true（仪表盘已开放给所有用户）', () => {
      expect(checkPermission('user', 'dashboard')).toBe(true);
    });

    it('游客对 browse 返回 true', () => {
      expect(checkPermission('guest', 'browse')).toBe(true);
    });

    it('游客对 dashboard 返回 true（仪表盘已开放给所有用户）', () => {
      expect(checkPermission('guest', 'dashboard')).toBe(true);
    });
  });

  describe('缓存命中', () => {
    it('相同 role:permission 第二次调用应命中缓存', () => {
      const ttl = 60000;
      // 首次：未命中
      const r1 = checkPermission('admin', 'dashboard', ttl);
      expect(r1).toBe(true);
      // 第二次：命中
      const r2 = checkPermission('admin', 'dashboard', ttl);
      expect(r2).toBe(true);
      // 缓存大小应 > 0
      const stats = getCacheStats();
      expect(stats.size).toBeGreaterThan(0);
    });

    it('不同 role 但相同 permission 应独立缓存', () => {
      checkPermission('admin', 'browse');
      checkPermission('user', 'browse');
      const stats = getCacheStats();
      expect(stats.size).toBeGreaterThanOrEqual(2);
    });

    it('相同 role 不同 permission 应独立缓存', () => {
      checkPermission('admin', 'browse');
      checkPermission('admin', 'dashboard');
      const stats = getCacheStats();
      expect(stats.size).toBeGreaterThanOrEqual(2);
    });
  });

  describe('TTL 失效', () => {
    it('TTL 到期后应重新计算', () => {
      const ttl = 1;
      checkPermission('admin', 'dashboard', ttl);
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // 缓存应过期，重新计算
          const r = checkPermission('admin', 'dashboard', 60000);
          expect(r).toBe(true);
          resolve();
        }, 5);
      });
    });
  });

  describe('checkPermissions (批量)', () => {
    it('管理员对多个权限返回全 true', () => {
      const results = checkPermissions('admin', ['dashboard', 'users', 'browse']);
      expect(results).toEqual([true, true, true]);
    });

    it('普通用户对混合权限返回全部 true（dashboard 已开放）', () => {
      const results = checkPermissions('user', ['browse', 'dashboard', 'query']);
      expect(results).toEqual([true, true, true]);
    });

    it('普通用户对含 users 的混合权限返回部分 false', () => {
      const results = checkPermissions('user', ['browse', 'users', 'query']);
      expect(results).toEqual([true, false, true]);
    });

    it('空数组返回空数组', () => {
      const results = checkPermissions('admin', []);
      expect(results).toEqual([]);
    });
  });

  describe('invalidateRoleCache', () => {
    it('应清除指定角色的所有缓存项', () => {
      checkPermission('admin', 'dashboard');
      checkPermission('user', 'browse');
      checkPermission('guest', 'query');
      const before = getCacheStats().size;
      const removed = invalidateRoleCache('admin');
      expect(removed).toBeGreaterThan(0);
      const after = getCacheStats().size;
      expect(after).toBeLessThan(before);
    });

    it('清除后重新检查应重新计算', () => {
      checkPermission('admin', 'dashboard');
      invalidateRoleCache('admin');
      const r = checkPermission('admin', 'dashboard');
      expect(r).toBe(true);
    });

    it('无缓存的角色返回 0', () => {
      const removed = invalidateRoleCache('guest');
      expect(removed).toBe(0);
    });
  });

  describe('clearPermissionCache', () => {
    it('应清空所有缓存', () => {
      checkPermission('admin', 'dashboard');
      checkPermission('user', 'browse');
      clearPermissionCache();
      expect(getCacheStats().size).toBe(0);
    });
  });

  describe('checkPermissionWithStats', () => {
    it('首次应为 miss，第二次应为 hit', () => {
      const ttl = 60000;
      checkPermissionWithStats('admin', 'dashboard', ttl);
      const stats1 = getCacheStats();
      expect(stats1.missCount).toBe(1);
      expect(stats1.hitCount).toBe(0);
      checkPermissionWithStats('admin', 'dashboard', ttl);
      const stats2 = getCacheStats();
      expect(stats2.missCount).toBe(1);
      expect(stats2.hitCount).toBe(1);
    });

    it('缓存未命中时递增 missCount', () => {
      checkPermissionWithStats('user', 'browse');
      checkPermissionWithStats('user', 'dashboard');
      const stats = getCacheStats();
      expect(stats.missCount).toBe(2);
    });

    it('resetCacheStats 应重置统计', () => {
      checkPermissionWithStats('admin', 'dashboard');
      resetCacheStats();
      const stats = getCacheStats();
      expect(stats.hitCount).toBe(0);
      expect(stats.missCount).toBe(0);
    });
  });

  describe('缓存一致性', () => {
    it('清除角色缓存后，权限结果应与 RBAC 静态表一致', () => {
      const perms: AuthPermission[] = ['dashboard', 'browse', 'query', 'users', 'config'];
      for (const p of perms) {
        checkPermission('user', p);
      }
      invalidateRoleCache('user');
      // 重新检查，结果应一致
      for (const p of perms) {
        const r = checkPermission('user', p);
        // dashboard/browse/query 为 true（dashboard 已开放给所有用户）
        if (p === 'dashboard' || p === 'browse' || p === 'query') {
          expect(r).toBe(true);
        } else {
          expect(r).toBe(false);
        }
      }
    });
  });
});

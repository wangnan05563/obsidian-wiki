import type { AuthRole, AuthPermission } from './types.js';
import { hasPermission } from './rbac.js';

// 权限缓存模块
// 为什么需要：每个 API 请求都要做权限校验，避免每次都查 RBAC 静态表
// 缓存 key 格式：{role}:{permission}，value: boolean
// 缓存 TTL 由 AuthConfig.permissionCacheTtlSec 控制（默认 300 秒）

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

// 权限缓存：Map<role:permission, CacheEntry>
const permissionCache = new Map<string, CacheEntry>();

// 默认 TTL：5 分钟
// 为什么 5 分钟：角色权限变更后最长 5 分钟生效，平衡性能与一致性
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// 生成缓存 key
function makeCacheKey(role: AuthRole, permission: AuthPermission): string {
  return `${role}:${permission}`;
}

// 从缓存读取
function getFromCache(role: AuthRole, permission: AuthPermission): boolean | null {
  const key = makeCacheKey(role, permission);
  const entry = permissionCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    permissionCache.delete(key);
    return null;
  }
  return entry.value;
}

// 写入缓存
function setToCache(role: AuthRole, permission: AuthPermission, value: boolean, ttlMs: number): void {
  const key = makeCacheKey(role, permission);
  permissionCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

// 带缓存的权限检查
// 优先查缓存，未命中查 RBAC 静态表并写入缓存
export function checkPermission(
  role: AuthRole,
  permission: AuthPermission,
  ttlMs: number = DEFAULT_TTL_MS,
): boolean {
  // 1. 查缓存
  const cached = getFromCache(role, permission);
  if (cached !== null) return cached;

  // 2. 未命中，查 RBAC 静态表
  const result = hasPermission(role, permission);

  // 3. 写入缓存
  setToCache(role, permission, result, ttlMs);
  return result;
}

// 批量检查权限（带缓存）
export function checkPermissions(
  role: AuthRole,
  permissions: AuthPermission[],
  ttlMs: number = DEFAULT_TTL_MS,
): boolean[] {
  return permissions.map((p) => checkPermission(role, p, ttlMs));
}

// 清除指定角色的权限缓存（用户角色变更时调用）
export function invalidateRoleCache(role: AuthRole): number {
  const prefix = `${role}:`;
  let count = 0;
  for (const key of permissionCache.keys()) {
    if (key.startsWith(prefix)) {
      permissionCache.delete(key);
      count++;
    }
  }
  return count;
}

// 清除全部权限缓存（配置变更或测试用）
export function clearPermissionCache(): void {
  permissionCache.clear();
}

// 获取缓存统计信息（监控用）
export function getCacheStats(): { size: number; hitCount: number; missCount: number } {
  return {
    size: permissionCache.size,
    hitCount: stats.hitCount,
    missCount: stats.missCount,
  };
}

// 命中率统计（监控用）
const stats = { hitCount: 0, missCount: 0 };

// 重置统计（测试用）
export function resetCacheStats(): void {
  stats.hitCount = 0;
  stats.missCount = 0;
}

// 带统计的权限检查（仅在需要监控时使用）
export function checkPermissionWithStats(
  role: AuthRole,
  permission: AuthPermission,
  ttlMs: number = DEFAULT_TTL_MS,
): boolean {
  const cached = getFromCache(role, permission);
  if (cached !== null) {
    stats.hitCount++;
    return cached;
  }
  stats.missCount++;
  const result = hasPermission(role, permission);
  setToCache(role, permission, result, ttlMs);
  return result;
}

import type { SessionRecord, AuthRole } from './types.js';
import { generateSessionToken, verifySessionToken } from './password.js';

// 会话管理模块
// 维护 token → SessionRecord 映射，支持创建、验证、销毁
// 为什么内存存储而非 Redis：本地优先应用，无需分布式会话；重启清空更安全

// 会话存储：Map<token, SessionRecord>
const sessions = new Map<string, SessionRecord>();

// 默认会话有效期：24 小时
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// 定时清理过期会话（每 10 分钟执行一次）
// 为什么需要：避免 Map 无限增长，长时间运行的服务累积过期 token
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
let cleanupTimer: NodeJS.Timeout | null = null;

// 启动清理定时器
export function startSessionCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanupExpiredSessions();
  }, CLEANUP_INTERVAL_MS);
  // 为什么 unref：定时器不阻止进程退出（与 graceful-shutdown-rule 协同）
  cleanupTimer.unref();
}

// 停止清理定时器（测试用）
export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// 清理过期会话
export function cleanupExpiredSessions(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [token, record] of sessions) {
    if (record.expiresAt <= now) {
      sessions.delete(token);
      cleaned++;
    }
  }
  return cleaned;
}

// 创建会话
export function createSession(params: {
  userId: string;
  username: string;
  role: AuthRole;
  secret: string;
  ttlMs?: number;
}): SessionRecord {
  const token = generateSessionToken(params.secret);
  const now = Date.now();
  const ttl = params.ttlMs ?? DEFAULT_TTL_MS;
  const record: SessionRecord = {
    token,
    userId: params.userId,
    username: params.username,
    role: params.role,
    createdAt: now,
    expiresAt: now + ttl,
  };
  sessions.set(token, record);
  return record;
}

// 验证会话：返回会话记录或 null
// 为什么检查 secret：防止配置变更后旧 token 仍有效（secret 变更后签名校验失败）
export function validateSession(token: string, secret: string): SessionRecord | null {
  if (!token) return null;
  if (!verifySessionToken(token, secret)) return null;
  const record = sessions.get(token);
  if (!record) return null;
  // 检查过期
  if (record.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return record;
}

// 销毁会话（登出）
export function destroySession(token: string): boolean {
  return sessions.delete(token);
}

// 销毁用户的所有会话（用户被禁用或删除时调用）
export function destroyUserSessions(userId: string): number {
  let count = 0;
  for (const [token, record] of sessions) {
    if (record.userId === userId) {
      sessions.delete(token);
      count++;
    }
  }
  return count;
}

// 获取当前活跃会话数（监控用）
export function getSessionCount(): number {
  return sessions.size;
}

// 清空所有会话（测试用）
export function clearAllSessions(): void {
  sessions.clear();
}

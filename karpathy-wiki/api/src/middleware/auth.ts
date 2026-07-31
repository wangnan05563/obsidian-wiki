import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SessionRecord, AuthPermission, AuditAction } from '../auth/types.js';
import { validateSession } from '../auth/session.js';
import { checkPermission } from '../auth/permission-cache.js';
import { createAuditEntry, writeAuditLog } from '../auth/audit-log.js';

// 认证中间件模块
// 通过 Fastify 的 decorate + preHandler 机制实现
// decorate: 将 currentUser 注入到 request 对象
// preHandler: 在路由处理前校验 token + 权限

// 扩展 FastifyRequest 类型，注入 currentUser 字段
declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: SessionRecord;
  }
}

// 认证中间件配置
export interface AuthMiddlewareConfig {
  // 是否启用权限控制（关闭时所有请求视为 admin）
  enabled: boolean;
  // 会话密钥
  sessionSecret: string;
  // 权限缓存 TTL（ms）
  permissionCacheTtlMs: number;
  // 公开路由前缀（无需认证）
  publicPaths: string[];
}

// 默认公开路由（无需认证即可访问）
// 为什么 /api/auth/login 公开：登录接口本身不需要 token
// 为什么 /health 公开：Docker healthcheck 不带 token
// 为什么导出：auth.ts 注册中间件时复用同一常量，避免字面量重复导致漂移（BR-048）
export const DEFAULT_PUBLIC_PATHS = [
  '/api/auth/login',
  '/health',
] as const;

// 初始化认证中间件
// 为什么 decorate 而非 addHook：decorate 后类型可推断，路由层可直接读 request.currentUser
export function setupAuthMiddleware(app: FastifyInstance, config: AuthMiddlewareConfig): void {
  // 如果未启用权限控制：所有请求视为 admin，跳过认证
  if (!config.enabled) {
    app.decorate('currentUser', null);
    console.warn('[auth] 权限控制未启用，所有请求视为管理员');
    return;
  }

  // 装饰 request：默认无用户（未认证状态）
  app.decorateRequest('currentUser', null);

  // 全局 preHandler：解析 token + 注入 currentUser
  // 为什么用 preHandler 而非 onRequest：preHandler 在路由解析后执行，可读取路由配置
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. 公开路由跳过认证
    if (isPublicPath(request.url, config.publicPaths)) return;

    // 2. 解析 Authorization 头
    const token = extractToken(request);
    if (!token) {
      // 无 token → 视为游客（游客可访问公开接口）
      // 为什么不直接 401：游客角色允许访问部分接口（browse/query/graph）
      return;
    }

    // 3. 验证 token
    const session = validateSession(token, config.sessionSecret);
    if (!session) {
      // token 无效或过期 → 不注入 currentUser，后续 requireAuth 守卫会拒绝
      return;
    }

    // 4. 注入当前用户
    request.currentUser = session;
  });
}

// 判断是否为公开路径
function isPublicPath(url: string, publicPaths: string[]): boolean {
  // 取 pathname 部分（去除 query）
  const pathname = url.split('?')[0];
  return publicPaths.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

// 从请求头提取 token
// 支持两种格式：
//   1. Authorization: Bearer {token}
//   2. Cookie: session={token}（兜底，部分场景用 cookie）
export function extractToken(request: FastifyRequest): string | null {
  // 1. Authorization: Bearer
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  // 2. Cookie: session=
  const cookie = request.headers.cookie;
  if (cookie) {
    const match = /(?:^|;\s*)session=([^;]+)/.exec(cookie);
    if (match) return match[1].trim();
  }
  return null;
}

// 路由级权限守卫：要求用户已登录
// 用法：app.get('/api/xxx', { preHandler: requireAuth }, handler)
// 为什么用 async 而非回调风格：Fastify 4.x 推荐 async 风格，TypeScript 类型推导更友好
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.currentUser) {
    reply.code(401).send({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  }
}

// 路由级权限守卫：要求用户拥有指定权限
// 返回 preHandler 函数，可携带 permission 参数（闭包）
// 为什么用高阶函数：避免在路由内手写 if 判断，声明式标注更清晰
export function requirePermission(permission: AuthPermission, permissionCacheTtlMs: number) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // 1. 必须先登录
    if (!request.currentUser) {
      // 记录审计日志：未登录访问受保护资源
      writeAuditLog(
        createAuditEntry({
          userId: null,
          username: null,
          action: 'permission_denied',
          resource: `${request.method} ${request.url}`,
          ip: request.ip,
          result: 'fail',
          message: '未登录访问受保护资源',
        }),
      );
      reply.code(401).send({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
      return;
    }

    // 2. 检查权限（带缓存）
    const allowed = checkPermission(request.currentUser.role, permission, permissionCacheTtlMs);
    if (!allowed) {
      // 记录审计日志：越权访问
      writeAuditLog(
        createAuditEntry({
          userId: request.currentUser.userId,
          username: request.currentUser.username,
          action: 'permission_denied',
          resource: `${request.method} ${request.url}`,
          ip: request.ip,
          result: 'fail',
          message: `角色 ${request.currentUser.role} 无权限访问 ${permission}`,
        }),
      );
      reply.code(403).send({ error: '权限不足', code: 'FORBIDDEN', required: permission });
    }
  };
}

// 路由级权限守卫：要求管理员角色
// 是 requirePermission('users') 的语法糖
export function requireAdmin(permissionCacheTtlMs: number) {
  return requirePermission('users', permissionCacheTtlMs);
}

// 记录审计日志的辅助函数（供路由层调用）
export function audit(params: {
  request: FastifyRequest;
  action: AuditAction;
  resource: string;
  result: 'success' | 'fail';
  message?: string;
}): void {
  const { request, action, resource, result, message } = params;
  writeAuditLog(
    createAuditEntry({
      userId: request.currentUser?.userId ?? null,
      username: request.currentUser?.username ?? null,
      action,
      resource,
      ip: request.ip,
      result,
      message,
    }),
  );
}

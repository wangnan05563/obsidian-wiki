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
// 为什么 /api/auth/register 公开：自助注册接口本身不需要 token
// 为什么 /health 公开：Docker healthcheck 不带 token
// 为什么导出：auth.ts 注册中间件时复用同一常量，避免字面量重复导致漂移（BR-048）
export const DEFAULT_PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
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

  // 公开路径白名单：优先用 AuthConfig.publicPaths 覆盖，否则回退 DEFAULT_PUBLIC_PATHS 兜底常量。
  // 单一来源 + 可配置，满足 auth-endpoint-classification「禁止硬编码端点路径」的硬约束。
  const publicPaths = config.publicPaths && config.publicPaths.length > 0
    ? config.publicPaths
    : [...DEFAULT_PUBLIC_PATHS];

  // 全局 preHandler：解析 token + 注入 currentUser
  // 为什么用 preHandler 而非 onRequest：preHandler 在路由解析后执行，可读取路由配置
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. 公开路由跳过认证
    if (isPublicPath(request.url, publicPaths)) return;

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
// 精确匹配：避免 /health 误匹配 /health/xxx 等子路径（排查报告模块 1 MEDIUM）。
// 当前公开端点（login/register/health）均无需要前缀放行的子路径，精确匹配即可收紧边界。
function isPublicPath(url: string, publicPaths: string[]): boolean {
  // 取 pathname 部分（去除 query）
  const pathname = url.split('?')[0];
  return publicPaths.includes(pathname);
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
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  if (!request.currentUser) {
    // 必须 return reply.send()：Fastify 据此判定响应已发送并终止后续管线。
    // 若仅 send 后 return undefined，handler 仍会对已发送响应二次 send → FST_ERR_REP_ALREADY_SENT → 进程崩溃
    return reply.code(401).send({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  }
}

// 路由级权限守卫：要求用户拥有指定权限
// 返回 preHandler 函数，可携带 permission 参数（闭包）
// 为什么用高阶函数：避免在路由内手写 if 判断，声明式标注更清晰
export function requirePermission(permission: AuthPermission, permissionCacheTtlMs: number) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
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
      return reply.code(401).send({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
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
      return reply.code(403).send({ error: '权限不足', code: 'FORBIDDEN', required: permission });
    }
    return undefined;
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

// ─────────────────────────────────────────────────────────────────────────
// 隔离守卫工厂（权限隔离整改：BR-ISOLATION-01 / BR-ISOLATION-02）
//
// 背景：全局 preHandler 只「注入 currentUser」而「不拒绝」未认证请求；除 /api/auth/*
// 外的大量写接口（会话/线程记忆/共享配置）零守卫，导致游客可越权读写删他人数据、
// 篡改共享服务端密钥。本工厂为这些接口提供「auth 感知」的守卫。
//
// 关键不变量：当 auth 未启用（单租户 / 本地部署，enabled=false）时，守卫一律放行，
// 严格保持既有的「关闭认证 = 全部管理员」部署形态，绝不破坏单租户可用性。
// 仅当 auth.enabled === true 时才真正执行登录/管理员校验。
// ─────────────────────────────────────────────────────────────────────────
export interface IsolationGuardInput {
  enabled?: boolean;
  permissionCacheTtlSec?: number;
}

export interface IsolationGuards {
  /** auth 是否启用；路由层可据此决定是否做 owner 归属校验。 */
  enabled: boolean;
  /** 要求已登录（auth 启用时），未登录返回 401。auth 关闭时放行。 */
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | void;
  /** 要求管理员角色（auth 启用时），否则 401/403。auth 关闭时放行。 */
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | void;
}

export function createIsolationGuards(auth?: IsolationGuardInput): IsolationGuards {
  const enabled = auth?.enabled ?? false;
  // AuthConfig.permissionCacheTtlSec 单位为秒，requireAdmin 内部需要毫秒
  const ttlMs = (auth?.permissionCacheTtlSec ?? 300) * 1000;

  // 采用 async 风格而非回调（done）。理由：回调风格中 send(401) 后再调 done()，
  // Fastify 仍会继续执行 handler，对已发送响应二次 send → FST_ERR_REP_ALREADY_SENT → 崩溃。
  // async 失败分支必须 return reply.send()，Fastify 据此判定响应已发送并终止管线。
  const authGuard = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    if (!enabled) { return undefined; } // 单租户：放行
    if (!request.currentUser) {
      return reply.code(401).send({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
    }
    return undefined;
  };

  const adminGuard = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    if (!enabled) { return undefined; } // 单租户：放行
    return requireAdmin(ttlMs)(request, reply);
  };

  return { enabled, requireAuth: authGuard, requireAdmin: adminGuard };
}

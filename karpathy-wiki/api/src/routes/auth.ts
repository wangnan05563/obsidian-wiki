import type { FastifyInstance, FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import path from 'node:path';
import type { AuthConfig, LoginRequest, CreateUserRequest, UpdateUserRequest } from '../auth/types.js';
import { findUserByUsername, findUserById, listUsers, createUser, updateUser, deleteUser, updateLastLogin, initUserStore } from '../auth/user-store.js';
import { verifyPassword, getSessionSecret } from '../auth/password.js';
import { createSession, destroySession, destroyUserSessions, startSessionCleanup } from '../auth/session.js';
import { getRolePermissions } from '../auth/rbac.js';
import { initAuditLog, writeAuditLog, createAuditEntry, readAuditLog } from '../auth/audit-log.js';
import { setupAuthMiddleware, requireAuth, requireAdmin, audit, DEFAULT_PUBLIC_PATHS } from '../middleware/auth.js';
import { invalidateRoleCache } from '../auth/permission-cache.js';
import { getDataDir } from '../utils/runtime.js';

// 认证路由模块
// 提供：登录、登出、当前用户、权限列表、用户管理（管理员）、审计日志（管理员）
// 路由前缀：/api/auth/*
//
// 设计要点：
//   - 登录失败不区分"用户名错误"和"密码错误"，统一返回"用户名或密码错误"防止枚举
//   - 登出销毁会话，使 token 失效
//   - 用户管理仅管理员可访问（requirePermission('users')）
//   - 审计日志仅管理员可访问

// 模块级配置（initAuthModule 时注入）
let authConfig: AuthConfig | null = null;
let sessionSecret = '';
let permissionCacheTtlMs = 5 * 60 * 1000;
let auditLogPath = '';

// 初始化认证模块（在 index.ts 启动时调用一次）
// 为什么单独导出：路由注册前需要先初始化 user-store、audit-log、中间件
export async function initAuthModule(config: AuthConfig, vaultPath: string): Promise<void> {
  authConfig = config;
  sessionSecret = getSessionSecret(config.sessionSecretRef);
  permissionCacheTtlMs = config.permissionCacheTtlSec * 1000;

  // 解析 users.json / audit.log 的绝对路径
  // config 中路径形如 '../data/users.json'，实际文件位于 data/ 目录下
  // 用 getDataDir() 统一定位 data/ 目录，兼容开发模式（karpathy-wiki/data/）与 SEA 模式（exe/data/）
  // 为什么取 basename：config 路径含 ../data/ 前缀，只需文件名部分拼接到 dataDir
  const dataDir = getDataDir();
  const usersFileAbs = path.join(dataDir, path.basename(config.usersFilePath));
  auditLogPath = path.join(dataDir, path.basename(config.auditLogPath));

  // 初始化用户存储（首次启动创建默认用户）
  await initUserStore(usersFileAbs, config.pbkdf2Iterations);

  // 初始化审计日志
  await initAuditLog(auditLogPath);

  // 启动会话清理定时器
  startSessionCleanup();
}

// 注册认证路由
// 为什么单独导出 registerAuthRoute：遵循项目 register{Name}Route 模式（route-registration-rule）
export function registerAuthRoute(app: FastifyInstance): void {
  if (!authConfig) {
    throw new Error('auth 模块未初始化，请先调用 initAuthModule');
  }

  // 注册认证中间件（全局 preHandler）
  // 为什么 /api/auth/me 不在 publicPaths：放公开列表会导致全局 preHandler 跳过 token 解析，
  // currentUser 永远为 null，authGuard 必然返回 401，已登录用户也无法获取自身信息。
  // 正确行为：/api/auth/me 走正常 token 解析流程，未登录时 authGuard 返回 401，前端据此跳转登录页。
  // 为什么复用 DEFAULT_PUBLIC_PATHS：避免字面量重复导致漂移，单一源真相（BR-048）
  setupAuthMiddleware(app, {
    enabled: authConfig.enabled,
    sessionSecret,
    permissionCacheTtlMs,
    publicPaths: [...DEFAULT_PUBLIC_PATHS],
  });

  // preHandler 守卫包装：requireAuth/requireAdmin 返回 async 函数，直接传引用触发 SonarQube S6544
  // （SonarQube 无法识别 Fastify preHandler 联合类型已支持 async 分支）
  // 用 done 回调风格显式处理 Promise 的成功/失败分支，避免 Promise 被框架丢弃
  const authGuard = (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    requireAuth(request, reply).then(() => done(), (err) => done(err as Error));
  };
  const adminGuard = (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    requireAdmin(permissionCacheTtlMs)(request, reply).then(() => done(), (err) => done(err as Error));
  };

  // ===== 公开接口 =====

  // POST /api/auth/login：登录
  // 为什么不返回 token 在 cookie：本地优先应用，前端存储 token 更简单
  app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as LoginRequest;
    // 可选链合并 body nullish 守卫与字段访问（S6582）
    if (!body?.username || !body?.password) {
      return reply.code(400).send({ ok: false, message: '用户名和密码不能为空' });
    }

    const user = await findUserByUsername(body.username);
    // 为什么恒定时间验证：避免通过响应时间区分"用户名存在"和"用户名不存在"
    // 即使用户不存在也执行一次哈希（用假盐），保持响应时间一致
    const dummySalt = 'AAAAAAAAAAAAAAAAAAAAAA=='; // 固定假盐，base64 编码
    const salt = user?.salt ?? dummySalt;
    const expectedHash = user?.passwordHash ?? 'dummyhash==';
    // 为什么无论用户是否存在都 await verifyPassword：保持响应时间一致
    // 异步 pbkdf2 不再阻塞事件循环，但响应时间仍包含一次完整哈希耗时
    const passwordOk = await verifyPassword(body.password, salt, expectedHash, authConfig!.pbkdf2Iterations);
    const passwordValid = user !== null && passwordOk;

    if (!user || !passwordValid) {
      // 记录审计日志：登录失败
      writeAuditLog(
        createAuditEntry({
          userId: user?.id ?? null,
          username: body.username,
          action: 'login',
          resource: '/api/auth/login',
          ip: request.ip,
          result: 'fail',
          message: '用户名或密码错误',
        }),
      );
      // 不区分"用户名错误"和"密码错误"，统一返回
      return reply.code(401).send({ ok: false, message: '用户名或密码错误' });
    }

    // 检查用户是否启用
    if (!user.enabled) {
      writeAuditLog(
        createAuditEntry({
          userId: user.id,
          username: user.username,
          action: 'login',
          resource: '/api/auth/login',
          ip: request.ip,
          result: 'fail',
          message: '账户已禁用',
        }),
      );
      return reply.code(403).send({ ok: false, message: '账户已禁用，请联系管理员' });
    }

    // 创建会话
    const session = createSession({
      userId: user.id,
      username: user.username,
      role: user.role,
      secret: sessionSecret,
      ttlMs: authConfig!.sessionTtlHours * 60 * 60 * 1000,
    });

    // 更新最后登录时间
    await updateLastLogin(user.id);

    // 记录审计日志：登录成功
    writeAuditLog(
      createAuditEntry({
        userId: user.id,
        username: user.username,
        action: 'login',
        resource: '/api/auth/login',
        ip: request.ip,
        result: 'success',
      }),
    );

    return reply.send({
      ok: true,
      token: session.token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        enabled: user.enabled,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
        permissions: getRolePermissions(user.role),
      },
    });
  });

  // ===== 已登录接口 =====

  // GET /api/auth/me：当前用户信息
  // 为什么不放公开列表：放公开列表会导致全局 preHandler 跳过 token 解析，
  // currentUser 永远为 null，authGuard 必然返回 401，已登录用户也无法获取自身信息。
  // 正确行为：走正常 token 解析流程，未登录时 authGuard 返回 401，前端据此跳转登录页。
  app.get('/api/auth/me', { preHandler: authGuard }, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.currentUser!;
    const user = await findUserById(session.userId);
    if (!user) {
      // 用户已被删除但会话仍有效
      return reply.code(401).send({ error: '用户不存在' });
    }
    return reply.send({
      id: user.id,
      username: user.username,
      role: user.role,
      enabled: user.enabled,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
      permissions: getRolePermissions(user.role),
    });
  });

  // POST /api/auth/logout：登出
  app.post('/api/auth/logout', { preHandler: authGuard }, async (request: FastifyRequest, reply: FastifyReply) => {
    // 从 Authorization 头提取 token
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (token) destroySession(token);

    audit({
      request,
      action: 'logout',
      resource: '/api/auth/logout',
      result: 'success',
    });

    return reply.send({ ok: true });
  });

  // GET /api/auth/permissions：当前用户权限列表
  app.get('/api/auth/permissions', { preHandler: authGuard }, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.currentUser!;
    return reply.send({
      role: session.role,
      permissions: getRolePermissions(session.role),
    });
  });

  // ===== 用户管理接口（仅管理员）=====

  // GET /api/auth/users：用户列表
  app.get('/api/auth/users', { preHandler: adminGuard }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const users = await listUsers();
    // 脱敏：不返回 passwordHash/salt
    const sanitized = users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      enabled: u.enabled,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      lastLoginAt: u.lastLoginAt,
    }));
    return reply.send({ users: sanitized });
  });

  // POST /api/auth/users：创建用户
  app.post('/api/auth/users', { preHandler: adminGuard }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CreateUserRequest;
    // 可选链合并 body nullish 守卫与字段访问（S6582）
    if (!body?.username || !body?.password || !body?.role) {
      return reply.code(400).send({ error: '用户名、密码和角色不能为空' });
    }
    if (!['admin', 'user', 'guest'].includes(body.role)) {
      return reply.code(400).send({ error: '无效的角色' });
    }
    try {
      const user = await createUser({
        username: body.username,
        password: body.password,
        role: body.role,
      });
      audit({
        request,
        action: 'user_create',
        resource: `/api/auth/users/${user.id}`,
        result: 'success',
        message: `创建用户 ${user.username}（角色：${user.role}）`,
      });
      return reply.send({
        id: user.id,
        username: user.username,
        role: user.role,
        enabled: user.enabled,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });
    } catch (err) {
      audit({
        request,
        action: 'user_create',
        resource: '/api/auth/users',
        result: 'fail',
        message: err instanceof Error ? err.message : String(err),
      });
      return reply.code(400).send({ error: err instanceof Error ? err.message : '创建用户失败' });
    }
  });

  // PUT /api/auth/users/:id：更新用户
  app.put('/api/auth/users/:id', { preHandler: adminGuard }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateUserRequest;
    if (!body) {
      return reply.code(400).send({ error: '请求体为空' });
    }
    try {
      const updated = await updateUser(id, {
        username: body.username,
        password: body.password,
        role: body.role,
        enabled: body.enabled,
      });
      // 角色变更时清除权限缓存
      if (body.role) {
        invalidateRoleCache(updated.role);
      }
      // 用户被禁用时销毁其所有会话
      if (body.enabled === false) {
        destroyUserSessions(updated.id);
      }
      audit({
        request,
        action: 'user_update',
        resource: `/api/auth/users/${id}`,
        result: 'success',
        message: `更新用户 ${updated.username}`,
      });
      return reply.send({
        id: updated.id,
        username: updated.username,
        role: updated.role,
        enabled: updated.enabled,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        lastLoginAt: updated.lastLoginAt,
      });
    } catch (err) {
      audit({
        request,
        action: 'user_update',
        resource: `/api/auth/users/${id}`,
        result: 'fail',
        message: err instanceof Error ? err.message : String(err),
      });
      return reply.code(400).send({ error: err instanceof Error ? err.message : '更新用户失败' });
    }
  });

  // DELETE /api/auth/users/:id：删除用户
  app.delete('/api/auth/users/:id', { preHandler: adminGuard }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    // 禁止删除自己
    if (request.currentUser?.userId === id) {
      return reply.code(400).send({ error: '不能删除当前登录用户' });
    }
    try {
      // 先销毁被删用户的会话
      destroyUserSessions(id);
      await deleteUser(id);
      audit({
        request,
        action: 'user_delete',
        resource: `/api/auth/users/${id}`,
        result: 'success',
      });
      return reply.send({ ok: true });
    } catch (err) {
      audit({
        request,
        action: 'user_delete',
        resource: `/api/auth/users/${id}`,
        result: 'fail',
        message: err instanceof Error ? err.message : String(err),
      });
      return reply.code(400).send({ error: err instanceof Error ? err.message : '删除用户失败' });
    }
  });

  // GET /api/auth/audit-log：审计日志（仅管理员）
  app.get('/api/auth/audit-log', { preHandler: adminGuard }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const entries = await readAuditLog(auditLogPath, 1000);
    return reply.send({ entries, count: entries.length });
  });
}

import type { FastifyInstance, FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import path from 'node:path';
import type { AuthConfig, LoginRequest, RegisterRequest, CreateUserRequest, UpdateUserRequest, UserRecord } from '../auth/types.js';
import { findUserByUsername, findUserById, listUsers, createUser, updateUser, deleteUser, updateLastLogin, initUserStore, validateRegistrationInput } from '../auth/user-store.js';
import { verifyPassword, getSessionSecret } from '../auth/password.js';
import { createSession, destroySession, destroyUserSessions, startSessionCleanup } from '../auth/session.js';
import { getRolePermissions } from '../auth/rbac.js';
import { initAuditLog, writeAuditLog, createAuditEntry, readAuditLog } from '../auth/audit-log.js';
import { setupAuthMiddleware, requireAuth, requireAdmin, audit, DEFAULT_PUBLIC_PATHS } from '../middleware/auth.js';
import { invalidateRoleCache } from '../auth/permission-cache.js';
import { checkAuthRateLimit, clientIpFromRequest } from '../auth/auth-rate-limit.js';
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
  // 守卫后 authConfig 已确定非 null；闭包内 TS 无法保持对模块级 let 的收窄，
  // 故捕获为 const 后在闭包中使用，避免冗余的非空断言（BR-028-1）。
  const cfg = authConfig;

  // 注册认证中间件（全局 preHandler）
  // 为什么 /api/auth/me 不在 publicPaths：放公开列表会导致全局 preHandler 跳过 token 解析，
  // currentUser 永远为 null，authGuard 必然返回 401，已登录用户也无法获取自身信息。
  // 正确行为：/api/auth/me 走正常 token 解析流程，未登录时 authGuard 返回 401，前端据此跳转登录页。
  // 为什么复用 DEFAULT_PUBLIC_PATHS：避免字面量重复导致漂移，单一源真相（BR-048）
  setupAuthMiddleware(app, {
    enabled: authConfig.enabled,
    sessionSecret,
    permissionCacheTtlMs,
    publicPaths: authConfig.publicPaths && authConfig.publicPaths.length > 0
      ? authConfig.publicPaths
      : [...DEFAULT_PUBLIC_PATHS],
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
    // 还原真实客户端 IP（隧道/反代场景取 X-Forwarded-For 首跳，否则回退 socket IP）
    const clientIp = clientIpFromRequest(request);
    // 可选链合并 body nullish 守卫与字段访问（S6582）
    if (!body?.username || !body?.password) {
      return reply.code(400).send({ ok: false, message: '用户名和密码不能为空' });
    }

    // FR-RM-10 登录限流（复用同一框架）：单 IP 10 次/分钟、单用户名 5 次/分钟（防爆破）
    const loginRl = checkAuthRateLimit({ ip: clientIp, username: body.username, kind: 'login' });
    if (!loginRl.allowed) {
      // BR-057-4 错误双日志：限流拒绝属潜在暴力破解/枚举，须留痕便于审计与溯源
      request.log.warn({ ip: clientIp, username: body.username, kind: 'login' }, 'auth rate limit exceeded');
      return reply
        .code(429)
        .header('Retry-After', String(loginRl.retryAfterSec))
        .send({ ok: false, error: '登录请求过于频繁，请稍后再试', retryAfterSec: loginRl.retryAfterSec });
    }

    const user = await findUserByUsername(body.username);
    // 为什么恒定时间验证：避免通过响应时间区分"用户名存在"和"用户名不存在"
    // 即使用户不存在也执行一次哈希（用假盐），保持响应时间一致
    const dummySalt = 'AAAAAAAAAAAAAAAAAAAAAA=='; // 固定假盐，base64 编码
    const salt = user?.salt ?? dummySalt;
    const expectedHash = user?.passwordHash ?? 'dummyhash==';
    // 为什么无论用户是否存在都 await verifyPassword：保持响应时间一致
    // 异步 pbkdf2 不再阻塞事件循环，但响应时间仍包含一次完整哈希耗时
    const passwordOk = await verifyPassword(body.password, salt, expectedHash, cfg.pbkdf2Iterations);
    const passwordValid = user !== null && passwordOk;

    if (!user || !passwordValid) {
      // 记录审计日志：登录失败
      writeAuditLog(
        createAuditEntry({
          userId: user?.id ?? null,
          username: body.username,
          action: 'login',
          resource: '/api/auth/login',
          ip: clientIp,
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
          ip: clientIp,
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
      ttlMs: cfg.sessionTtlHours * 60 * 60 * 1000,
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
          ip: clientIp,
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

  // POST /api/auth/register：自助注册（公开）
  // 简易机制：仅用户名 + 密码，默认角色 user（强制，忽略请求体 role，防权限提升）
  // 成功后自动创建会话并返回 token（与 login 同构），实现「注册即登录」
  //
  // 设计要点（BR-057-5）：
  //   - 双维度限流：单 IP 10/min + 单用户名探测 5/min（FR-RM-10），超限 429 + Retry-After；
  //     真实客户端 IP 经 X-Forwarded-For 还原，避免隧道场景下 per-IP 限流坍缩为全站单桶。
  //   - 恒定时间验证：用户名唯一性查库失败也走统一 409，不泄露用户名是否存在（枚举防护）。
  //   - 角色强制：忽略请求体 role 字段，新建用户恒为 'user'，杜绝权限提升。
  //   - 注册即登录：成功后直接签发会话 token，前端无需二次登录。
  //   - 全链路审计：成功/失败/限流拒绝均写审计日志，便于安全溯源。
  app.post('/api/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as RegisterRequest;
    // 还原真实客户端 IP（隧道/反代场景取 X-Forwarded-For 首跳，否则回退 socket IP）
    const clientIp = clientIpFromRequest(request);

    // 1. 同步格式校验（不访问存储）
    const validation = validateRegistrationInput(body);
    if (!validation.ok) {
      return reply.code(validation.status).send({ error: validation.error });
    }
    const username = body.username;

    // FR-RM-10 注册限流：单 IP 10 次/分钟、单用户名探测 5 次/分钟（防批量撞库/枚举）
    const rl = checkAuthRateLimit({ ip: clientIp, username, kind: 'register' });
    if (!rl.allowed) {
      // BR-057-4 错误双日志：限流拒绝属潜在批量撞库/枚举，须留痕便于审计与溯源
      request.log.warn({ ip: clientIp, username, kind: 'register' }, 'auth rate limit exceeded');
      return reply
        .code(429)
        .header('Retry-After', String(rl.retryAfterSec))
        .send({ ok: false, error: '注册请求过于频繁，请稍后再试', retryAfterSec: rl.retryAfterSec });
    }

    // 2. 用户名唯一性校验（异步查库）
    const existing = await findUserByUsername(username);
    if (existing) {
      writeAuditLog(
        createAuditEntry({
          userId: null,
          username,
          action: 'user_register',
          resource: '/api/auth/register',
          ip: clientIp,
          result: 'fail',
          message: '用户名已存在',
        }),
      );
      return reply.code(409).send({ error: '用户名已存在' });
    }

    // 3. 创建用户（PBKDF2 哈希），角色强制为 user
    // catch 分支已 return，故 try 后 newUser 必然已赋值，TS 流分析可收窄为 UserRecord，无需确定赋值断言
    let newUser: UserRecord;
    try {
      newUser = await createUser({ username, password: body.password, role: 'user' });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : '注册失败' });
    }

    // 4. 自动登录：创建会话并返回 token
    const session = createSession({
      userId: newUser.id,
      username: newUser.username,
      role: newUser.role,
      secret: sessionSecret,
      ttlMs: cfg.sessionTtlHours * 60 * 60 * 1000,
    });
    await updateLastLogin(newUser.id);

    // 5. 审计日志：注册成功
    writeAuditLog(
      createAuditEntry({
        userId: newUser.id,
        username: newUser.username,
          action: 'user_register',
          resource: '/api/auth/register',
          ip: clientIp,
          result: 'success',
      }),
    );

    return reply.send({
      ok: true,
      token: session.token,
      user: {
        id: newUser.id,
        username: newUser.username,
        role: newUser.role,
        enabled: newUser.enabled,
        createdAt: newUser.createdAt,
        updatedAt: newUser.updatedAt,
        lastLoginAt: newUser.lastLoginAt,
        permissions: getRolePermissions(newUser.role),
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

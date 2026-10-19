import type { FastifyInstance, FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import path from 'node:path';
import type { AuthConfig, LoginRequest, RegisterRequest, CreateUserRequest, UpdateUserRequest, UserRecord } from '../auth/types.js';
import { findUserByUsername, findUserById, listUsers, createUser, updateUser, deleteUser, updateLastLogin, initUserStore, validateRegistrationInput, validateNewPassword } from '../auth/user-store.js';
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
// T02453（PRD A1）：localOnly 部署模式。true = 本地调试（默认口令提示可见、不强制首登改密）；
// false = 生产（隐藏默认口令提示、首登强制改密）。
let localOnlyMode = false;

// 初始化认证模块（在 index.ts 启动时调用一次）
// 为什么单独导出：路由注册前需要先初始化 user-store、audit-log、中间件
export async function initAuthModule(config: AuthConfig, vaultPath: string, localOnly = false): Promise<void> {
  authConfig = config;
  sessionSecret = getSessionSecret(config.sessionSecretRef);
  permissionCacheTtlMs = config.permissionCacheTtlSec * 1000;
  localOnlyMode = localOnly;

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

  // GET /api/auth/bootstrap：登录页引导信息（T02453，PRD A1）
  // 为什么需要公开端点：默认账户提示只能在 localOnly 调试模式显示，而登录页在认证前
  // 就需要知道该开关；仅返回布尔，不暴露 localOnly 原始值与其他配置。
  app.get('/api/auth/bootstrap', async (_request: FastifyRequest, reply: FastifyReply) => {
    return void reply.send({ ok: true, showDefaultAccountHint: localOnlyMode });
  });

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
    // PERF-TEST HOOK: WIKI_DISABLE_RATE_LIMIT=1 跳过登录限流，便于高并发登录压测
    const rlDisabled = process.env.WIKI_DISABLE_RATE_LIMIT === '1';
    const loginRl = rlDisabled
      ? { allowed: true, limit: 0, remaining: 0, retryAfterSec: 0 }
      : checkAuthRateLimit({ ip: clientIp, username: body.username, kind: 'login' });
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
      return void reply.code(401).send({ ok: false, message: '用户名或密码错误' });
    }

    // 显式守卫帮助 TS 收窄 user 类型（上方 OR 条件未保证 user 非 null）
    if (!user) {
      return void reply.code(500).send({ error: 'unreachable' });
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

    // 更新最后登录时间（非关键写：与审计日志同策略，fire-and-forget 不阻塞响应）
    // 内部已 try/catch 降级告警，写盘失败不影响登录成功返回；去掉 await 让
    // 响应更快返回，避免慢盘/隧道叠加放大登录时延（state-machine-simplify-rule）。
    updateLastLogin(user.id).catch(() => {});

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

    return void reply.send({
      ok: true,
      token: session.token,
      // T02453（PRD A1）：localOnly 门控——生产环境对仍用默认口令的账户返回强制改密标记，
      // 前端据此弹出不可跳过的改密对话框；本地调试模式放行（false）。
      mustChangePassword: !localOnlyMode && user.mustChangePassword === true,
      localOnly: localOnlyMode,
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
      return void reply.code(400).send({ error: err instanceof Error ? err.message : '注册失败' });
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

    return void reply.send({
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
      return void reply.code(401).send({ error: '用户不存在' });
    }
    return void reply.send({
      id: user.id,
      username: user.username,
      role: user.role,
      enabled: user.enabled,
      // T02453：与 login 同口径门控，保证刷新页面后强制改密状态不丢失
      mustChangePassword: !localOnlyMode && user.mustChangePassword === true,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
      permissions: getRolePermissions(user.role),
    });
  });

  // POST /api/auth/change-password：自助改密（T02453，PRD A1 生产首登强制改密落地）
  // 为什么必须登录态：旧密码验证 + 会话归属，防未认证改密；改密成功即清除 mustChangePassword 标记。
  app.post('/api/auth/change-password', { preHandler: authGuard }, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.currentUser!;
    const body = (request.body ?? {}) as { oldPassword?: unknown; newPassword?: unknown; confirmPassword?: unknown };
    const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

    const user = await findUserById(session.userId);
    if (!user) {
      return void reply.code(401).send({ ok: false, message: '用户不存在' });
    }
    if (!oldPassword) {
      return void reply.code(400).send({ ok: false, message: '请输入当前密码' });
    }
    // 旧密码校验：恒定时间比较，失败不区分用户是否存在（与 login 同策略）
    const oldOk = await verifyPassword(oldPassword, user.salt, user.passwordHash, cfg.pbkdf2Iterations);
    if (!oldOk) {
      writeAuditLog(
        createAuditEntry({
          userId: user.id,
          username: user.username,
          action: 'password_change',
          resource: '/api/auth/change-password',
          ip: clientIpFromRequest(request),
          result: 'fail',
          message: '旧密码校验失败',
        }),
      );
      return reply.code(401).send({ ok: false, message: '当前密码不正确' });
    }
    if (newPassword === oldPassword) {
      return void reply.code(400).send({ ok: false, message: '新密码不能与当前密码相同' });
    }
    const validated = validateNewPassword(newPassword, body.confirmPassword);
    if (!validated.ok) {
      return reply.code(validated.status).send({ ok: false, message: validated.error });
    }

    await updateUser(user.id, { password: newPassword, mustChangePassword: false });
    writeAuditLog(
      createAuditEntry({
        userId: user.id,
        username: user.username,
        action: 'password_change',
        resource: '/api/auth/change-password',
        ip: clientIpFromRequest(request),
        result: 'success',
      }),
    );
    return void reply.send({ ok: true, message: '密码修改成功' });
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

    return void reply.send({ ok: true });
  });

  // GET /api/auth/permissions：当前用户权限列表
  app.get('/api/auth/permissions', { preHandler: authGuard }, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.currentUser!;
    return void reply.send({
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
    return void reply.send({ users: sanitized });
  });

  // POST /api/auth/users：创建用户
  app.post('/api/auth/users', { preHandler: adminGuard }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CreateUserRequest;
    // T02473（PRD U2）：这些 400 分支原先缺 return，Fastify 不会中断 handler，
    // 于是校验失败的请求照样落到下面的 createUser() —— 形同「报了错但还是建了号」。守卫必须真的 return。
    if (!body?.username || !body?.password || !body?.role) {
      return void reply.code(400).send({ error: '用户名、密码和角色不能为空' });
    }
    if (!['admin', 'user', 'guest'].includes(body.role)) {
      return void reply.code(400).send({ error: '无效的角色' });
    }
    if (!/^\w{3,32}$/.test(body.username)) {
      return void reply.code(400).send({ error: '用户名须为 3-32 位字母、数字或下划线' });
    }
    const pwdCheck = validateNewPassword(body.password);
    if (!pwdCheck.ok) {
      return void reply.code(pwdCheck.status).send({ error: pwdCheck.error });
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
      return void reply.send({
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
      reply.code(400).send({ error: err instanceof Error ? err.message : '创建用户失败' });
    }
  });

  // PUT /api/auth/users/:id：更新用户
  app.put('/api/auth/users/:id', { preHandler: adminGuard }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateUserRequest;
    if (!body) {
      return void reply.code(400).send({ error: '请求体为空' });
    }
    if (body.role && !['admin', 'user', 'guest'].includes(body.role)) {
      return void reply.code(400).send({ error: '无效的角色' });
    }
    const target = await findUserById(id);
    if (!target) {
      return void reply.code(404).send({ error: `用户不存在: ${id}` });
    }
    // 禁止停用/改角色搞死当前登录账户自身（停用会销毁自己的会话 → 立刻被踢出）
    if (target.id === request.currentUser?.userId && (body.enabled === false || (body.role && body.role !== 'admin'))) {
      return void reply.code(400).send({ error: '不能停用或降级当前登录账户' });
    }
    // T02473（PRD U2）：禁止把最后一个可用管理员改角色或停用 —— 与删除同一条锁死红线
    if (target.role === 'admin' && ((body.role && body.role !== 'admin') || body.enabled === false)) {
      const all = await listUsers();
      const otherActiveAdmins = all.filter((u) => u.id !== target.id && u.role === 'admin' && u.enabled).length;
      if (otherActiveAdmins === 0) {
        return void reply.code(400).send({ error: '系统至少保留一个启用的管理员账户' });
      }
    }
    if (body.password) {
      const pwdCheck = validateNewPassword(body.password);
      if (!pwdCheck.ok) {
        return void reply.code(pwdCheck.status).send({ error: pwdCheck.error });
      }
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
      return void reply.send({
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
      reply.code(400).send({ error: err instanceof Error ? err.message : '更新用户失败' });
    }
  });

  // DELETE /api/auth/users/:id：删除用户
  app.delete('/api/auth/users/:id', { preHandler: adminGuard }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    // 禁止删除自己
    // T02473（PRD U2）：原先缺 return，400 只是「回执」—— handler 继续往下跑，
    // 结果照样 destroyUserSessions + deleteUser，把当前登录账户真的删掉。守卫必须真的 return。
    if (request.currentUser?.userId === id) {
      return void reply.code(400).send({ error: '不能删除当前登录用户' });
    }
    try {
      await deleteUser(id);
      // 会话销毁挪到删除成功之后：原先在 deleteUser 之前执行，
      // 「最后一个管理员」等失败场景会留下「人已删不掉、会话却全没了」的半截状态
      destroyUserSessions(id);
      audit({
        request,
        action: 'user_delete',
        resource: `/api/auth/users/${id}`,
        result: 'success',
      });
      return void reply.send({ ok: true });
    } catch (err) {
      audit({
        request,
        action: 'user_delete',
        resource: `/api/auth/users/${id}`,
        result: 'fail',
        message: err instanceof Error ? err.message : String(err),
      });
      reply.code(400).send({ error: err instanceof Error ? err.message : '删除用户失败' });
    }
  });

  // GET /api/auth/audit-log：审计日志（仅管理员）
  app.get('/api/auth/audit-log', { preHandler: adminGuard }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const entries = await readAuditLog(auditLogPath, 1000);
    return void reply.send({ entries, count: entries.length });
  });
}

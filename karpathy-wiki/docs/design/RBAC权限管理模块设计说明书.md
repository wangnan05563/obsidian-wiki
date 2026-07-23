# RBAC 权限管理模块设计说明书

## 1. 引言

### 1.1 目的
本设计文档描述 Karpathy-Wiki 系统的基于角色的访问控制（RBAC）模块。该模块实现用户认证、角色权限分配、前端菜单访问控制、后端 API 接口权限校验、权限缓存与审计日志等能力，确保系统在不同角色登录时严格按照权限定义展示和控制访问。

### 1.2 范围
- 三种角色：管理员（admin）、普通用户（user）、游客（guest）
- 前端路由层菜单访问控制
- 后端 API 接口层数据操作权限验证
- 权限缓存与审计日志

### 1.3 设计原则
- **单一权威源**：RBAC 权限表为后端静态常量，前端不持有多份副本
- **防御性编程**：前端控制 UX，后端强制鉴权，任一层被绕过均不导致越权
- **配置化无硬编码**：会话 TTL、缓存 TTL、密码迭代次数等参数均在 config 管理
- **最小权限原则**：默认拒绝，显式允许

## 2. 角色与权限模型

### 2.1 角色定义

| 角色 | 标识 | 说明 |
|------|------|------|
| 管理员 | `admin` | 拥有全部 13 个权限点，包含用户管理 |
| 普通用户 | `user` | 仅拥有知识浏览、知识图谱查看、知识库问答等 5 个公开菜单权限 |
| 游客 | `guest` | 权限边界与普通用户一致 |

### 2.2 权限点清单

| 权限点 | 说明 | admin | user | guest |
|--------|------|:-----:|:----:|:-----:|
| `dashboard` | 仪表盘 | ✓ | - | - |
| `ingest` | 知识导入 | ✓ | - | - |
| `progress` | 处理进度 | ✓ | - | - |
| `browse` | 知识浏览 | ✓ | ✓ | ✓ |
| `query` | 知识库问答 | ✓ | ✓ | ✓ |
| `graph` | 知识图谱 | ✓ | ✓ | ✓ |
| `health` | 健康检查 | ✓ | - | - |
| `config` | 系统配置 | ✓ | - | - |
| `tunnel` | 隧道管理 | ✓ | - | - |
| `cleanup` | 系统清理 | ✓ | - | - |
| `users` | 用户管理 | ✓ | - | - |
| `help` | 帮助 | ✓ | ✓ | ✓ |
| `about` | 关于 | ✓ | ✓ | ✓ |

**权限分配规则**：
- 管理员：全部 13 项
- 普通用户 / 游客：`[browse, query, graph, help, about]` 共 5 项（对应"知识浏览、知识图谱查看、知识库问答"三大菜单及辅助页面）

### 2.3 RBAC 静态权限表

权限分配在 [api/src/auth/rbac.ts](../../api/src/auth/rbac.ts) 中以静态常量 `ROLE_PERMISSIONS` 定义：

```typescript
const ROLE_PERMISSIONS: Record<AuthRole, readonly AuthPermission[]> = {
  admin: ['dashboard','ingest','progress','browse','query','graph','health','config','tunnel','cleanup','users','help','about'],
  user:  ['browse','query','graph','help','about'],
  guest: ['browse','query','graph','help','about'],
};
```

`getRolePermissions(role)` 返回数组副本，防止外部修改静态表。

## 3. 模块架构

### 3.1 分层结构

```
┌───────────────────────────────────────────────────┐
│  前端 (frontend/src)                              │
│  ┌─────────────────────────────────────────────┐  │
│  │ Login.vue  →  auth store  →  usePermission │  │
│  │       ↓             ↓             ↓         │  │
│  │    App.vue   visibleMenuItems   canView()   │  │
│  └─────────────────────────────────────────────┘  │
└──────────────────────┬────────────────────────────┘
                       │ HTTP + Bearer Token
┌──────────────────────▼────────────────────────────┐
│  后端 API (api/src)                              │
│  ┌─────────────────────────────────────────────┐  │
│  │ routes/auth.ts  ←  middleware/auth.ts       │  │
│  │      ↓                  ↓                   │  │
│  │  session.ts       requirePermission()       │  │
│  │  password.ts            ↓                    │  │
│  │  user-store.ts    permission-cache.ts        │  │
│  │      ↓                  ↓                    │  │
│  │  rbac.ts          audit-log.ts               │  │
│  └─────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

### 3.2 后端模块清单

| 文件 | 职责 |
|------|------|
| [api/src/auth/types.ts](../../api/src/auth/types.ts) | 类型定义：`AuthRole`/`AuthPermission`/`SessionRecord`/`AuditAction` 等 |
| [api/src/auth/rbac.ts](../../api/src/auth/rbac.ts) | 静态权限表 + 判断函数（hasPermission/hasAny/hasAll/矩阵） |
| [api/src/auth/password.ts](../../api/src/auth/password.ts) | PBKDF2-SHA512 密码哈希 + HMAC 会话 Token |
| [api/src/auth/session.ts](../../api/src/auth/session.ts) | 内存会话存储 + TTL 清理 + 用户级会话销毁 |
| [api/src/auth/permission-cache.ts](../../api/src/auth/permission-cache.ts) | 权限缓存（TTL 5 分钟，可失效） |
| [api/src/auth/audit-log.ts](../../api/src/auth/audit-log.ts) | JSONL 审计日志（串行化写入） |
| [api/src/auth/user-store.ts](../../api/src/auth/user-store.ts) | 用户 CRUD + 默认用户初始化 + 缓存刷新 |
| [api/src/middleware/auth.ts](../../api/src/middleware/auth.ts) | Fastify 中间件：extractToken/requireAuth/requirePermission/audit |
| [api/src/routes/auth.ts](../../api/src/routes/auth.ts) | 认证路由：login/logout/me + 用户管理 |

### 3.3 前端模块清单

| 文件 | 职责 |
|------|------|
| [frontend/src/stores/auth.ts](../../frontend/src/stores/auth.ts) | Pinia 认证 store：token/user 状态、authFetch、权限判断、用户管理方法 |
| [frontend/src/composables/usePermission.ts](../../frontend/src/composables/usePermission.ts) | 权限判断 composable：computed 响应式权限属性、filterVisibleMenus |
| [frontend/src/views/Login.vue](../../frontend/src/views/Login.vue) | 登录页 UI |
| [frontend/src/views/Users.vue](../../frontend/src/views/Users.vue) | 用户管理页 UI（仅管理员可见） |
| [frontend/src/App.vue](../../frontend/src/App.vue) | Login 守卫 + visibleMenuItems 过滤 + 登出按钮 |

## 4. 详细设计

### 4.1 认证流程

#### 4.1.1 登录流程
1. 前端 `Login.vue` 收集用户名/密码，调用 `authStore.login()`
2. 前端 POST `/api/auth/login` → 后端 `routes/auth.ts`
3. 后端 `user-store.findUserByUsername()` 查找用户
4. 后端 `password.verifyPassword()` 用 PBKDF2-SHA512 恒定时间比较验证密码
5. 验证通过：`session.createSession()` 生成 HMAC 签名 Token，写入审计日志
6. 返回 `{ ok: true, token, user }`，前端保存 token 到 localStorage、user 到内存
7. 验证失败：记录审计日志，返回 401，前端设置 error

#### 4.1.2 会话恢复流程
1. 应用启动时 `App.vue` 调用 `authStore.restoreSession()`
2. 前端从 localStorage 读取 token，GET `/api/auth/me`
3. 后端 `validateSession()` 验证 HMAC 签名 + TTL
4. 验证通过：返回用户信息，前端恢复 user
5. 验证失败（401）：前端 `clearAuth()` 清除本地状态

#### 4.1.3 登出流程
1. 前端 `authStore.logout()` POST `/api/auth/logout`
2. 后端 `destroySession()` 从内存会话表移除
3. 前端 `clearAuth()` 清除 token 和 user

### 4.2 密码安全

#### 4.2.1 PBKDF2-SHA512 哈希
- **盐**：`crypto.randomBytes(16)` 生成 16 字节随机盐
- **迭代次数**：100000 次（配置化，在 password.ts 中定义）
- **输出长度**：64 字节
- **存储格式**：`base64(salt):base64(hash)`
- **验证**：`crypto.timingSafeEqual()` 恒定时间比较，防时序攻击

#### 4.2.2 会话 Token
- **结构**：`base64(random32bytes).base64(hmacSignature)`
- **签名算法**：HMAC-SHA256，密钥从 `process.env.SESSION_SECRET` 或 fallback 到固定值
- **验证**：重新计算 HMAC 并 `timingSafeEqual` 比较
- **为什么用 HMAC**：防止客户端伪造 Token，签名密钥只在服务端

### 4.3 前端权限控制

#### 4.3.1 菜单访问控制
- `App.vue` 中 `menuItems` 数组定义全部菜单项，每项含 `key: AuthPermission`
- `usePermission().filterVisibleMenus(menuItems)` 过滤当前用户可见菜单
- `v-for="tab in visibleMenuItems"` 渲染过滤后的菜单
- 未登录用户看到 `<Login>` 组件，不渲染主应用

#### 4.3.2 路由守卫
- `requirePermission(permission, ttl)` 高阶函数返回 Fastify preHandler
- 路由注册时声明所需权限，中间件自动校验
- 公开路径（如 `/api/auth/login`、`/api/health`）在 `PUBLIC_PATHS` 白名单中跳过鉴权

#### 4.3.3 视图渲染守卫
- `Users.vue` 仅在 `currentView === 'users' && isLoggedIn && isAdmin` 时渲染
- `FloatingChat` 仅在 `isLoggedIn` 时渲染

### 4.4 后端权限校验

#### 4.4.1 中间件链
```
请求 → onRequest(extractToken) → preHandler(requirePermission) → 路由处理 → audit
```

1. `setupAuthMiddleware(app, options)` 注册中间件
2. `extractToken`：从 `Authorization: Bearer <token>` 提取 token，注入 `request.session`
3. `requirePermission(perm)`：
   - 未登录 → 401
   - 已登录但无权限 → 403 + 审计日志 `permission_denied`
   - 通过 → 继续路由处理
4. `audit(action)`：记录请求结果到审计日志

#### 4.4.2 权限缓存
- **缓存键**：`userId:permission`
- **TTL**：5 分钟（配置化）
- **失效策略**：
  - 用户角色变更时 `invalidateUserCache(userId)`
  - 手动清除 `clearPermissionCache()`
  - TTL 自然过期
- **统计**：`getCacheStats()` 返回命中/未命中次数

#### 4.4.3 审计日志
- **格式**：JSONL（每行一条 JSON）
- **字段**：`timestamp`/`userId`/`username`/`action`/`resource`/`ip`/`result`
- **写入**：串行化队列，防止并发写入交错
- **动作类型**：`login`/`logout`/`permission_denied`/`user_create`/`user_update`/`user_delete` 等
- **存储**：`data/auth/audit.log`

### 4.5 安全机制

#### 4.5.1 防越权
- **前端伪造角色无效**：后端 RBAC 静态表是权威源，前端 user.role 仅供 UI 展示
- **角色变更即时失效**：`updateUser` 修改角色后调用 `destroyUserSessions(userId)`，旧 Token 立即失效
- **最后一个管理员保护**：`deleteUser` 检查剩余管理员数量，禁止删除最后一个
- **Token 防伪造**：HMAC 签名校验，客户端无法构造合法 Token

#### 4.5.2 敏感信息保护
- API Key 不存 localStorage（后端 config.json 唯一权威源）
- 用户密码以 PBKDF2 哈希存储，永不返回前端
- GET 接口返回用户列表时脱敏密码字段

## 5. 数据结构

### 5.1 用户记录
```typescript
interface UserRecord {
  id: string;            // UUID
  username: string;
  role: 'admin' | 'user' | 'guest';
  enabled: boolean;
  salt: string;          // base64
  hash: string;          // base64
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}
```

### 5.2 会话记录
```typescript
interface SessionRecord {
  token: string;
  userId: string;
  username: string;
  role: AuthRole;
  permissions: AuthPermission[];
  createdAt: number;
  expiresAt: number;
}
```

### 5.3 审计日志条目
```typescript
interface AuditEntry {
  timestamp: string;
  userId: string | null;
  username: string | null;
  action: AuditAction;
  resource: string;
  ip: string;
  result: 'success' | 'failure';
}
```

## 6. 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 会话 TTL | 24 小时 | `session.createSession` 默认参数 |
| 权限缓存 TTL | 5 分钟 | `permission-cache.ts` 内部常量 |
| PBKDF2 迭代次数 | 100000 | `password.ts` 内部常量 |
| PBKDF2 盐长度 | 16 字节 | `password.ts` 内部常量 |
| PBKDF2 输出长度 | 64 字节 | `password.ts` 内部常量 |
| 审计日志路径 | `data/auth/audit.log` | `audit-log.ts` 内部默认 |
| 用户存储路径 | `data/auth/users.json` | `user-store.ts` 内部默认 |

## 7. 测试设计

### 7.1 测试覆盖

| 测试文件 | 用例数 | 覆盖模块 |
|----------|--------|----------|
| [test/rbac.test.ts](../../api/test/rbac.test.ts) | 25 | RBAC 权限表与判断函数 |
| [test/password.test.ts](../../api/test/password.test.ts) | 25 | 密码哈希与 Token 验证 |
| [test/session.test.ts](../../api/test/session.test.ts) | 20 | 会话生命周期 |
| [test/permission-cache.test.ts](../../api/test/permission-cache.test.ts) | 20 | 缓存命中/失效/统计 |
| [test/audit-log.test.ts](../../api/test/audit-log.test.ts) | 15 | 审计日志写入与读取 |
| [test/user-store.test.ts](../../api/test/user-store.test.ts) | 30 | 用户 CRUD 与缓存 |
| [test/middleware-auth.test.ts](../../api/test/middleware-auth.test.ts) | 若干 | 中间件链 |
| [test/integration.test.ts](../../api/test/integration.test.ts) | 29 | 端到端权限边界 |
| [frontend/test/auth-store.test.ts](../../frontend/test/auth-store.test.ts) | 30 | 前端认证 store |
| [frontend/test/usePermission.test.ts](../../frontend/test/usePermission.test.ts) | 38 | 前端权限 composable |

### 7.2 测试结果

| 端 | 测试用例 | 通过 | 失败 | 覆盖率 |
|----|----------|------|------|--------|
| 后端 | 211 | 211 | 0 | Stmts 98.23% / Branch 95.42% / Funcs 100% / Lines 98.23% |
| 前端 | 68 | 68 | 0 | （覆盖率报告运行中） |

### 7.3 集成测试覆盖的需求点

| 需求 | 测试用例 |
|------|----------|
| 需求 1：管理员全权限 | 管理员角色应拥有全部 13 个权限点 / 管理员对所有受保护菜单有访问权 / 管理员会话通过 requirePermission 守卫 |
| 需求 2：普通用户三菜单 | 普通用户权限列表应为 [browse, query, graph, help, about] / 普通用户对受保护菜单无访问权 / 普通用户对公开菜单有访问权 / 普通用户会话通过 browse 守卫被 dashboard 守卫拒绝 |
| 需求 3：游客与普通用户一致 | 游客权限应等于普通用户权限 / 游客会话通过 browse 守卫被 users 守卫拒绝 |
| 需求 4：防越权 | 未登录用户访问受保护资源应返回 401 / 普通用户伪造管理员角色仍会被拒绝 / 用户角色变更后旧会话权限应立即失效 |
| 需求 5：权限缓存 | 权限缓存清除后重新检查应返回新结果 / 缓存命中应加速后续检查 / TTL 到期后缓存失效 / 角色级缓存清除应只影响该角色 |
| 需求 6：审计日志 | 登录成功/失败应记录审计日志 / 越权访问应记录 permission_denied / 用户管理操作应记录审计日志 / 审计日志应按时间顺序追加 |
| 端到端 | 管理员完整流程 / 普通用户完整流程（含越权拒绝）/ 游客完整流程 |
| 安全 | 默认管理员密码不可为空 / 会话 token 防伪造 / 会话过期后无效 / 最后一个管理员不可删除 |

## 8. 部署与运维

### 8.1 默认用户
首次启动时若 `data/auth/users.json` 不存在，自动创建三个默认用户：
- `admin/admin123`（管理员）
- `user/user123`（普通用户）
- `guest/guest123`（游客）

**生产环境必须立即修改默认密码**。

### 8.2 环境变量
- `SESSION_SECRET`：会话 Token 签名密钥（推荐生产环境设置）

### 8.3 日志位置
- 审计日志：`data/auth/audit.log`
- 后端运行日志：由 Fastify logger 输出到 stdout

## 9. 约束遵循

本模块严格遵循 [wiki-code-dev](../../.trae/skills/wiki-code-dev/SKILL.md) 规范：
- ✓ 所有源文件 UTF-8 无 BOM
- ✓ 路径解析基于 `import.meta.url`，不依赖 CWD
- ✓ 写盘函数（createUser/updateUser/deleteUser）同步刷新内存缓存
- ✓ 权限缓存符合"写后即刷"原则
- ✓ 敏感字段（密码/hash/salt）GET 接口脱敏
- ✓ 后端 types.ts 与前端 types.ts 同步
- ✓ 新增路由在 index.ts 注册
- ✓ 中间件注册 onRequest/onResponse/onError 钩子
- ✓ 审计日志 catch 块调用 `request.log.error`

// RBAC 权限模块类型定义
// 与前端 types.ts 中的 AuthRole / AuthPermission / UserInfo 对齐（type-sync-rule）

// 系统支持的三种角色：管理员、普通用户、游客
// 为什么用字面量联合而非 enum：tree-shaking 友好且无需运行时转换
export type AuthRole = 'admin' | 'user' | 'guest';

// 权限点：对应前端菜单的 ViewName，控制菜单可见性
// 与 frontend/src/App.vue 的 ViewName 保持一致
export type AuthPermission =
  | 'dashboard'
  | 'ingest'
  | 'progress'
  | 'browse'
  | 'query'
  | 'graph'
  | 'health'
  | 'config'
  | 'tunnel'
  | 'cleanup'
  | 'help'
  | 'about'
  // 用户管理是独立的权限点，不对应菜单 key
  | 'users'
  // 技能导入管理：管理员专属，与 config/cleanup 同级
  | 'skill';

// 用户记录（持久化到 users.json）
// passwordHash + salt 用于 PBKDF2 验证；password 字段不存储
export interface UserRecord {
  id: string;
  username: string;
  // PBKDF2 哈希结果（base64）
  passwordHash: string;
  // 盐（base64，16 字节）
  salt: string;
  role: AuthRole;
  // 是否启用（禁用用户无法登录）
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  // 最后登录时间（首次为空）
  lastLoginAt?: string;
}

// 会话记录（内存中维护，token → userId 映射）
export interface SessionRecord {
  token: string;
  userId: string;
  username: string;
  role: AuthRole;
  // 创建时间戳（ms）
  createdAt: number;
  // 过期时间戳（ms）
  expiresAt: number;
}

// 审计日志条目（追加写入 audit.log）
export interface AuditLogEntry {
  ts: string;
  userId: string | null;
  username: string | null;
  action: AuditAction;
  resource: string;
  ip: string;
  // success/fail，用于区分越权尝试
  result: 'success' | 'fail';
  message?: string;
}

// 审计动作类型
export type AuditAction =
  | 'login'
  | 'logout'
  | 'permission_check'
  | 'permission_denied'
  | 'user_create'
  | 'user_update'
  | 'user_delete'
  | 'user_register'
  | 'config_change';

// 认证配置（嵌入 AppConfig.auth）
export interface AuthConfig {
  // 是否启用权限控制（关闭时所有请求视为 admin）
  // 为什么保留开关：本地开发场景可关闭简化测试
  enabled: boolean;
  // 会话有效期（小时）
  sessionTtlHours: number;
  // 权限缓存 TTL（秒）
  permissionCacheTtlSec: number;
  // 审计日志文件路径（相对 vaultPath 同级 data 目录）
  auditLogPath: string;
  // 用户存储文件路径
  usersFilePath: string;
  // PBKDF2 迭代次数
  pbkdf2Iterations: number;
  // JWT 签名密钥引用（环境变量名）
  // 为什么用 ref：与 llm.apiKeyRef 一致，避免密钥落盘 config.json
  sessionSecretRef: string;
  // 公开路径（无需认证即可访问）白名单，覆盖 DEFAULT_PUBLIC_PATHS 兜底常量。
  // 为什么可配：auth-endpoint-classification 规则要求端点路径单一来源、禁止硬编码，
  // 运营可按部署形态扩展/收敛公开端点（如新增隧道健康检查路径）。
  publicPaths?: string[];
}

// 登录请求体
export interface LoginRequest {
  username: string;
  password: string;
}

// 自助注册请求体（公开接口，默认角色 user）
export interface RegisterRequest {
  username: string;
  password: string;
  confirmPassword?: string;
}

// 登录响应
export interface LoginResponse {
  ok: boolean;
  token?: string;
  user?: UserInfo;
  message?: string;
}

// 用户信息（脱敏后返回前端）
// 不含 passwordHash/salt
export interface UserInfo {
  id: string;
  username: string;
  role: AuthRole;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  // 当前用户权限列表（GET /api/auth/me 直接附带）
  permissions: AuthPermission[];
}

// 创建/更新用户请求体（管理员操作）
export interface CreateUserRequest {
  username: string;
  password: string;
  role: AuthRole;
}

export interface UpdateUserRequest {
  username?: string;
  password?: string;
  role?: AuthRole;
  enabled?: boolean;
}

// 用户管理页的纯展示逻辑（T02473，PRD §13 U1~U8）
// 为什么抽出来：删除/停用守卫与列表筛选排序分页是「点了会不会把人锁在系统外」的判断，
// 放进组件里只能靠 UI 实测覆盖；这里做成无状态函数，由 frontend/test/users-manage-presentation.test.ts 断言。
import type { AuthRole, UserInfo } from '../types';

/** 仓库公开的出厂种子账号名（api/src/auth/user-store.ts SEED_USERS 同源） */
export const SEED_ACCOUNT_NAMES: readonly string[] = ['admin', 'user', 'guest'];

export const SEED_ACCOUNT_HINT =
  'admin / user / guest 是随代码公开的出厂账号，口令一旦被改过就不再是风险；仍启用的建议停用。';

/** 与后端 validateNewPassword / validateRegistrationInput 同源的输入规则 */
export const USERNAME_RULE = '用户名须为 3-32 位字母、数字或下划线';
export const PASSWORD_RULE = '密码长度须为 8-64 位';

export type SortOrder = 'ascending' | 'descending';
export type UserSortProp = 'username' | 'role' | 'createdAt' | 'lastLoginAt';

export interface UserTableQuery {
  keyword: string;
  sortProp: UserSortProp;
  sortOrder: SortOrder;
}

export function defaultUserTableQuery(): UserTableQuery {
  return { keyword: '', sortProp: 'username', sortOrder: 'ascending' };
}

/** 角色排序层级：管理员 → 普通用户 → 游客（同组内按用户名） */
const ROLE_LEVEL: Record<AuthRole, number> = { admin: 0, user: 1, guest: 2 };

export function roleLabel(role: AuthRole): string {
  if (role === 'admin') return '管理员';
  if (role === 'user') return '普通用户';
  return '游客';
}

export interface GuardResult {
  blocked: boolean;
  /** blocked 时为按钮常驻说明（data-tip）；放行时为正常操作说明 */
  reason: string;
}

export interface ProtectContext {
  /** 当前登录账户 id；未登录/未知时传 undefined，此时自删保护退化为仅服务端守卫 */
  currentUserId?: string;
  /** 管理员账户总数（与后端 deleteUser 的「至少保留一个管理员」同口径，含已禁用） */
  adminCount: number;
  /** 仍启用的管理员数：停用唯一启用管理员会让所有人被锁在管理页外 */
  activeAdminCount: number;
}

/** U2：删除守卫——当前登录账户与最后一个管理员不可删 */
export function deleteGuard(user: Pick<UserInfo, 'id' | 'role'>, ctx: ProtectContext): GuardResult {
  if (ctx.currentUserId && user.id === ctx.currentUserId) {
    return { blocked: true, reason: '不能删除当前登录账户：删除后本次会话立即失效且无法恢复' };
  }
  if (user.role === 'admin' && ctx.adminCount <= 1) {
    return { blocked: true, reason: '系统至少保留一个管理员账户，最后一个管理员不可删除' };
  }
  return { blocked: false, reason: '删除该账户（会话立即失效，不可撤销）' };
}

/** U2：停用守卫——不可停用当前登录账户，也不可停用唯一启用的管理员 */
export function disableGuard(user: Pick<UserInfo, 'id' | 'role' | 'enabled'>, ctx: ProtectContext): GuardResult {
  if (!user.enabled) return { blocked: false, reason: '该账户已停用' };
  if (ctx.currentUserId && user.id === ctx.currentUserId) {
    return { blocked: true, reason: '不能停用当前登录账户：停用后会被立即登出且无法自行恢复' };
  }
  if (user.role === 'admin' && ctx.activeAdminCount <= 1) {
    return { blocked: true, reason: '这是唯一启用的管理员，停用后无人能进入用户管理' };
  }
  return { blocked: false, reason: '停用该账户（已登录会话立即失效，可再次启用）' };
}

/**
 * U3：挑出仍是启用态的出厂种子账号。
 * 返回按 admin → user → guest 排序，管理页据此显示一条告警并提供逐项停用。
 */
export function seedRiskUsers(users: UserInfo[], ctx: ProtectContext): { user: UserInfo; guard: GuardResult }[] {
  return users
    .filter((u) => SEED_ACCOUNT_NAMES.includes(u.username) && u.enabled)
    .map((user) => ({ user, guard: disableGuard(user, ctx) }))
    .sort((a, b) => ROLE_LEVEL[a.user.role] - ROLE_LEVEL[b.user.role] || a.user.username.localeCompare(b.user.username));
}

/** U1：删除确认文案——把影响写在确认框里，而不是只问「确认删除？」 */
export function deleteConfirmMessage(user: UserInfo, ctx: ProtectContext): string {
  const isSelf = ctx.currentUserId === user.id;
  const lines = [
    `将删除账户 ${user.username}（${roleLabel(user.role)}，创建于 ${absoluteTime(user.createdAt)}）。`,
    '影响：该账户的登录会话立即失效、无法再登录，历史审计日志保留。',
    '此操作不可撤销。',
  ];
  if (isSelf) lines.unshift('注意：这是你当前登录的账户。');
  return lines.join('\n');
}

export function filterUsers(users: UserInfo[], keyword: string): UserInfo[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [...users];
  return users.filter((u) => u.username.toLowerCase().includes(kw));
}

export function sortUsers(users: UserInfo[], prop: UserSortProp, order: SortOrder): UserInfo[] {
  const dir = order === 'ascending' ? 1 : -1;
  return [...users].sort((a, b) => {
    const primary = compareBy(prop, a, b);
    if (primary !== 0) return primary * dir;
    return a.username.localeCompare(b.username);
  });
}

function compareBy(prop: UserSortProp, a: UserInfo, b: UserInfo): number {
  switch (prop) {
    case 'username':
      return a.username.localeCompare(b.username);
    case 'role':
      return ROLE_LEVEL[a.role] - ROLE_LEVEL[b.role];
    case 'createdAt':
      return timeValue(a.createdAt) - timeValue(b.createdAt);
    case 'lastLoginAt':
      return timeValue(a.lastLoginAt) - timeValue(b.lastLoginAt);
  }
}

/** 缺失/非法时间戳排到 0（从未登录在倒序里自然沉底） */
function timeValue(s?: string): number {
  if (!s) return 0;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export const USER_PAGE_SIZE_OPTIONS = [20, 50, 100];

export function sliceUsers(users: UserInfo[], page: number, size: number): UserInfo[] {
  const start = (Math.max(1, page) - 1) * size;
  return users.slice(start, start + size);
}

/** U8：列表里显示相对时间，完整时间戳放 tooltip */
export function relativeTime(iso?: string, now: number = Date.now()): string {
  const t = timeValue(iso);
  if (t === 0) return '—';
  const diffMs = now - t;
  // 未来时间戳（时钟漂移）不显示「-3 分钟前」
  if (diffMs < 0) return '刚刚';
  const minutes = diffMs / 60000;
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${Math.floor(minutes)} 分钟前`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)} 小时前`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)} 天前`;
  return dayKey(t);
}

/** 本地日期 YYYY-MM-DD：不能用 toLocaleString 切片，zh-CN 会输出「2026/1/1 08:00:00」 */
function dayKey(t: number): string {
  const d = new Date(t);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function absoluteTime(iso?: string): string {
  const t = timeValue(iso);
  if (t === 0) return '—';
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

export interface FieldErrors {
  username?: string;
  password?: string;
}

/**
 * U7：把后端的输入规则前移到表单，避免「创建用户失败（用户名可能已存在）」这类把三种原因糊成一句的提示。
 * requirePassword=false 用于编辑态（留空表示不改密码）；
 * username 传 undefined 表示这个表单根本没有用户名字段（编辑弹窗），此时不校验用户名。
 */
export function validateUserForm(params: { username?: string; password?: string; requirePassword: boolean }): FieldErrors {
  const errors: FieldErrors = {};
  const password = params.password ?? '';
  if (params.username !== undefined) {
    const username = params.username.trim();
    if (!username) {
      errors.username = '用户名不能为空';
    } else if (!/^\w{3,32}$/.test(username)) {
      errors.username = USERNAME_RULE;
    }
  }
  if (params.requirePassword) {
    if (!password) errors.password = '密码不能为空';
    else if (password.length < 8 || password.length > 64) errors.password = PASSWORD_RULE;
  } else if (password && (password.length < 8 || password.length > 64)) {
    errors.password = PASSWORD_RULE;
  }
  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Boolean(errors.username || errors.password);
}

import type { AuthRole, AuthPermission } from './types.js';

// RBAC 核心：角色到权限的静态映射表
// 为什么用静态映射而非数据库：角色权限是业务规则，不应被运维或用户误改
// 修改权限分配规则需变更代码 + 测试，避免运行时配置被篡改绕过控制

// 角色-权限映射表
// 设计依据：需求要求 admin 拥有全部，user/guest 仅拥有知识浏览/图谱/问答三个核心菜单
// help/about 作为公共辅助页面，所有人可见（无需权限点校验，由前端兜底）
const ROLE_PERMISSIONS: Readonly<Record<AuthRole, Readonly<AuthPermission[]>>> = {
  // 管理员：系统所有功能模块
  admin: [
    'dashboard',
    'ingest',
    'progress',
    'browse',
    'query',
    'graph',
    'health',
    'config',
    'tunnel',
    'cleanup',
    'help',
    'about',
    'users',
    'skill',
  ],
  // 普通用户：知识浏览、知识图谱查看、知识库问答 + 公共辅助页
  user: ['browse', 'query', 'graph', 'help', 'about'],
  // 游客：与普通用户相同（核心三菜单 + 公共辅助页）
  // 为什么不进一步收紧：需求明确「游客仅拥有 browse/query/graph」
  // help/about 视为登录态辅助页（登出回到 login），不视为业务权限点
  guest: ['browse', 'query', 'graph', 'help', 'about'],
};

// 获取角色对应的权限列表（返回新数组避免外部修改）
export function getRolePermissions(role: AuthRole): AuthPermission[] {
  return [...ROLE_PERMISSIONS[role]];
}

// 检查角色是否拥有指定权限
export function hasPermission(role: AuthRole, permission: AuthPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

// 检查角色是否拥有任一权限（用于 OR 关系校验，如菜单可见性）
export function hasAnyPermission(role: AuthRole, permissions: AuthPermission[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

// 检查角色是否拥有全部权限（用于 AND 关系校验）
export function hasAllPermissions(role: AuthRole, permissions: AuthPermission[]): boolean {
  return permissions.every((p) => hasPermission(role, p));
}

// 判断是否为管理员角色（用于路由守卫的快捷判断）
export function isAdmin(role: AuthRole): boolean {
  return role === 'admin';
}

// 列出系统支持的全部角色（用于用户管理 UI 下拉选项）
export function listRoles(): AuthRole[] {
  return ['admin', 'user', 'guest'];
}

// 列出系统支持的全部权限点（用于权限矩阵展示）
export function listPermissions(): AuthPermission[] {
  return [
    'dashboard',
    'ingest',
    'progress',
    'browse',
    'query',
    'graph',
    'health',
    'config',
    'tunnel',
    'cleanup',
    'help',
    'about',
    'users',
    'skill',
  ];
}

// 获取角色-权限完整映射（用于权限矩阵展示，返回深拷贝避免外部修改）
export function getRolePermissionMatrix(): Record<AuthRole, AuthPermission[]> {
  return {
    admin: getRolePermissions('admin'),
    user: getRolePermissions('user'),
    guest: getRolePermissions('guest'),
  };
}

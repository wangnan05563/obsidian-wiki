import { computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import type { AuthPermission } from '../types';

// 权限判断组合式函数
// 封装 auth store 的权限判断逻辑，提供响应式计算属性
// 为什么单独 composable：组件层直接用 store 会暴露 store 实现细节，composable 层更稳定
//
// 使用示例：
//   const { isLoggedIn, isAdmin, canView } = usePermission();
//   canView('dashboard')  // 当前用户能否查看仪表盘

export function usePermission() {
  const authStore = useAuthStore();

  // 是否已登录
  const isLoggedIn = computed(() => authStore.isLoggedIn);

  // 是否为管理员
  const isAdmin = computed(() => authStore.isAdmin);

  // 是否为游客
  const isGuest = computed(() => authStore.isGuest);

  // 当前用户名
  const username = computed(() => authStore.user?.username ?? '');

  // 当前角色
  const role = computed(() => authStore.role);

  // 当前权限列表
  const permissions = computed(() => authStore.permissions);

  // 检查是否拥有指定权限
  function canView(permission: AuthPermission): boolean {
    return authStore.hasPermission(permission);
  }

  // 检查是否拥有任一权限（OR 关系）
  function canViewAny(perms: AuthPermission[]): boolean {
    return authStore.hasAnyPermission(perms);
  }

  // 检查是否拥有全部权限（AND 关系）
  function canViewAll(perms: AuthPermission[]): boolean {
    return authStore.hasAllPermissions(perms);
  }

  // 过滤菜单项：传入菜单 key 列表，返回当前用户可见的菜单
  // 为什么返回新数组：避免外部修改原数组
  function filterVisibleMenus<T extends { key: AuthPermission }>(menus: T[]): T[] {
    return menus.filter((m) => canView(m.key));
  }

  return {
    isLoggedIn,
    isAdmin,
    isGuest,
    username,
    role,
    permissions,
    canView,
    canViewAny,
    canViewAll,
    filterVisibleMenus,
  };
}

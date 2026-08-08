import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '../src/stores/auth';
import { usePermission } from '../src/composables/usePermission';
import type { UserInfo, AuthPermission } from '../src/types';

// usePermission composable 测试
// 覆盖点：isLoggedIn/isAdmin/isGuest 响应式、canView/canViewAny/canViewAll、filterVisibleMenus

function makeUser(role: 'admin' | 'user' | 'guest'): UserInfo {
  return {
    id: `uid-${role}`,
    username: role,
    role,
    enabled: true,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    permissions: role === 'admin'
      ? ['dashboard', 'ingest', 'progress', 'browse', 'query', 'graph', 'health', 'config', 'tunnel', 'cleanup', 'help', 'about', 'users']
      : ['dashboard', 'browse', 'query', 'graph', 'help', 'about'],
  };
}

describe('usePermission composable', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('未登录状态', () => {
    it('isLoggedIn 应为 false', () => {
      const { isLoggedIn } = usePermission();
      expect(isLoggedIn.value).toBe(false);
    });

    it('isAdmin 应为 false', () => {
      const { isAdmin } = usePermission();
      expect(isAdmin.value).toBe(false);
    });

    it('isGuest 应为 true（未登录也算游客）', () => {
      const { isGuest } = usePermission();
      expect(isGuest.value).toBe(true);
    });

    it('username 应为空字符串', () => {
      const { username } = usePermission();
      expect(username.value).toBe('');
    });

    it('role 应为 null', () => {
      const { role } = usePermission();
      expect(role.value).toBeNull();
    });

    it('permissions 应为空数组', () => {
      const { permissions } = usePermission();
      expect(permissions.value).toEqual([]);
    });

    it('canView 对任何权限返回 false', () => {
      const { canView } = usePermission();
      expect(canView('browse')).toBe(false);
      expect(canView('dashboard')).toBe(false);
    });

    it('filterVisibleMenus 应返回空数组', () => {
      const { filterVisibleMenus } = usePermission();
      const menus = [
        { permission: 'browse' as AuthPermission, label: '浏览' },
        { permission: 'dashboard' as AuthPermission, label: '仪表盘' },
      ];
      const visible = filterVisibleMenus(menus);
      expect(visible).toEqual([]);
    });
  });

  describe('管理员状态', () => {
    beforeEach(() => {
      const store = useAuthStore();
      store.user = makeUser('admin');
      store.token = 'admin-token';
    });

    it('isLoggedIn 应为 true', () => {
      const { isLoggedIn } = usePermission();
      expect(isLoggedIn.value).toBe(true);
    });

    it('isAdmin 应为 true', () => {
      const { isAdmin } = usePermission();
      expect(isAdmin.value).toBe(true);
    });

    it('isGuest 应为 false', () => {
      const { isGuest } = usePermission();
      expect(isGuest.value).toBe(false);
    });

    it('username 应为 admin', () => {
      const { username } = usePermission();
      expect(username.value).toBe('admin');
    });

    it('role 应为 admin', () => {
      const { role } = usePermission();
      expect(role.value).toBe('admin');
    });

    it('canView 对所有权限返回 true', () => {
      const { canView } = usePermission();
      const perms: AuthPermission[] = ['dashboard', 'ingest', 'progress', 'browse', 'query', 'graph', 'health', 'config', 'tunnel', 'cleanup', 'help', 'about', 'users'];
      for (const p of perms) {
        expect(canView(p)).toBe(true);
      }
    });

    it('canViewAny 对任一权限组合返回 true', () => {
      const { canViewAny } = usePermission();
      expect(canViewAny(['dashboard', 'users'])).toBe(true);
    });

    it('canViewAll 对全部权限组合返回 true', () => {
      const { canViewAll } = usePermission();
      expect(canViewAll(['dashboard', 'users', 'browse'])).toBe(true);
    });

    it('filterVisibleMenus 应返回全部菜单', () => {
      const { filterVisibleMenus } = usePermission();
      const menus = [
        { permission: 'browse' as AuthPermission, label: '浏览' },
        { permission: 'dashboard' as AuthPermission, label: '仪表盘' },
        { permission: 'users' as AuthPermission, label: '用户管理' },
      ];
      const visible = filterVisibleMenus(menus);
      expect(visible).toHaveLength(3);
    });
  });

  describe('普通用户状态', () => {
    beforeEach(() => {
      const store = useAuthStore();
      store.user = makeUser('user');
      store.token = 'user-token';
    });

    it('isLoggedIn 应为 true', () => {
      const { isLoggedIn } = usePermission();
      expect(isLoggedIn.value).toBe(true);
    });

    it('isAdmin 应为 false', () => {
      const { isAdmin } = usePermission();
      expect(isAdmin.value).toBe(false);
    });

    it('isGuest 应为 false', () => {
      const { isGuest } = usePermission();
      expect(isGuest.value).toBe(false);
    });

    it('username 应为 user', () => {
      const { username } = usePermission();
      expect(username.value).toBe('user');
    });

    it('role 应为 user', () => {
      const { role } = usePermission();
      expect(role.value).toBe('user');
    });

    it('canView browse 返回 true', () => {
      const { canView } = usePermission();
      expect(canView('browse')).toBe(true);
    });

    it('canView dashboard 返回 true（仪表盘已开放给所有用户）', () => {
      const { canView } = usePermission();
      expect(canView('dashboard')).toBe(true);
    });

    it('canViewAny 对 [browse, dashboard] 返回 true', () => {
      const { canViewAny } = usePermission();
      expect(canViewAny(['browse', 'dashboard'])).toBe(true);
    });

    // 仪表盘已开放给所有用户：普通用户拥有 dashboard，因此对 [dashboard, users] 返回 true
    it('canViewAny 对 [dashboard, users] 返回 true', () => {
      const { canViewAny } = usePermission();
      expect(canViewAny(['dashboard', 'users'])).toBe(true);
    });

    it('canViewAll 对 [browse, query] 返回 true', () => {
      const { canViewAll } = usePermission();
      expect(canViewAll(['browse', 'query'])).toBe(true);
    });

    it('canViewAll 对 [browse, dashboard] 返回 true（仪表盘已开放）', () => {
      const { canViewAll } = usePermission();
      expect(canViewAll(['browse', 'dashboard'])).toBe(true);
    });

    it('filterVisibleMenus 应过滤掉无权限菜单', () => {
      const { filterVisibleMenus } = usePermission();
      const menus = [
        { permission: 'browse' as AuthPermission, label: '浏览' },
        { permission: 'dashboard' as AuthPermission, label: '仪表盘' },
        { permission: 'query' as AuthPermission, label: '问答' },
        { permission: 'users' as AuthPermission, label: '用户管理' },
      ];
      // 仪表盘已开放给所有用户，故 browse/dashboard/query 可见（users 仍被过滤）
      const visible = filterVisibleMenus(menus);
      expect(visible).toHaveLength(3);
      expect(visible[0].permission).toBe('browse');
      expect(visible[1].permission).toBe('dashboard');
      expect(visible[2].permission).toBe('query');
    });
  });

  describe('游客状态', () => {
    beforeEach(() => {
      const store = useAuthStore();
      store.user = makeUser('guest');
      store.token = 'guest-token';
    });

    it('isGuest 应为 true', () => {
      const { isGuest } = usePermission();
      expect(isGuest.value).toBe(true);
    });

    it('canView browse 返回 true', () => {
      const { canView } = usePermission();
      expect(canView('browse')).toBe(true);
    });

    it('canView dashboard 返回 true（仪表盘已开放给所有用户）', () => {
      const { canView } = usePermission();
      expect(canView('dashboard')).toBe(true);
    });

    it('filterVisibleMenus 应与普通用户相同（仪表盘可见）', () => {
      const { filterVisibleMenus } = usePermission();
      const menus = [
        { permission: 'browse' as AuthPermission, label: '浏览' },
        { permission: 'dashboard' as AuthPermission, label: '仪表盘' },
        { permission: 'query' as AuthPermission, label: '问答' },
        { permission: 'users' as AuthPermission, label: '用户管理' },
      ];
      const visible = filterVisibleMenus(menus);
      expect(visible).toHaveLength(3);
    });
  });

  describe('响应式更新', () => {
    it('用户状态变更后 isLoggedIn 应响应更新', () => {
      const store = useAuthStore();
      const { isLoggedIn } = usePermission();
      expect(isLoggedIn.value).toBe(false);
      store.user = makeUser('admin');
      store.token = 't';
      expect(isLoggedIn.value).toBe(true);
    });

    it('角色变更后 isAdmin 应响应更新', () => {
      const store = useAuthStore();
      const { isAdmin } = usePermission();
      store.user = makeUser('user');
      store.token = 't';
      expect(isAdmin.value).toBe(false);
      store.user = makeUser('admin');
      expect(isAdmin.value).toBe(true);
    });

    it('登出后 canView 应返回 false', () => {
      const store = useAuthStore();
      store.user = makeUser('admin');
      store.token = 't';
      const { canView } = usePermission();
      expect(canView('dashboard')).toBe(true);
      store.clearAuth();
      expect(canView('dashboard')).toBe(false);
    });
  });

  describe('filterVisibleMenus 不可变性', () => {
    it('应返回新数组，不修改原数组', () => {
      const store = useAuthStore();
      store.user = makeUser('user');
      store.token = 't';
      const { filterVisibleMenus } = usePermission();
      const menus = [
        { permission: 'browse' as AuthPermission, label: '浏览' },
        { permission: 'dashboard' as AuthPermission, label: '仪表盘' },
      ];
      const originalLength = menus.length;
      const visible = filterVisibleMenus(menus);
      expect(visible).not.toBe(menus);
      expect(menus.length).toBe(originalLength);
    });

    it('空数组应返回空数组', () => {
      const store = useAuthStore();
      store.user = makeUser('admin');
      store.token = 't';
      const { filterVisibleMenus } = usePermission();
      const visible = filterVisibleMenus([]);
      expect(visible).toEqual([]);
    });
  });
});

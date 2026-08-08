import { describe, it, expect } from 'vitest';
import {
  getRolePermissions,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  isAdmin,
  listRoles,
  listPermissions,
  getRolePermissionMatrix,
} from '../src/auth/rbac.js';
import type { AuthRole, AuthPermission } from '../src/auth/types.js';

// RBAC 核心规则测试
// 覆盖点：角色权限映射、权限判断、OR/AND 逻辑、管理员判断、列表导出

describe('RBAC 模块', () => {
  describe('getRolePermissions', () => {
    it('管理员应返回全部 13 个权限点', () => {
      const perms = getRolePermissions('admin');
      expect(perms).toHaveLength(14);
      expect(perms).toContain('dashboard');
      expect(perms).toContain('ingest');
      expect(perms).toContain('progress');
      expect(perms).toContain('browse');
      expect(perms).toContain('query');
      expect(perms).toContain('graph');
      expect(perms).toContain('health');
      expect(perms).toContain('config');
      expect(perms).toContain('tunnel');
      expect(perms).toContain('cleanup');
      expect(perms).toContain('help');
      expect(perms).toContain('about');
      expect(perms).toContain('users');
    });

    it('普通用户拥有 dashboard + browse/query/graph/help/about 六个权限', () => {
      const perms = getRolePermissions('user');
      expect(perms).toHaveLength(6);
      expect(perms).toEqual(['dashboard', 'browse', 'query', 'graph', 'help', 'about']);
    });

    it('游客拥有 dashboard + browse/query/graph/help/about 六个权限', () => {
      const perms = getRolePermissions('guest');
      expect(perms).toHaveLength(6);
      expect(perms).toEqual(['dashboard', 'browse', 'query', 'graph', 'help', 'about']);
    });

    it('返回数组应为新副本，修改不影响内部映射', () => {
      const perms = getRolePermissions('admin');
      perms.push('ingest' as AuthPermission);
      const perms2 = getRolePermissions('admin');
      expect(perms2).toHaveLength(14);
    });
  });

  describe('hasPermission', () => {
    it('管理员对所有权限点返回 true', () => {
      const allPerms = listPermissions();
      for (const p of allPerms) {
        expect(hasPermission('admin', p)).toBe(true);
      }
    });

    it('普通用户对 browse/query/graph/help/about 返回 true', () => {
      expect(hasPermission('user', 'browse')).toBe(true);
      expect(hasPermission('user', 'query')).toBe(true);
      expect(hasPermission('user', 'graph')).toBe(true);
      expect(hasPermission('user', 'help')).toBe(true);
      expect(hasPermission('user', 'about')).toBe(true);
    });

    it('普通用户对 ingest/config/users 返回 false（dashboard 已开放）', () => {
      expect(hasPermission('user', 'dashboard')).toBe(true);
      expect(hasPermission('user', 'ingest')).toBe(false);
      expect(hasPermission('user', 'config')).toBe(false);
      expect(hasPermission('user', 'users')).toBe(false);
    });

    it('游客与普通用户权限一致', () => {
      const userPerms = getRolePermissions('user');
      const guestPerms = getRolePermissions('guest');
      expect(userPerms).toEqual(guestPerms);
    });
  });

  describe('hasAnyPermission (OR 关系)', () => {
    it('管理员对任一权限组合返回 true', () => {
      expect(hasAnyPermission('admin', ['dashboard', 'users'])).toBe(true);
      expect(hasAnyPermission('admin', ['ingest', 'config'])).toBe(true);
    });

    it('普通用户对包含 browse 的组合返回 true', () => {
      expect(hasAnyPermission('user', ['dashboard', 'browse'])).toBe(true);
      expect(hasAnyPermission('user', ['browse', 'query'])).toBe(true);
    });

    it('普通用户对全部无权限的组合返回 false', () => {
      // dashboard 已开放，故 [dashboard, users] 命中 dashboard 返回 true
      expect(hasAnyPermission('user', ['ingest', 'config'])).toBe(false);
      expect(hasAnyPermission('user', ['users', 'config'])).toBe(false);
    });

    it('空数组返回 false', () => {
      expect(hasAnyPermission('admin', [])).toBe(false);
      expect(hasAnyPermission('user', [])).toBe(false);
    });
  });

  describe('hasAllPermissions (AND 关系)', () => {
    it('管理员对全部权限组合返回 true', () => {
      expect(hasAllPermissions('admin', ['dashboard', 'users'])).toBe(true);
      expect(hasAllPermissions('admin', ['browse', 'query', 'graph'])).toBe(true);
    });

    it('普通用户对 browse+query+graph 返回 true', () => {
      expect(hasAllPermissions('user', ['browse', 'query', 'graph'])).toBe(true);
    });

    it('普通用户对 browse+dashboard 返回 true（dashboard 已开放）', () => {
      expect(hasAllPermissions('user', ['browse', 'dashboard'])).toBe(true);
    });

    it('空数组返回 true（全称量词的空集为真）', () => {
      expect(hasAllPermissions('user', [])).toBe(true);
    });
  });

  describe('isAdmin', () => {
    it('admin 角色返回 true', () => {
      expect(isAdmin('admin')).toBe(true);
    });

    it('user/guest 角色返回 false', () => {
      expect(isAdmin('user')).toBe(false);
      expect(isAdmin('guest')).toBe(false);
    });
  });

  describe('listRoles', () => {
    it('应返回 admin/user/guest 三个角色', () => {
      const roles = listRoles();
      expect(roles).toHaveLength(3);
      expect(roles).toContain('admin');
      expect(roles).toContain('user');
      expect(roles).toContain('guest');
    });
  });

  describe('listPermissions', () => {
    it('应返回全部 13 个权限点', () => {
      const perms = listPermissions();
      expect(perms).toHaveLength(14);
      expect(perms).toContain('dashboard');
      expect(perms).toContain('users');
    });
  });

  describe('getRolePermissionMatrix', () => {
    it('应返回三个角色的权限矩阵', () => {
      const matrix = getRolePermissionMatrix();
      expect(Object.keys(matrix)).toHaveLength(3);
      expect(matrix.admin).toHaveLength(14);
      expect(matrix.user).toHaveLength(6);
      expect(matrix.guest).toHaveLength(6);
    });

    it('矩阵为深拷贝，修改不影响内部映射', () => {
      const matrix = getRolePermissionMatrix();
      matrix.admin.push('ingest' as AuthPermission);
      const matrix2 = getRolePermissionMatrix();
      expect(matrix2.admin).toHaveLength(14);
    });
  });

  describe('权限边界一致性', () => {
    it('user 是 guest 的权限子集且相等', () => {
      const userPerms = getRolePermissions('user');
      const guestPerms = getRolePermissions('guest');
      expect(userPerms).toEqual(guestPerms);
    });

    it('admin 权限是所有其他角色权限的超集', () => {
      const adminPerms = getRolePermissions('admin');
      const userPerms = getRolePermissions('user');
      const guestPerms = getRolePermissions('guest');
      for (const p of userPerms) {
        expect(adminPerms).toContain(p);
      }
      for (const p of guestPerms) {
        expect(adminPerms).toContain(p);
      }
    });

    it('所有角色均包含 help 与 about（辅助页公共可见）', () => {
      const roles: AuthRole[] = ['admin', 'user', 'guest'];
      for (const r of roles) {
        expect(hasPermission(r, 'help')).toBe(true);
        expect(hasPermission(r, 'about')).toBe(true);
      }
    });
  });
});

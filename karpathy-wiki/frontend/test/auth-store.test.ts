import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '../src/stores/auth';
import type { UserInfo, LoginResponse } from '../src/types';

// auth store 测试
// 覆盖点：登录、登出、会话恢复、权限判断、用户管理方法、401 自动登出、isGuest 兜底

// 构造模拟用户信息
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
      : ['browse', 'query', 'graph', 'help', 'about'],
  };
}

// 构造模拟 fetch 响应
function makeResponse(body: unknown, ok: boolean = true, status: number = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('auth store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('初始状态', () => {
    it('未登录时 isLoggedIn 应为 false', () => {
      const store = useAuthStore();
      // localStorage 为空，token 应为 null
      expect(store.isLoggedIn).toBe(false);
      expect(store.user).toBeNull();
      expect(store.role).toBeNull();
      expect(store.permissions).toEqual([]);
    });

    it('未登录时 isGuest 应为 true', () => {
      const store = useAuthStore();
      expect(store.isGuest).toBe(true);
    });

    it('未登录时 isAdmin 应为 false', () => {
      const store = useAuthStore();
      expect(store.isAdmin).toBe(false);
    });
  });

  describe('login', () => {
    it('登录成功应设置 token + user', async () => {
      const store = useAuthStore();
      const mockUser = makeUser('admin');
      const mockRes: LoginResponse = {
        ok: true,
        token: 'test-token',
        user: mockUser,
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse(mockRes));
      const ok = await store.login({ username: 'admin', password: 'admin123' });
      expect(ok).toBe(true);
      expect(store.token).toBe('test-token');
      expect(store.user).toEqual(mockUser);
      expect(store.isLoggedIn).toBe(true);
      // 验证 saveToken 用正确的 key 写入 localStorage
      expect(localStorage.getItem('authToken')).toBe('test-token');
    });

    it('登录失败应设置 error 并返回 false', async () => {
      const store = useAuthStore();
      const mockRes: LoginResponse = {
        ok: false,
        message: '用户名或密码错误',
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse(mockRes, false, 401));
      const ok = await store.login({ username: 'admin', password: 'wrong' });
      expect(ok).toBe(false);
      expect(store.error).toBe('用户名或密码错误');
      expect(store.token).toBeNull();
      expect(store.isLoggedIn).toBe(false);
    });

    it('登录响应缺少 token 或 user 应失败', async () => {
      const store = useAuthStore();
      const mockRes = { ok: true } as LoginResponse;
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse(mockRes));
      const ok = await store.login({ username: 'x', password: 'y' });
      expect(ok).toBe(false);
      expect(store.error).toContain('缺少');
    });

    it('网络错误应捕获并设置 error', async () => {
      const store = useAuthStore();
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));
      const ok = await store.login({ username: 'x', password: 'y' });
      expect(ok).toBe(false);
      expect(store.error).toBe('Network error');
    });

    it('登录成功后 isAdmin 应为 true（admin 角色）', async () => {
      const store = useAuthStore();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeResponse({ ok: true, token: 't', user: makeUser('admin') }),
      );
      await store.login({ username: 'admin', password: 'p' });
      expect(store.isAdmin).toBe(true);
      expect(store.isGuest).toBe(false);
    });

    it('登录成功后 isGuest 应为 true（guest 角色）', async () => {
      const store = useAuthStore();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeResponse({ ok: true, token: 't', user: makeUser('guest') }),
      );
      await store.login({ username: 'guest', password: 'p' });
      expect(store.isGuest).toBe(true);
      expect(store.isAdmin).toBe(false);
    });
  });

  describe('logout', () => {
    it('登出应清除 token 与 user', async () => {
      const store = useAuthStore();
      // 先登录
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeResponse({ ok: true, token: 't', user: makeUser('admin') }),
      );
      await store.login({ username: 'admin', password: 'p' });
      expect(store.isLoggedIn).toBe(true);
      // 登出
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({ ok: true }));
      await store.logout();
      expect(store.token).toBeNull();
      expect(store.user).toBeNull();
      expect(store.isLoggedIn).toBe(false);
      expect(localStorage.getItem('authToken')).toBeNull();
    });

    it('登出时后端不可用也清除本地状态', async () => {
      const store = useAuthStore();
      store.token = 't';
      store.user = makeUser('user');
      localStorage.setItem('authToken', 't');
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network'));
      await store.logout();
      expect(store.token).toBeNull();
      expect(store.user).toBeNull();
    });

    it('无 token 时登出直接清除本地状态', async () => {
      const store = useAuthStore();
      await store.logout();
      expect(store.token).toBeNull();
    });
  });

  describe('restoreSession', () => {
    it('无 token 时返回 false 并标记 initialized', async () => {
      const store = useAuthStore();
      const ok = await store.restoreSession();
      expect(ok).toBe(false);
      expect(store.initialized).toBe(true);
    });

    it('有 token 且后端验证成功应恢复用户', async () => {
      const store = useAuthStore();
      store.token = 'valid-token';
      localStorage.setItem('authToken', 'valid-token');
      const mockUser = makeUser('admin');
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse(mockUser));
      const ok = await store.restoreSession();
      expect(ok).toBe(true);
      expect(store.user).toEqual(mockUser);
      expect(store.isLoggedIn).toBe(true);
    });

    it('后端返回 401 应清除 token 并返回 false', async () => {
      const store = useAuthStore();
      store.token = 'expired';
      localStorage.setItem('authToken', 'expired');
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({ error: 'expired' }, false, 401));
      const ok = await store.restoreSession();
      expect(ok).toBe(false);
      expect(store.token).toBeNull();
      expect(store.user).toBeNull();
    });

    it('网络错误应保持登录状态（等待重试）', async () => {
      const store = useAuthStore();
      store.token = 't';
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network'));
      const ok = await store.restoreSession();
      expect(ok).toBe(false);
      // token 应保留（等待网络恢复后重试）
      expect(store.token).toBe('t');
    });
  });

  describe('authFetch', () => {
    it('应注入 Authorization 头', async () => {
      const store = useAuthStore();
      store.token = 'my-token';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({}));
      await store.authFetch('/api/test');
      const callArgs = fetchSpy.mock.calls[0];
      const headers = callArgs[1].headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer my-token');
    });

    it('无 token 时不注入 Authorization', async () => {
      const store = useAuthStore();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({}));
      await store.authFetch('/api/test');
      const callArgs = fetchSpy.mock.calls[0];
      const headers = callArgs[1].headers as Headers;
      expect(headers.get('Authorization')).toBeNull();
    });

    it('POST 请求应自动设置 Content-Type', async () => {
      const store = useAuthStore();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({}));
      await store.authFetch('/api/test', { method: 'POST', body: '{}' });
      const callArgs = fetchSpy.mock.calls[0];
      const headers = callArgs[1].headers as Headers;
      expect(headers.get('Content-Type')).toBe('application/json');
    });

    it('401 响应应自动登出', async () => {
      const store = useAuthStore();
      store.token = 'expired';
      store.user = makeUser('admin');
      localStorage.setItem('authToken', 'expired');
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeResponse({}, false, 401));
      await store.authFetch('/api/test');
      expect(store.token).toBeNull();
      expect(store.user).toBeNull();
    });
  });

  describe('权限判断', () => {
    it('hasPermission 应基于 permissions 列表判断', () => {
      const store = useAuthStore();
      store.user = makeUser('admin');
      expect(store.hasPermission('dashboard')).toBe(true);
      expect(store.hasPermission('users')).toBe(true);
    });

    it('普通用户 hasPermission dashboard 应为 false', () => {
      const store = useAuthStore();
      store.user = makeUser('user');
      expect(store.hasPermission('dashboard')).toBe(false);
      expect(store.hasPermission('browse')).toBe(true);
    });

    it('hasAnyPermission (OR) 任一匹配返回 true', () => {
      const store = useAuthStore();
      store.user = makeUser('user');
      expect(store.hasAnyPermission(['browse', 'dashboard'])).toBe(true);
      expect(store.hasAnyPermission(['dashboard', 'users'])).toBe(false);
    });

    it('hasAllPermissions (AND) 全部匹配返回 true', () => {
      const store = useAuthStore();
      store.user = makeUser('user');
      expect(store.hasAllPermissions(['browse', 'query'])).toBe(true);
      expect(store.hasAllPermissions(['browse', 'dashboard'])).toBe(false);
    });
  });

  describe('用户管理方法（仅管理员）', () => {
    it('非管理员调用 listUsers 返回 null', async () => {
      const store = useAuthStore();
      store.user = makeUser('user');
      const result = await store.listUsers();
      expect(result).toBeNull();
    });

    it('管理员调用 listUsers 应返回用户列表', async () => {
      const store = useAuthStore();
      store.user = makeUser('admin');
      store.token = 't';
      const mockUsers = [makeUser('admin'), makeUser('user')];
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeResponse({ users: mockUsers }),
      );
      const result = await store.listUsers();
      expect(result).toEqual(mockUsers);
    });

    it('非管理员调用 createUser 返回 null', async () => {
      const store = useAuthStore();
      store.user = makeUser('user');
      const result = await store.createUser({ username: 'x', password: 'y', role: 'user' });
      expect(result).toBeNull();
    });

    it('管理员调用 createUser 应发起 POST 请求', async () => {
      const store = useAuthStore();
      store.user = makeUser('admin');
      store.token = 't';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeResponse(makeUser('user')),
      );
      await store.createUser({ username: 'new', password: 'pwd', role: 'user' });
      expect(fetchSpy).toHaveBeenCalled();
      const callArgs = fetchSpy.mock.calls[0];
      expect(callArgs[1].method).toBe('POST');
    });

    it('非管理员调用 deleteUser 返回 false', async () => {
      const store = useAuthStore();
      store.user = makeUser('user');
      const result = await store.deleteUser('uid');
      expect(result).toBe(false);
    });
  });

  describe('clearAuth', () => {
    it('应清除所有认证状态', () => {
      const store = useAuthStore();
      store.token = 't';
      store.user = makeUser('admin');
      localStorage.setItem('authToken', 't');
      store.clearAuth();
      expect(store.token).toBeNull();
      expect(store.user).toBeNull();
      expect(localStorage.getItem('authToken')).toBeNull();
    });
  });
});

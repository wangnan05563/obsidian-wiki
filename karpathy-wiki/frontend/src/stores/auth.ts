import { API_BASE } from '../utils/apiBase';
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { UserInfo, LoginRequest, LoginResponse, RegisterRequest, CreateUserRequest, UpdateUserRequest, AuthPermission, AuthRole } from '../types';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { unlock as unlockVault, lock as lockVault, restoreKeyFromSession } from '../services/localVault';

// 认证状态管理 store
// 职责：
//   1. 维护当前登录用户（token + 用户信息）
//   2. 提供 fetch 拦截器注入 Authorization 头
//   3. 提供权限判断辅助方法
//   4. 处理登录/登出/会话恢复
//
// token 存储策略：localStorage 持久化（支持刷新页面后保持登录）
// 用户信息存储策略：内存（不持久化，刷新后从后端 /api/auth/me 恢复）
// 为什么用户信息不持久化：避免角色变更后前端仍显示旧角色（后端是唯一权威源）

// ===== 持久化辅助 =====
// 为什么放在模块顶层：这两个函数不依赖 store 内部状态，仅操作 localStorage，属于纯工具函数
// 提升到外层避免每次 setup store 实例化时重复创建函数对象（S7721）

function loadTokenFromStorage(): string | null {
  try { return localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN); }
  catch { return null; }
}

function saveToken(t: string | null): void {
  try {
    if (t) {
      localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, t);
    } else {
      localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
    }
  } catch {
    // localStorage 不可用时降级为内存存储
  }
}

export const useAuthStore = defineStore('auth', () => {
  // token：localStorage 持久化，刷新后保留登录状态
  const token = ref<string | null>(loadTokenFromStorage());
  // 用户信息：内存，每次启动从后端恢复
  const user = ref<UserInfo | null>(null);
  // 加载状态：用于路由守卫判断是否已恢复会话
  const initialized = ref(false);
  // 错误信息：登录失败时展示
  const error = ref('');

  // ===== 计算属性 =====

  // 是否已登录
  const isLoggedIn = computed(() => !!token.value && !!user.value);

  // 当前用户角色（未登录返回 null）
  const role = computed<AuthRole | null>(() => user.value?.role ?? null);

  // 当前用户权限列表（未登录返回空数组）
  const permissions = computed<AuthPermission[]>(() => user.value?.permissions ?? []);

  // 是否为管理员
  const isAdmin = computed(() => role.value === 'admin');

  // 是否为游客（未登录或角色为 guest）
  // 为什么未登录也算游客：游客角色允许浏览公开页面
  const isGuest = computed(() => role.value === 'guest' || !isLoggedIn.value);

  // ===== 通用 fetch 包装：自动注入 Authorization 头 =====

  // 所有需要认证的请求都应通过此函数调用
  // 为什么单独导出：路由层和组件层都需要用，避免重复实现
  async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (token.value) {
      headers.set('Authorization', `Bearer ${token.value}`);
    }
    // 默认 Content-Type: application/json（POST/PUT 场景）
    if (!headers.has('Content-Type') && init.body) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(input, { ...init, headers });

    // 401 自动登出：token 失效或被撤销
    if (response.status === 401 && token.value) {
      console.warn('[auth] 会话已失效，自动登出');
      clearAuth();
    }
    return response;
  }

  // ===== 操作方法 =====

  // 登录
  async function login(params: LoginRequest): Promise<boolean> {
    error.value = '';
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json() as LoginResponse;
      if (!res.ok || !data.ok) {
        error.value = data.message ?? `登录失败（HTTP ${res.status}）`;
        return false;
      }
      if (data.token && data.user) {
        token.value = data.token;
        user.value = data.user;
        saveToken(data.token);
        // FR-RM-07：用登录密码派生本地加密密钥（失败不影响登录，仅本地加密不可用）
        try {
          await unlockVault(params.password);
        } catch {
          // 忽略
        }
        return true;
      }
      error.value = '登录响应缺少 token 或用户信息';
      return false;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  // 自助注册（公开接口，无需 token）
  // 成功后自动登录（后端返回 token + user），与 login 行为一致
  async function register(params: RegisterRequest): Promise<boolean> {
    error.value = '';
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json() as LoginResponse & { error?: string };
      if (!res.ok || !data.ok) {
        error.value = data.error ?? `注册失败（HTTP ${res.status}）`;
        return false;
      }
      if (data.token && data.user) {
        token.value = data.token;
        user.value = data.user;
        saveToken(data.token);
        // FR-RM-07：用注册密码派生本地加密密钥
        try {
          await unlockVault(params.password);
        } catch {
          // 忽略
        }
        return true;
      }
      error.value = '注册响应缺少 token 或用户信息';
      return false;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  // 登出
  async function logout(): Promise<void> {
    if (!token.value) {
      clearAuth();
      return;
    }
    try {
      await authFetch(`${API_BASE}/auth/logout`, { method: 'POST' });
    } catch {
      // 后端不可用也清除本地状态
    } finally {
      clearAuth();
      // FR-RM-07：清除内存 / sessionStorage 中的本地加密密钥
      lockVault();
    }
  }

  // 清除本地认证状态（登出或会话失效）
  function clearAuth(): void {
    token.value = null;
    user.value = null;
    saveToken(null);
  }

  // 恢复会话：从 localStorage 读取 token，向后端验证并恢复用户信息
  // 为什么需要：刷新页面后 Pinia state 丢失，需从后端恢复
  async function restoreSession(): Promise<boolean> {
    // 同标签页刷新：尝试从 sessionStorage 恢复本地加密密钥（否则关闭标签页后需重新登录解锁）
    try {
      await restoreKeyFromSession();
    } catch {
      // 忽略
    }
    if (!token.value) {
      initialized.value = true;
      return false;
    }
    try {
      const res = await authFetch(`${API_BASE}/auth/me`);
      if (!res.ok) {
        // token 失效
        clearAuth();
        initialized.value = true;
        return false;
      }
      user.value = await res.json() as UserInfo;
      initialized.value = true;
      return true;
    } catch {
      // 网络错误：保持登录状态，等待网络恢复后重试
      initialized.value = true;
      return false;
    }
  }

  // ===== 权限判断方法 =====

  // 检查当前用户是否拥有指定权限
  function hasPermission(permission: AuthPermission): boolean {
    return permissions.value.includes(permission);
  }

  // 检查当前用户是否拥有任一权限（OR 关系）
  function hasAnyPermission(perms: AuthPermission[]): boolean {
    return perms.some((p) => hasPermission(p));
  }

  // 检查当前用户是否拥有全部权限（AND 关系）
  function hasAllPermissions(perms: AuthPermission[]): boolean {
    return perms.every((p) => hasPermission(p));
  }

  // ===== 用户管理方法（仅管理员可用）=====

  // 获取用户列表
  async function listUsers(): Promise<UserInfo[] | null> {
    if (!isAdmin.value) return null;
    const res = await authFetch(`${API_BASE}/auth/users`);
    if (!res.ok) return null;
    const data = await res.json() as { users: UserInfo[] };
    return data.users;
  }

  // 创建用户
  async function createUser(params: CreateUserRequest): Promise<UserInfo | null> {
    if (!isAdmin.value) return null;
    const res = await authFetch(`${API_BASE}/auth/users`, {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (!res.ok) return null;
    return await res.json() as UserInfo;
  }

  // 更新用户
  async function updateUser(id: string, params: UpdateUserRequest): Promise<UserInfo | null> {
    if (!isAdmin.value) return null;
    const res = await authFetch(`${API_BASE}/auth/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(params),
    });
    if (!res.ok) return null;
    return await res.json() as UserInfo;
  }

  // 删除用户
  async function deleteUser(id: string): Promise<boolean> {
    if (!isAdmin.value) return false;
    const res = await authFetch(`${API_BASE}/auth/users/${id}`, { method: 'DELETE' });
    return res.ok;
  }

  return {
    // 状态
    token,
    user,
    initialized,
    error,
    // 计算属性
    isLoggedIn,
    role,
    permissions,
    isAdmin,
    isGuest,
    // 通用方法
    authFetch,
    // 认证方法
    login,
    register,
    logout,
    restoreSession,
    clearAuth,
    // 权限判断
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    // 用户管理
    listUsers,
    createUser,
    updateUser,
    deleteUser,
  };
});

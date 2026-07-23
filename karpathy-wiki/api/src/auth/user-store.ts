import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { UserRecord, AuthRole } from './types.js';
import { generateSalt, hashPassword } from './password.js';

// 用户存储模块
// 持久化到 JSON 文件（默认 data/users.json）
// 为什么用 JSON 文件：本地优先应用，无 DB 依赖；用户数通常 < 100，JSON 性能足够

// 内存缓存：避免每次操作都读文件
let usersCache: UserRecord[] | null = null;
let usersFilePath: string | null = null;
let pbkdf2Iterations = 100000;

// 默认用户列表（首次启动时自动创建）
// 为什么明文默认密码：首次启动后必须立即修改；console 提示用户
const DEFAULT_USERS = [
  { username: 'admin', password: 'admin123', role: 'admin' as AuthRole },
  { username: 'user', password: 'user123', role: 'user' as AuthRole },
  { username: 'guest', password: 'guest123', role: 'guest' as AuthRole },
];

// 初始化用户存储
// 首次启动时文件不存在 → 创建默认用户 → 写入文件
export async function initUserStore(filePath: string, iterations: number): Promise<void> {
  usersFilePath = filePath;
  pbkdf2Iterations = iterations;

  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // 目录已存在
  }

  // 文件存在 → 加载；文件不存在 → 创建默认用户
  if (fsSync.existsSync(filePath)) {
    await loadUsers();
  } else {
    console.log('[auth] 用户存储文件不存在，创建默认用户...');
    const defaultUsers = await createDefaultUsers();
    await saveUsers(defaultUsers);
    console.warn('[auth] 默认用户已创建，请立即修改密码：');
    console.warn('  admin/admin123 (管理员)');
    console.warn('  user/user123 (普通用户)');
    console.warn('  guest/guest123 (游客)');
  }
}

// 创建默认用户列表（带 PBKDF2 哈希）
async function createDefaultUsers(): Promise<UserRecord[]> {
  const now = new Date().toISOString();
  return Promise.all(
    DEFAULT_USERS.map(async (u) => {
      const salt = generateSalt();
      const passwordHash = hashPassword(u.password, salt, pbkdf2Iterations);
      return {
        id: crypto.randomUUID(),
        username: u.username,
        passwordHash,
        salt,
        role: u.role,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      } satisfies UserRecord;
    }),
  );
}

// 从文件加载用户列表（带缓存）
export async function loadUsers(): Promise<UserRecord[]> {
  if (!usersFilePath) throw new Error('userStore 未初始化，请先调用 initUserStore');
  // 已有缓存直接返回
  if (usersCache) return usersCache;

  try {
    const raw = await fs.readFile(usersFilePath, 'utf8');
    const parsed = JSON.parse(raw) as { users?: UserRecord[] };
    usersCache = parsed.users ?? [];
    return usersCache;
  } catch {
    // 文件损坏或解析失败 → 空列表（避免阻断启动）
    usersCache = [];
    return usersCache;
  }
}

// 保存用户列表到文件（同步刷新缓存）
// 为什么同步刷新缓存：写盘后立即更新内存，避免后续读到旧值（写后即刷原则）
async function saveUsers(users: UserRecord[]): Promise<void> {
  if (!usersFilePath) throw new Error('userStore 未初始化');
  const data = JSON.stringify({ users }, null, 2);
  await fs.writeFile(usersFilePath, data, 'utf8');
  // 写盘后刷新缓存
  usersCache = users;
}

// 根据用户名查找用户（用于登录验证）
export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  const users = await loadUsers();
  return users.find((u) => u.username === username) ?? null;
}

// 根据用户 ID 查找用户
export async function findUserById(id: string): Promise<UserRecord | null> {
  const users = await loadUsers();
  return users.find((u) => u.id === id) ?? null;
}

// 列出所有用户（脱敏后，用于管理员查看）
export async function listUsers(): Promise<UserRecord[]> {
  return loadUsers();
}

// 创建新用户
export async function createUser(params: {
  username: string;
  password: string;
  role: AuthRole;
}): Promise<UserRecord> {
  const users = await loadUsers();
  // 用户名唯一性校验
  if (users.some((u) => u.username === params.username)) {
    throw new Error(`用户名已存在: ${params.username}`);
  }
  const now = new Date().toISOString();
  const salt = generateSalt();
  const passwordHash = hashPassword(params.password, salt, pbkdf2Iterations);
  const newUser: UserRecord = {
    id: crypto.randomUUID(),
    username: params.username,
    passwordHash,
    salt,
    role: params.role,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  users.push(newUser);
  await saveUsers(users);
  return newUser;
}

// 更新用户（部分更新，空字段不修改）
export async function updateUser(
  id: string,
  updates: {
    username?: string;
    password?: string;
    role?: AuthRole;
    enabled?: boolean;
  },
): Promise<UserRecord> {
  const users = await loadUsers();
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error(`用户不存在: ${id}`);

  // 用户名唯一性校验（如果修改了用户名）
  if (updates.username && updates.username !== user.username) {
    if (users.some((u) => u.username === updates.username)) {
      throw new Error(`用户名已存在: ${updates.username}`);
    }
    user.username = updates.username;
  }

  // 修改密码时重新生成盐并哈希
  if (updates.password) {
    user.salt = generateSalt();
    user.passwordHash = hashPassword(updates.password, user.salt, pbkdf2Iterations);
  }

  if (updates.role) user.role = updates.role;
  if (updates.enabled !== undefined) user.enabled = updates.enabled;

  user.updatedAt = new Date().toISOString();
  await saveUsers(users);
  return user;
}

// 删除用户
// 为什么禁止删除最后一个管理员：避免系统失去管理员导致无法管理
export async function deleteUser(id: string): Promise<void> {
  const users = await loadUsers();
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error(`用户不存在: ${id}`);

  if (user.role === 'admin') {
    const adminCount = users.filter((u) => u.role === 'admin').length;
    if (adminCount <= 1) {
      throw new Error('系统至少保留一个管理员账户，无法删除');
    }
  }

  const filtered = users.filter((u) => u.id !== id);
  await saveUsers(filtered);
}

// 更新最后登录时间
export async function updateLastLogin(id: string): Promise<void> {
  const users = await loadUsers();
  const user = users.find((u) => u.id === id);
  if (!user) return;
  user.lastLoginAt = new Date().toISOString();
  await saveUsers(users);
}

// 重置模块状态（测试用）
export function resetUserStore(): void {
  usersCache = null;
  usersFilePath = null;
  pbkdf2Iterations = 100000;
}

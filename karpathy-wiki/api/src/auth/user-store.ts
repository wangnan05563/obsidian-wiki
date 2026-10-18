import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { UserRecord, AuthRole } from './types.js';
import { generateSalt, hashPassword, verifyPassword } from './password.js';

// 用户存储模块
// 持久化到 JSON 文件（默认 data/users.json）
// 为什么用 JSON 文件：本地优先应用，无 DB 依赖；用户数通常 < 100，JSON 性能足够

// 内存缓存：避免每次操作都读文件
let usersCache: UserRecord[] | null = null;
let usersFilePath: string | null = null;
let pbkdf2Iterations = 100000;
// 标记磁盘用户文件是否已损坏（解析失败）。损坏时 saveUsers 拒绝覆盖原文件，防数据丢失（评审 S5）
let usersFileCorrupt = false;

// 默认用户列表（首次启动时自动创建）
// 为什么明文默认密码：首次启动后必须立即修改；console 提示用户
// T02453（PRD A1）种子加固：guest 种子默认停用（enabled:false）；admin/user 种子带
// mustChangePassword 标记（生产首登强制改密，localOnly 开发模式在登录响应层放行）。
const DEFAULT_USERS: Array<{ username: string; password: string; role: AuthRole; enabled?: boolean; mustChangePassword?: boolean }> = [
  { username: 'admin', password: 'admin123', role: 'admin', mustChangePassword: true },
  { username: 'user', password: 'user123', role: 'user', mustChangePassword: true },
  { username: 'guest', password: 'guest123', role: 'guest', enabled: false, mustChangePassword: true },
];

// 种子用户名 → 默认口令映射（迁移时判定「仍在使用默认口令」用）
const DEFAULT_PASSWORDS: Record<string, string> = {
  admin: 'admin123',
  user: 'user123',
  guest: 'guest123',
};

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
    // T02453（PRD A1）存量迁移：老 users.json 里的种子账号若仍用默认口令，一次性加固
    // （guest 停用 / admin+user 打首登改密标记）；已改过口令的账户不受影响。幂等可重跑。
    try {
      if (await hardenSeedUsers()) {
        await saveUsers(usersCache ?? []);
        console.warn('[auth] 已对仍使用默认口令的种子账号执行安全加固（guest 停用 / 首登改密标记）');
      }
    } catch (err) {
      console.warn('[auth] 种子账号加固失败（不影响启动）：', err instanceof Error ? err.message : String(err));
    }
  } else {
    console.log('[auth] 用户存储文件不存在，创建默认用户...');
    const defaultUsers = await createDefaultUsers();
    // 默认用户创建属非关键初始化：写盘失败（只读/沙箱写保护）仅告警、不阻断启动；
    // 内存缓存已在 saveUsers 内先行刷新，本次会话仍可正常鉴权（评审 S2）。
    try {
      await saveUsers(defaultUsers);
    } catch (err) {
      console.warn('[auth] 默认用户写盘失败（服务仍可启动，但默认账户未持久化，请检查 data 目录写权限）：', err instanceof Error ? err.message : String(err));
    }
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
      const passwordHash = await hashPassword(u.password, salt, pbkdf2Iterations);
      return {
        id: crypto.randomUUID(),
        username: u.username,
        passwordHash,
        salt,
        role: u.role,
        enabled: u.enabled ?? true,
        mustChangePassword: u.mustChangePassword,
        createdAt: now,
        updatedAt: now,
      } satisfies UserRecord;
    }),
  );
}

// T02453（PRD A1）存量种子账号加固：对「种子用户名 + 仍匹配默认口令」的账户执行
//   guest → enabled:false（停用）；admin/user → mustChangePassword:true（首登强制改密）。
// 已修改过口令的账户与普通注册账户完全不受影响。返回是否有改动（供调用方决定是否写盘）。
export async function hardenSeedUsers(): Promise<boolean> {
  const users = await loadUsers();
  let changed = false;
  for (const user of users) {
    const defaultPassword = DEFAULT_PASSWORDS[user.username];
    if (!defaultPassword) continue;
    let stillDefault = false;
    try {
      stillDefault = await verifyPassword(defaultPassword, user.salt, user.passwordHash, pbkdf2Iterations);
    } catch {
      continue; // 哈希异常时保守跳过，不误伤
    }
    if (!stillDefault) continue;
    if (user.username === 'guest' && user.enabled !== false) {
      user.enabled = false;
      changed = true;
    }
    if (user.mustChangePassword !== true) {
      user.mustChangePassword = true;
      changed = true;
    }
  }
  return changed;
}

// 从文件加载用户列表（带缓存）
export async function loadUsers(): Promise<UserRecord[]> {
  if (!usersFilePath) throw new Error('userStore 未初始化，请先调用 initUserStore');
  // 已有缓存直接返回
  if (usersCache) return usersCache;

  let raw: string;
  try {
    raw = await fs.readFile(usersFilePath, 'utf8');
  } catch (err) {
    // 文件不存在：正常初始化路径（首次启动），返回空列表由调用方创建默认用户
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      usersCache = [];
      return usersCache;
    }
    // 其他读取错误（权限等）按损坏处理，标记后拒绝后续写盘覆盖（评审 S5）
    usersFileCorrupt = true;
    console.error('[auth] 用户数据文件读取失败，疑似损坏，将以空列表运行且拒绝写盘以免覆盖原文件：', (err as Error).message);
    usersCache = [];
    return usersCache;
  }

  try {
    const parsed = JSON.parse(raw) as { users?: UserRecord[] };
    usersFileCorrupt = false;
    usersCache = parsed.users ?? [];
    return usersCache;
  } catch (err) {
    // JSON 解析失败：文件损坏。告警并标记，拒绝后续写盘覆盖（评审 S5）
    usersFileCorrupt = true;
    console.error('[auth] 用户数据文件损坏（JSON 解析失败），将以空列表运行且拒绝写盘以免覆盖原文件：', (err as Error).message);
    usersCache = [];
    return usersCache;
  }
}

// 保存用户列表到文件（写后即刷缓存）
// 写后即刷原则：先刷新内存缓存，保证本次会话内用户状态正确（即便后续写盘失败）。
// 错误处理（评审 S2）：写盘失败改为上抛，而非静默吞掉——
//   - 关键写（注册/改密/删户）由调用方透传错误 → 路由层返回 500，避免"操作成功但数据未持久化"的静默丢失。
//   - 非关键写（updateLastLogin 的 lastLoginAt）调用方已自行 try/catch，不会阻断登录。
//   - initUserStore 的默认用户创建也自行 try/catch，不会阻断启动。
// 文件损坏保护（评审 S5）：已标记损坏时拒绝写盘，避免用空列表覆盖可能仍可手工修复的原文件。
async function saveUsers(users: UserRecord[]): Promise<void> {
  if (!usersFilePath) throw new Error('userStore 未初始化');
  // 写后即刷：先刷新内存，保证本次会话内用户状态正确
  usersCache = users;
  if (usersFileCorrupt) {
    console.error('[auth] 用户数据文件已标记损坏，拒绝写盘覆盖原文件（请先手动修复 data/users.json）');
    throw new Error('用户数据文件损坏，写盘被拒绝（请手动修复 data/users.json）');
  }
  const data = JSON.stringify({ users }, null, 2);
  // 写盘失败（只读文件系统 / 沙箱写保护 / 磁盘满）：上抛由调用方决定如何暴露（评审 S2）
  await fs.writeFile(usersFilePath, data, 'utf8');
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

// 列出所有用户（完整记录，含密码哈希）
// 为什么不在 user-store 层脱敏：routes/auth.ts 的 GET /api/auth/users 已做脱敏，
//   在 store 层再脱敏会导致返回类型与 UserRecord[] 不匹配（缺 passwordHash/salt），
//   且重复脱敏增加维护成本。store 层保持原始数据，脱敏由调用方决定
export async function listUsers(): Promise<UserRecord[]> {
  return await loadUsers();
}

// 新密码格式校验（同步，不访问存储）——T02453 改密端点与注册共用同一份规则
export function validateNewPassword(password?: unknown, confirmPassword?: unknown): { ok: true } | { ok: false; error: string; status: number } {
  const pwd = typeof password === 'string' ? password : '';
  const confirm = typeof confirmPassword === 'string' ? confirmPassword : '';
  // 长度 8-64（简易机制的安全底线，与注册口径一致）
  if (pwd.length < 8 || pwd.length > 64) {
    return { ok: false, error: '密码长度须为 8-64 位', status: 400 };
  }
  // 确认密码（若提供）须一致
  if (confirm && pwd !== confirm) {
    return { ok: false, error: '两次输入的密码不一致', status: 400 };
  }
  return { ok: true };
}

// 自助注册输入校验（同步，不访问存储）
// 仅校验格式 / 长度 / 一致性；用户名唯一性由调用方异步查库（findUserByUsername）
// 为什么要单独导出：注册路由与单元测试都复用同一份校验规则，避免漂移
export function validateRegistrationInput(params: {
  username?: unknown;
  password?: unknown;
  confirmPassword?: unknown;
}): { ok: true } | { ok: false; error: string; status: number } {
  const username = typeof params.username === 'string' ? params.username : '';

  if (!username) {
    return { ok: false, error: '用户名和密码不能为空', status: 400 };
  }
  // 用户名：3-32 位字母、数字、下划线
  if (!/^\w{3,32}$/.test(username)) {
    return { ok: false, error: '用户名须为 3-32 位字母、数字或下划线', status: 400 };
  }
  // 密码规则统一走 validateNewPassword（T02453 提取，注册/改密同源）
  return validateNewPassword(params.password, params.confirmPassword);
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
  const passwordHash = await hashPassword(params.password, salt, pbkdf2Iterations);
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
    mustChangePassword?: boolean;
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
    user.passwordHash = await hashPassword(updates.password, user.salt, pbkdf2Iterations);
  }

  if (updates.role) user.role = updates.role;
  if (updates.enabled !== undefined) user.enabled = updates.enabled;
  if (updates.mustChangePassword !== undefined) user.mustChangePassword = updates.mustChangePassword;

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
// 为什么吞掉写盘异常：lastLoginAt 是非关键字段，不应因磁盘写失败（只读文件系统 / 沙箱写保护 /
//   磁盘满）而导致登录或注册整体失败；内存缓存中的用户对象已被就地更新（与缓存数组同引用），
//   因此即使写盘失败，本次会话返回的最后登录时间仍正确。
export async function updateLastLogin(id: string): Promise<void> {
  const users = await loadUsers();
  const user = users.find((u) => u.id === id);
  if (!user) return;
  user.lastLoginAt = new Date().toISOString();
  try {
    await saveUsers(users);
  } catch (err) {
    console.warn('[auth] 更新最后登录时间写盘失败（不影响登录）：', err instanceof Error ? err.message : String(err));
  }
}

// 重置模块状态（测试用）
export function resetUserStore(): void {
  usersCache = null;
  usersFilePath = null;
  pbkdf2Iterations = 100000;
  usersFileCorrupt = false;
}

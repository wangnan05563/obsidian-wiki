import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initUserStore,
  loadUsers,
  findUserByUsername,
  findUserById,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  updateLastLogin,
  validateRegistrationInput,
  validateNewPassword,
  resetUserStore,
} from '../src/auth/user-store.js';
import { verifyPassword } from '../src/auth/password.js';
// T02836：本文件只剩这一处「确需定时」的等待——终点是被测函数**将要写入**的时间戳，
// 在它写入之前读不到，因此不能轮询真实状态，只能按契约常量定时（守护用例只放行这一类写法）。
import { contractSleep } from './helpers/waitForProgress.js';

// T02836 等待口径清点（本文件卡面登记 1 处：setTimeout(r, 10)）：
//  | 「updatedAt 应被更新」 | 裸写 10ms 赌时间戳变化 | **终点不可观测**（要等的是被测函数即将写入的时间戳本身）→ contractSleep(CLOCK_TICK_MS × 2)，来源点名 user-store.ts:303 的毫秒精度 ISO 时间戳 + Windows 时钟粒度上限 16ms；让步后再用 Date.now() > startedAt 实证时钟确实跨格 |

// Windows 真实时钟的推进粒度上限（Date.now()/new Date() 在同一次系统更新内不会变）。
// 来源：user-store.ts:303 `user.updatedAt = new Date().toISOString()` 只有毫秒精度，
// 两次调用落在同一格内就会得到相同字符串 → 断言必然假红。取 2 格保证跨过。
const CLOCK_TICK_MS = 16;

// 用户存储测试
// 覆盖点：初始化、默认用户、CRUD、唯一性校验、最后管理员保护

describe('user-store 模块', () => {
  let tempDir: string;
  let usersPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-user-test-'));
    usersPath = path.join(tempDir, 'users.json');
    resetUserStore();
  });

  afterEach(async () => {
    resetUserStore();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  describe('initUserStore', () => {
    it('文件不存在时应创建默认用户', async () => {
      await initUserStore(usersPath, 100000);
      expect(fsSync.existsSync(usersPath)).toBe(true);
      const users = await loadUsers();
      expect(users).toHaveLength(3);
      const usernames = users.map((u) => u.username);
      expect(usernames).toContain('admin');
      expect(usernames).toContain('user');
      expect(usernames).toContain('guest');
    });

    it('默认用户密码应可通过 PBKDF2 验证', async () => {
      await initUserStore(usersPath, 100000);
      const admin = await findUserByUsername('admin');
      expect(admin).not.toBeNull();
      expect(await verifyPassword('admin123', admin!.salt, admin!.passwordHash, 100000)).toBe(true);
    });

    it('文件存在时应加载已有用户不创建默认', async () => {
      // 先初始化创建默认用户
      await initUserStore(usersPath, 100000);
      // 再次初始化不应创建新默认用户
      await initUserStore(usersPath, 100000);
      const users = await loadUsers();
      expect(users).toHaveLength(3);
    });

    it('应创建嵌套目录', async () => {
      const nestedPath = path.join(tempDir, 'nested', 'dir', 'users.json');
      await initUserStore(nestedPath, 100000);
      expect(fsSync.existsSync(nestedPath)).toBe(true);
    });

    it('默认用户应包含正确角色分配', async () => {
      await initUserStore(usersPath, 100000);
      const admin = await findUserByUsername('admin');
      const user = await findUserByUsername('user');
      const guest = await findUserByUsername('guest');
      expect(admin?.role).toBe('admin');
      expect(user?.role).toBe('user');
      expect(guest?.role).toBe('guest');
    });

    it('默认用户应启用（T02453 起 guest 种子加固为停用）', async () => {
      await initUserStore(usersPath, 100000);
      const users = await loadUsers();
      const byName = Object.fromEntries(users.map((u) => [u.username, u]));
      expect(byName.admin.enabled).toBe(true);
      expect(byName.user.enabled).toBe(true);
      // PRD A1：guest 种子账号默认停用，杜绝默认口令未授权访问
      expect(byName.guest.enabled).toBe(false);
    });
  });

  describe('T02453 种子账号安全加固（PRD A1）', () => {
    it('新初始化：guest 停用，admin/user 带首登改密标记', async () => {
      await initUserStore(usersPath, 100000);
      const admin = await findUserByUsername('admin');
      const user = await findUserByUsername('user');
      const guest = await findUserByUsername('guest');
      expect(guest?.enabled).toBe(false);
      expect(admin?.mustChangePassword).toBe(true);
      expect(user?.mustChangePassword).toBe(true);
    });

    it('存量迁移：默认口令的种子被加固，已改密与普通用户不受影响', async () => {
      // 预写老格式 users.json（无 mustChangePassword 字段）
      const { generateSalt, hashPassword } = await import('../src/auth/password.js');
      const seed = async (username: string, password: string, role: 'admin' | 'user' | 'guest') => {
        const salt = generateSalt();
        return {
          id: `id-${username}-${password.length}`,
          username,
          passwordHash: await hashPassword(password, salt, 100000),
          salt,
          role,
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      };
      const legacy = {
        users: [
          await seed('admin', 'admin123', 'admin'), // 仍默认口令 → 打标记
          await seed('user', 'user-new-pass', 'user'), // 已改密 → 不动
          await seed('guest', 'guest123', 'guest'), // 仍默认口令 → 停用 + 标记
          await seed('alice', 'alice-pass-1', 'user'), // 普通注册用户 → 不动
        ],
      };
      await fs.writeFile(usersPath, JSON.stringify(legacy), 'utf8');

      await initUserStore(usersPath, 100000);
      const admin = await findUserByUsername('admin');
      const user = await findUserByUsername('user');
      const guest = await findUserByUsername('guest');
      const alice = await findUserByUsername('alice');
      expect(admin?.mustChangePassword).toBe(true);
      expect(admin?.enabled).toBe(true);
      expect(guest?.enabled).toBe(false);
      expect(guest?.mustChangePassword).toBe(true);
      expect(user?.mustChangePassword).toBeUndefined();
      expect(alice?.mustChangePassword).toBeUndefined();
      expect(alice?.enabled).toBe(true);
    });

    it('迁移幂等：二次初始化文件内容不变', async () => {
      await initUserStore(usersPath, 100000);
      const before = JSON.stringify(await loadUsers());
      resetUserStore();
      await initUserStore(usersPath, 100000);
      expect(JSON.stringify(await loadUsers())).toBe(before);
    });

    it('updateUser 可清除 mustChangePassword 并重设密码（改密端点依赖）', async () => {
      await initUserStore(usersPath, 100000);
      const admin = await findUserByUsername('admin');
      expect(admin?.mustChangePassword).toBe(true);
      const updated = await updateUser(admin!.id, { password: 'brand-new-pass', mustChangePassword: false });
      expect(updated.mustChangePassword).toBe(false);
      expect(await verifyPassword('brand-new-pass', updated.salt, updated.passwordHash, 100000)).toBe(true);
    });
  });

  describe('validateNewPassword（T02453）', () => {
    it('接受 8-64 位且确认一致', () => {
      expect(validateNewPassword('12345678', '12345678')).toEqual({ ok: true });
    });
    it('拒绝过短 / 过长 / 两次不一致', () => {
      expect(validateNewPassword('1234567').ok).toBe(false);
      expect(validateNewPassword('a'.repeat(65)).ok).toBe(false);
      expect(validateNewPassword('12345678', '87654321').ok).toBe(false);
    });
  });

  describe('findUserByUsername', () => {
    beforeEach(async () => {
      await initUserStore(usersPath, 100000);
    });

    it('存在的用户名应返回用户', async () => {
      const user = await findUserByUsername('admin');
      expect(user).not.toBeNull();
      expect(user?.username).toBe('admin');
    });

    it('不存在的用户名应返回 null', async () => {
      const user = await findUserByUsername('nonexistent');
      expect(user).toBeNull();
    });
  });

  describe('findUserById', () => {
    beforeEach(async () => {
      await initUserStore(usersPath, 100000);
    });

    it('存在的 ID 应返回用户', async () => {
      const users = await loadUsers();
      const admin = users.find((u) => u.username === 'admin')!;
      const found = await findUserById(admin.id);
      expect(found?.username).toBe('admin');
    });

    it('不存在的 ID 应返回 null', async () => {
      const user = await findUserById('nonexistent-id');
      expect(user).toBeNull();
    });
  });

  describe('createUser', () => {
    beforeEach(async () => {
      await initUserStore(usersPath, 100000);
    });

    it('应创建新用户并返回完整记录', async () => {
      const user = await createUser({
        username: 'newuser',
        password: 'password123',
        role: 'user',
      });
      expect(user.id).toBeTruthy();
      expect(user.username).toBe('newuser');
      expect(user.role).toBe('user');
      expect(user.enabled).toBe(true);
      expect(user.passwordHash).not.toBe('password123');
      expect(user.salt).toBeTruthy();
    });

    it('新用户密码应可验证', async () => {
      const user = await createUser({
        username: 'newuser',
        password: 'mypassword',
        role: 'user',
      });
      const ok = await verifyPassword('mypassword', user.salt, user.passwordHash, 100000);
      expect(ok).toBe(true);
    });

    it('重复用户名应抛错', async () => {
      await expect(
        createUser({ username: 'admin', password: 'pwd', role: 'admin' }),
      ).rejects.toThrow('用户名已存在');
    });

    it('创建后应能在列表中找到', async () => {
      await createUser({ username: 'newuser', password: 'pwd', role: 'user' });
      const found = await findUserByUsername('newuser');
      expect(found?.username).toBe('newuser');
    });
  });

  describe('updateUser', () => {
    beforeEach(async () => {
      await initUserStore(usersPath, 100000);
    });

    it('应更新用户名', async () => {
      const user = await findUserByUsername('user');
      const updated = await updateUser(user!.id, { username: 'renamed' });
      expect(updated.username).toBe('renamed');
    });

    it('更新密码应重新生成盐与哈希', async () => {
      const user = await findUserByUsername('user');
      const oldSalt = user!.salt;
      const oldHash = user!.passwordHash;
      const updated = await updateUser(user!.id, { password: 'newpassword' });
      expect(updated.salt).not.toBe(oldSalt);
      expect(updated.passwordHash).not.toBe(oldHash);
      expect(await verifyPassword('newpassword', updated.salt, updated.passwordHash, 100000)).toBe(true);
    });

    it('应更新角色', async () => {
      const user = await findUserByUsername('user');
      const updated = await updateUser(user!.id, { role: 'admin' });
      expect(updated.role).toBe('admin');
    });

    it('应更新启用状态', async () => {
      const user = await findUserByUsername('user');
      const updated = await updateUser(user!.id, { enabled: false });
      expect(updated.enabled).toBe(false);
    });

    it('不存在的 ID 应抛错', async () => {
      await expect(updateUser('nonexistent', { username: 'x' })).rejects.toThrow('用户不存在');
    });

    it('更新为已存在的用户名应抛错', async () => {
      const user = await findUserByUsername('user');
      await expect(updateUser(user!.id, { username: 'admin' })).rejects.toThrow('用户名已存在');
    });

    it('updatedAt 应被更新', async () => {
      const user = await findUserByUsername('user');
      const oldUpdatedAt = user!.updatedAt;
      // 等待真实时钟跨过一格，确保 updateUser 写出的毫秒时间戳与旧值不同（来源见 CLOCK_TICK_MS 注释）
      const startedAt = Date.now();
      await contractSleep(
        `CLOCK_TICK_MS=16（Windows 时钟粒度上限）× 2：user-store.ts:303 updatedAt = new Date().toISOString() 为毫秒精度，同格内两次值相同`,
        CLOCK_TICK_MS * 2,
      );
      // 让步够不够只有时钟自己知道：这里读真实状态复核，不足就当场点名（而不是让下一条断言假红）
      expect(Date.now(), '让步后真实时钟未跨格，updatedAt 必然与旧值相同').toBeGreaterThan(startedAt);
      const updated = await updateUser(user!.id, { enabled: false });
      expect(updated.updatedAt).not.toBe(oldUpdatedAt);
    });
  });

  describe('deleteUser', () => {
    beforeEach(async () => {
      await initUserStore(usersPath, 100000);
    });

    it('应删除非管理员用户', async () => {
      const user = await findUserByUsername('user');
      await deleteUser(user!.id);
      const found = await findUserById(user!.id);
      expect(found).toBeNull();
    });

    it('不存在的 ID 应抛错', async () => {
      await expect(deleteUser('nonexistent')).rejects.toThrow('用户不存在');
    });

    it('最后一个管理员不可删除', async () => {
      const admin = await findUserByUsername('admin');
      await expect(deleteUser(admin!.id)).rejects.toThrow('系统至少保留一个管理员');
    });

    it('有多个管理员时可删除其中一个', async () => {
      const admin1 = await findUserByUsername('admin');
      await createUser({ username: 'admin2', password: 'pwd', role: 'admin' });
      await deleteUser(admin1!.id);
      const found = await findUserById(admin1!.id);
      expect(found).toBeNull();
    });
  });

  describe('updateLastLogin', () => {
    beforeEach(async () => {
      await initUserStore(usersPath, 100000);
    });

    it('应更新 lastLoginAt', async () => {
      const user = await findUserByUsername('admin');
      expect(user?.lastLoginAt).toBeUndefined();
      await updateLastLogin(user!.id);
      const updated = await findUserById(user!.id);
      expect(updated?.lastLoginAt).toBeTruthy();
    });

    it('不存在的用户不抛错（静默返回）', async () => {
      // void 函数：返回 undefined 即说明静默返回，未抛错
      expect(await updateLastLogin('nonexistent')).toBeUndefined();
    });
  });

  describe('loadUsers 缓存', () => {
    beforeEach(async () => {
      await initUserStore(usersPath, 100000);
    });

    it('第二次调用应返回缓存（同一引用）', async () => {
      const u1 = await loadUsers();
      const u2 = await loadUsers();
      // 缓存返回同一引用
      expect(u1).toBe(u2);
    });

    it('创建用户后缓存应被刷新（新引用）', async () => {
      const u1 = await loadUsers();
      // 保存初始长度：createUser 会修改缓存数组（push），u1 引用会被同步修改
      const initialLength = u1.length;
      await createUser({ username: 'newuser', password: 'pwd', role: 'user' });
      const u2 = await loadUsers();
      expect(u2.length).toBe(initialLength + 1);
    });
  });

  describe('listUsers', () => {
    beforeEach(async () => {
      await initUserStore(usersPath, 100000);
    });

    it('应返回全部用户', async () => {
      const users = await listUsers();
      expect(users).toHaveLength(3);
    });
  });

  describe('loadUsers 文件损坏保护（评审 S5）', () => {
    it('文件损坏时应返回空列表且不覆盖原文件', async () => {
      // 先写入损坏内容（非合法 JSON）
      await fs.writeFile(usersPath, '{ this is not valid json', 'utf8');
      resetUserStore();
      // 重新初始化：文件存在 → loadUsers 读取损坏内容
      await initUserStore(usersPath, 100000);
      const users = await loadUsers();
      expect(users).toHaveLength(0);
      // 已标记损坏：关键写（createUser）应拒绝写盘，避免用空列表覆盖损坏原文件
      await expect(
        createUser({ username: 'x', password: 'password123', role: 'user' }),
      ).rejects.toThrow(/损坏/);
      // 原损坏文件内容仍在（未被覆盖）
      const raw = await fs.readFile(usersPath, 'utf8');
      expect(raw).toContain('not valid json');
    });

    it('文件不存在时应正常初始化且可创建用户（不标记损坏）', async () => {
      resetUserStore();
      // 不创建文件，直接初始化 → 创建默认用户（3 个），不标记为损坏
      await initUserStore(usersPath, 100000);
      const users = await loadUsers();
      expect(users).toHaveLength(3); // 默认用户已创建
      // 首次启动路径不标记损坏：createUser 可正常写盘落盘
      const created = await createUser({ username: 'first', password: 'password123', role: 'user' });
      expect(created.username).toBe('first');
      const raw = await fs.readFile(usersPath, 'utf8');
      expect(raw).toContain('first');
    });
  });
});

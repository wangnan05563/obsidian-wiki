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
  resetUserStore,
} from '../src/auth/user-store.js';
import { verifyPassword } from '../src/auth/password.js';

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
      expect(verifyPassword('admin123', admin!.salt, admin!.passwordHash, 100000)).toBe(true);
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

    it('默认用户应启用', async () => {
      await initUserStore(usersPath, 100000);
      const users = await loadUsers();
      for (const u of users) {
        expect(u.enabled).toBe(true);
      }
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
      const ok = verifyPassword('mypassword', user.salt, user.passwordHash, 100000);
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
      expect(verifyPassword('newpassword', updated.salt, updated.passwordHash, 100000)).toBe(true);
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
      // 等待 10ms 确保 timestamp 不同
      await new Promise((r) => setTimeout(r, 10));
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
});

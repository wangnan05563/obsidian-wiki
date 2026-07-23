import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initAuditLog,
  writeAuditLog,
  createAuditEntry,
  readAuditLog,
  flushAuditLog,
  resetAuditLog,
} from '../src/auth/audit-log.js';
import type { AuditLogEntry, AuditAction } from '../src/auth/types.js';

// 审计日志测试
// 覆盖点：初始化、写入、读取、队列串行化、降级 console、字段格式

describe('audit-log 模块', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-audit-test-'));
    logPath = path.join(tempDir, 'audit.log');
    resetAuditLog();
  });

  afterEach(async () => {
    resetAuditLog();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  describe('initAuditLog', () => {
    it('应创建日志目录与文件', async () => {
      const deepPath = path.join(tempDir, 'nested', 'deep', 'audit.log');
      await initAuditLog(deepPath);
      expect(fsSync.existsSync(deepPath)).toBe(true);
    });

    it('文件已存在时不覆盖内容', async () => {
      await initAuditLog(logPath);
      await fs.writeFile(logPath, '{"existing": true}\n', 'utf8');
      await initAuditLog(logPath);
      const content = await fs.readFile(logPath, 'utf8');
      expect(content).toContain('{"existing": true}');
    });

    it('初始化后 logFilePath 应被设置', async () => {
      await initAuditLog(logPath);
      // 通过写入测试间接验证
      writeAuditLog(
        createAuditEntry({
          userId: 'u1',
          username: 'admin',
          action: 'login',
          resource: '/api/auth/login',
          ip: '127.0.0.1',
          result: 'success',
        }),
      );
      await flushAuditLog();
      const content = await fs.readFile(logPath, 'utf8');
      expect(content).toContain('"action":"login"');
    });
  });

  describe('writeAuditLog', () => {
    beforeEach(async () => {
      await initAuditLog(logPath);
    });

    it('应追加写入日志条目（JSONL 格式）', async () => {
      const entry = createAuditEntry({
        userId: 'u1',
        username: 'admin',
        action: 'login',
        resource: '/api/auth/login',
        ip: '127.0.0.1',
        result: 'success',
      });
      writeAuditLog(entry);
      await flushAuditLog();
      const content = await fs.readFile(logPath, 'utf8');
      expect(content).toContain('"action":"login"');
      expect(content).toContain('"username":"admin"');
      expect(content.endsWith('\n')).toBe(true);
    });

    it('多次写入应各自独占一行', async () => {
      for (let i = 0; i < 3; i++) {
        writeAuditLog(
          createAuditEntry({
            userId: `u${i}`,
            username: `user${i}`,
            action: 'login',
            resource: '/api/auth/login',
            ip: '127.0.0.1',
            result: 'success',
          }),
        );
      }
      await flushAuditLog();
      const content = await fs.readFile(logPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines).toHaveLength(3);
    });

    it('并发写入应串行化，不交错', async () => {
      // 同时写入 100 条，验证无行交错
      // 为什么 30s 超时：vitest v4 单线程模式下文件 I/O 可能较慢
      for (let i = 0; i < 100; i++) {
        writeAuditLog(
          createAuditEntry({
            userId: `u${i}`,
            username: `user${i}`,
            action: 'login',
            resource: '/api/auth/login',
            ip: '127.0.0.1',
            result: 'success',
          }),
        );
      }
      await flushAuditLog();
      const content = await fs.readFile(logPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines).toHaveLength(100);
      // 每行都应是有效 JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }, 30000);
  });

  describe('未初始化降级', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('未初始化时应降级到 console.warn', () => {
      resetAuditLog();
      writeAuditLog(
        createAuditEntry({
          userId: null,
          username: null,
          action: 'permission_denied',
          resource: '/api/auth/users',
          ip: '127.0.0.1',
          result: 'fail',
        }),
      );
      expect(console.warn).toHaveBeenCalled();
    });
  });

  describe('createAuditEntry', () => {
    it('应生成包含所有字段的日志条目', () => {
      const entry = createAuditEntry({
        userId: 'u1',
        username: 'admin',
        action: 'user_create',
        resource: '/api/auth/users',
        ip: '192.168.1.1',
        result: 'success',
        message: '创建用户 test',
      });
      expect(entry.ts).toBeTruthy();
      expect(entry.userId).toBe('u1');
      expect(entry.username).toBe('admin');
      expect(entry.action).toBe('user_create');
      expect(entry.resource).toBe('/api/auth/users');
      expect(entry.ip).toBe('192.168.1.1');
      expect(entry.result).toBe('success');
      expect(entry.message).toBe('创建用户 test');
    });

    it('userId/username 可为 null（未登录场景）', () => {
      const entry = createAuditEntry({
        userId: null,
        username: null,
        action: 'permission_denied',
        resource: '/api/xxx',
        ip: '0.0.0.0',
        result: 'fail',
      });
      expect(entry.userId).toBeNull();
      expect(entry.username).toBeNull();
    });

    it('ts 应为 ISO 格式字符串', () => {
      const entry = createAuditEntry({
        userId: 'u1',
        username: 'a',
        action: 'login',
        resource: '/api/auth/login',
        ip: '127.0.0.1',
        result: 'success',
      });
      expect(() => new Date(entry.ts).toISOString()).not.toThrow();
    });
  });

  describe('readAuditLog', () => {
    beforeEach(async () => {
      await initAuditLog(logPath);
    });

    it('应返回最后 N 条记录（倒序时间）', async () => {
      for (let i = 0; i < 10; i++) {
        writeAuditLog(
          createAuditEntry({
            userId: `u${i}`,
            username: `user${i}`,
            action: 'login',
            resource: '/api/auth/login',
            ip: '127.0.0.1',
            result: 'success',
          }),
        );
      }
      await flushAuditLog();
      const entries = await readAuditLog(logPath, 5);
      expect(entries).toHaveLength(5);
      // 最后 5 条
      expect(entries[0].username).toBe('user5');
      expect(entries[4].username).toBe('user9');
    });

    it('空日志文件返回空数组', async () => {
      const entries = await readAuditLog(logPath);
      expect(entries).toEqual([]);
    });

    it('损坏行应被跳过不报错', async () => {
      await fs.writeFile(logPath, '{"valid":true}\nINVALID JSON\n{"also":"valid"}\n', 'utf8');
      const entries = await readAuditLog(logPath);
      expect(entries.length).toBeLessThanOrEqual(2);
    });

    it('文件不存在返回空数组', async () => {
      const entries = await readAuditLog(path.join(tempDir, 'nonexistent.log'));
      expect(entries).toEqual([]);
    });
  });

  describe('flushAuditLog', () => {
    beforeEach(async () => {
      await initAuditLog(logPath);
    });

    it('应等待所有挂起写入完成', async () => {
      for (let i = 0; i < 5; i++) {
        writeAuditLog(
          createAuditEntry({
            userId: `u${i}`,
            username: `user${i}`,
            action: 'login',
            resource: '/api/auth/login',
            ip: '127.0.0.1',
            result: 'success',
          }),
        );
      }
      await flushAuditLog();
      const content = await fs.readFile(logPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines).toHaveLength(5);
    });
  });
});

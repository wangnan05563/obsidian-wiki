import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  initAuditLog,
  flushAuditLog,
  resetAuditLog,
  enforceAuditRetention,
  AUDIT_RETENTION_LINES,
} from '../src/auth/audit-log.js';

// T02782：审计日志保留窗口（写入侧轮转）。
// data/audit.log 此前只追加无上界——登录限流触发（429 也写审计）或长期运行后会无界增长。
// 保留窗口让体积有可验证的上界：超限保留最近 maxLines 条，最旧的被淘汰。

describe('audit-log 保留窗口（T02782）', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-audit-retention-'));
    logPath = path.join(tempDir, 'audit.log');
    resetAuditLog();
    await initAuditLog(logPath);
  });

  afterEach(async () => {
    resetAuditLog();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  async function lineCount(): Promise<number> {
    const content = await fs.readFile(logPath, 'utf8');
    return content.split('\n').filter(Boolean).length;
  }

  it('文件小于字节快速闸时不轮转（免读全文件）', async () => {
    await fs.writeFile(logPath, '{"a":1}\n{"b":2}\n', 'utf8');
    const rotated = await enforceAuditRetention(1);
    expect(rotated).toBe(false);
    const content = await fs.readFile(logPath, 'utf8');
    expect(content).toContain('{"a":1}');
    expect(content).toContain('{"b":2}');
  });

  it('超限保留最近 maxLines 条，最旧的被淘汰', async () => {
    // 造一个大文件：填足字节快速闸 + 行数超限
    const lines: string[] = [];
    for (let i = 0; i < 1200; i++) {
      lines.push(JSON.stringify({ ts: new Date(2026, 0, 1).toISOString(), seq: i, pad: 'x'.repeat(4000) }));
    }
    await fs.writeFile(logPath, lines.join('\n') + '\n', 'utf8');

    const rotated = await enforceAuditRetention(1000);
    expect(rotated).toBe(true);
    expect(await lineCount()).toBe(1000);
    const content = await fs.readFile(logPath, 'utf8');
    expect(content).toContain('"seq":200');
    expect(content).not.toContain('"seq":199');
    expect(content).toContain('"seq":1199');
  });

  it('行数未超限但字节超闸时不轮转', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(JSON.stringify({ ts: new Date(2026, 0, 1).toISOString(), seq: i, pad: 'x'.repeat(4000) }));
    }
    await fs.writeFile(logPath, lines.join('\n') + '\n', 'utf8');
    const rotated = await enforceAuditRetention(1000);
    expect(rotated).toBe(false);
    expect(await lineCount()).toBe(500);
  });

  it('默认保留上限为 1 万条（常量锚定，防止被无意识调小）', () => {
    expect(AUDIT_RETENTION_LINES).toBe(10_000);
  });

  it('写入路径的摊销检查不破坏追加语义（flush 后全部行在盘）', async () => {
    // 少量写入不会触发轮转（计数未满 200 且字节远低于闸），只验证写入路径未被轮转逻辑破坏
    const { writeAuditLog, createAuditEntry } = await import('../src/auth/audit-log.js');
    for (let i = 0; i < 5; i++) {
      writeAuditLog(createAuditEntry({ userId: 'u1', username: 'admin', action: 'login', resource: '/api/auth/login', ip: '127.0.0.1', result: 'success' }));
    }
    await flushAuditLog();
    expect(await lineCount()).toBe(5);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ThreadMemoryStore } from '../src/engine/thread-memory-store.js';

// ThreadMemoryStore 持久化开关测试
// 验证 persist=false（D-1 默认：会话不落盘服务端）时：
//   - appendSessionMessage / appendMemory 不写盘，且返回结构占位值
//   - getHistoryContext 恒返回 []
//   - 不创建 data/threads/ 目录
// 并对照 persist=true 时正常落盘。

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('ThreadMemoryStore 持久化开关', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-tms-it-'));
  });

  afterAll(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('persist=false：appendSessionMessage 不写盘且返回占位值', async () => {
    const store = new ThreadMemoryStore(tempDir, false);
    const threadId = randomUUID();
    const res = await store.appendSessionMessage(threadId, {
      question: 'q',
      answer: 'a',
      refs: [],
      ts: new Date().toISOString(),
    });
    expect(res.sessionId).toBe(threadId);
    expect(res.messageIndex).toBe(0);
    // 关键：不应创建线程目录（会话不落盘服务端）
    const dir = path.join(tempDir, 'threads', threadId);
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it('persist=false：appendMemory 返回空记忆且不写盘', async () => {
    const store = new ThreadMemoryStore(tempDir, false);
    const threadId = randomUUID();
    const mem = await store.appendMemory(threadId, [
      { role: 'user', content: 'hi', ts: new Date().toISOString() },
    ]);
    expect(mem.threadId).toBe(threadId);
    expect(mem.entries).toEqual([]);
    const dir = path.join(tempDir, 'threads', threadId);
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it('persist=false：getHistoryContext 恒返回 []', async () => {
    const store = new ThreadMemoryStore(tempDir, false);
    const threadId = randomUUID();
    const ctx = await store.getHistoryContext(threadId);
    expect(ctx).toEqual([]);
  });

  it('persist=false：createThread 返回元信息但不创建目录', async () => {
    const store = new ThreadMemoryStore(tempDir, false);
    const id = randomUUID();
    const meta = await store.createThread({ id, title: 't' });
    expect(meta.id).toBe(id);
    expect(UUID_RE.test(meta.id)).toBe(true);
    const dir = path.join(tempDir, 'threads', id);
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it('persist=true：createThread + appendSessionMessage 正常落盘', async () => {
    const store = new ThreadMemoryStore(tempDir, true);
    const id = randomUUID();
    await store.createThread({ id });
    await store.appendSessionMessage(id, {
      question: 'q',
      answer: 'a',
      refs: [],
      ts: new Date().toISOString(),
    });
    const sessionFile = path.join(tempDir, 'threads', id, 'session.json');
    const raw = await fs.readFile(sessionFile, 'utf8');
    const parsed = JSON.parse(raw) as { messages: unknown[] };
    expect(parsed.messages.length).toBe(1);
  });

  it('persist=true：getHistoryContext 返回已落盘的记忆', async () => {
    const store = new ThreadMemoryStore(tempDir, true);
    const id = randomUUID();
    await store.appendMemory(id, [
      { role: 'user', content: 'hi', ts: new Date().toISOString() },
      { role: 'assistant', content: 'hello', ts: new Date().toISOString() },
    ]);
    const ctx = await store.getHistoryContext(id);
    expect(ctx.length).toBe(2);
  });
});

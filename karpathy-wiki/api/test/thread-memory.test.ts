// 线程隔离的本地会话 / 记忆存储引擎单元测试
// 覆盖：线程隔离边界、本地持久化（跨重启）、记忆读/写/清、滚动裁剪、非法 id 拒绝。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ThreadMemoryStore, InvalidThreadIdError } from '../src/engine/thread-memory-store.js';

const tmpRoots: string[] = [];

async function makeStore(): Promise<{ store: ThreadMemoryStore; dataDir: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-store-'));
  tmpRoots.push(dataDir);
  return { store: new ThreadMemoryStore(dataDir), dataDir };
}

beforeEach(() => {
  // 每个用例独立临时目录在 makeStore 内创建
});

afterEach(async () => {
  // 清理所有临时目录
  await Promise.all(
    tmpRoots.splice(0).map((d) =>
      fs.rm(d, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});

describe('ThreadMemoryStore - 线程隔离边界', () => {
  it('每个线程拥有独立目录与数据，互不干扰', async () => {
    const { store } = await makeStore();
    const a = await store.createThread({ title: 'A' });
    const b = await store.createThread({ title: 'B' });

    // 向线程 A 写入会话
    await store.appendSessionMessage(a.id, { question: 'q-a', answer: 'ans-a', refs: [], ts: new Date().toISOString() });

    // 线程 B 的会话必须为空，且不能被读到 A 的内容
    const sessionB = await store.getSession(b.id);
    expect(sessionB?.messages.length ?? 0).toBe(0);
    const sessionA = await store.getSession(a.id);
    expect(sessionA?.messages.length).toBe(1);
    expect(sessionA?.messages[0].answer).toBe('ans-a');

    // 物理目录隔离：data/threads/{a}/{b} 不应存在
    const dirA = path.join(store['threadsDir'], a.id);
    const dirB = path.join(store['threadsDir'], b.id);
    expect(fsSync.existsSync(dirA)).toBe(true);
    expect(fsSync.existsSync(dirB)).toBe(true);
  });

  it('非法 threadId 被拒绝（防路径穿越 / 隔离越界）', async () => {
    const { store } = await makeStore();
    await expect(store.ensureThread('../evil')).rejects.toBeInstanceOf(InvalidThreadIdError);
    await expect(store.appendSessionMessage('not-a-uuid', {
      question: 'x', answer: 'y', refs: [], ts: new Date().toISOString(),
    })).rejects.toBeInstanceOf(InvalidThreadIdError);
    await expect(store.appendMemory('not-a-uuid', [{ role: 'user', content: 'x', ts: new Date().toISOString() }]))
      .rejects.toBeInstanceOf(InvalidThreadIdError);
    // 绝不能因非法 id 而在 threads 根目录创建随机线程
    const entries = await fs.readdir(store['threadsDir']);
    expect(entries).toEqual([]);
  });
});

describe('ThreadMemoryStore - 本地持久化（跨重启）', () => {
  it('进程重启（新实例同目录）后会话数据仍在', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-store-'));
    tmpRoots.push(dataDir);

    const threadId = randomUUID();
    const store1 = new ThreadMemoryStore(dataDir);
    await store1.appendSessionMessage(threadId, {
      question: '持久化测试', answer: '答案应保留', refs: ['页面X'], ts: new Date().toISOString(),
    });
    await store1.appendMemory(threadId, [
      { role: 'user', content: '持久化测试', ts: new Date().toISOString() },
      { role: 'assistant', content: '答案应保留', ts: new Date().toISOString() },
    ]);

    // 模拟重启：新建实例指向同一 data 目录
    const store2 = new ThreadMemoryStore(dataDir);
    const session = await store2.getSession(threadId);
    expect(session?.messages.length).toBe(1);
    expect(session?.messages[0].answer).toBe('答案应保留');
    expect(session?.messages[0].refs).toEqual(['页面X']);

    const memory = await store2.getMemory(threadId);
    expect(memory?.entries.length).toBe(2);
    expect(memory?.entries[1].content).toBe('答案应保留');
  });
});

describe('ThreadMemoryStore - 记忆 读/写/清', () => {
  it('appendMemory / getMemory / clearMemory 闭环', async () => {
    const { store } = await makeStore();
    const id = (await store.createThread()).id;
    const now = new Date().toISOString();
    await store.appendMemory(id, [
      { role: 'user', content: '你好', ts: now },
      { role: 'assistant', content: '你好，有什么可以帮你？', ts: now },
    ]);

    let mem = await store.getMemory(id);
    expect(mem?.entries.length).toBe(2);

    // getHistoryContext 返回记忆条目（注入 LLM 的上下文）
    const ctx = await store.getHistoryContext(id);
    expect(ctx.length).toBe(2);
    expect(ctx[0].role).toBe('user');

    // 清空记忆
    await store.clearMemory(id);
    mem = await store.getMemory(id);
    expect(mem?.entries.length).toBe(0);
    expect(await store.memoryLength(id)).toBe(0);

    // 会话不受记忆清空影响
    const session = await store.getSession(id);
    expect(session?.messages.length).toBe(0); // 本用例未写会话
  });

  it('记忆按 MAX_MEMORY_MESSAGES 滚动裁剪，保留最近内容', async () => {
    const { store } = await makeStore();
    const id = (await store.createThread()).id;
    // 写入 60 条，超过上限 40，应裁剪为最近 40
    for (let i = 0; i < 60; i++) {
      await store.appendMemory(id, [{ role: 'user', content: `m${i}`, ts: new Date().toISOString() }]);
    }
    const mem = await store.getMemory(id);
    expect(mem?.entries.length).toBe(40);
    // 保留的是最近的：最后写入的 m59 仍在
    expect(mem?.entries[mem.entries.length - 1].content).toBe('m59');
    expect(mem?.entries[0].content).toBe('m20'); // 60-40 = 20 起
  }, 30000); // 沙箱磁盘慢：60 次 appendMemory 落盘，默认 5s 在高负载下超时
});

describe('ThreadMemoryStore - 会话生命周期', () => {
  it('clearSession 清空会话但保留记忆与线程', async () => {
    const { store } = await makeStore();
    const id = (await store.createThread()).id;
    const ts = new Date().toISOString();
    await store.appendSessionMessage(id, { question: 'q', answer: 'a', refs: [], ts });
    await store.appendMemory(id, [{ role: 'user', content: 'q', ts }, { role: 'assistant', content: 'a', ts }]);

    await store.clearSession(id);
    const session = await store.getSession(id);
    expect(session?.messages.length).toBe(0);
    // 记忆与元信息仍在
    expect((await store.getMemory(id))?.entries.length).toBe(2);
    expect((await store.getThread(id))?.messageCount).toBe(0);
  });

  it('deleteThread 连带删除会话与记忆', async () => {
    const { store } = await makeStore();
    const id = (await store.createThread()).id;
    const ts = new Date().toISOString();
    await store.appendSessionMessage(id, { question: 'q', answer: 'a', refs: [], ts });

    await store.deleteThread(id);
    expect(await store.getThread(id)).toBeNull();
    expect(await store.getSession(id)).toBeNull();
    expect(await store.getMemory(id)).toBeNull();
    expect(fsSync.existsSync(path.join(store['threadsDir'], id))).toBe(false);
  });

  it('appendSessionMessage 返回正确的 messageIndex 与 sessionId', async () => {
    const { store } = await makeStore();
    const id = (await store.createThread()).id;
    const ts = new Date().toISOString();
    const r1 = await store.appendSessionMessage(id, { question: 'q1', answer: 'a1', refs: [], ts });
    const r2 = await store.appendSessionMessage(id, { question: 'q2', answer: 'a2', refs: [], ts });
    expect(r1.messageIndex).toBe(0);
    expect(r2.messageIndex).toBe(1);
    expect(r1.sessionId).toBe(id); // 1 线程 1 会话
  });
});

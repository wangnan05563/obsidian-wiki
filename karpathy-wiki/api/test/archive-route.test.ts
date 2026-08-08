// 归档路由（POST /api/query/archive）单元测试
// 用最小 Fastify 应用挂载 registerQueryArchiveRoute，配假 VaultService（仅捕获写入调用）
// 与真实 ThreadMemoryStore（persist=true，使回退路径可读到 session），通过 inject 验证：
//   ① 主路径从请求体取内容写 vault ② 同日同线程多次归档不互相覆盖（碰撞回归）
//   ③ 回退路径 404/400 ④ 非法 ts 鲁棒性 ⑤ 回退成功从 record 取数。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ThreadMemoryStore } from '../src/engine/thread-memory-store.js';
import { registerQueryArchiveRoute } from '../src/routes/query.js';
import type { VaultService } from '../src/vault/vault-service.js';

let app: FastifyInstance;
let store: ThreadMemoryStore;
let dataDir: string;

// 捕获 vault 写入行为的最小假实现（不落盘，仅记录调用）
const vaultCalls = {
  writeFile: [] as { path: string; content: string }[],
  appendIndex: [] as { pageName: string; summary: string }[],
  appendLog: [] as { operation: string; files: string[]; note?: string }[],
};

function makeFakeVault() {
  return {
    writeFile: async (relativePath: string, content: string | Buffer) => {
      vaultCalls.writeFile.push({ path: relativePath, content: String(content) });
    },
    appendIndex: async (pageName: string, summary: string) => {
      vaultCalls.appendIndex.push({ pageName, summary });
      return { ok: true, skipped: false };
    },
    appendLog: async (operation: 'compile' | 'query' | 'health-check', affectedFiles: string[], note?: string) => {
      vaultCalls.appendLog.push({ operation, files: affectedFiles, note });
    },
  } as unknown as VaultService;
}

const UUID = '12345678-1234-1234-1234-123456789abc';
const FBUUID = 'aaaaaaaa-1234-1234-1234-123456789abc';

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-test-'));
  store = new ThreadMemoryStore(dataDir); // persist=true：回退路径可读取 session
  app = Fastify();
  registerQueryArchiveRoute(app, makeFakeVault(), store);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(() => {
  vaultCalls.writeFile.length = 0;
  vaultCalls.appendIndex.length = 0;
  vaultCalls.appendLog.length = 0;
});

describe('POST /api/query/archive', () => {
  it('主路径：从请求体取内容写 vault（200 + 文件名格式正确）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/archive',
      payload: {
        threadId: UUID,
        sessionId: UUID,
        messageIndex: 2,
        question: '什么是注意力机制？',
        answer: '注意力机制让模型聚焦关键 token。',
        refs: ['Transformer', 'Self-Attention'],
        ts: '2026-08-08T10:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toMatch(/^queries\/qa-\d{4}-\d{2}-\d{2}-12345678-[0-9a-f]{4}\.md$/);

    // 三次 vault 写入：文件 + index + log
    expect(vaultCalls.writeFile).toHaveLength(1);
    expect(vaultCalls.writeFile[0].path).toBe(body.path);
    expect(vaultCalls.writeFile[0].content).toContain('什么是注意力机制？');
    expect(vaultCalls.writeFile[0].content).toContain('注意力机制让模型聚焦关键 token。');
    expect(vaultCalls.writeFile[0].content).toContain('- [[Transformer]]');
    expect(vaultCalls.appendIndex).toHaveLength(1);
    expect(vaultCalls.appendLog).toHaveLength(1);
  });

  it('回归：同一线程同一天归档两条不同消息，文件名不互相覆盖', async () => {
    const a = await app.inject({
      method: 'POST',
      url: '/api/query/archive',
      payload: { threadId: UUID, question: '问题A', answer: '答案A', ts: '2026-08-08T10:00:00.000Z' },
    });
    const b = await app.inject({
      method: 'POST',
      url: '/api/query/archive',
      payload: { threadId: UUID, question: '问题B', answer: '答案B', ts: '2026-08-08T10:00:00.000Z' },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const pa = (JSON.parse(a.body) as { path: string }).path;
    const pb = (JSON.parse(b.body) as { path: string }).path;
    expect(pa).not.toBe(pb);
    expect(pa).toMatch(/^queries\/qa-2026-08-08-12345678-[0-9a-f]{4}\.md$/);
    expect(pb).toMatch(/^queries\/qa-2026-08-08-12345678-[0-9a-f]{4}\.md$/);
    // 两次写入文件路径不同 → 互不覆盖
    expect(vaultCalls.writeFile.map((w) => w.path)).toEqual([pa, pb]);
  });

  it('回退路径：store 无 session 时返回 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/archive',
      payload: { threadId: UUID, messageIndex: 0 },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toContain('不存在');
  });

  it('回退路径：非法 threadId 返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/archive',
      payload: { threadId: '../escape', messageIndex: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('非法的 threadId');
  });

  it('回退路径：messageIndex 非整数返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/archive',
      payload: { threadId: UUID, messageIndex: 1.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('回退路径：缺 messageIndex 返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/archive',
      payload: { threadId: UUID },
    });
    expect(res.statusCode).toBe(400);
  });

  it('鲁棒性：非法 ts 不抛 500，回退到今天日期并成功归档', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/archive',
      payload: { threadId: UUID, question: 'Q', answer: 'A', ts: 'not-a-date' },
    });
    expect(res.statusCode).toBe(200);
    const p = (JSON.parse(res.body) as { path: string }).path;
    const today = new Date().toISOString().slice(0, 10);
    expect(p).toMatch(new RegExp(`^queries/qa-${today}-12345678-[0-9a-f]{4}\\.md$`));
  });

  it('回退路径成功：store 有 session 时从 record 取内容归档', async () => {
    await store.appendSessionMessage(FBUUID, {
      question: '回退问题',
      answer: '回退答案',
      refs: ['PageX'],
      ts: '2026-08-07T09:00:00.000Z',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/archive',
      payload: { threadId: FBUUID, messageIndex: 0 },
    });
    expect(res.statusCode).toBe(200);
    const written = vaultCalls.writeFile.find((w) => w.content.includes('回退问题'));
    expect(written).toBeTruthy();
    expect(written!.content).toContain('回退答案');
    expect(written!.content).toContain('- [[PageX]]');
  });

  it('refs 清洗：含换行/控制字符的 ref 不会破坏 wikilink 语法', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/archive',
      payload: { threadId: UUID, question: 'Q', answer: 'A', refs: ['Page\nX', '  ', 'OK'] },
    });
    expect(res.statusCode).toBe(200);
    const written = vaultCalls.writeFile[0].content;
    // 换行被替换为空格，空串被剔除 → 仅 [OK] 与 [Page X]
    expect(written).toContain('- [[Page X]]');
    expect(written).toContain('- [[OK]]');
    expect(written).not.toContain('[Page\n');
  });

  it('防御：question 与 answer 均为空的 session 记录被拒绝（400）', async () => {
    await store.appendSessionMessage('bbbbbbbb-1234-1234-1234-123456789abc', {
      question: '',
      answer: '',
      refs: [],
      ts: '2026-08-07T09:00:00.000Z',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/query/archive',
      payload: { threadId: 'bbbbbbbb-1234-1234-1234-123456789abc', messageIndex: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('归档内容为空');
  });
});

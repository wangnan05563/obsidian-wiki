// 上下文记忆治理 REST 端点测试
// 挂载真实的 threads 路由（persist=true，使用临时目录），验证：
//  ① GET  /api/threads/:id/context  —— 非破坏性治理预览（压缩/清理/淘汰效果 + 摘要）
//  ② POST /api/threads/:id/compact   —— 存储层显式折叠（摘要 + 裁剪原文）
//  ③ 非法 threadId 一律 400（防路径穿越）
// 这是 wiki-auto-testing 技能 api_tests / route_registration_check 对本会话新增端点的落地。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { HistoryMessage } from '../src/engine/thread-memory-store.js';
import { ThreadMemoryStore } from '../src/engine/thread-memory-store.js';
import { registerThreadsRoute } from '../src/routes/threads.js';
import { DEFAULT_GOVERNOR_CONFIG } from '../src/engine/context-governor.js';

let app: FastifyInstance;
let store: ThreadMemoryStore;
let dataDir: string;

/** 构造 length 轮（user+assistant）历史，用于触发治理阈值。 */
function makeHistory(turns: number, base = 0): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (let i = 1; i <= turns; i++) {
    const n = base + i;
    out.push({ role: 'user', content: `问题${n}`, ts: new Date(Date.now() - (turns - i) * 60000).toISOString() });
    out.push({ role: 'assistant', content: `概念${n}：这是关于第${n}个概念的一段较长解释性回答内容，用于占据一定的 token 预算以便触发治理压缩。`, ts: new Date(Date.now() - (turns - i) * 60000 + 1000).toISOString() });
  }
  return out;
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gov-routes-'));
  store = new ThreadMemoryStore(dataDir); // persist=true：真实落盘以验证 /compact 折叠
  app = Fastify();
  registerThreadsRoute(app, store, DEFAULT_GOVERNOR_CONFIG);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('GET /api/threads/:id/context —— 治理预览', () => {
  it('超阈值历史触发治理：返回摘要 + 压缩后消息，且 token 净缩减', async () => {
    const id = randomUUID();
    await store.createThread({ id });
    await store.appendMemory(id, makeHistory(20)); // 40 条 > maxMessages(30) → 触发

    const res = await app.inject({ method: 'GET', url: `/api/threads/${id}/context` });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(Array.isArray(body.context)).toBe(true);
    expect(typeof body.summary).toBe('string');
    expect(body.stats).toBeTruthy();

    // 触发：消息数超出 maxMessages，治理被激活
    expect(body.stats.triggered).toBe(true);
    // 连贯性底线：至少保留摘要 + 最近窗口的一部分
    expect(body.context.length).toBeGreaterThan(0);
    expect(body.context.length).toBeLessThanOrEqual(DEFAULT_GOVERNOR_CONFIG.maxMessages);
    // token 净缩减（压缩/淘汰生效）
    expect(body.stats.outputTokens).toBeLessThan(body.stats.inputTokens);
  });

  it('支持 ?question= 相关性重组（治理仍返回连贯上下文）', async () => {
    const id = randomUUID();
    await store.createThread({ id });
    await store.appendMemory(id, makeHistory(20));

    const res = await app.inject({ method: 'GET', url: `/api/threads/${id}/context?question=问题15` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.context)).toBe(true);
    expect(body.stats.triggered).toBe(true);
  });

  it('线程不存在返回 404', async () => {
    const id = randomUUID();
    const res = await app.inject({ method: 'GET', url: `/api/threads/${id}/context` });
    expect(res.statusCode).toBe(404);
  });

  it('非法 threadId 返回 400（防路径穿越）', async () => {
    for (const bad of ['not-a-uuid', '12345', 'foo_bar!']) {
      const res = await app.inject({ method: 'GET', url: `/api/threads/${bad}/context` });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('POST /api/threads/:id/compact —— 存储层折叠', () => {
  it('折叠后原文裁剪到 keepRecent，摘要被填充', async () => {
    const id = randomUUID();
    await store.createThread({ id });
    await store.appendMemory(id, makeHistory(20)); // 40 条

    const before = await store.getMemory(id);
    expect(before?.entries.length).toBe(40);
    expect(before?.summary ?? '').toBe('');

    const res = await app.inject({ method: 'POST', url: `/api/threads/${id}/compact` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);

    // 默认 keepRecent=12 → 原文裁到 12 条，摘要非空
    expect(body.memory.entries.length).toBe(12);
    expect(body.memory.summary.length).toBeGreaterThan(0);

    // 持久化生效：再次读取保持一致
    const after = await store.getMemory(id);
    expect(after?.entries.length).toBe(12);
    expect(after?.summary.length).toBeGreaterThan(0);
  });

  it('支持自定义 keepRecent', async () => {
    const id = randomUUID();
    await store.createThread({ id });
    await store.appendMemory(id, makeHistory(20));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${id}/compact`,
      payload: { keepRecent: 6 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().memory.entries.length).toBe(6);
    expect(res.json().memory.summary.length).toBeGreaterThan(0);
  });

  it('无历史线程折叠为安全空状态', async () => {
    const id = randomUUID();
    await store.createThread({ id });
    const res = await app.inject({ method: 'POST', url: `/api/threads/${id}/compact` });
    expect(res.statusCode).toBe(200);
    expect(res.json().memory.entries.length).toBe(0);
  });

  it('非法 threadId 返回 400（防路径穿越）', async () => {
    for (const bad of ['not-a-uuid', '12345', 'foo_bar!']) {
      const res = await app.inject({ method: 'POST', url: `/api/threads/${bad}/compact` });
      expect(res.statusCode).toBe(400);
    }
  });
});

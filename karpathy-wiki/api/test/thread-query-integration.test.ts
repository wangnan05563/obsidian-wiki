// 线程隔离问答路由集成测试
// 用最小 Fastify 应用挂载真实的 threads 路由与 query 路由（配合假 adapter），
// 验证：① 历史上下文由本地记忆注入（跨轮连贯）② 会话/记忆落盘持久化
//       ③ 自动建线程 ④ 非法 threadId 拒绝 ⑤ 记忆读/写/清 经 HTTP 闭环。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { EngineAdapter, QueryInput, AnswerChunk } from '../src/types.js';
import { ThreadMemoryStore } from '../src/engine/thread-memory-store.js';
import { registerThreadsRoute } from '../src/routes/threads.js';
import { registerQueryRoute } from '../src/routes/query.js';
import { DEFAULT_GOVERNOR_CONFIG } from '../src/engine/context-governor.js';

let app: FastifyInstance;
let store: ThreadMemoryStore;
let dataDir: string;

// 假 adapter：记录每次 query 收到的 input.history，并回吐答案文本
function makeFakeAdapter() {
  const recorded: QueryInput[] = [];
  const adapter = {
    query: async function* (input: QueryInput): AsyncIterable<AnswerChunk> {
      recorded.push(input);
      yield { text: `回答[${input.question}]` };
      yield { refs: ['页面A'], done: true };
    },
    compile: async function* () {},
    resumeCompile: async function* () {},
    healthCheck: async () => ({ orphans: [], brokenLinks: [], stale: [] }),
    healthCheckFix: async function* () {},
    updateConfig: () => {},
    podcast: async () => ({ script: '', audioFiles: [], durationSec: 0, archivePath: '', ttsEnabled: false }),
    generateVideo: async () => ({ taskId: '', videoId: '', status: 'queued', progress: 0 }),
    pollVideoTask: async () => ({ taskId: '', videoId: '', status: 'queued', progress: 0 }),
  } as unknown as EngineAdapter;
  return { adapter, recorded };
}

// 从 SSE 响应体解析 done 事件，提取 threadId
function parseDoneThreadId(body: string): string | undefined {
  for (const block of body.split('\n\n')) {
    const lines = block.split('\n');
    let ev = '';
    let data = '';
    for (const l of lines) {
      if (l.startsWith('event: ')) ev = l.slice(7);
      if (l.startsWith('data: ')) data = l.slice(6);
    }
    if (ev === 'done' && data) {
      try {
        const parsed = JSON.parse(data) as { threadId?: string };
        return parsed.threadId;
      } catch { /* ignore */ }
    }
  }
  return undefined;
}

let fake: ReturnType<typeof makeFakeAdapter>;

// BYOK 强制每用户各自配置：query 路由要求 body 携带 llmConfig（apiKey 非空），否则拒绝。
// 本集成测试仅验证线程隔离/路由行为，不触发真实 LLM，故统一附带一个测试用覆盖项，
// 使其通过 API Key 校验后继续走线程隔离/记忆注入等既有逻辑。
const BYOK_OVERRIDE = {
  llmConfig: { provider: 'glm', baseUrl: 'http://test.local/v4', model: 'test-model', apiKey: 'TEST_USER_KEY' },
};

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-int-'));
  store = new ThreadMemoryStore(dataDir);
  fake = makeFakeAdapter();
  app = Fastify();
  registerThreadsRoute(app, store, DEFAULT_GOVERNOR_CONFIG);
  registerQueryRoute(app, fake.adapter, store, DEFAULT_GOVERNOR_CONFIG);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('query 路由 + 线程隔离本地存储 集成', () => {
  it('未传 threadId 时后端自动建线程，且 done 事件回传 threadId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query',
      payload: { ...BYOK_OVERRIDE, question: '第一轮问题' },
    });
    expect(res.statusCode).toBe(200);
    const threadId = parseDoneThreadId(res.body);
    expect(threadId).toBeTruthy();

    // 会话与记忆已落盘
    const session = await store.getSession(threadId!);
    expect(session?.messages.length).toBe(1);
    expect(session?.messages[0].question).toBe('第一轮问题');

    const memory = await store.getMemory(threadId!);
    expect(memory?.entries.length).toBe(2); // user + assistant
  });

  it('同一线程第二轮问答：后端从本地记忆注入历史上下文（连贯性）', async () => {
    fake.recorded.length = 0; // 隔离本测试的 adapter 调用记录（recorded 跨用例共享）
    const created = await app.inject({ method: 'POST', url: '/api/threads', payload: {} });
    const threadId = (JSON.parse(created.body) as { thread: { id: string } }).thread.id;

    // 第一轮
    await app.inject({ method: 'POST', url: '/api/query', payload: { ...BYOK_OVERRIDE, question: '甲', threadId } });
    // 第二轮：adapter 应收到由记忆注入的 history（含第一轮 user/assistant）
    await app.inject({ method: 'POST', url: '/api/query', payload: { ...BYOK_OVERRIDE, question: '乙', threadId } });

    expect(fake.recorded.length).toBe(2);
    const secondInput = fake.recorded[1];
    expect(secondInput.history?.length).toBe(2);
    expect(secondInput.history?.[0].role).toBe('user');
    expect(secondInput.history?.[0].content).toBe('甲');
    expect(secondInput.history?.[1].content).toContain('回答[甲]');
  });

  it('不携带 threadId 时回退前端透传 history（向后兼容）', async () => {
    fake.recorded.length = 0;
    await app.inject({
      method: 'POST',
      url: '/api/query',
      payload: { ...BYOK_OVERRIDE, question: 'Q', history: [{ role: 'user', content: '旧历史' }] },
    });
    // 自动建的新线程记忆为空，因此后端使用客户端透传 history
    expect(fake.recorded[0].history?.[0].content).toBe('旧历史');
  });

  it('非法 threadId 被拒绝（400）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/query',
      payload: { ...BYOK_OVERRIDE, question: 'x', threadId: '../escape' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('非法的 threadId');
  });

  it('记忆经 HTTP 读/写/清 闭环', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/threads', payload: {} });
    const threadId = (JSON.parse(created.body) as { thread: { id: string } }).thread.id;

    // 写
    const post = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/memory`,
      payload: { entries: [{ role: 'user', content: '手动记忆', ts: new Date().toISOString() }] },
    });
    expect(post.statusCode).toBe(200);
    expect((JSON.parse(post.body) as any).memory.entries.length).toBe(1);

    // 读
    const get = await app.inject({ method: 'GET', url: `/api/threads/${threadId}/memory` });
    expect((JSON.parse(get.body) as any).memory.entries[0].content).toBe('手动记忆');

    // 清
    const del = await app.inject({ method: 'DELETE', url: `/api/threads/${threadId}/memory` });
    expect(del.statusCode).toBe(200);
    const get2 = await app.inject({ method: 'GET', url: `/api/threads/${threadId}/memory` });
    expect((JSON.parse(get2.body) as any).memory.entries.length).toBe(0);
  });

  it('删除线程后会话与记忆一并消失', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/threads', payload: {} });
    const threadId = (JSON.parse(created.body) as { thread: { id: string } }).thread.id;
    await app.inject({ method: 'POST', url: '/api/query', payload: { ...BYOK_OVERRIDE, question: 'zz', threadId } });

    const del = await app.inject({ method: 'DELETE', url: `/api/threads/${threadId}` });
    expect(del.statusCode).toBe(200);
    expect(await store.getThread(threadId)).toBeNull();
    expect(fsSync.existsSync(path.join(store['threadsDir'], threadId))).toBe(false);
  });
});

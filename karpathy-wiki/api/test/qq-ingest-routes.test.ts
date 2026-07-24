// QQ 导入子系统路由层集成测试
// 覆盖 SRS §6.1 路由族 8 个端点：upload / preview / extract / drafts / compile / compile/batch / config(GET/PUT)
// 为什么用 Fastify inject 而非 mock request/reply：inject 能测试完整路由注册 + 中间件 + SSE 写入链路，
//   更接近真实运行时行为；SSE 端点在 inject 模式下 writeHead/write 被缓冲为完整 payload 返回，可解析后断言
// 为什么用真实 VaultService + 临时目录：测试路径越界校验、白名单约束、archiveRaw 等真实行为，
//   而非仅验证 mock 调用参数
// 为什么 mock saveQqConfig：PUT /config 路由内部调用 saveQqConfig 写 config.json，
//   真实执行会污染项目配置文件，且 getConfigPath 基于 import.meta.url 无法覆盖

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerQqIngestRoute } from '../src/routes/qq-ingest.js';
import { VaultService } from '../src/vault/vault-service.js';
import type { AppConfig, EngineAdapter, ProgressEvent, QqConfig } from '../src/types.js';

// vi.hoisted 确保 mock 函数在 vi.mock 工厂执行前已定义
// 为什么用 hoisted 而非顶层 const：vi.mock 会被 hoist 到文件顶部，
//   顶层 const 在 mock 工厂执行时尚未初始化，会抛 ReferenceError
const { saveQqConfigMock } = vi.hoisted(() => ({
  saveQqConfigMock: vi.fn(),
}));

// mock config.js 的 saveQqConfig 导出，避免写真实 config.json
// 其他导出保持原样（spread actual），不影响 loadConfig 等函数
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    saveQqConfig: saveQqConfigMock,
  };
});

// 测试用默认 QQ 配置（与 config.ts defaultConfig().qq 一致）
const DEFAULT_QQ_CONFIG: QqConfig = {
  noise_rules: { 'NR-1': true, 'NR-2': true, 'NR-3': true, 'NR-4': true, 'NR-5': true, 'NR-6': true },
  privacy_patterns: {
    phone: String.raw`1[3-9]\d{9}`,
    id_card: String.raw`\d{17}[\dXx]`,
    email: String.raw`[\w.-]+@[\w.-]+\.\w+`,
    card: String.raw`\d{16,19}`,
    qq: String.raw`(?<=QQ|扣扣|qq号|企鹅)\s*[0-9]{5,11}`,
  },
  max_batch_size: 20,
  chunk_threshold: 200,
  extract_model: 'glm-4-plus',
  extract_base_url: '',
  extract_token_budget: 50000,
};

// 构造测试用 AppConfig（复用 qq-extract-workflow.test.ts 的结构）
function createTestConfig(vaultPath: string): AppConfig {
  return {
    vaultPath,
    adapter: 'harness',
    llm: { provider: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', apiKeyRef: 'GLM_KEY', apiKey: 'test-key' },
    budget: { maxSteps: 20, tokenBudget: 50000 },
    server: { host: 'localhost', port: 3000 },
    localOnly: false,
    healthCheck: { staleDays: 30 },
    tunnel: {
      provider: 'cloudflare', localPort: 0, cpolarAuthtoken: '', binaryPath: '',
      autoStart: false, tunnelMode: 'quick', tunnelName: '', tunnelId: '',
      credentialsFile: '', hostname: '', certFile: '',
    },
    qq: DEFAULT_QQ_CONFIG,
    batch: { allowedExtensions: ['md', 'txt'], maxBatchSize: 5, maxFileSizeMb: 10 },
  };
}

// mock EngineAdapter：compile 返回固定的事件流，避免依赖外部 LLM API
function createMockAdapter(): EngineAdapter {
  return {
    compile: async function* (): AsyncIterable<ProgressEvent> {
      yield { step: 'progress', status: 'running', message: 'mock compile start' };
      yield { step: 'done', status: 'done', message: 'mock compile done', data: { path: 'qa/mock-page.md', title: 'Mock Page' } };
    },
    resumeCompile: async function* () { /* 测试不使用 */ },
    query: async function* () { /* 测试不使用 */ },
    healthCheck: async () => ({ status: 'ok' }) as never,
    healthCheckFix: async function* () { /* 测试不使用 */ },
    updateConfig: () => { /* 测试不使用 */ },
  } as unknown as EngineAdapter;
}

// 构造 multipart/form-data 请求体
// 为什么手动构造而非用 form-data 库：减少测试依赖，且 inject 对手动构造的 multipart 兼容性好
function buildMultipartPayload(filename: string, content: string, contentType = 'text/plain'): { body: string; boundary: string } {
  const boundary = `----vitest${process.hrtime.bigint().toString()}`;
  const parts = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
    '',
    content,
    `--${boundary}--`,
    '',
  ];
  return { body: parts.join('\r\n'), boundary };
}

// 解析 SSE 响应文本为事件数组
// 为什么按 \n\n 分割：SSE 规范中事件以空行分隔，每个事件含 event: 和 data: 行
function parseSSEEvents(payload: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  for (const block of payload.split('\n\n')) {
    if (!block.trim()) continue;
    let event = '';
    let dataStr = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataStr += line.slice(6);
    }
    if (event) {
      try { events.push({ event, data: JSON.parse(dataStr) }); }
      catch { events.push({ event, data: dataStr }); }
    }
  }
  return events;
}

// 构建测试用 Fastify app：注册 multipart + QQ 路由
async function buildApp(vault: VaultService, config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 10 } });
  registerQqIngestRoute(app, createMockAdapter(), vault, config);
  await app.ready();
  return app;
}

describe('路由层集成测试：QQ 导入子系统', () => {
  let tempDir: string;
  let vault: VaultService;
  let config: AppConfig;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-routes-test-'));
    config = createTestConfig(tempDir);
    vault = new VaultService(tempDir);
    await vault.init();
    saveQqConfigMock.mockReset();
  });

  afterEach(async () => {
    // 临时目录清理失败不阻断后续测试
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ==========================================================================
  // POST /api/qq-ingest/upload
  // ==========================================================================
  describe('POST /api/qq-ingest/upload', () => {
    it('上传 TXT 文件应返回 SSE 流含 progress + done 事件', async () => {
      const app = await buildApp(vault, config);
      try {
        const txt = `测试群 聊天记录
2026-07-20 14:30:15 张三<zhangsan@qq.com>
如何配置环境变量？
2026-07-20 14:30:20 李四<lisi@qq.com>
在 .env 文件中添加 CONFIG_KEY=value`;
        const { body, boundary } = buildMultipartPayload('test.txt', txt);

        const res = await app.inject({
          method: 'POST',
          url: '/api/qq-ingest/upload',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: body,
        });

        expect(res.statusCode).toBe(200);
        const events = parseSSEEvents(res.payload);
        // 应至少含 progress(filter) 和 done 事件
        const doneEvent = events.find((e) => e.event === 'done');
        expect(doneEvent).toBeTruthy();
        const doneData = doneEvent!.data as { data?: { rawId?: string; rawPath?: string; meta?: { filteredCount?: number } } };
        expect(doneData.data?.rawId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        expect(doneData.data?.rawPath).toContain('raw/');
        expect(doneData.data?.meta?.filteredCount).toBe(2);
      } finally {
        await app.close();
      }
    });

    it('上传 JSON 文件应正确解析 qq-chat-exporter 格式', async () => {
      const app = await buildApp(vault, config);
      try {
        const json = JSON.stringify({
          meta: { source: 'qq-chat-exporter', chatName: '技术群' },
          messages: [
            { timestamp: '2026-07-20 14:30:15', speaker: '张三', type: 'text', content: '如何部署？' },
            { timestamp: '2026-07-20 14:30:20', speaker: '李四', type: 'text', content: '用 docker compose up' },
          ],
        });
        const { body, boundary } = buildMultipartPayload('test.json', json, 'application/json');

        const res = await app.inject({
          method: 'POST',
          url: '/api/qq-ingest/upload',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: body,
        });

        expect(res.statusCode).toBe(200);
        const events = parseSSEEvents(res.payload);
        const doneData = events.find((e) => e.event === 'done')!.data as { data?: { meta?: { chatName?: string } } };
        expect(doneData.data?.meta?.chatName).toBe('技术群');
      } finally {
        await app.close();
      }
    });

    it('缺少 file 字段应返回 400', async () => {
      const app = await buildApp(vault, config);
      try {
        // 空 multipart 请求体（只有 boundary 结束标记）
        const boundary = '----vitestempty';
        const body = `--${boundary}--\r\n`;
        const res = await app.inject({
          method: 'POST',
          url: '/api/qq-ingest/upload',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: body,
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toContain('file');
      } finally {
        await app.close();
      }
    });
  });

  // ==========================================================================
  // GET /api/qq-ingest/preview/:rawId
  // ==========================================================================
  describe('GET /api/qq-ingest/preview/:rawId', () => {
    it('应返回清洗后的中间格式 JSON', async () => {
      // 先 upload 获取 rawId
      const rawId = await seedRawFile(vault, '预览测试群', { messages: ['测试消息内容'] });

      const app = await buildApp(vault, config);
      try {
        const res = await app.inject({ method: 'GET', url: `/api/qq-ingest/preview/${rawId}` });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.meta.chatName).toBe('预览测试群');
        expect(body.meta.source).toBe('qq-chat');
        expect(Array.isArray(body.chunks)).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('无效 rawId 格式应返回 400', async () => {
      const app = await buildApp(vault, config);
      try {
        const res = await app.inject({ method: 'GET', url: '/api/qq-ingest/preview/not-a-uuid' });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toContain('rawId');
      } finally {
        await app.close();
      }
    });

    it('rawId 不存在应返回 404', async () => {
      const app = await buildApp(vault, config);
      try {
        const fakeUuid = '00000000-0000-0000-0000-000000000000';
        const res = await app.inject({ method: 'GET', url: `/api/qq-ingest/preview/${fakeUuid}` });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });

  // ==========================================================================
  // POST /api/qq-ingest/extract/:rawId
  // ==========================================================================
  describe('POST /api/qq-ingest/extract/:rawId', () => {
    it('应返回 SSE 流含 done 事件（mock fetch 返回空抽取结果）', async () => {
      // mock fetch：extractWorkflow 内部调用 LLM API，mock 返回空 qa_pairs/solutions
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '{"qa_pairs":[],"solutions":[]}',
        json: async () => ({ choices: [{ message: { content: '{"qa_pairs":[],"solutions":[]}' } }] }),
      }));
      vi.stubGlobal('fetch', fetchMock);

      try {
        const rawId = await seedRawFile(vault, 'extract-test', { chatName: '抽取测试', messages: ['有价值的长消息内容用于抽取'] });
        const app = await buildApp(vault, config);
        try {
          const res = await app.inject({ method: 'POST', url: `/api/qq-ingest/extract/${rawId}` });
          expect(res.statusCode).toBe(200);
          const events = parseSSEEvents(res.payload);
          const doneEvent = events.find((e) => e.event === 'done');
          expect(doneEvent).toBeTruthy();
        } finally {
          await app.close();
        }
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('无效 rawId 格式应返回 400', async () => {
      const app = await buildApp(vault, config);
      try {
        const res = await app.inject({ method: 'POST', url: '/api/qq-ingest/extract/invalid-id' });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });
  });

  // ==========================================================================
  // GET /api/qq-ingest/drafts
  // ==========================================================================
  describe('GET /api/qq-ingest/drafts', () => {
    it('drafts 目录不存在时应返回空数组', async () => {
      const app = await buildApp(vault, config);
      try {
        const res = await app.inject({ method: 'GET', url: '/api/qq-ingest/drafts' });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).drafts).toEqual([]);
      } finally {
        await app.close();
      }
    });

    it('应列出 drafts 目录下的 .md 文件', async () => {
      // 手动创建 drafts 目录和测试文件
      await fs.mkdir(path.join(tempDir, 'drafts'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'drafts', 'qa-test.md'), '# test', 'utf8');
      await fs.writeFile(path.join(tempDir, 'drafts', 'solution-test.md'), '# test', 'utf8');

      const app = await buildApp(vault, config);
      try {
        const res = await app.inject({ method: 'GET', url: '/api/qq-ingest/drafts' });
        expect(res.statusCode).toBe(200);
        const drafts = JSON.parse(res.payload).drafts;
        expect(drafts).toHaveLength(2);
        expect(drafts.some((d: { name: string }) => d.name === 'qa-test.md')).toBe(true);
      } finally {
        await app.close();
      }
    });
  });

  // ==========================================================================
  // POST /api/qq-ingest/compile/:draftPath
  // ==========================================================================
  describe('POST /api/qq-ingest/compile/:draftPath', () => {
    it('应返回 SSE 流含 done 事件（mock adapter.compile）', async () => {
      await fs.mkdir(path.join(tempDir, 'drafts'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'drafts', 'qa-compile.md'), '---\ntype: qa\n---\n# test', 'utf8');

      const app = await buildApp(vault, config);
      try {
        // draftPath 含 /，需 URL 编码：Fastify :draftPath 参数默认不匹配 /，编码后作为单段路径
        const encoded = encodeURIComponent('drafts/qa-compile.md');
        const res = await app.inject({ method: 'POST', url: `/api/qq-ingest/compile/${encoded}` });
        expect(res.statusCode).toBe(200);
        const events = parseSSEEvents(res.payload);
        const doneEvent = events.find((e) => e.event === 'done');
        expect(doneEvent).toBeTruthy();
      } finally {
        await app.close();
      }
    });

    it('无效 draftPath 格式应返回 400', async () => {
      const app = await buildApp(vault, config);
      try {
        // entities/ 路径不在 drafts/ 白名单内，URL 编码后作为单段路径传入
        const encoded = encodeURIComponent('entities/foo.md');
        const res = await app.inject({ method: 'POST', url: `/api/qq-ingest/compile/${encoded}` });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toContain('draftPath');
      } finally {
        await app.close();
      }
    });
  });

  // ==========================================================================
  // POST /api/qq-ingest/compile/batch
  // ==========================================================================
  describe('POST /api/qq-ingest/compile/batch', () => {
    it('请求体指定 drafts 应返回 SSE 流含 batch_done 事件', async () => {
      await fs.mkdir(path.join(tempDir, 'drafts'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'drafts', 'qa-1.md'), '# test1', 'utf8');
      await fs.writeFile(path.join(tempDir, 'drafts', 'qa-2.md'), '# test2', 'utf8');

      const app = await buildApp(vault, config);
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/qq-ingest/compile/batch',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ drafts: ['drafts/qa-1.md', 'drafts/qa-2.md'] }),
        });
        expect(res.statusCode).toBe(200);
        const events = parseSSEEvents(res.payload);
        // batch 路由中每个 draft 编译会发 done 事件（mock adapter），最后发 step=batch_done 的汇总事件
        // 为什么找 batch_done 而非第一个 done：第一个 done 是单个 draft 的编译完成，batch_done 才是批量汇总
        const batchDone = events.find((e) => e.event === 'done' && (e.data as { step?: string }).step === 'batch_done');
        expect(batchDone).toBeTruthy();
        const doneData = batchDone!.data as { message?: string };
        expect(doneData.message).toContain('成功 2');
      } finally {
        await app.close();
      }
    });

    it('未指定 drafts 时应扫描 drafts 目录', async () => {
      await fs.mkdir(path.join(tempDir, 'drafts'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'drafts', 'auto-1.md'), '# auto', 'utf8');

      const app = await buildApp(vault, config);
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/qq-ingest/compile/batch',
          headers: { 'content-type': 'application/json' },
          payload: '{}',
        });
        expect(res.statusCode).toBe(200);
        const events = parseSSEEvents(res.payload);
        expect(events.find((e) => e.event === 'done')).toBeTruthy();
      } finally {
        await app.close();
      }
    });

    it('存在无效 draftPath 应返回 400', async () => {
      const app = await buildApp(vault, config);
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/qq-ingest/compile/batch',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ drafts: ['entities/foo.md'] }),
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toContain('draftPath');
      } finally {
        await app.close();
      }
    });

    it('超过 maxBatchSize 应返回 400', async () => {
      // config.batch.maxBatchSize = 5，提交 6 个 draft
      const drafts = Array.from({ length: 6 }, (_, i) => `drafts/qa-${i}.md`);
      const app = await buildApp(vault, config);
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/qq-ingest/compile/batch',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ drafts }),
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toContain('上限');
      } finally {
        await app.close();
      }
    });

    it('空 drafts 列表应返回 400', async () => {
      const app = await buildApp(vault, config);
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/qq-ingest/compile/batch',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ drafts: [] }),
        });
        // drafts 为空数组 → 扫描 drafts 目录 → 目录不存在 → 返回 400 "无可编译的 draft 文件"
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });
  });

  // ==========================================================================
  // GET /api/qq-ingest/config
  // ==========================================================================
  describe('GET /api/qq-ingest/config', () => {
    it('应返回 QQ 配置（含默认值）', async () => {
      const app = await buildApp(vault, config);
      try {
        const res = await app.inject({ method: 'GET', url: '/api/qq-ingest/config' });
        expect(res.statusCode).toBe(200);
        const qq = JSON.parse(res.payload).qq;
        expect(qq.noise_rules['NR-1']).toBe(true);
        expect(qq.chunk_threshold).toBe(200);
        expect(qq.privacy_patterns.phone).toBeTruthy();
      } finally {
        await app.close();
      }
    });

    it('config.qq 缺失时应返回默认值兜底', async () => {
      const configWithoutQq = { ...config, qq: undefined };
      const app = await buildApp(vault, configWithoutQq);
      try {
        const res = await app.inject({ method: 'GET', url: '/api/qq-ingest/config' });
        expect(res.statusCode).toBe(200);
        const qq = JSON.parse(res.payload).qq;
        // 默认值应完整
        expect(qq.noise_rules).toBeDefined();
        expect(qq.privacy_patterns).toBeDefined();
        expect(qq.max_batch_size).toBe(20);
      } finally {
        await app.close();
      }
    });
  });

  // ==========================================================================
  // PUT /api/qq-ingest/config
  // ==========================================================================
  describe('PUT /api/qq-ingest/config', () => {
    it('部分更新应返回合并后的配置', async () => {
      // mock saveQqConfig 返回合并后的配置（避免写真实 config.json）
      saveQqConfigMock.mockResolvedValue({
        ...config,
        qq: { ...DEFAULT_QQ_CONFIG, chunk_threshold: 100 },
      });

      const app = await buildApp(vault, config);
      try {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/qq-ingest/config',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ chunk_threshold: 100 }),
        });
        expect(res.statusCode).toBe(200);
        const qq = JSON.parse(res.payload).qq;
        expect(qq.chunk_threshold).toBe(100);
        // 其他字段应保留原值
        expect(qq.max_batch_size).toBe(20);
        expect(saveQqConfigMock).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    });
  });

  // ==========================================================================
  // 辅助函数：在 vault/raw/ 下种子一个测试用预清洗结果文件，返回 rawId
  // 为什么需要：preview / extract 端点依赖 raw/ 下已存在文件，直接种子比走 upload 更独立
  // ==========================================================================
  async function seedRawFile(
    vault: VaultService,
    chatName: string,
    opts: { messages: string[] },
  ): Promise<string> {
    const rawId = crypto.randomUUID();
    // 构造与 preprocessQqChat 输出一致的中间格式
    const content = JSON.stringify({
      meta: {
        source: 'qq-chat',
        chatName,
        dateRange: '2026-07-20',
        originalCount: opts.messages.length,
        filteredCount: opts.messages.length,
        redactedCount: 0,
        rawId,
      },
      chunks: [opts.messages.map((m, i) => ({
        ts: `2026-07-20T14:30:${String(i).padStart(2, '0')}Z`,
        speaker: '测试用户',
        content: m,
        type: 'text',
      }))],
    }, null, 2);
    // 文件名含 rawId，与 upload 路由落盘格式一致
    await vault.archiveRaw(`qq-${chatName}-${rawId}.json`, content);
    return rawId;
  }
});

// Node 内置 crypto（放在文件末尾避免与 vitest hoist 冲突）
import crypto from 'node:crypto';

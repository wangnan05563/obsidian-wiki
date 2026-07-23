// qq-extract-workflow.ts 单元测试
// 覆盖：JSON 解析容错、跨 chunk 去重、draft 写入（含二次脱敏）、extractWorkflow 集成流程

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import matter from 'gray-matter';
import {
  parseLlmJsonOutput,
  deduplicateQaPairs,
  deduplicateSolutions,
  writeQaDraft,
  writeSolutionDraft,
  extractWorkflow,
} from './qq-extract-workflow.js';
import type { QqConfig, QaPair, QqSolution, AppConfig } from '../types.js';
import type { VaultService } from '../vault/vault-service.js';

// 测试用默认配置（与 config.ts defaultConfig().qq 一致 + extract_base_url 空串）
const TEST_QQ_CONFIG: QqConfig = {
  noise_rules: {
    'NR-1': true,
    'NR-2': true,
    'NR-3': true,
    'NR-4': true,
    'NR-5': true,
    'NR-6': true,
  },
  privacy_patterns: {
    phone: '1[3-9]\\d{9}',
    id_card: '\\d{17}[\\dXx]',
    email: '[\\w.-]+@[\\w.-]+\\.\\w+',
    card: '\\d{16,19}',
    qq: '(?<=QQ|扣扣|qq号|企鹅)\\s*[0-9]{5,11}',
  },
  max_batch_size: 20,
  chunk_threshold: 200,
  extract_model: 'glm-4-plus',
  extract_base_url: '',
  extract_token_budget: 50000,
};

// 测试用 AppConfig（仅含 extractWorkflow 依赖的字段）
const TEST_CONFIG: AppConfig = {
  vaultPath: '../data/vault',
  adapter: 'harness',
  llm: {
    provider: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    apiKeyRef: 'GLM_KEY',
    apiKey: 'test-api-key',
  },
  budget: { maxSteps: 20, tokenBudget: 50000 },
  server: { host: 'localhost', port: 3000 },
  localOnly: false,
  healthCheck: { staleDays: 30 },
  tunnel: {
    provider: 'cloudflare',
    localPort: 0,
    cpolarAuthtoken: '',
    binaryPath: '',
    autoStart: false,
    tunnelMode: 'quick',
    tunnelName: '',
    tunnelId: '',
    credentialsFile: '',
    hostname: '',
    certFile: '',
  },
  qq: TEST_QQ_CONFIG,
};

// 构造 VaultService mock：用最小化 mock 对象避免实现细节耦合
function createVaultMock(opts: {
  rawFiles?: Array<{ name: string; path: string; content: string }>;
  writeFileFn?: (relPath: string, content: string) => Promise<void>;
} = {}): VaultService & {
  writeFileSpy: ReturnType<typeof vi.fn>;
  readFileSpy: ReturnType<typeof vi.fn>;
  listTreeSpy: ReturnType<typeof vi.fn>;
} {
  const writeFileSpy = opts.writeFileFn
    ? vi.fn(opts.writeFileFn)
    : vi.fn(async () => undefined);
  const rawFiles = opts.rawFiles ?? [];
  const readFileSpy = vi.fn(async (relPath: string): Promise<string> => {
    const found = rawFiles.find((f) => f.path === relPath);
    if (!found) throw new Error(`mock readFile: 未找到 ${relPath}`);
    return found.content;
  });
  const listTreeSpy = vi.fn(async (dir?: string) => {
    if (dir === 'raw') {
      return rawFiles.map((f) => ({ name: f.name, path: f.path, type: 'file' as const }));
    }
    return [];
  });
  return {
    getVaultPath: () => '/mock/vault',
    init: vi.fn(async () => undefined),
    readFile: readFileSpy,
    writeFile: writeFileSpy,
    appendIndex: vi.fn(async () => undefined),
    appendLog: vi.fn(async () => undefined),
    archiveRaw: vi.fn(async (filename: string) => `raw/${filename}`),
    listTree: listTreeSpy,
    resolvePageName: vi.fn(async () => null),
    buildLinkGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
    getPageUpdated: vi.fn(async () => null),
    writeFileSpy,
    readFileSpy,
    listTreeSpy,
  } as unknown as VaultService & {
    writeFileSpy: ReturnType<typeof vi.fn>;
    readFileSpy: ReturnType<typeof vi.fn>;
    listTreeSpy: ReturnType<typeof vi.fn>;
  };
}

// 构造 LLM fetch mock：返回指定 content
function createFetchMock(content: string, ok = true, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok,
    status,
    text: async () => content,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  })) as unknown as ReturnType<typeof vi.fn>;
}

describe('qq-extract-workflow', () => {
  // ==========================================================================
  // parseLlmJsonOutput：JSON 解析容错
  // ==========================================================================
  describe('parseLlmJsonOutput', () => {
    it('应正确解析纯 JSON', () => {
      const text = JSON.stringify({
        qa_pairs: [{ question: 'Q1', answer: 'A1', answerer: 'U1', ts: '2026-01-01T00:00:00Z', context: 'C1', original_refs: ['R1'], tags: ['t1'] }],
        solutions: [],
      });
      const result = parseLlmJsonOutput(text);
      expect(result.qa_pairs).toHaveLength(1);
      expect(result.qa_pairs[0].question).toBe('Q1');
      expect(result.solutions).toHaveLength(0);
    });

    it('应剥离 ```json 代码块包裹', () => {
      const text = '```json\n{"qa_pairs":[],"solutions":[]}\n```';
      const result = parseLlmJsonOutput(text);
      expect(result.qa_pairs).toHaveLength(0);
      expect(result.solutions).toHaveLength(0);
    });

    it('应剥离 ``` 代码块包裹（无 json 标识）', () => {
      const text = '```\n{"qa_pairs":[],"solutions":[]}\n```';
      const result = parseLlmJsonOutput(text);
      expect(result.qa_pairs).toHaveLength(0);
    });

    it('应从 JSON 前后多余文字中提取 JSON', () => {
      const text = '好的，以下是抽取结果：\n{"qa_pairs":[],"solutions":[]}\n以上是结果。';
      const result = parseLlmJsonOutput(text);
      expect(result.qa_pairs).toHaveLength(0);
    });

    it('缺少 qa_pairs 字段时应返回空数组', () => {
      const text = '{"solutions":[]}';
      const result = parseLlmJsonOutput(text);
      expect(result.qa_pairs).toHaveLength(0);
      expect(result.solutions).toHaveLength(0);
    });

    it('qa_pairs 非 Array 时应返回空数组', () => {
      const text = '{"qa_pairs":null,"solutions":[]}';
      const result = parseLlmJsonOutput(text);
      expect(result.qa_pairs).toHaveLength(0);
    });

    it('无效 JSON 应抛出 SyntaxError', () => {
      const text = 'not a json at all';
      expect(() => parseLlmJsonOutput(text)).toThrow(SyntaxError);
    });
  });

  // ==========================================================================
  // deduplicateQaPairs：跨 chunk 去重
  // ==========================================================================
  describe('deduplicateQaPairs', () => {
    it('空数组应返回空数组', () => {
      expect(deduplicateQaPairs([])).toHaveLength(0);
    });

    it('无重复时应全部保留', () => {
      const pairs: QaPair[] = [
        { question: 'Q1', answer: 'A1', answerer: 'U1', ts: '2026-01-01T00:00:00Z', context: '', original_refs: [], tags: [] },
        { question: 'Q2', answer: 'A2', answerer: 'U2', ts: '2026-01-01T00:00:00Z', context: '', original_refs: [], tags: [] },
      ];
      expect(deduplicateQaPairs(pairs)).toHaveLength(2);
    });

    it('完全重复时应保留首条', () => {
      const pairs: QaPair[] = [
        { question: 'Q1', answer: 'A1', answerer: 'U1', ts: '2026-01-01T00:00:00Z', context: '', original_refs: [], tags: [] },
        { question: 'Q1', answer: 'A2', answerer: 'U2', ts: '2026-01-02T00:00:00Z', context: '', original_refs: [], tags: [] },
      ];
      const result = deduplicateQaPairs(pairs);
      expect(result).toHaveLength(1);
      expect(result[0].answer).toBe('A1');
    });

    it('大小写差异应归并为同一问题', () => {
      const pairs: QaPair[] = [
        { question: 'How to config', answer: 'A1', answerer: 'U1', ts: '', context: '', original_refs: [], tags: [] },
        { question: 'how to config', answer: 'A2', answerer: 'U2', ts: '', context: '', original_refs: [], tags: [] },
      ];
      expect(deduplicateQaPairs(pairs)).toHaveLength(1);
    });

    it('空格差异应归并为同一问题', () => {
      const pairs: QaPair[] = [
        { question: '如何配置', answer: 'A1', answerer: 'U1', ts: '', context: '', original_refs: [], tags: [] },
        { question: '如何 配置', answer: 'A2', answerer: 'U2', ts: '', context: '', original_refs: [], tags: [] },
      ];
      expect(deduplicateQaPairs(pairs)).toHaveLength(1);
    });
  });

  // ==========================================================================
  // deduplicateSolutions：跨 chunk 去重
  // ==========================================================================
  describe('deduplicateSolutions', () => {
    it('完全重复 title 时应保留首条', () => {
      const sols: QqSolution[] = [
        { title: '部署方案', background: 'B1', steps: [], caveats: '', original_refs: [], ts: '' },
        { title: '部署方案', background: 'B2', steps: [], caveats: '', original_refs: [], ts: '' },
      ];
      const result = deduplicateSolutions(sols);
      expect(result).toHaveLength(1);
      expect(result[0].background).toBe('B1');
    });

    it('大小写差异应归并', () => {
      const sols: QqSolution[] = [
        { title: 'Deploy Plan', background: 'B1', steps: [], caveats: '', original_refs: [], ts: '' },
        { title: 'deploy plan', background: 'B2', steps: [], caveats: '', original_refs: [], ts: '' },
      ];
      expect(deduplicateSolutions(sols)).toHaveLength(1);
    });
  });

  // ==========================================================================
  // writeQaDraft：draft 写入 + 二次脱敏
  // ==========================================================================
  describe('writeQaDraft', () => {
    it('应写入 drafts/qa-xxx.md 路径，frontmatter 含正确字段', async () => {
      const vault = createVaultMock();
      const qa: QaPair = {
        question: '如何配置环境变量？',
        answer: '在 .env 文件中添加 CONFIG_KEY=value',
        answerer: '张三',
        ts: '2026-07-20T14:30:15Z',
        context: '群友询问配置方法',
        original_refs: ['在 .env 文件中添加'],
        tags: ['配置'],
      };

      const relPath = await writeQaDraft(vault, 'raw-001', qa, TEST_QQ_CONFIG);

      // 路径格式校验
      expect(relPath).toMatch(/^drafts\/qa-[0-9a-f]{8}\.md$/);
      // writeFile 被调用一次
      expect(vault.writeFileSpy).toHaveBeenCalledTimes(1);
      const [writtenPath, writtenContent] = vault.writeFileSpy.mock.calls[0];
      expect(writtenPath).toBe(relPath);

      // frontmatter 字段校验
      const parsed = matter(writtenContent);
      expect(parsed.data.type).toBe('qa');
      expect(parsed.data.status).toBe('draft');
      expect(parsed.data.confidence).toBe('medium');
      expect(parsed.data.source).toBe('qq-chat:raw-001');
      expect(parsed.data.answerer).toBe('张三');
      expect(parsed.data.ts).toBe('2026-07-20T14:30:15Z');
      expect(parsed.data.tags).toEqual(['配置']);
      expect(parsed.data.original_refs).toEqual(['在 .env 文件中添加']);
    });

    it('应对 PII 执行二次脱敏', async () => {
      const vault = createVaultMock();
      const qa: QaPair = {
        question: '我的手机号是 13800138000 怎么办？',
        answer: '请发邮件到 test@example.com 联系',
        answerer: '李四',
        ts: '2026-07-20T14:30:15Z',
        context: '用户咨询',
        original_refs: ['13800138000'],
        tags: [],
      };

      await writeQaDraft(vault, 'raw-002', qa, TEST_QQ_CONFIG);

      const [, writtenContent] = vault.writeFileSpy.mock.calls[0];
      const parsed = matter(writtenContent);

      // 手机号应被替换为 [REDACTED-PHONE]
      expect(parsed.content).toContain('[REDACTED-PHONE]');
      expect(parsed.content).not.toContain('13800138000');
      // 邮箱应被替换为 [REDACTED-EMAIL]
      expect(parsed.content).toContain('[REDACTED-EMAIL]');
      expect(parsed.content).not.toContain('test@example.com');
      // original_refs 中的 PII 也应脱敏
      expect(parsed.data.original_refs).toEqual(['[REDACTED-PHONE]']);
    });

    it('question 长度 > 50 时 title 应截断并加 ...', async () => {
      const vault = createVaultMock();
      // 60 个中文字符，确保超过 50 字符阈值
      const longQuestion = '这是一个非常长的问题标题用于测试截断逻辑应该超过五十个字符才会触发截断逻辑处理逻辑一二三四五六七八九十';
      expect(longQuestion.length).toBeGreaterThan(50);
      const qa: QaPair = {
        question: longQuestion,
        answer: 'A',
        answerer: 'U',
        ts: '',
        context: '',
        original_refs: [],
        tags: [],
      };

      await writeQaDraft(vault, 'raw-003', qa, TEST_QQ_CONFIG);

      const [, writtenContent] = vault.writeFileSpy.mock.calls[0];
      const parsed = matter(writtenContent);
      expect(parsed.data.title).toBe(longQuestion.slice(0, 50) + '...');
    });
  });

  // ==========================================================================
  // writeSolutionDraft：solution draft 写入
  // ==========================================================================
  describe('writeSolutionDraft', () => {
    it('应写入 drafts/solution-xxx.md 路径，frontmatter type=solution', async () => {
      const vault = createVaultMock();
      const sol: QqSolution = {
        title: '部署方案',
        background: '生产环境部署',
        steps: ['步骤1', '步骤2'],
        caveats: '注意备份',
        original_refs: ['部署前备份'],
        ts: '2026-07-20T14:30:15Z',
      };

      const relPath = await writeSolutionDraft(vault, 'raw-004', sol, TEST_QQ_CONFIG);

      expect(relPath).toMatch(/^drafts\/solution-[0-9a-f]{8}\.md$/);
      const [, writtenContent] = vault.writeFileSpy.mock.calls[0];
      const parsed = matter(writtenContent);
      expect(parsed.data.type).toBe('solution');
      expect(parsed.data.status).toBe('draft');
      expect(parsed.data.title).toBe('部署方案');
      // 步骤应渲染为有序列表
      expect(parsed.content).toContain('1. 步骤1');
      expect(parsed.content).toContain('2. 步骤2');
    });
  });

  // ==========================================================================
  // extractWorkflow：集成流程
  // ==========================================================================
  describe('extractWorkflow', () => {
    const rawId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    beforeEach(() => {
      // 每个测试前重置 fetch mock
      vi.stubGlobal('fetch', createFetchMock('{"qa_pairs":[],"solutions":[]}'));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('rawId 找不到时应 yield error 事件', async () => {
      const vault = createVaultMock({ rawFiles: [] });
      const events: unknown[] = [];
      for await (const ev of extractWorkflow({ rawId, vault, config: TEST_CONFIG })) {
        events.push(ev);
      }
      const lastEvent = events[events.length - 1] as { step: string; status: string };
      expect(lastEvent.step).toBe('locate_raw');
      expect(lastEvent.status).toBe('error');
    });

    it('chunks 为空时应 yield done 事件', async () => {
      const vault = createVaultMock({
        rawFiles: [{
          name: `test-${rawId}.json`,
          path: `raw/test-${rawId}.json`,
          content: JSON.stringify({ chunks: [] }),
        }],
      });
      const events: unknown[] = [];
      for await (const ev of extractWorkflow({ rawId, vault, config: TEST_CONFIG })) {
        events.push(ev);
      }
      const lastEvent = events[events.length - 1] as { step: string };
      expect(lastEvent.step).toBe('done');
    });

    it('单 chunk 成功时应写入 draft 并 yield done 事件', async () => {
      const llmOutput = JSON.stringify({
        qa_pairs: [{
          question: 'Q1',
          answer: 'A1',
          answerer: 'U1',
          ts: '2026-01-01T00:00:00Z',
          context: 'C1',
          original_refs: ['R1'],
          tags: ['t1'],
        }],
        solutions: [{
          title: 'S1',
          background: 'B1',
          steps: ['step1'],
          caveats: 'note',
          original_refs: ['R2'],
          ts: '2026-01-01T00:00:00Z',
        }],
      });
      vi.stubGlobal('fetch', createFetchMock(llmOutput));

      const vault = createVaultMock({
        rawFiles: [{
          name: `test-${rawId}.json`,
          path: `raw/test-${rawId}.json`,
          content: JSON.stringify({
            chunks: [[{ ts: '2026-01-01T00:00:00Z', speaker: 'U1', content: 'Q1', type: 'text' }]],
          }),
        }],
      });

      const events: unknown[] = [];
      for await (const ev of extractWorkflow({ rawId, vault, config: TEST_CONFIG })) {
        events.push(ev);
      }

      // 应有 2 个 draft_written 事件（1 qa + 1 solution）
      const draftEvents = events.filter((e) => (e as { step: string }).step === 'draft_written');
      expect(draftEvents).toHaveLength(2);

      // 应调用 vault.writeFile 2 次
      expect(vault.writeFileSpy).toHaveBeenCalledTimes(2);

      // 最终事件为 done
      const lastEvent = events[events.length - 1] as { step: string; status: string; message: string };
      expect(lastEvent.step).toBe('done');
      expect(lastEvent.status).toBe('done');
      expect(lastEvent.message).toContain('1 qa');
      expect(lastEvent.message).toContain('1 solution');
    });

    it('LLM API 错误时应 yield chunk error 事件并继续', async () => {
      // fetch 返回 500 错误
      vi.stubGlobal('fetch', createFetchMock('Internal Server Error', false, 500));

      const vault = createVaultMock({
        rawFiles: [{
          name: `test-${rawId}.json`,
          path: `raw/test-${rawId}.json`,
          content: JSON.stringify({
            chunks: [[{ ts: '2026-01-01T00:00:00Z', speaker: 'U1', content: 'Q1', type: 'text' }]],
          }),
        }],
      });

      const events: unknown[] = [];
      for await (const ev of extractWorkflow({ rawId, vault, config: TEST_CONFIG })) {
        events.push(ev);
      }

      // 应有 extract_chunk error 事件
      const errorEvents = events.filter((e) => (e as { step: string; status: string }).step === 'extract_chunk' && (e as { status: string }).status === 'error');
      expect(errorEvents).toHaveLength(1);

      // 不应写入任何 draft
      expect(vault.writeFileSpy).not.toHaveBeenCalled();

      // 最终事件为 done（含 0 qa + 0 solution）
      const lastEvent = events[events.length - 1] as { step: string; message: string };
      expect(lastEvent.step).toBe('done');
      expect(lastEvent.message).toContain('0 qa');
    });

    it('多 chunk 应跨 chunk 合并去重', async () => {
      // 第一次调用返回 Q1，第二次返回 Q1（重复）+ Q2
      let callCount = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        callCount++;
        const content = callCount === 1
          ? JSON.stringify({
              qa_pairs: [{
                question: '如何配置', answer: 'A1', answerer: 'U1', ts: '', context: '', original_refs: [], tags: [],
              }],
              solutions: [],
            })
          : JSON.stringify({
              qa_pairs: [
                { question: '如何配置', answer: 'A2', answerer: 'U2', ts: '', context: '', original_refs: [], tags: [] },
                { question: '如何部署', answer: 'A3', answerer: 'U3', ts: '', context: '', original_refs: [], tags: [] },
              ],
              solutions: [],
            });
        return {
          ok: true,
          status: 200,
          text: async () => content,
          json: async () => ({ choices: [{ message: { content } }] }),
        };
      }));

      const vault = createVaultMock({
        rawFiles: [{
          name: `test-${rawId}.json`,
          path: `raw/test-${rawId}.json`,
          content: JSON.stringify({
            chunks: [
              [{ ts: '', speaker: 'U1', content: 'Q1', type: 'text' }],
              [{ ts: '', speaker: 'U2', content: 'Q2', type: 'text' }],
            ],
          }),
        }],
      });

      const events: unknown[] = [];
      for await (const ev of extractWorkflow({ rawId, vault, config: TEST_CONFIG })) {
        events.push(ev);
      }

      // 写入 3 个 draft（每个 qa 一条），但 done 事件统计应为 2（去重后）
      const draftEvents = events.filter((e) => (e as { step: string }).step === 'draft_written');
      expect(draftEvents).toHaveLength(3);

      const lastEvent = events[events.length - 1] as { step: string; message: string };
      expect(lastEvent.step).toBe('done');
      expect(lastEvent.message).toContain('2 qa');
    });

    it('QQ 配置缺失时应 yield error 事件', async () => {
      const configWithoutQq: AppConfig = { ...TEST_CONFIG, qq: undefined };
      const vault = createVaultMock();

      const events: unknown[] = [];
      for await (const ev of extractWorkflow({ rawId, vault, config: configWithoutQq })) {
        events.push(ev);
      }

      const firstEvent = events[0] as { step: string; status: string };
      expect(firstEvent.step).toBe('error');
      expect(firstEvent.status).toBe('error');
    });

    it('超过 max_batch_size 时应截断处理', async () => {
      // 设 max_batch_size = 2，提供 3 个 chunk
      const configLimited: AppConfig = {
        ...TEST_CONFIG,
        qq: { ...TEST_QQ_CONFIG, max_batch_size: 2 },
      };
      vi.stubGlobal('fetch', createFetchMock('{"qa_pairs":[],"solutions":[]}'));

      const vault = createVaultMock({
        rawFiles: [{
          name: `test-${rawId}.json`,
          path: `raw/test-${rawId}.json`,
          content: JSON.stringify({
            chunks: [
              [{ ts: '', speaker: 'U1', content: 'Q1', type: 'text' }],
              [{ ts: '', speaker: 'U2', content: 'Q2', type: 'text' }],
              [{ ts: '', speaker: 'U3', content: 'Q3', type: 'text' }],
            ],
          }),
        }],
      });

      const events: unknown[] = [];
      for await (const ev of extractWorkflow({ rawId, vault, config: configLimited })) {
        events.push(ev);
      }

      // 应有 batch_limit 事件
      const batchLimitEvents = events.filter((e) => (e as { step: string }).step === 'batch_limit');
      expect(batchLimitEvents).toHaveLength(1);

      // 应只处理 2 个 chunk（extract_chunk done 事件数 = 2）
      const chunkDoneEvents = events.filter((e) => {
        const ev = e as { step: string; status: string };
        return ev.step === 'extract_chunk' && ev.status === 'done';
      });
      expect(chunkDoneEvents).toHaveLength(2);
    });
  });
});

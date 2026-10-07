// ambiguity-detector.ts 单元测试。
// 分层策略：
//   - extractJsonObject / normalizeReport：纯函数，直接喂畸形/边界 JSON 断言归一化语义；
//   - detectAmbiguity：mock @wiki/harness（避免真实 LLM 调用/网络）与 node:fs/promises
//     （clarify prompt 文件读取，避免耦合仓库 prompts/clarify.md 内容），
//     断言 prompt 构造（模板替换/历史拼接）、harness 配置覆盖（tools/预算/hooks）、
//     fail-open 语义（failed 状态/垃圾输出 → null）与 prompt 缓存。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HarnessConfig } from '@wiki/harness';

const h = vi.hoisted(() => ({
  // Harness.run 的可编程结果（每个用例设置）
  runResults: [] as Array<{ status: string; finalContent?: string }>,
  runError: null as unknown,
  tasks: [] as string[],
  configs: [] as Array<Record<string, unknown>>,
  harnessCount: 0,
  readFileCount: 0,
}));

// clarify prompt 受控模板（模块级缓存只会读取一次，见最后一条缓存用例）
const PROMPT_TEMPLATE = 'TPL>>{question}';

vi.mock('@wiki/harness', () => ({
  Harness: class FakeHarness {
    private cfg: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.cfg = config;
      h.configs.push(config);
      h.harnessCount++;
    }
    async run(input: { task: string }) {
      h.tasks.push(input.task);
      if (h.runError !== null) throw h.runError;
      const idx = Math.min(h.tasks.length - 1, h.runResults.length - 1);
      return h.runResults[idx] ?? { status: 'failed' };
    }
  },
}));

// mock node:fs/promises 的 readFile：clarify prompt 从受控模板读取，不碰真实文件
// 为什么保留 importOriginal 展开：导入图里的其他模块可能使用 fs/promises 的其余导出；
// 为什么同时提供 default：源码用 `import fs from 'node:fs/promises'` 默认导入，
//   interop 需要 default 形态，否则命中的是真实模块对象（mock 失效）
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFileMock = async (...args: unknown[]) => {
    h.readFileCount++;
    if (typeof args[1] === 'string') return PROMPT_TEMPLATE;
    return Buffer.from(PROMPT_TEMPLATE, 'utf8');
  };
  const overridden = { ...actual, readFile: readFileMock };
  return { ...overridden, default: overridden };
});

import {
  extractJsonObject,
  normalizeReport,
  detectAmbiguity,
} from '../src/workflows/clarify/ambiguity-detector.js';

function baseHarnessConfig(): HarnessConfig {
  return {
    llm: { provider: 'glm', baseUrl: 'https://example.invalid/v4', model: 'm', apiKey: 'k' },
    budget: { maxSteps: 20, tokenBudget: 50000 },
    tools: [{ name: 'read_file' } as never],
    hooks: { preTool: () => {} } as never,
  } as unknown as HarnessConfig;
}

beforeEach(() => {
  h.runResults = [];
  h.runError = null;
  h.tasks = [];
  h.configs = [];
  h.harnessCount = 0;
  // readFileCount 故意不重置：用于跨用例验证 prompt 单点缓存只读一次
});

describe('extractJsonObject', () => {
  it('裸 JSON 直接解析', () => {
    expect(extractJsonObject('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it('容忍 ```json 代码块包裹', () => {
    const raw = '这是我的分析：\n```json\n{"ambiguous":true}\n```\n希望有帮助';
    expect(extractJsonObject(raw)).toEqual({ ambiguous: true });
  });

  it('取首个 { 到末个 } 的子串', () => {
    expect(extractJsonObject('前缀 {"x":"}内嵌"} 后缀')).toEqual({ x: '}内嵌' });
  });

  it('无花括号 / 括号不成对（闭括号缺失或顺序颠倒）→ null', () => {
    expect(extractJsonObject('完全没有任何括号')).toBeNull();
    expect(extractJsonObject('{"unclosed": 1')).toBeNull();
    expect(extractJsonObject('}{')).toBeNull();
  });

  it('内容不是合法 JSON → null', () => {
    expect(extractJsonObject('{not valid json}')).toBeNull();
  });
});

describe('normalizeReport', () => {
  it('非对象输入（null/数组/字符串/数字）→ null', () => {
    expect(normalizeReport(null)).toBeNull();
    expect(normalizeReport([{ ambiguous: true }])).toBeNull();
    expect(normalizeReport('text')).toBeNull();
    expect(normalizeReport(42)).toBeNull();
  });

  it('合法完整报告原样归一', () => {
    const r = normalizeReport({
      ambiguous: true,
      confidence: 0.8,
      interpretations: [{ label: '解读A', description: '说明A' }],
      recommendedIndex: 0,
    });
    expect(r).toEqual({
      ambiguous: true,
      confidence: 0.8,
      interpretations: [{ label: '解读A', description: '说明A' }],
      recommendedIndex: 0,
    });
  });

  it('ambiguous 非布尔 → 默认 false；confidence 非法/越界 → 0 或 clamp 到 [0,1]', () => {
    expect(normalizeReport({ ambiguous: 'yes' })!.ambiguous).toBe(false);
    expect(normalizeReport({ confidence: 5 })!.confidence).toBe(1);
    expect(normalizeReport({ confidence: -2 })!.confidence).toBe(0);
    expect(normalizeReport({ confidence: Number.NaN })!.confidence).toBe(0);
    expect(normalizeReport({ confidence: '0.9' })!.confidence).toBe(0);
  });

  it('interpretations：剔除非对象项与空 label+description 项，字符串 trim', () => {
    const r = normalizeReport({
      interpretations: [
        null,
        'str',
        { label: '', description: '' },
        { label: '  A  ', description: '  说明  ' },
      ],
    })!;
    expect(r.interpretations).toEqual([{ label: 'A', description: '说明' }]);
  });

  it('label 缺失时用 description 前 10 字兜底', () => {
    const r = normalizeReport({
      interpretations: [{ description: '零一二三四五六七八九十十一' }],
    })!;
    expect(r.interpretations[0].label).toBe('零一二三四五六七八九');
    expect(r.interpretations[0].description).toBe('零一二三四五六七八九十十一');
  });

  it('description 类型错误时为空串，label 保留', () => {
    const r = normalizeReport({ interpretations: [{ label: 'L', description: 42 }] })!;
    expect(r.interpretations).toEqual([{ label: 'L', description: '' }]);
  });

  it('recommendedIndex 非整数 → 0', () => {
    expect(normalizeReport({ recommendedIndex: 1.5 })!.recommendedIndex).toBe(0);
    expect(normalizeReport({ recommendedIndex: '2' })!.recommendedIndex).toBe(0);
    expect(normalizeReport({ recommendedIndex: 2 })!.recommendedIndex).toBe(2);
  });

  it('空对象 → 全默认值结构', () => {
    expect(normalizeReport({})).toEqual({
      ambiguous: false,
      confidence: 0,
      interpretations: [],
      recommendedIndex: 0,
    });
  });
});

describe('detectAmbiguity', () => {
  it('空串/纯空白/undefined 兜底 → null 且不构造 Harness', async () => {
    expect(await detectAmbiguity(baseHarnessConfig(), '')).toBeNull();
    expect(await detectAmbiguity(baseHarnessConfig(), '   \n\t ')).toBeNull();
    expect(await detectAmbiguity(baseHarnessConfig(), undefined as unknown as string)).toBeNull();
    expect(h.harnessCount).toBe(0);
  });

  it('harness 配置被覆盖为单轮无工具无钩子，保留调用方 llm 配置', async () => {
    h.runResults = [{ status: 'completed', finalContent: '{"ambiguous":false}' }];
    await detectAmbiguity(baseHarnessConfig(), '问题一');
    const cfg = h.configs[0];
    expect(cfg.tools).toEqual([]);
    expect(cfg.budget).toEqual({ maxSteps: 1, tokenBudget: 2048 });
    expect(cfg.hooks).toEqual({});
    expect(cfg.llm).toEqual(baseHarnessConfig().llm);
  });

  it('问题被 trim 后替换进模板；无历史时不追加历史段', async () => {
    h.runResults = [{ status: 'completed', finalContent: '{}' }];
    await detectAmbiguity(baseHarnessConfig(), '  歧义问题  ');
    expect(h.tasks[0]).toBe('TPL>>歧义问题');
  });

  it('历史对话拼在任务尾部：user→用户、其它→助手', async () => {
    h.runResults = [{ status: 'completed', finalContent: '{}' }];
    await detectAmbiguity(baseHarnessConfig(), '它怎么配置', [
      { role: 'user', content: '讲讲网关' },
      { role: 'assistant', content: '网关如下' },
    ]);
    expect(h.tasks[0]).toContain('TPL>>它怎么配置');
    expect(h.tasks[0]).toContain('## 历史对话（用于消解指代）');
    expect(h.tasks[0]).toContain('用户: 讲讲网关');
    expect(h.tasks[0]).toContain('助手: 网关如下');
  });

  it('history 为空数组时不追加历史段', async () => {
    h.runResults = [{ status: 'completed', finalContent: '{}' }];
    await detectAmbiguity(baseHarnessConfig(), '问题', []);
    expect(h.tasks[0]).toBe('TPL>>问题');
  });

  it('成功输出（代码块包裹的 JSON）解析为归一化报告', async () => {
    h.runResults = [{
      status: 'completed',
      finalContent: '```json\n{"ambiguous":true,"confidence":0.9,"interpretations":[{"label":"A","description":"a"},{"label":"B","description":"b"}],"recommendedIndex":1}\n```',
    }];
    const r = await detectAmbiguity(baseHarnessConfig(), '多义问题');
    expect(r).toEqual({
      ambiguous: true,
      confidence: 0.9,
      interpretations: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      recommendedIndex: 1,
    });
  });

  it('harness 状态 failed → null', async () => {
    h.runResults = [{ status: 'failed' }];
    expect(await detectAmbiguity(baseHarnessConfig(), '问题')).toBeNull();
  });

  it('输出无 JSON / finalContent 缺失 → null（fail-open）', async () => {
    h.runResults = [{ status: 'completed', finalContent: '抱歉，我无法判断' }];
    expect(await detectAmbiguity(baseHarnessConfig(), '问题A')).toBeNull();
    h.runResults = [{ status: 'completed' }];
    expect(await detectAmbiguity(baseHarnessConfig(), '问题B')).toBeNull();
  });

  it('harness.run 抛错时异常向上传播（由上层门禁 catch 实现 fail-open）', async () => {
    h.runError = new Error('network down');
    await expect(detectAmbiguity(baseHarnessConfig(), '问题')).rejects.toThrow('network down');
    h.runError = null;
  });

  it('clarify prompt 单点缓存：首次读文件后不再重复读取', async () => {
    h.runResults = [
      { status: 'completed', finalContent: '{}' },
      { status: 'completed', finalContent: '{}' },
    ];
    const before = h.readFileCount;
    await detectAmbiguity(baseHarnessConfig(), '第一次问题');
    await detectAmbiguity(baseHarnessConfig(), '第二次问题');
    // 本文件更靠前的用例已触发首次加载 → 此处两次调用都应命中缓存
    expect(h.readFileCount - before).toBe(0);
    expect(h.tasks).toHaveLength(2);
  });
});

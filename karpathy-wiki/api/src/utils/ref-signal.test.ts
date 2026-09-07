// ref-signal.ts 与 refs 对象化传输（FR-19）单元测试：覆盖 T3-1/T3-2/T3-3
// - T3-1 authority：source 类别经 authorityMap 映射，未覆盖归 unknown
// - T3-2 confidence / review：正文非空 / 存在 reviewed_at
// - T3-3 传输：upgradeRefs 把 string[] refs 升级为信号对象数组（含 knowledgeStatus 继承）
import { describe, it, expect } from 'vitest';
import { buildRefSignals } from './ref-signal.js';
import { normalizeRefs } from '../types.js';
import { upgradeRefs } from '../workflows/query-workflow.js';
import type { AppConfig, AnswerChunk } from '../types.js';

// 最小 Vault mock：按路径返回不同 frontmatter，缺文件抛错以模拟读取失败
const mockVault = {
  readFile: async (p: string): Promise<string> => {
    const pages: Record<string, string> = {
      'web.md': '---\nsource: web\n---\n正文内容',
      'manual.md': '---\nsource: manual\nreviewed_at: 2026-08-01\n---\n正文内容',
      'empty.md': '---\nsource: qq-chat\n---\n',
      'stale.md': '---\nsource: web\nknowledge_class: dated\nupdated: 2020-01-01\n---\n正文内容',
    };
    if (!pages[p]) throw new Error(`not found: ${p}`);
    return pages[p];
  },
} as unknown as import('../vault/vault-service.js').VaultService;

const appConfig: AppConfig = {
  refs: { authorityMap: { web: 'high', manual: 'medium', 'qq-chat': 'low' } },
  knowledge: { staleDays: 365 },
} as unknown as AppConfig;

describe('buildRefSignals（T3-1 authority + T3-2 confidence/review + 时效继承）', () => {
  it('web → high；manual → medium；qq-chat → low；未覆盖 source → unknown', async () => {
    const signs = await buildRefSignals(['web.md', 'manual.md', 'empty.md', 'unknown.md'], mockVault, appConfig);
    const byPath = Object.fromEntries(signs.map((s) => [s.path, s]));
    expect(byPath['web.md'].authority).toBe('high');
    expect(byPath['manual.md'].authority).toBe('medium');
    expect(byPath['empty.md'].authority).toBe('low');
    // unknown.md 读取失败 → unknown（保留引用且信号未知）
    expect(byPath['unknown.md'].authority).toBe('unknown');
  });

  it('confidence：正文非空为 true，空正文为 false', async () => {
    const signs = await buildRefSignals(['web.md', 'empty.md'], mockVault, appConfig);
    const byPath = Object.fromEntries(signs.map((s) => [s.path, s]));
    expect(byPath['web.md'].confidence).toBe(true);
    expect(byPath['empty.md'].confidence).toBe(false);
  });

  it('review：存在 reviewed_at 为 true，否则 false', async () => {
    const signs = await buildRefSignals(['manual.md', 'web.md'], mockVault, appConfig);
    const byPath = Object.fromEntries(signs.map((s) => [s.path, s]));
    expect(byPath['manual.md'].review).toBe(true);
    expect(byPath['web.md'].review).toBe(false);
  });

  it('knowledgeStatus 继承 FR-18：dated 超阈值 → stale，未标 class → unknown', async () => {
    const signs = await buildRefSignals(['stale.md', 'web.md'], mockVault, appConfig);
    const byPath = Object.fromEntries(signs.map((s) => [s.path, s]));
    expect(byPath['stale.md'].knowledgeStatus).toBe('stale');
    expect(byPath['web.md'].knowledgeStatus).toBe('unknown');
  });

  it('单页读失败不丢弃引用（AC-19-6）：信号冷启动为 unknown/false', async () => {
    const signs = await buildRefSignals(['missing.md'], mockVault, appConfig);
    expect(signs.length).toBe(1);
    expect(signs[0]).toMatchObject({
      path: 'missing.md',
      authority: 'unknown',
      confidence: false,
      review: false,
      knowledgeStatus: 'unknown',
    });
  });
});

describe('normalizeRefs（AC-19-1/19-5 refs 双形态兼容）', () => {
  it('纯 string 数组 → 全 unknown/false 信号对象', () => {
    const out = normalizeRefs(['a.md', 'b.md']);
    expect(out).toEqual([
      { path: 'a.md', authority: 'unknown', confidence: false, review: false, knowledgeStatus: 'unknown' },
      { path: 'b.md', authority: 'unknown', confidence: false, review: false, knowledgeStatus: 'unknown' },
    ]);
  });

  it('对象数组 → 字段透传并补齐缺省', () => {
    const out = normalizeRefs([
      { path: 'a.md', authority: 'high', confidence: true, review: true, knowledgeStatus: 'ok' },
    ]);
    expect(out[0]).toEqual({
      path: 'a.md', authority: 'high', confidence: true, review: true, knowledgeStatus: 'ok',
    });
  });

  it('未定义/非数组 → 空数组', () => {
    expect(normalizeRefs(undefined)).toEqual([]);
  });
});

describe('upgradeRefs（T3-3 refs 对象化传输）', () => {
  it('done chunk 的 string[] refs 升级为信号对象数组', async () => {
    const source = (async function* (): AsyncGenerator<AnswerChunk> {
      yield { refs: ['web.md', 'manual.md'], done: true };
    })();
    const out: AnswerChunk[] = [];
    for await (const chunk of upgradeRefs(source, mockVault, appConfig)) {
      out.push(chunk);
    }
    expect(out[0].refs).toHaveLength(2);
    expect(out[0].refs![0]).toEqual(expect.objectContaining({ path: 'web.md', authority: 'high' }));
    expect(out[0].refs![1]).toEqual(expect.objectContaining({ path: 'manual.md', review: true }));
  });

  it('无 refs 的中间文本块原样透传', async () => {
    const source = (async function* (): AsyncGenerator<AnswerChunk> {
      yield { text: '你好' };
    })();
    const out: AnswerChunk[] = [];
    for await (const chunk of upgradeRefs(source, mockVault, appConfig)) {
      out.push(chunk);
    }
    expect(out[0]).toEqual({ text: '你好' });
  });

  it('空 refs 数组不触发转换，维持透传', async () => {
    const source = (async function* (): AsyncGenerator<AnswerChunk> {
      yield { refs: [], done: true };
    })();
    const out: AnswerChunk[] = [];
    for await (const chunk of upgradeRefs(source, mockVault, appConfig)) {
      out.push(chunk);
    }
    expect(out[0]).toEqual({ refs: [], done: true });
  });
});
import { describe, it, expect } from 'vitest';
import {
  computeGaps,
  streamGapSuggestions,
  summarizeGapsText,
  type GapResult,
  type PageMeta,
} from './gaps-workflow.js';

// 构造页面元数据：name 即 pageName（路由 entities/<name>.md），links 为 [[pageName]] 双链目标
function page(name: string, opts: { tags?: string[]; links?: string[] } = {}): PageMeta {
  return {
    path: `entities/${name}.md`,
    pageName: name,
    tags: opts.tags ?? [],
    wikilinks: new Set(opts.links ?? []),
  };
}

describe('computeGaps', () => {
  it('小样本库返回 insufficient-data', () => {
    const r = computeGaps([page('a'), page('b')], 20);
    expect(r.status).toBe('insufficient-data');
    if (r.status === 'insufficient-data') expect(r.pageCount).toBe(2);
  });

  it('孤立节点被识别', () => {
    // iso 无任何链接 → 孤立；x<->y 互链 → 不属于孤立
    const pages = [page('iso'), page('x', { links: ['y'] }), page('y', { links: ['x'] })];
    const r = computeGaps(pages, 3);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.isolated).toEqual(['entities/iso.md']);
      expect(r.unlinkedPairs).toHaveLength(0);
    }
  });

  it('低密度社区：size>=3 且 边数<节点数', () => {
    // x->y->z 链式：3 节点、2 边，边数 < 节点数 → 低密度社区
    const pages = [page('x', { links: ['y'] }), page('y', { links: ['z'] }), page('z')];
    const r = computeGaps(pages, 3);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.lowDensity).toHaveLength(1);
      expect(r.lowDensity[0].paths).toHaveLength(3);
      expect(r.lowDensity[0].edgeCount).toBe(2);
    }
  });

  it('同标签未双链对全部被识别', () => {
    // a/b/c 同标签 nlp 且两两无链接 → C(3,2)=3 对
    const pages = [page('a', { tags: ['nlp'] }), page('b', { tags: ['nlp'] }), page('c', { tags: ['nlp'] })];
    const r = computeGaps(pages, 3);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.unlinkedPairs).toHaveLength(3);
      for (const p of r.unlinkedPairs) expect(p.sharedTags).toEqual(['nlp']);
    }
  });

  it('二元互链共享标签不误报为缺口', () => {
    // a<->b 已互链且同标签，不应出现在 unlinkedPairs，也不孤立
    const pages = [
      page('a', { tags: ['nlp'], links: ['b'] }),
      page('b', { tags: ['nlp'], links: ['a'] }),
    ];
    const r = computeGaps(pages, 2);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.isolated).toHaveLength(0);
      expect(r.unlinkedPairs).toHaveLength(0);
      expect(r.lowDensity).toHaveLength(0); // 2 节点 < 3，不属于低密度社区
    }
  });
});

// 构造一个字段齐全的 ok 结果，供 LLM 层用例复用
function okResult(): Extract<GapResult, { status: 'ok' }> {
  return {
    status: 'ok',
    pageCount: 3,
    isolated: ['entities/iso.md'],
    lowDensity: [{ paths: ['entities/x.md', 'entities/y.md', 'entities/z.md'], edgeCount: 2 }],
    unlinkedPairs: [
      { a: 'a', b: 'b', pathA: 'entities/a.md', pathB: 'entities/b.md', sharedTags: ['nlp'] },
    ],
  };
}

describe('summarizeGapsText', () => {
  it('把三类缺口整理成人类可读摘要', () => {
    const t = summarizeGapsText(okResult());
    expect(t).toContain('孤立节点');
    expect(t).toContain('iso');
    expect(t).toContain('低密度社区');
    expect(t).toContain('同标签建议互引');
    expect(t).toContain('[[a]] ↔ [[b]]');
  });

  it('无缺口时返回提示语', () => {
    const r: Extract<GapResult, { status: 'ok' }> = {
      status: 'ok',
      pageCount: 3,
      isolated: [],
      lowDensity: [],
      unlinkedPairs: [],
    };
    expect(summarizeGapsText(r)).toContain('未发现明显结构缺口');
  });
});

describe('streamGapSuggestions', () => {
  it('逐段透传 delta 文本', async () => {
    const stream = streamGapSuggestions(
      { llm: { provider: 'mock', baseUrl: '', model: '', apiKey: '' }, tools: [], budget: { maxSteps: 1, tokenBudget: 1 } },
      okResult(),
      async function* () {
        yield { type: 'delta', text: '第一段' };
        yield { type: 'delta', text: '第二段' };
      },
    );
    const out: string[] = [];
    for await (const part of stream) out.push(part.text);
    expect(out).toEqual(['第一段', '第二段']);
  });

  it('LLM 返回 error 事件时抛出异常（route 据此降级）', async () => {
    const stream = streamGapSuggestions(
      { llm: { provider: 'mock', baseUrl: '', model: '', apiKey: '' }, tools: [], budget: { maxSteps: 1, tokenBudget: 1 } },
      okResult(),
      async function* () {
        yield { type: 'error', message: 'upstream timeout' };
      },
    );
    await expect(async () => {
      for await (const _part of stream) {
        // 不应产生任何文本输出
      }
    }).rejects.toThrow('upstream timeout');
  });

  it('忽略非 delta 事件（如 thinking）', async () => {
    const stream = streamGapSuggestions(
      { llm: { provider: 'mock', baseUrl: '', model: '', apiKey: '' }, tools: [], budget: { maxSteps: 1, tokenBudget: 1 } },
      okResult(),
      async function* () {
        yield { type: 'thinking', text: '内部思考' };
        yield { type: 'delta', text: '最终建议' };
      },
    );
    const out: string[] = [];
    for await (const part of stream) out.push(part.text);
    expect(out).toEqual(['最终建议']);
  });
});
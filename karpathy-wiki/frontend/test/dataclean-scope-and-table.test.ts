// wiki三期 T02472（PRD §16 数据清洗口径与交互）单测：
//   L1 总页数口径与仪表盘同源；L2 评分卡改成可操作的问题分类；L3 表格搜索/排序/分页/跨页选择。
// 约定：被测逻辑全部是 frontend/src/utils/dataCleanPresentation.ts 的纯函数（本项目不挂载 SFC）。
import { describe, expect, it } from 'vitest';
import type { PageQualityScore } from '../src/types';
import {
  ISSUE_CATEGORIES,
  PAGE_SIZE_OPTIONS,
  PAGE_SCOPE_DIRS,
  PAGE_TOTAL_HINT,
  SHORT_WORDS_MIN,
  buildIssueContext,
  categoryCounts,
  categoryMeta,
  categoryPaths,
  defaultTableQuery,
  filterPages,
  mergeSelection,
  pageIssueKeys,
  problemCount,
  selectionSummary,
  slicePage,
  sortPages,
  totalPageCount,
} from '../src/utils/dataCleanPresentation';

/** 造一条「健康」页面：有元信息、有出链、字数达标；用 metadata 覆写制造各类问题 */
function makePage(over: Partial<PageQualityScore> & { path: string }): PageQualityScore {
  const { metadata: metaOver, ...rest } = over;
  return {
    title: over.path.split('/').pop()!.replace('.md', ''),
    qualityScore: 90,
    category: { length: 20, links: 25, frontmatter: 25, citations: 20, duplicate: 0, freshness: 10 },
    issues: [],
    suggestions: [],
    ...rest,
    metadata: {
      wordCount: 300,
      lineCount: 40,
      internalLinks: 5,
      inboundLinks: 2,
      lastModified: '2026-10-01T00:00:00Z',
      hasFrontmatter: true,
      isDraft: false,
      fileSizeBytes: 4096,
      hasBom: false,
      encoding: 'utf-8' as const,
      directory: over.path.split('/')[0],
      ...metaOver,
    },
  } as PageQualityScore;
}

describe('L1 页面总数口径', () => {
  it('口径目录与后端 page-scope 一致：6 个页面目录，含 queries/qa/solutions', () => {
    expect(PAGE_SCOPE_DIRS).toEqual(['entities', 'concepts', 'comparisons', 'queries', 'qa', 'solutions']);
    // drafts 是中间态、raw 是原始资料，都不算正式页面
    expect(PAGE_SCOPE_DIRS).not.toContain('drafts');
    expect(PAGE_SCOPE_DIRS).not.toContain('raw');
  });

  it('总数卡片把口径写在数旁边，并声明与仪表盘同源', () => {
    expect(PAGE_TOTAL_HINT).toContain('与仪表盘一致');
    for (const d of PAGE_SCOPE_DIRS) expect(PAGE_TOTAL_HINT).toContain(d);
  });
});

describe('L2 可操作问题分类', () => {
  it('五类标签用可行动的大白话，不再是「优秀/良好/需改进」', () => {
    expect(ISSUE_CATEGORIES.map((c) => c.label)).toEqual(['缺元信息', '标题重复', '无出链', '字数过短', '读取失败']);
    expect(ISSUE_CATEGORIES.every((c) => c.desc.length > 0 && c.action.length > 0)).toBe(true);
  });

  it('缺元信息 / 无出链 / 字数过短 / 读取失败各自命中对应分类，健康页不命中', () => {
    const noFm = makePage({ path: 'concepts/a.md', metadata: { hasFrontmatter: false } });
    const noLink = makePage({ path: 'concepts/b.md', metadata: { internalLinks: 0 } });
    const short = makePage({ path: 'concepts/c.md', metadata: { wordCount: SHORT_WORDS_MIN - 1 } });
    const broken = makePage({ path: 'concepts/d.md', issues: [{ code: 'SCAN_ERROR', severity: 'error', detail: 'Failed to read' }] });
    const good = makePage({ path: 'concepts/g.md' });
    const ctx = buildIssueContext([noFm, noLink, short, broken, good]);
    expect(pageIssueKeys(noFm, ctx)).toContain('missingFrontmatter');
    expect(pageIssueKeys(noLink, ctx)).toContain('noOutlinks');
    expect(pageIssueKeys(short, ctx)).toContain('tooShort');
    expect(pageIssueKeys(broken, ctx)).toContain('scanError');
    expect(problemCount(good, ctx)).toBe(0);
  });

  it('标题重复按归一化标题判定（大小写与首尾空格不算差异），同组的每个页面都算重复', () => {
    const a = makePage({ path: 'entities/x.md', title: 'Karpathy' });
    const b = makePage({ path: 'concepts/y.md', title: '  karpathy ' });
    const c = makePage({ path: 'concepts/z.md', title: 'Unique' });
    const ctx = buildIssueContext([a, b, c]);
    expect(pageIssueKeys(a, ctx)).toContain('duplicateTitle');
    expect(pageIssueKeys(b, ctx)).toContain('duplicateTitle');
    expect(pageIssueKeys(c, ctx)).not.toContain('duplicateTitle');
  });

  it('字数刚好等于阈值不算过短（阈值语义是「不足」）', () => {
    const edge = makePage({ path: 'concepts/e.md', metadata: { wordCount: SHORT_WORDS_MIN } });
    const ctx = buildIssueContext([edge]);
    expect(pageIssueKeys(edge, ctx)).not.toContain('tooShort');
  });

  it('卡片数字与批量动作共用同一份分类结果：计数与路径集合互相一致', () => {
    const p1 = makePage({ path: 'concepts/one.md', metadata: { hasFrontmatter: false } });
    const p2 = makePage({ path: 'concepts/two.md', metadata: { hasFrontmatter: false, internalLinks: 0 } });
    const pages = [p1, p2];
    const ctx = buildIssueContext(pages);
    const counts = categoryCounts(pages, ctx);
    expect(counts.missingFrontmatter).toBe(2);
    expect(counts.noOutlinks).toBe(1);
    expect(counts.duplicateTitle).toBe(0);
    expect(categoryPaths(pages, ctx, 'missingFrontmatter')).toEqual(['concepts/one.md', 'concepts/two.md']);
    expect(categoryPaths(pages, ctx, 'noOutlinks')).toEqual(['concepts/two.md']);
  });

  it('0 个的分类不说「一切正常」，只说没有这类页面', () => {
    expect(categoryMeta(0)).toBe('没有这类页面');
    expect(categoryMeta(3)).not.toContain('正常');
  });
});

describe('L3 搜索 / 排序 / 分页', () => {
  const dirty = makePage({ path: 'entities/dup-a.md', title: 'Same', metadata: { hasFrontmatter: false, internalLinks: 0, wordCount: 120 } });
  const half = makePage({ path: 'concepts/half.md', title: 'Half', metadata: { internalLinks: 0, wordCount: 200 } });
  const clean = makePage({ path: 'queries/clean.md', title: 'Clean', metadata: { wordCount: 300 } });
  const pages = [clean, half, dirty];
  const ctx = buildIssueContext(pages);
  const base = defaultTableQuery();

  it('默认按问题数倒序：最该处理的页面排在第一页最前', () => {
    expect(base.sortProp).toBe('problems');
    expect(base.sortOrder).toBe('descending');
    expect(sortPages(pages, ctx, base.sortProp, base.sortOrder).map((p) => p.path))
      .toEqual(['entities/dup-a.md', 'concepts/half.md', 'queries/clean.md']);
  });

  it('升序同样可用', () => {
    expect(sortPages(pages, ctx, 'problems', 'ascending').map((p) => p.path))
      .toEqual(['queries/clean.md', 'concepts/half.md', 'entities/dup-a.md']);
  });

  it('关键字命中路径或标题（大小写不敏感），分类与目录筛选可叠加', () => {
    expect(filterPages(pages, ctx, { ...base, keyword: 'dup' }).map((p) => p.path)).toEqual(['entities/dup-a.md']);
    expect(filterPages(pages, ctx, { ...base, keyword: 'SAME' }).map((p) => p.path)).toEqual(['entities/dup-a.md']);
    expect(filterPages(pages, ctx, { ...base, issue: 'noOutlinks' })).toHaveLength(2);
    expect(filterPages(pages, ctx, { ...base, dir: 'concepts' }).map((p) => p.path)).toEqual(['concepts/half.md']);
    expect(filterPages(pages, ctx, { ...base, dir: 'concepts', issue: 'noOutlinks' })).toHaveLength(1);
    expect(filterPages(pages, ctx, { ...base, dir: 'concepts', issue: 'missingFrontmatter' })).toHaveLength(0);
  });

  it('数值列按数值排序，同分时按路径升序（翻页顺序抖动会丢勾选）', () => {
    expect(sortPages(pages, ctx, 'wordCount', 'descending').map((p) => p.path))
      .toEqual(['queries/clean.md', 'concepts/half.md', 'entities/dup-a.md']);
    const sameScore = [makePage({ path: 'concepts/b.md', qualityScore: 70 }), makePage({ path: 'concepts/a.md', qualityScore: 70 })];
    const ctxSame = buildIssueContext(sameScore);
    expect(sortPages(sameScore, ctxSame, 'qualityScore', 'descending').map((p) => p.path))
      .toEqual(['concepts/a.md', 'concepts/b.md']);
  });

  it('分页与总页数：空集合也算 1 页，越界页码返回空数组', () => {
    expect(totalPageCount(0, 50)).toBe(1);
    expect(totalPageCount(101, 50)).toBe(3);
    expect(slicePage(pages, 1, 2).map((p) => p.path)).toEqual(['queries/clean.md', 'concepts/half.md']);
    expect(slicePage(pages, 2, 2).map((p) => p.path)).toEqual(['entities/dup-a.md']);
    expect(slicePage(pages, 3, 2)).toHaveLength(0);
    expect(slicePage(pages, 0, 2)).toHaveLength(2);
  });

  it('翻页只替换当前页的选择，其他页已选页面不丢', () => {
    const keptAcrossPages = ['entities/dup-a.md', 'queries/clean.md'];
    // 当前页是 concepts/half.md，用户在表格取消勾选它 → 本页清掉，其他两页保留
    expect(mergeSelection(keptAcrossPages, ['concepts/half.md'], [])).toEqual(keptAcrossPages);
    // 本页旧值被本页新值覆盖，不会重复累积
    expect(mergeSelection(['concepts/half.md'], ['concepts/half.md'], ['concepts/half.md'])).toEqual(['concepts/half.md']);
    expect(mergeSelection([], ['concepts/half.md'], ['concepts/half.md'])).toEqual(['concepts/half.md']);
  });

  it('已选数量常驻在工具栏，0 个时不显示「已选 0 个」', () => {
    expect(selectionSummary(0)).toBe('未选择页面');
    expect(selectionSummary(7)).toContain('7');
  });

  it('每页条数提供 50/100/200 三档', () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([50, 100, 200]);
  });
});

// wiki三期 T02472（PRD §16 数据清洗口径与交互）单测：
//   L1 总页数口径与仪表盘同源；L2 评分卡改成可操作的问题分类；L3 表格搜索/排序/分页/跨页选择。
// 约定：被测逻辑全部是 frontend/src/utils/dataCleanPresentation.ts 的纯函数（本项目不挂载 SFC）。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { MisplacedPage, PageQualityScore } from '../src/types';
import {
  ISSUE_CATEGORIES,
  MISPLACED_ISSUE_TEXT,
  PAGE_SIZE_OPTIONS,
  PAGE_SCOPE_DIRS,
  PAGE_TOTAL_HINT,
  SHORT_WORDS_MIN,
  conflictedMisplaced,
  buildIssueContext,
  categoryCounts,
  categoryMeta,
  categoryPaths,
  defaultTableQuery,
  filterPages,
  mergeSelection,
  misplacedSummaryText,
  pageIssueKeys,
  precheckCategoryLines,
  precheckToastSummary,
  problemCount,
  promotableMisplaced,
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

// T02934：200 行/页时旧实现每次排序都重新跑 pageIssueKeys（O(n log n) 次），
// 且 200 行全量渲染成 DOM。这里锁两件事：分类结果在上下文里只算一次；表格必须走虚拟滚动。
describe('T02934 排序预计算与表格虚拟滚动', () => {
  const pages = [
    makePage({ path: 'concepts/a.md', metadata: { hasFrontmatter: false, internalLinks: 0 } }),
    makePage({ path: 'concepts/b.md', metadata: { wordCount: 10 } }),
    makePage({ path: 'entities/c.md' }),
  ];

  it('问题分类在 buildIssueContext 时算好：重复查询返回同一份缓存，排序比较只做 Map 查询', () => {
    const ctx = buildIssueContext(pages);
    const first = pageIssueKeys(pages[0], ctx);
    expect(pageIssueKeys(pages[0], ctx)).toBe(first);
    for (const p of pages) {
      expect(problemCount(p, ctx)).toBe(pageIssueKeys(p, ctx).length);
    }
    // 排序结果不受缓存影响，与既有 L3 口径一致
    expect(sortPages(pages, ctx, 'problems', 'descending').map((p) => p.path))
      .toEqual(['concepts/a.md', 'concepts/b.md', 'entities/c.md']);
  });

  it('上下文之外的页面按需计算并缓存，口径与批量构建一致', () => {
    const ctx = buildIssueContext([pages[2]]);
    const foreign = makePage({ path: 'queries/late.md', metadata: { hasFrontmatter: false } });
    expect(pageIssueKeys(foreign, ctx)).toEqual(['missingFrontmatter']);
    expect(pageIssueKeys(foreign, ctx)).toBe(pageIssueKeys(foreign, ctx));
    expect(problemCount(foreign, ctx)).toBe(1);
  });

  it('DataClean 表格走自实现虚拟窗口，旧的全量 el-table 与逐单元格组件的 table-v2 都不得回潮', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/views/DataClean.vue'), 'utf8');
    // 虚拟窗口三要素：滚动容器、窗口切片、绝对定位行
    expect(src).toContain('dc-table-viewport');
    expect(src).toContain('dc-tr');
    expect(src).toMatch(/const ROW_HEIGHT = 44/);
    expect(src).toMatch(/const VIRTUAL_OVERSCAN = 4/);
    expect(src).toMatch(/pagedRows\.value\.slice\(start, start \+ VIRTUAL_VIEWPORT_ROWS\)/);
    // 容器高度与旧 height="520" 一致，行绝对定位在自己的序号位置
    expect(src).toContain('.table-virtual-wrap');
    expect(src).toMatch(/\.table-virtual-wrap\s*\{[^}]*height:\s*520px/);
    expect(src).toMatch(/top:\s*`\$\{item\.index \* ROW_HEIGHT\}px`/);
    // 旧实现：<el-table ...> 全量渲染；table-v2 每格一个组件，滚动 40ms/帧（T02934 实测）
    expect(src).not.toMatch(/<el-table[\s>]/);
    expect(src).not.toContain('<el-table-column');
    expect(src).not.toContain('<el-table-v2');
  });
});

// T02797：子目录中的页面（存量错位页）在前端的展示口径。
// 这块的逻辑只有「哪些能自动归位 / 哪些要人工确认」一条判断，其余是文案；
// 文案单独断言是为了让术语表守护之外再钉一次：这一类必须称「页面」，且必须说清后果。
describe('子目录中的页面展示（T02797）', () => {
  const item = (over: Partial<MisplacedPage> & { path: string }): MisplacedPage => ({
    title: over.path.split('/').pop()!.replace(/\.md$/, ''),
    type: '',
    suggestedPath: over.path,
    conflict: null,
    ...over,
  });

  it('问题文案按任务口径原样呈现，不出现「文档/条目」那类别名', () => {
    expect(MISPLACED_ISSUE_TEXT).toBe('页面在子目录里，知识库索引不到');
  });

  it('有冲突的条目不进批量归位，只单独列出', () => {
    const items = [
      item({ path: 'concepts/entity/a.md', suggestedPath: 'entities/a.md', type: 'entity' }),
      item({ path: 'concepts/sub/b.md', suggestedPath: 'concepts/b.md', conflict: '目标位置已有同名页面：concepts/b.md' }),
    ];
    expect(promotableMisplaced(items).map((m) => m.path)).toEqual(['concepts/entity/a.md']);
    expect(conflictedMisplaced(items).map((m) => m.path)).toEqual(['concepts/sub/b.md']);
  });

  it('空集合不写「一切正常」；有冲突时把「可自动 / 需人工」两个数都说出来', () => {
    expect(misplacedSummaryText([])).toBe('没有落在子目录里的页面');
    expect(misplacedSummaryText([item({ path: 'qa/sub/x.md', suggestedPath: 'qa/x.md' })])).toContain('全部可直接归位');
    const mixed = [
      item({ path: 'qa/sub/x.md', suggestedPath: 'qa/x.md' }),
      item({ path: 'qa/sub/y.md', suggestedPath: 'qa/y.md', conflict: '目标目录已有同标题页面：qa/y.md' }),
    ];
    expect(misplacedSummaryText(mixed)).toBe('2 个页面，其中 1 个可直接归位、1 个目标位置已有页面需人工确认');
  });
});

// T02907：预检分类计数的展示口径。misplaced 行必须用前端自己的短语（不透传服务端 label），
// 否则同屏「预检分类行」与「错位块标题」两句话又会漂移（T02843 起就是同源约定）。
describe('预检分类计数展示（T02907）', () => {
  const result = (categories: Array<{ key: string; label: string; count: number }>) => ({
    scannedFiles: 245,
    passed: false,
    warnings: [],
    errors: [],
    blocked: false,
    warningCategories: categories,
  });

  it('每类一行「label：count」，misplaced 行用前端短语、不看服务端 label', () => {
    const lines = precheckCategoryLines(result([
      { key: 'bom', label: '页面带 UTF-8 BOM', count: 1 },
      { key: 'unresolvedLink', label: '未解析双链（目标页还没建）', count: 478 },
      { key: 'misplaced', label: '服务端说法（不得透传）', count: 3 },
    ]));
    expect(lines).toEqual([
      '页面带 UTF-8 BOM：1',
      '未解析双链（目标页还没建）：478',
      `${MISPLACED_ISSUE_TEXT}：3`,
    ]);
  });

  it('无分类字段（旧响应体）时给空数组、toast 摘要为空串——不渲染也不报错', () => {
    expect(precheckCategoryLines({ scannedFiles: 1, passed: true, warnings: [], errors: [], blocked: false } as never)).toEqual([]);
    expect(precheckToastSummary(result([]))).toBe('');
    expect(precheckCategoryLines(result([]))).toEqual([]);
  });

  it('toast 摘要：有分类时括号拼接，无分类时不拖尾巴', () => {
    expect(precheckToastSummary(result([
      { key: 'misplaced', label: 'x', count: 3 },
      { key: 'bom', label: 'y', count: 1 },
    ]))).toBe(`（${MISPLACED_ISSUE_TEXT}：3，y：1）`);
  });
});

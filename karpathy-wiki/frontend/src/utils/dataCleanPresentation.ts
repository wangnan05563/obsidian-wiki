// wiki三期 T02472（PRD §16 L1/L2/L3）：数据清洗页口径与表格交互的纯展示逻辑。
// 抽到本文件的原因：分类判定、搜索过滤、排序、分页、跨页选择合并都是可断言的纯函数，
// 与页面耦合后无法单测（本项目测试约定不挂载 SFC）。
import type { PageQualityScore } from '../types';

// ─────────── L1 总页数口径 ───────────
// 与后端 api/src/vault/page-scope.ts 的 PAGE_DIRS 保持一致：两处任何一侧改动都会重新引入
// 「本页 216 / 仪表盘 245」那类矛盾，因此把口径写死在此并用于页脚说明。
export const PAGE_SCOPE_DIRS = ['entities', 'concepts', 'comparisons', 'queries', 'qa', 'solutions'];

/** 总页数卡片下方的一行口径说明：让「这个数是什么」写在数旁边 */
export const PAGE_TOTAL_HINT = `口径与仪表盘一致：${PAGE_SCOPE_DIRS.join(' / ')}`;

/** 字数过短阈值（词）：低于此值多为占位页或编译中断产物 */
export const SHORT_WORDS_MIN = 100;

// ─────────── L2 可操作问题分类 ───────────
export type IssueKey = 'missingFrontmatter' | 'noOutlinks' | 'duplicateTitle' | 'tooShort' | 'scanError';

export interface IssueCategoryDef {
  key: IssueKey;
  /** 卡片标题 */
  label: string;
  /** 为什么这算问题（一句话，不堆术语） */
  desc: string;
  /** 该分类对应的批量动作按钮文案 */
  action: string;
}

export const ISSUE_CATEGORIES: IssueCategoryDef[] = [
  {
    key: 'missingFrontmatter',
    label: '缺元信息',
    desc: '页头的 type/title 缺失，编译和图谱会识别不到它',
    action: '批量补元信息',
  },
  {
    key: 'duplicateTitle',
    label: '标题重复',
    desc: '同一个标题出现在多个文件里，通常是重复编译产物',
    action: '运行重复检测',
  },
  {
    key: 'noOutlinks',
    label: '无出链',
    desc: '正文没有 [[双向链接]]，在知识图谱里是一座孤岛',
    action: '选中这些',
  },
  {
    key: 'tooShort',
    label: '字数过短',
    desc: `正文不足 ${SHORT_WORDS_MIN} 词，多半是占位页或编译中断`,
    action: '选中这些',
  },
  {
    key: 'scanError',
    label: '读取失败',
    desc: '文件读不出来（权限或编码问题），需要人工确认',
    action: '选中这些',
  },
];

export function issueDefOf(key: IssueKey): IssueCategoryDef {
  const def = ISSUE_CATEGORIES.find((c) => c.key === key);
  if (!def) throw new Error(`未知问题分类：${key}`);
  return def;
}

/** 标题归一化：大小写与首尾空格不参与重复判定 */
function normTitle(title: string): string {
  return title.trim().toLowerCase();
}

export interface PageIssueContext {
  /** 归一化标题 → 出现次数 */
  titleCount: Map<string, number>;
}

export function buildIssueContext(pages: PageQualityScore[]): PageIssueContext {
  const titleCount = new Map<string, number>();
  for (const p of pages) {
    const k = normTitle(p.title);
    titleCount.set(k, (titleCount.get(k) ?? 0) + 1);
  }
  return { titleCount };
}

/** 单页命中的问题分类（可能多个），供「问题数」列、筛选与默认排序使用 */
export function pageIssueKeys(page: PageQualityScore, ctx: PageIssueContext): IssueKey[] {
  const out: IssueKey[] = [];
  if (page.issues.some((i) => i.code === 'SCAN_ERROR')) out.push('scanError');
  if (!page.metadata.hasFrontmatter) out.push('missingFrontmatter');
  if ((ctx.titleCount.get(normTitle(page.title)) ?? 0) > 1) out.push('duplicateTitle');
  if (page.metadata.internalLinks < 1) out.push('noOutlinks');
  if (page.metadata.wordCount < SHORT_WORDS_MIN) out.push('tooShort');
  return out;
}

export function problemCount(page: PageQualityScore, ctx: PageIssueContext): number {
  return pageIssueKeys(page, ctx).length;
}

/** 各分类命中数：分类卡片的数字与「全部为 0 = 集合已较健康」的判断依据 */
export function categoryCounts(pages: PageQualityScore[], ctx: PageIssueContext): Record<IssueKey, number> {
  const counts = {
    missingFrontmatter: 0,
    noOutlinks: 0,
    duplicateTitle: 0,
    tooShort: 0,
    scanError: 0,
  } as Record<IssueKey, number>;
  for (const p of pages) {
    for (const k of pageIssueKeys(p, ctx)) counts[k] += 1;
  }
  return counts;
}

/** 某分类下的全部路径（供「选中这些 / 批量补元信息」直接使用，不依赖表格当前页可见行） */
export function categoryPaths(pages: PageQualityScore[], ctx: PageIssueContext, key: IssueKey): string[] {
  return pages.filter((p) => pageIssueKeys(p, ctx).includes(key)).map((p) => p.path);
}

/** 卡片副标题：0 个时不写「一切正常」这类空话，直接说明没有该类问题 */
export function categoryMeta(count: number): string {
  return count === 0 ? '没有这类页面' : '可用下方按钮批量处理';
}

// ─────────── L3 搜索 / 排序 / 分页 ───────────
export type SortProp = 'path' | 'title' | 'problems' | 'qualityScore' | 'wordCount' | 'internalLinks';
export type SortOrder = 'ascending' | 'descending';

export interface TableQuery {
  keyword: string;
  /** 'all' = 不按问题分类筛选 */
  issue: IssueKey | 'all';
  /** 'all' = 不按目录筛选 */
  dir: string;
  sortProp: SortProp;
  sortOrder: SortOrder;
}

/** 默认按问题数倒序：最该处理的页面第一页就能看到（PRD §16 L3） */
export function defaultTableQuery(): TableQuery {
  return { keyword: '', issue: 'all', dir: 'all', sortProp: 'problems', sortOrder: 'descending' };
}

function keywordHit(page: PageQualityScore, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return true;
  return (
    page.path.toLowerCase().includes(k) ||
    page.title.toLowerCase().includes(k) ||
    page.metadata.directory.toLowerCase().includes(k)
  );
}

export function filterPages(pages: PageQualityScore[], ctx: PageIssueContext, q: TableQuery): PageQualityScore[] {
  return pages.filter((p) => {
    if (!keywordHit(p, q.keyword)) return false;
    if (q.dir !== 'all' && p.metadata.directory !== q.dir) return false;
    if (q.issue !== 'all' && !pageIssueKeys(p, ctx).includes(q.issue)) return false;
    return true;
  });
}

function compareBy(prop: SortProp, a: PageQualityScore, b: PageQualityScore, ctx: PageIssueContext): number {
  switch (prop) {
    case 'path':
      return a.path.localeCompare(b.path);
    case 'title':
      return a.title.localeCompare(b.title);
    case 'problems':
      return problemCount(a, ctx) - problemCount(b, ctx);
    case 'qualityScore':
      return a.qualityScore - b.qualityScore;
    case 'wordCount':
      return a.metadata.wordCount - b.metadata.wordCount;
    case 'internalLinks':
      return a.metadata.internalLinks - b.metadata.internalLinks;
    default:
      return 0;
  }
}

/** 排序 + 同分时按路径升序，保证翻页顺序稳定（分页时顺序抖动会丢选择） */
export function sortPages(pages: PageQualityScore[], ctx: PageIssueContext, prop: SortProp, order: SortOrder): PageQualityScore[] {
  const dir = order === 'ascending' ? 1 : -1;
  return [...pages].sort((a, b) => {
    const primary = compareBy(prop, a, b, ctx);
    if (primary !== 0) return primary * dir;
    return a.path.localeCompare(b.path);
  });
}

export const PAGE_SIZE_OPTIONS = [50, 100, 200];

export function slicePage(pages: PageQualityScore[], page: number, size: number): PageQualityScore[] {
  const start = (Math.max(1, page) - 1) * size;
  return pages.slice(start, start + size);
}

export function totalPageCount(total: number, size: number): number {
  if (total <= 0 || size <= 0) return 1;
  return Math.ceil(total / size);
}

/**
 * 跨页选择合并：el-table 的 selection-change 只带当前页的行。
 * 直接把结果赋值会让翻页丢掉其他页的勾选，所以只替换「当前页范围内」的部分。
 */
export function mergeSelection(currentSelection: string[], pageRowPaths: string[], checkedPaths: string[]): string[] {
  const onPage = new Set(pageRowPaths);
  const kept = currentSelection.filter((p) => !onPage.has(p));
  return [...kept, ...checkedPaths];
}

/** 已选统计：把「选中 N 个」翻译成用户能判断后果的话 */
export function selectionSummary(count: number): string {
  return count === 0 ? '未选择页面' : `已选 ${count} 个页面`;
}

// wiki三期 T02472（PRD §16 L1/L2/L3）：数据清洗页口径与表格交互的纯展示逻辑。
// 抽到本文件的原因：分类判定、搜索过滤、排序、分页、跨页选择合并都是可断言的纯函数，
// 与页面耦合后无法单测（本项目测试约定不挂载 SFC）。
import type { MisplacedPage, PageQualityScore, PrecheckResult } from '../types';

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
  /** 页面路径 → 命中分类（T02934：构建时算一次，排序/筛选/单元格复用，不再逐次重算） */
  issueKeys: Map<string, IssueKey[]>;
  /** 页面路径 → 问题数（与 issueKeys 同源，排序比较只做 Map 查询） */
  problemCounts: Map<string, number>;
}

function computeIssueKeys(page: PageQualityScore, ctx: Pick<PageIssueContext, 'titleCount'>): IssueKey[] {
  const out: IssueKey[] = [];
  if (page.issues.some((i) => i.code === 'SCAN_ERROR')) out.push('scanError');
  if (!page.metadata.hasFrontmatter) out.push('missingFrontmatter');
  if ((ctx.titleCount.get(normTitle(page.title)) ?? 0) > 1) out.push('duplicateTitle');
  if (page.metadata.internalLinks < 1) out.push('noOutlinks');
  if (page.metadata.wordCount < SHORT_WORDS_MIN) out.push('tooShort');
  return out;
}

export function buildIssueContext(pages: PageQualityScore[]): PageIssueContext {
  const titleCount = new Map<string, number>();
  for (const p of pages) {
    const k = normTitle(p.title);
    titleCount.set(k, (titleCount.get(k) ?? 0) + 1);
  }
  const ctx: PageIssueContext = { titleCount, issueKeys: new Map(), problemCounts: new Map() };
  for (const p of pages) {
    const keys = computeIssueKeys(p, ctx);
    ctx.issueKeys.set(p.path, keys);
    ctx.problemCounts.set(p.path, keys.length);
  }
  return ctx;
}

/** 单页命中的问题分类（可能多个），供「问题数」列、筛选与默认排序使用 */
export function pageIssueKeys(page: PageQualityScore, ctx: PageIssueContext): IssueKey[] {
  // 不在上下文里的页面（如单测直接构造）按需计算并缓存，口径与批建时完全一致
  const cached = ctx.issueKeys.get(page.path);
  if (cached) return cached;
  const keys = computeIssueKeys(page, ctx);
  ctx.issueKeys.set(page.path, keys);
  ctx.problemCounts.set(page.path, keys.length);
  return keys;
}

export function problemCount(page: PageQualityScore, ctx: PageIssueContext): number {
  return ctx.problemCounts.get(page.path) ?? pageIssueKeys(page, ctx).length;
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

// ─────────── T02797 子目录中的页面 ───────────
// 这类页面不在上面的表格与「页面总数」里：全库枚举按顶层目录平铺扫描，扫不到子目录，
// 所以它既进不了列表也解析不出引用。单列一块，是为了不把「索引不到的页」并进总数口径
// （那会重新制造「本页 N 个 / 仪表盘 M 个」的矛盾，T02472 已修过一次）。
export const MISPLACED_ISSUE_TEXT = '页面在子目录里，知识库索引不到';

export const MISPLACED_WHY_TEXT =
  '这些是写盘深度校验上线前落进子目录的存量页面：知识库的列表、搜索、统计与图谱只认「顶层目录/文件名」这一层，' +
  '子目录里的页面读得到却进不了索引，引用它的链接也点不开。归位只改落点，正文一字不动。';

/** 可自动归位的条目：有冲突的（目标位置已有同名/同标题页面）不在此列，须人工先决定并页 */
export function promotableMisplaced(items: MisplacedPage[]): MisplacedPage[] {
  return items.filter((i) => !i.conflict);
}

/** 冲突条目（只报不动手） */
export function conflictedMisplaced(items: MisplacedPage[]): MisplacedPage[] {
  return items.filter((i) => !!i.conflict);
}

/** 区块标题右侧的一句话状态：0 个时不写「一切正常」，直接说明这一类不存在 */
export function misplacedSummaryText(items: MisplacedPage[]): string {
  if (items.length === 0) return '没有落在子目录里的页面';
  const conflict = conflictedMisplaced(items).length;
  const auto = items.length - conflict;
  return conflict === 0
    ? `${items.length} 个页面，全部可直接归位`
    : `${items.length} 个页面，其中 ${auto} 个可直接归位、${conflict} 个目标位置已有页面需人工确认`;
}

// T02907：预检卡按类聚合展示。482 条警告直出会刷屏，只显示服务端给的分类计数；
// 前端不做字符串前缀解析（服务端 warningCategories 同一次扫描出数）。
// 「misplaced」类的文案与下方错位块标题（MISPLACED_ISSUE_TEXT）逐字同源，同屏说两句话就是矛盾。
export function precheckCategoryLines(result: PrecheckResult): string[] {
  const categories = result.warningCategories ?? [];
  return categories.map((c) => {
    const label = c.key === 'misplaced' ? MISPLACED_ISSUE_TEXT : c.label;
    return `${label}：${c.count}`;
  });
}

/** 预检 toast 的分类摘要：把「K 个警告」翻译成看得见的构成，无分类时回退纯计数 */
export function precheckToastSummary(result: PrecheckResult): string {
  const lines = precheckCategoryLines(result);
  return lines.length > 0 ? `（${lines.join('，')}）` : '';
}

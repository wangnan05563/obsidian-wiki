// T02466（PRD R-F1 / H1、H3、H5）体检问题列表治理纯函数。
//
// 为什么抽出来：Health.vue 原先把 4 类问题各写一段模板，597 项逐行渲染、无搜索、
// 无多选、无折叠，且「过期页面」这类根本不能自动修复的问题和可修复项混在同一个
// 总数里报警。列表建模属于纯计算，抽成 utils 后可单测、可复用（移动端后续接入）。
import type { BatchFixEstimate, HealthReport } from '../types';

export type IssueKind = 'orphan' | 'broken' | 'stale' | 'knowledge_stale';

export interface IssueRow {
  // 稳定 key：与批量修复 issueKeys / 单修复 loading 状态共用同一口径
  key: string;
  kind: IssueKind;
  // 主展示路径（broken 为来源页）
  path: string;
  // broken 专用：缺失的目标链接文本
  target?: string;
  // 归属目录（'/' 表示根目录），用于按目录聚合与筛选
  dir: string;
  // 是否可自动修复（调用 LLM 补回链/修正断链）
  fixable: boolean;
  // 修复入参：orphan 为路径字符串，broken 为 {from,to}
  fixTarget?: string | { from: string; to: string };
}

// 目录段：取路径去掉最后一段的目录前缀；无 '/' 视为根目录
export function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '/' : path.slice(0, idx);
}

export function orphanKey(path: string): string {
  return `orphan:${path}`;
}

export function brokenKey(from: string, to: string): string {
  return `broken:${from}->${to}`;
}

// 把体检报告摊平为统一行模型：4 类问题共用筛选/聚合/折叠/多选逻辑。
export function buildIssueRows(report: HealthReport): IssueRow[] {
  const orphans: IssueRow[] = (report.orphans ?? []).map((p) => ({
    key: orphanKey(p),
    kind: 'orphan',
    path: p,
    dir: dirOf(p),
    fixable: true,
    fixTarget: p,
  }));
  const broken: IssueRow[] = (report.brokenLinks ?? []).map((b) => ({
    key: brokenKey(b.from, b.to),
    kind: 'broken',
    path: b.from,
    target: b.to,
    dir: dirOf(b.from),
    fixable: true,
    fixTarget: { from: b.from, to: b.to },
  }));
  const stale: IssueRow[] = (report.stale ?? []).map((p) => ({
    key: `stale:${p}`,
    kind: 'stale',
    path: p,
    dir: dirOf(p),
    fixable: false,
  }));
  const knowledgeStale: IssueRow[] = (report.knowledgeStale ?? []).map((p) => ({
    key: `review:${p}`,
    kind: 'knowledge_stale',
    path: p,
    dir: dirOf(p),
    // 知识时效可「一键复核」（确定性 frontmatter 写），但不走 LLM 批量修复
    fixable: false,
  }));
  return [...orphans, ...broken, ...stale, ...knowledgeStale];
}

// 大小写不敏感的关键字过滤（同时匹配路径与断链目标）
export function filterRows(rows: IssueRow[], keyword: string): IssueRow[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return rows;
  return rows.filter(
    (r) => r.path.toLowerCase().includes(kw) || (r.target ?? '').toLowerCase().includes(kw),
  );
}

export function rowsOfKind(rows: IssueRow[], kind: IssueKind): IssueRow[] {
  return rows.filter((r) => r.kind === kind);
}

// 按目录聚合：保持原顺序，返回 { dir, rows } 列表；不聚合时由调用方直接使用扁平 rows。
export function groupRowsByDir(rows: IssueRow[]): Array<{ dir: string; rows: IssueRow[] }> {
  const order: string[] = [];
  const buckets = new Map<string, IssueRow[]>();
  for (const row of rows) {
    const bucket = buckets.get(row.dir);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(row.dir, [row]);
      order.push(row.dir);
    }
  }
  // 根目录排最后，避免它抢走首屏注意力
  order.sort((a, b) => (a === '/' ? 1 : 0) - (b === '/' ? 1 : 0));
  return order.map((dir) => ({ dir, rows: buckets.get(dir) ?? [] }));
}

// Top-N 折叠：默认只看前 N 条，返回可见行与被折叠数量。
export function takeVisible(rows: IssueRow[], topN: number, expanded: boolean): { visible: IssueRow[]; hiddenCount: number } {
  if (expanded || rows.length <= topN) return { visible: rows, hiddenCount: 0 };
  return { visible: rows.slice(0, topN), hiddenCount: rows.length - topN };
}

// 总数拆分（H5）：可自动修复 / 需人工判断，两类分开报警，混合计数失去指导意义。
export interface IssueSplit {
  autoFixable: number;
  manualReview: number;
  total: number;
}

export function splitByActionable(rows: IssueRow[]): IssueSplit {
  const autoFixable = rows.filter((r) => r.fixable).length;
  const manualReview = rows.length - autoFixable;
  return { autoFixable, manualReview, total: rows.length };
}

// 选中集 → 批量修复请求体（保持 orphan/broken 的 issueKey 口径与后端一致）
export function buildFixPayloadFromSelection(
  rows: IssueRow[],
  selected: Set<string>,
): { items: Array<{ issueType: 'broken_link' | 'orphan'; target: string | { from: string; to: string } }>; issueKeys: string[] } {
  const items: Array<{ issueType: 'broken_link' | 'orphan'; target: string | { from: string; to: string } }> = [];
  const issueKeys: string[] = [];
  for (const row of rows) {
    if (!selected.has(row.key) || !row.fixable || row.fixTarget === undefined) continue;
    items.push({
      issueType: row.kind === 'orphan' ? 'orphan' : 'broken_link',
      target: row.fixTarget,
    });
    issueKeys.push(row.key);
  }
  return { items, issueKeys };
}

// 选中集按类拆分，用于汇总条文案「已选 12 项（孤立 8 · 断链 4）」
export function selectionBreakdown(
  rows: IssueRow[],
  selected: Set<string>,
): { orphan: number; broken: number; total: number } {
  let orphan = 0;
  let broken = 0;
  for (const row of rows) {
    if (!row.fixable || !selected.has(row.key)) continue;
    if (row.kind === 'orphan') orphan++;
    else if (row.kind === 'broken') broken++;
  }
  return { orphan, broken, total: orphan + broken };
}

// 毫秒 → 人话时长（用于估算文案与「预计剩余」）
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '不足 1 分钟';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `约 ${hours} 小时 ${rest} 分` : `约 ${hours} 小时`;
}

// ===== T02924 启动前估算展示（口径见 api/src/workflows/batch-fix-job.ts）=====

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')} 万`;
  return String(Math.round(n));
}

type EstimateBasis = Pick<
  BatchFixEstimate,
  'basis' | 'samples' | 'avgMsPerIssue' | 'avgStepsPerIssue' | 'avgTokensPerIssue'
>;

// 三态必须投影到文案：default / measured-low 都要显式承认「样本不足」，
// 不能让用户把兜底值当成实测值（T02605 的 2 分钟 vs 实际 6 分钟即由此而来）。
export function estimateBasisText(e: EstimateBasis): string {
  const per = `${formatDuration(e.avgMsPerIssue)}、${e.avgStepsPerIssue} 次往返/项`;
  if (e.basis === 'measured') {
    return `估算依据：最近 ${e.samples} 次实测均值 ${per}`;
  }
  if (e.basis === 'measured-low') {
    return `估算依据：仅 ${e.samples} 个实测样本（不足 5 个，仅供参考），均值 ${per}`;
  }
  return `估算依据：尚无实测样本，按真实链路标定的默认值估算（${e.avgStepsPerIssue} 次往返 / ${formatDuration(e.avgMsPerIssue)} / 约 ${formatTokens(e.avgTokensPerIssue)} tokens 每项）`;
}

// 误差区间文案：宽度为 0（旧样本无法量方差之外的退化情形）时不显示，避免「假精确」
export function estimateRangeText(minMs: number, maxMs: number): string {
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || minMs === maxMs) return '';
  return `区间 ${formatDuration(minMs)} ~ ${formatDuration(maxMs)}`;
}

// 已用时 mm:ss
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ===== 「展开全部」虚拟滚动窗口计算（T02606）=====
// 为什么需要：T02606 真机量测（真实 vault 体检报告，展开后 778 行，系统 Chrome 1440×900，
// 3 轮中位数）显示点「展开全部」首帧 1354ms（主线程 long task 871+471ms），展开后真实滚轮
// 只有 18fps、步进滚动 11fps（60 帧里 61 个 long task、共 5266ms），重复展开一次 1078ms。
// Top-20 与「加载更多 200」是同一量级问题的临时缓解，「展开全部」没有上限保护。
// 这里只做纯计算（不碰 DOM），组件负责取 scrollTop/视口高与行高。
export const VIRTUAL_MIN_ROWS = 60;
export const VIRTUAL_OVERSCAN_ROWS = 8;

export interface VirtualWindowInput {
  count: number;
  // 列表自身被滚出视口的距离（>=0），不是页面 scrollTop
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  rowGap: number;
  overscan?: number;
}

export interface VirtualWindow {
  start: number;
  end: number;
  pitch: number;
  totalHeight: number;
}

// 行数很少时不做窗口化：多一层滚动监听与绝对定位反而更贵，且 DOM 里留全量更利于查找
export function shouldVirtualize(count: number, min = VIRTUAL_MIN_ROWS): boolean {
  return count > min;
}

export function computeVirtualWindow(input: VirtualWindowInput): VirtualWindow {
  const rowHeight = Math.max(1, input.rowHeight);
  const rowGap = Math.max(0, input.rowGap);
  const pitch = rowHeight + rowGap;
  // 末行没有下间距：总高 = count*pitch - gap
  const totalHeight = input.count > 0 ? input.count * pitch - rowGap : 0;
  const overscan = Math.max(0, input.overscan ?? VIRTUAL_OVERSCAN_ROWS);
  const scrolled = Math.min(Math.max(0, input.scrollTop), Math.max(0, totalHeight));
  const first = Math.floor(scrolled / pitch);
  const visibleRows = Math.ceil(Math.max(0, input.viewportHeight) / pitch) + 1;
  const start = Math.max(0, Math.min(first - overscan, input.count));
  const end = Math.min(input.count, start + visibleRows + overscan * 2);
  return { start, end, pitch, totalHeight };
}


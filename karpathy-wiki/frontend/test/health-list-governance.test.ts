import { describe, it, expect } from 'vitest';
import {
  buildIssueRows,
  filterRows,
  rowsOfKind,
  groupRowsByDir,
  takeVisible,
  splitByActionable,
  buildFixPayloadFromSelection,
  selectionBreakdown,
  dirOf,
  orphanKey,
  brokenKey,
  formatDuration,
  formatElapsed,
} from '../src/utils/healthList';
import type { HealthReport } from '../src/types';

// T02466（PRD R-F1 / H1、H3、H5）体检列表治理纯函数测试
function report(over: Partial<HealthReport> = {}): HealthReport {
  return {
    orphans: ['notes/a.md', 'notes/b.md', 'c.md'],
    brokenLinks: [{ from: 'notes/a.md', to: '缺失页' }],
    stale: ['old/x.md'],
    knowledgeStale: ['dated/y.md'],
    ...over,
  };
}

describe('buildIssueRows', () => {
  it('4 类问题摊平为统一行模型，key 与后端 issueKeys 口径一致', () => {
    const rows = buildIssueRows(report());
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.key)).toEqual([
      orphanKey('notes/a.md'),
      orphanKey('notes/b.md'),
      orphanKey('c.md'),
      brokenKey('notes/a.md', '缺失页'),
      'stale:old/x.md',
      'review:dated/y.md',
    ]);
  });

  it('只有 orphan/broken 可自动修复，stale 与知识时效标记为需人工判断', () => {
    const rows = buildIssueRows(report());
    expect(rows.filter((r) => r.fixable).map((r) => r.kind)).toEqual(['orphan', 'orphan', 'orphan', 'broken']);
    const broken = rows.find((r) => r.kind === 'broken');
    expect(broken?.fixTarget).toEqual({ from: 'notes/a.md', to: '缺失页' });
    const orphan = rows.find((r) => r.kind === 'orphan');
    expect(orphan?.fixTarget).toBe('notes/a.md');
  });

  it('目录段：带子目录取前缀，根目录为 /', () => {
    expect(dirOf('notes/a.md')).toBe('notes');
    expect(dirOf('c.md')).toBe('/');
    expect(buildIssueRows(report()).find((r) => r.key === orphanKey('c.md'))?.dir).toBe('/');
  });
});

describe('filterRows / rowsOfKind', () => {
  it('关键字大小写不敏感，且同时匹配断链目标', () => {
    const rows = buildIssueRows(report());
    expect(filterRows(rows, 'B.MD')).toHaveLength(1);
    expect(filterRows(rows, '缺失')).toHaveLength(1);
    expect(filterRows(rows, '   ')).toHaveLength(rows.length);
  });

  it('按类取行', () => {
    const rows = buildIssueRows(report());
    expect(rowsOfKind(rows, 'knowledge_stale')).toHaveLength(1);
    expect(rowsOfKind(rows, 'broken')).toHaveLength(1);
  });
});

describe('groupRowsByDir / takeVisible', () => {
  it('按目录聚合，根目录排最后以免抢首屏注意力', () => {
    const groups = groupRowsByDir(buildIssueRows(report()));
    expect(groups.map((g) => g.dir)).toEqual(['notes', 'old', 'dated', '/']);
    expect(groups[0].rows).toHaveLength(3);
  });

  it('Top-N 折叠：未展开时只给前 N 条并回报被折叠数', () => {
    const rows = buildIssueRows(report({ orphans: Array.from({ length: 597 }, (_, i) => `n/${i}.md`) }));
    const orphans = rowsOfKind(rows, 'orphan');
    const collapsed = takeVisible(orphans, 20, false);
    expect(collapsed.visible).toHaveLength(20);
    expect(collapsed.hiddenCount).toBe(577);
    expect(takeVisible(orphans, 20, true).visible).toHaveLength(597);
  });

  it('行数不超过 N 时不折叠', () => {
    const rows = rowsOfKind(buildIssueRows(report()), 'orphan');
    const out = takeVisible(rows, 20, false);
    expect(out.visible).toHaveLength(3);
    expect(out.hiddenCount).toBe(0);
  });
});

describe('splitByActionable', () => {
  it('总数拆成「可自动修复 / 需人工判断」，不再混为一谈', () => {
    const split = splitByActionable(buildIssueRows(report()));
    expect(split).toEqual({ autoFixable: 4, manualReview: 2, total: 6 });
  });
});

describe('buildFixPayloadFromSelection / selectionBreakdown', () => {
  const rows = buildIssueRows(report());

  it('选中集转批量请求体：非可修复项被跳过', () => {
    const sel = new Set([orphanKey('notes/a.md'), 'stale:old/x.md', brokenKey('notes/a.md', '缺失页')]);
    const payload = buildFixPayloadFromSelection(rows, sel);
    expect(payload.items).toEqual([
      { issueType: 'orphan', target: 'notes/a.md' },
      { issueType: 'broken_link', target: { from: 'notes/a.md', to: '缺失页' } },
    ]);
    expect(payload.issueKeys).toEqual([orphanKey('notes/a.md'), brokenKey('notes/a.md', '缺失页')]);
    expect(payload.items).toHaveLength(payload.issueKeys.length);
  });

  it('跨 section 汇总文案按类型计数', () => {
    const sel = new Set([orphanKey('notes/a.md'), orphanKey('c.md'), brokenKey('notes/a.md', '缺失页')]);
    expect(selectionBreakdown(rows, sel)).toEqual({ orphan: 2, broken: 1, total: 3 });
    expect(selectionBreakdown(rows, new Set(['stale:old/x.md']))).toEqual({ orphan: 0, broken: 0, total: 0 });
  });
});

describe('时长文案', () => {
  it('formatDuration 覆盖秒/分/小时三档', () => {
    expect(formatDuration(45_000)).toBe('45 秒');
    expect(formatDuration(120_000)).toBe('约 2 分钟');
    expect(formatDuration(3_600_000 + 5 * 60_000)).toBe('约 1 小时 5 分');
    expect(formatDuration(0)).toBe('不足 1 分钟');
  });

  it('formatElapsed 输出 mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(75_000)).toBe('01:15');
    expect(formatElapsed(-1000)).toBe('00:00');
  });
});

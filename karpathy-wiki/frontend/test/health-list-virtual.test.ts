import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  computeVirtualWindow,
  shouldVirtualize,
  quantizeScrollTop,
  VIRTUAL_MIN_ROWS,
  VIRTUAL_OVERSCAN_ROWS,
  VIRTUAL_WINDOW_BUCKET_ROWS,
} from '../src/utils/healthList';

const readSrc = (p: string) => readFileSync(resolve(__dirname, '../src', p), 'utf8');

// T02606「展开全部」大报告渲染性能：真机 3 轮中位数为「466 项首帧 1354ms、展开后滚轮 18fps」，
// 改为按视口窗口渲染。窗口数学是纯计算，先行单测；组件接线用源码守护。
const ROW = 46; // 与 .issue-item 定高一致
const GAP = 8; // 与 .issue-list gap 一致
const VIEW = 872; // MAIN.content 实测可视高

describe('shouldVirtualize', () => {
  it('默认折叠的 Top-20 与「加载更多」步长之间取阈值：小列表不做窗口化', () => {
    expect(shouldVirtualize(20)).toBe(false);
    expect(shouldVirtualize(VIRTUAL_MIN_ROWS)).toBe(false);
    expect(shouldVirtualize(VIRTUAL_MIN_ROWS + 1)).toBe(true);
    expect(shouldVirtualize(466)).toBe(true);
  });

  it('阈值高于折叠条数、低于分页步长，保证折叠视图零改动', () => {
    expect(VIRTUAL_MIN_ROWS).toBeGreaterThanOrEqual(40);
    expect(VIRTUAL_MIN_ROWS).toBeLessThan(200);
  });
});

describe('computeVirtualWindow', () => {
  it('空列表返回零区间，不产生占位高度', () => {
    const w = computeVirtualWindow({ count: 0, scrollTop: 0, viewportHeight: VIEW, rowHeight: ROW, rowGap: GAP });
    expect(w).toEqual({ start: 0, end: 0, pitch: ROW + GAP, totalHeight: 0 });
  });

  it('首屏从 0 开始，区间含上下外溢行数', () => {
    const w = computeVirtualWindow({ count: 466, scrollTop: 0, viewportHeight: VIEW, rowHeight: ROW, rowGap: GAP });
    expect(w.start).toBe(0);
    expect(w.end).toBeLessThanOrEqual(466);
    // 视口可容纳 17 行 + 1 行残余 + 上下各 8 行外溢
    expect(w.end).toBe(Math.ceil(VIEW / w.pitch) + 1 + VIRTUAL_OVERSCAN_ROWS * 2);
    expect(w.end).toBeLessThan(60);
  });

  it('总高按等距行计算且末行不计行间距（滚动条长度与真实列表一致）', () => {
    const w = computeVirtualWindow({ count: 466, scrollTop: 0, viewportHeight: VIEW, rowHeight: ROW, rowGap: GAP });
    expect(w.totalHeight).toBe(466 * (ROW + GAP) - GAP);
  });

  it('中段滚动时窗口跟随，起始行含外溢', () => {
    const w = computeVirtualWindow({ count: 466, scrollTop: 5400, viewportHeight: VIEW, rowHeight: ROW, rowGap: GAP });
    const first = Math.floor(5400 / w.pitch);
    expect(w.start).toBe(first - VIRTUAL_OVERSCAN_ROWS);
    expect(w.end - w.start).toBe(Math.ceil(VIEW / w.pitch) + 1 + VIRTUAL_OVERSCAN_ROWS * 2);
  });

  it('滚到底部时区间收敛到最后一行，不越界', () => {
    const w = computeVirtualWindow({
      count: 466,
      scrollTop: 466 * (ROW + GAP),
      viewportHeight: VIEW,
      rowHeight: ROW,
      rowGap: GAP,
    });
    expect(w.end).toBe(466);
    expect(w.start).toBeLessThan(466);
  });

  it('负 scrollTop 与零视口高被夹住，不产生负索引', () => {
    const w = computeVirtualWindow({ count: 100, scrollTop: -9999, viewportHeight: 0, rowHeight: ROW, rowGap: GAP });
    expect(w.start).toBe(0);
    expect(w.end).toBeGreaterThan(0);
    expect(w.end).toBeLessThanOrEqual(100);
  });

  it('overscan=0 时窗口等于视口行数（可调低外溢以换更少 DOM）', () => {
    const w = computeVirtualWindow({
      count: 466,
      scrollTop: 5400,
      viewportHeight: VIEW,
      rowHeight: ROW,
      rowGap: GAP,
      overscan: 0,
    });
    expect(w.start).toBe(Math.floor(5400 / w.pitch));
    expect(w.end - w.start).toBe(Math.ceil(VIEW / w.pitch) + 1);
  });

  it('非法行高被兜底，避免 pitch=0 造成除零与 NaN 索引', () => {
    const w = computeVirtualWindow({ count: 50, scrollTop: 100, viewportHeight: VIEW, rowHeight: 0, rowGap: -5 });
    expect(w.pitch).toBe(1);
    expect(Number.isNaN(w.start)).toBe(false);
    expect(w.start).toBeGreaterThanOrEqual(0);
  });
});

describe('quantizeScrollTop（T02929 滚动窗口分块）', () => {
  it('同一块内返回同一窗口起点，跨块才前进', () => {
    const pitch = ROW + GAP;
    const block = pitch * VIRTUAL_WINDOW_BUCKET_ROWS;
    expect(quantizeScrollTop(0, pitch)).toBe(0);
    expect(quantizeScrollTop(block - 1, pitch)).toBe(0);
    expect(quantizeScrollTop(block, pitch)).toBe(block);
    expect(quantizeScrollTop(block * 3 + 10, pitch)).toBe(block * 3);
  });

  it('负值与非法 pitch 被兜底，不产生负起点或 NaN', () => {
    expect(quantizeScrollTop(-500, ROW + GAP)).toBe(0);
    expect(quantizeScrollTop(100, 0)).toBe(96);
    expect(Number.isFinite(quantizeScrollTop(100, NaN))).toBe(true);
  });

  it('块内任意滚动位置都被窗口覆盖：起点不晚于首行、终点晚于末行', () => {
    const pitch = ROW + GAP;
    const block = pitch * VIRTUAL_WINDOW_BUCKET_ROWS;
    for (const actual of [1, pitch, block - 1, block + pitch * 3.5, 5400]) {
      const start0 = quantizeScrollTop(actual, pitch);
      const w = computeVirtualWindow({ count: 466, scrollTop: start0, viewportHeight: VIEW, rowHeight: ROW, rowGap: GAP });
      const firstVisible = Math.floor(actual / pitch);
      const lastVisible = Math.ceil((actual + VIEW) / pitch);
      expect(w.start).toBeLessThanOrEqual(firstVisible);
      expect(w.end).toBeGreaterThan(Math.min(lastVisible, 465));
    }
  });
});

describe('HealthIssueList 虚拟窗口接线（源码守护）', () => {
  const src = readSrc('components/HealthIssueList.vue');

  it('窗口计算走 utils 纯函数；未窗口化仍用 row.key，窗口化用槽位 key 复用组件实例', () => {
    expect(src).toContain('computeVirtualWindow');
    expect(src).toContain('shouldVirtualize');
    expect(src).toContain(':key="slotKeys[idx]"');
    expect(src).toContain('visibleRows.value.map((r) => r.key)');
    // T02929：滚动位置按行块量化，同一块内不重建窗口
    expect(src).toContain('const WINDOW_BUCKET_ROWS = 8;');
    expect(src).toContain('quantizeScrollTop(scrolled, pitch, WINDOW_BUCKET_ROWS)');
    expect(src).toContain('if (quantized === scrollTop.value) return;');
  });

  it('滚动主体是页面/内部滚动容器：捕获阶段监听，不新增内部滚动盒', () => {
    expect(src).toContain("addEventListener('scroll', onScrollOrResize, { capture: true");
    expect(src).not.toContain('<el-auto-resizer');
    expect(src).not.toContain('<el-virtual-list');
    expect(src).not.toContain('overflow-y: auto');
  });

  it('行等高前提：定高 + 单行截断，且绝对定位行不补间 top', () => {
    expect(src).toMatch(/height:\s*var\(--health-row-height, 46px\)/);
    expect(src).toMatch(/\.row-path,\s*\.broken-target\s*\{[^}]*white-space:\s*nowrap/);
    expect(src).toMatch(/position:\s*absolute/);
    expect(src).toContain('transition: background-color 0.25s ease, border-color 0.25s ease, transform 0.25s ease');
  });

  it('交互语义不变：选择、作业态、修复入口仍按行 key 走原 props/emit', () => {
    expect(src).toContain(':model-value="selected.has(row.key)"');
    expect(src).toContain("@change=\"emit('toggle', row.key)\"");
    expect(src).toContain(':loading="fixingKey === row.key"');
    expect(src).toContain('jobStates[row.key]');
  });

  it('截断信息不丢失：行提供完整文本 title', () => {
    expect(src).toContain(':title="rowTitle(row)"');
  });
});

describe('Health.vue 视口级模糊层（T02929）', () => {
  const src = readSrc('views/Health.vue');

  it('模糊由卡内 sticky 的 100vh 层承担，卡片自身不再按内容高度撑开模糊面积', () => {
    expect(src).toContain('class="glass-card health-card is-viewport-blur"');
    expect(src).toContain('class="health-blur-layer"');
    expect(src).toMatch(/\.health-card\.is-viewport-blur\s*\{[^}]*backdrop-filter:\s*none/s);
    expect(src).toMatch(/\.health-card\.is-viewport-blur\s*\{[^}]*overflow:\s*clip/s);
    expect(src).toMatch(/\.health-card\.is-viewport-blur \.health-blur-layer\s*\{[^}]*position:\s*sticky/s);
    expect(src).toMatch(/\.health-card\.is-viewport-blur \.health-blur-layer\s*\{[^}]*height:\s*100vh/s);
    expect(src).toMatch(/\.health-card\.is-viewport-blur \.health-blur-layer\s*\{[^}]*backdrop-filter:\s*var\(--blur\)/s);
  });

  it('不改滚动主体：体检页仍是页面级滚动，卡片不引入内部滚动盒', () => {
    expect(src).not.toContain('overflow-y: auto');
    expect(src).not.toContain('overflow: auto');
  });
});

describe('Health.vue 编排层未被窗口化污染', () => {
  const src = readSrc('views/Health.vue');

  it('折叠/加载更多/展开全部与搜索、聚合、多选仍由本层限额驱动', () => {
    expect(src).toContain('const TOP_N = 20;');
    expect(src).toContain('const PAGE_STEP = 200;');
    expect(src).toContain('takeVisible');
    expect(src).toContain('filterRows');
    expect(src).toContain('groupRowsByDir');
    expect(src).toContain('buildFixPayloadFromSelection');
  });

  it('行数上限逻辑不含 DOM 窗口计算（职责只在下层列表组件）', () => {
    expect(src).not.toContain('computeVirtualWindow');
    expect(src).not.toContain('windowInfo');
  });
});

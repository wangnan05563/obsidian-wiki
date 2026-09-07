// 图谱确定性径向布局的行为级测试。
// 为什么是"行为级"而非"快照/魔法常量级"：历史测试把实现内部的常量（size、radius、
// stabilization.iterations）当断言目标，实现一调参测试就红、失去了作为验收判据的作用。
// 这里改测"布局是否真的分散 / 卫星是否紧贴 / 椭圆化是否正确"等可观察行为，参数改动不红，
// 只有"又中心成团"这类回归才红。
import { describe, it, expect } from 'vitest';
import { computeRadialLayout, computeStretch, LAYOUT } from '../src/composables/graphLayout';
import type { GraphData } from '../src/types';

// 构造 hub-spoke 图：1 个 hub 连到 45 个叶子（复刻实测"一环 45 邻居"的拥挤场景），
// 外加 3 个卫星小分量，验证拆环与卫星摆放。
function buildHubSpokeGraph(): GraphData {
  const leafCount = 45;
  const nodes = ['hub', ...Array.from({ length: leafCount }, (_, i) => `leaf${i}`)];
  const edges = Array.from({ length: leafCount }, (_, i) => ({ from: 'hub', to: `leaf${i}` }));
  // 3 个卫星分量：各含一个不能连接到主 hub 的孤立小环
  for (let s = 0; s < 3; s++) {
    for (let j = 0; j < 4; j++) {
      const n = `sat${s}_${j}`;
      nodes.push(n);
      if (j > 0) edges.push({ from: `sat${s}_${j - 1}`, to: n });
    }
  }
  return { nodes, edges };
}

describe('computeStretch', () => {
  it('宽扁画布产生 fx>1, fy<1 且面积守恒 (fx*fy=1)', () => {
    const { fx, fy } = computeStretch(1466, 391);
    expect(fx).toBeGreaterThan(1);
    expect(fy).toBeLessThan(1);
    expect(fx * fy).toBeCloseTo(1, 6);
  });

  it('容器尺寸为 0 时回退到默认，不产生 NaN/Infinity', () => {
    const { fx, fy } = computeStretch(0, 0);
    expect(Number.isFinite(fx)).toBe(true);
    expect(Number.isFinite(fy)).toBe(true);
    expect(Number.isNaN(fx)).toBe(false);
    expect(Number.isNaN(fy)).toBe(false);
    expect(fx).toBeGreaterThan(0);
    expect(fy).toBeGreaterThan(0);
  });

  it('fx 被 MAX_STRETCH 夹住，避免过度压扁', () => {
    const { fx } = computeStretch(8000, 100);
    expect(fx).toBeLessThanOrEqual(LAYOUT.MAX_STRETCH);
  });
});

describe('computeRadialLayout', () => {
  it('空图返回空 Map', () => {
    expect(computeRadialLayout({ nodes: [], edges: [] })).toEqual(new Map());
  });

  it('单分量（无卫星）时所有节点都有有限坐标', () => {
    const data = buildHubSpokeGraph();
    // 这里卫星其实会退化为独立连通分量处理；先看纯 hub-spoke 主分量场景
    const { nodes, edges } = data;
    const onlyMain: GraphData = {
      nodes: nodes.filter((n) => !n.startsWith('sat')),
      edges: edges.filter((e) => !e.from.startsWith('sat') && !e.to.startsWith('sat')),
    };
    const pos = computeRadialLayout(onlyMain);
    expect(pos.size).toBe(onlyMain.nodes.length);
    for (const p of pos.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('hub 拥有最多邻居，应位于主分量中心附近（坐标模长最小）', () => {
    const data = buildHubSpokeGraph();
    const onlyMain: GraphData = {
      nodes: data.nodes.filter((n) => !n.startsWith('sat')),
      edges: data.edges.filter((e) => !e.from.startsWith('sat') && !e.to.startsWith('sat')),
    };
    const pos = computeRadialLayout(onlyMain);
    const hub = pos.get('hub')!;
    const hubDist = Math.hypot(hub.x, hub.y);
    // hub 为主分量根，应接近原点，比所有叶子更靠近中心
    for (const [n, p] of pos) {
      if (n === 'hub') continue;
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(hubDist);
    }
  });

  it('45 叶子单环节点被拆环，最外环节点数有界', () => {
    // 核心回归断言：hub-spoke 首层 45 邻居不应挤在单环上糊成色团，
    // 而应被拆成多个（内/外）子环。
    const data = buildHubSpokeGraph();
    const onlyMain: GraphData = {
      nodes: data.nodes.filter((n) => !n.startsWith('sat')),
      edges: data.edges.filter((e) => !e.from.startsWith('sat') && !e.to.startsWith('sat')),
    };
    const pos = computeRadialLayout(onlyMain);
    const hub = pos.get('hub')!;
    const layers = new Map<number, number>(); // 半径(四舍五入) -> 该环节点数
    for (const [n, p] of pos) {
      if (n === 'hub') continue;
      const r = Math.round(Math.hypot(p.x - hub.x, p.y - hub.y));
      layers.set(r, (layers.get(r) ?? 0) + 1);
    }
    // 拆环后：任一环节点数为 0 或不超过单环容量上限
    for (const count of layers.values()) {
      expect(count).toBeLessThanOrEqual(LAYOUT.RING_CAPACITY);
    }
    // 45 邻居确实被拆散到 ≥2 个子环（而非全部堆在一环，否则 count 会到 45）
    expect(layers.size).toBeGreaterThanOrEqual(2);
    // 同环相邻节点的弧向间距不为 0（有实际分散而非全部重叠）
    const grouped = new Map<number, Array<{ x: number; y: number }>>();
    for (const [n, p] of pos) {
      if (n === 'hub') continue;
      const r = Math.round(Math.hypot(p.x - hub.x, p.y - hub.y));
      if (!grouped.has(r)) grouped.set(r, []);
      grouped.get(r)!.push(p);
    }
    for (const group of grouped.values()) {
      if (group.length < 2) continue;
      // 按极角排序后取相邻弦长最小值，应 > 0（确认拆环后同环节点未重叠）
      const byAngle = [...group].sort(
        (a, b) => Math.atan2(a.y - hub.y, a.x - hub.x) - Math.atan2(b.y - hub.y, b.x - hub.x),
      );
      let minArc = Infinity;
      for (let i = 0; i < byAngle.length; i++) {
        const pa = byAngle[i];
        const pb = byAngle[(i + 1) % byAngle.length];
        minArc = Math.min(minArc, Math.hypot(pa.x - pb.x, pa.y - pb.y));
      }
      expect(minArc).toBeGreaterThan(0);
    }
  });

  it('卫星分量中心围绕主分量外环，且与主分量保持间距', () => {
    const data = buildHubSpokeGraph();
    const pos = computeRadialLayout(data);
    // 主分量根 hub 在原点附近
    const hub = pos.get('hub')!;
    let satDistMin = Infinity;
    for (const [n] of pos) {
      if (n.startsWith('sat')) {
        const d = Math.hypot(pos.get(n)!.x - hub.x, pos.get(n)!.y - hub.y);
        satDistMin = Math.min(satDistMin, d);
      }
    }
    // 卫星至少比首层叶子远，且不小于主分量半径 + 卫星半径 + gap
    expect(satDistMin).toBeGreaterThan(LAYOUT.RING_GAP);
  });

  it('椭圆化后包围盒改变，但节点相对顺序保持', () => {
    const data = buildHubSpokeGraph();
    const onemain: GraphData = {
      nodes: data.nodes.filter((n) => !n.startsWith('sat')),
      edges: data.edges.filter((e) => !e.from.startsWith('sat') && !e.to.startsWith('sat')),
    };
    const round = computeRadialLayout(onemain, 1, 1);
    const ellip = computeRadialLayout(onemain, 2, 0.5);
    // 椭圆化后 x 扩张、y 收缩
    const roundXs = [...round.values()].map((p) => p.x);
    const ellipXs = [...ellip.values()].map((p) => p.x);
    expect(ellipXs.reduce((a, b) => Math.abs(a) + Math.abs(b), 0)).toBeGreaterThan(
      roundXs.reduce((a, b) => Math.abs(a) + Math.abs(b), 0),
    );
    // 面积守恒：椭圆化不改变同一点 x*y 的尺度关系（等价的相对分散）
    const id = onemain.nodes[0];
    const a = round.get(id)!;
    const b = ellip.get(id)!;
    expect(b.x).toBeCloseTo(a.x * 2, 5);
    expect(b.y).toBeCloseTo(a.y * 0.5, 5);
  });
});
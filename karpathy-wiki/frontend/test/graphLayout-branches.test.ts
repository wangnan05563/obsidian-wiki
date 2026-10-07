// 图谱径向布局的分支级行为测试（与 graphLayout.test.ts 的行为级测试互补）。
// 侧重既有测试未触达的路径：节点数为 0/1、孤立节点、多层级链、环/自环/重复边、
// 悬空边端点（ghost）、拆环容量边界（24/25）、椭圆化单系数分支、computeStretch 防御分支。
// 所有断言均按源码实际语义推演（BFS 根选择、子环外扩、卫星间距公式），非快照。
import { describe, it, expect } from 'vitest';
import { computeRadialLayout, computeStretch, LAYOUT } from '../src/composables/graphLayout';
import type { GraphData } from '../src/types';

const EPS = 1e-6;
function dist(p: { x: number; y: number }): number {
  return Math.hypot(p.x, p.y);
}

describe('computeRadialLayout：节点规模边界', () => {
  it('0 个节点：返回空 Map（即使有悬空边）', () => {
    const pos = computeRadialLayout({ nodes: [], edges: [{ from: 'x', to: 'y' }] });
    expect(pos.size).toBe(0);
  });

  it('1 个节点：落在自身分量中心 (0,0)', () => {
    const pos = computeRadialLayout({ nodes: ['a'], edges: [] });
    expect(pos.size).toBe(1);
    const p = pos.get('a')!;
    expect(Math.abs(p.x)).toBeLessThan(EPS);
    expect(Math.abs(p.y)).toBeLessThan(EPS);
  });

  it('两个互不相连节点：第二个作为卫星分量，中心距 = SATELLITE_GAP（两分量半径均为 0）', () => {
    const pos = computeRadialLayout({ nodes: ['n1', 'n2'], edges: [] });
    expect(pos.size).toBe(2);
    expect(dist(pos.get('n1')!)).toBeLessThan(EPS); // 主分量根在原点
    expect(dist(pos.get('n2')!)).toBeCloseTo(LAYOUT.SATELLITE_GAP, 6);
  });

  it('3 个孤立节点：角度均匀分布（-90° 与 +90°），到原点距离均为 SATELLITE_GAP', () => {
    const pos = computeRadialLayout({ nodes: ['n1', 'n2', 'n3'], edges: [] });
    expect(dist(pos.get('n2')!)).toBeCloseTo(LAYOUT.SATELLITE_GAP, 6);
    expect(dist(pos.get('n3')!)).toBeCloseTo(LAYOUT.SATELLITE_GAP, 6);
    // idx0 卫星放于 -π/2 方向（正上方），idx1 在 π/2 方向（正下方）
    expect(pos.get('n2')!.y).toBeCloseTo(-LAYOUT.SATELLITE_GAP, 6);
    expect(pos.get('n3')!.y).toBeCloseTo(LAYOUT.SATELLITE_GAP, 6);
    expect(pos.get('n2')!.x).toBeCloseTo(0, 6);
  });
});

describe('computeRadialLayout：多层级链与根选择', () => {
  // 链 a-b-c-d：最大度节点（b，度 2，遍历时先于 c 达到 2）被选为根
  const chain: GraphData = {
    nodes: ['a', 'b', 'c', 'd'],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
    ],
  };

  it('以最大度节点为根：b 在中心，1 层（a、c）在 RING_GAP 半径，2 层（d）在 2*RING_GAP', () => {
    const pos = computeRadialLayout(chain);
    expect(pos.size).toBe(4);
    expect(dist(pos.get('b')!)).toBeLessThan(EPS);
    expect(dist(pos.get('a')!)).toBeCloseTo(LAYOUT.RING_GAP, 6);
    expect(dist(pos.get('c')!)).toBeCloseTo(LAYOUT.RING_GAP, 6);
    expect(dist(pos.get('d')!)).toBeCloseTo(LAYOUT.RING_GAP * 2, 6);
    // a 是 b 邻接表中第一个被发现节点 → 起始角 -π/2（正上方）；c 对角 → 正下方
    expect(pos.get('a')!.y).toBeCloseTo(-LAYOUT.RING_GAP, 6);
    expect(pos.get('c')!.y).toBeCloseTo(LAYOUT.RING_GAP, 6);
    expect(pos.get('d')!.y).toBeCloseTo(-LAYOUT.RING_GAP * 2, 6);
  });

  it('同度节点不覆盖先出现者：根保持 b（c 度同为 2 但需严格大于才替换）', () => {
    // 若根变成 c，则 b 会在 1 层、a 在 2 层；此处断言 a 距根 RING_GAP（a 是 b 的邻居）
    const pos = computeRadialLayout(chain);
    expect(dist(pos.get('b')!)).toBeLessThan(EPS);
    expect(dist(pos.get('a')!)).toBeCloseTo(LAYOUT.RING_GAP, 6);
  });

  it('主分量取节点数最多者（即使它排在孤立节点之后）', () => {
    const data: GraphData = {
      nodes: ['iso', 'h', 'l1', 'l2'],
      edges: [
        { from: 'h', to: 'l1' },
        { from: 'h', to: 'l2' },
      ],
    };
    const pos = computeRadialLayout(data);
    // 3 节点分量是主分量：hub 居中
    expect(dist(pos.get('h')!)).toBeLessThan(EPS);
    expect(dist(pos.get('l1')!)).toBeCloseTo(LAYOUT.RING_GAP, 6);
    // 孤立节点是卫星：主分量半径 90 + 卫星半径 0 + SATELLITE_GAP
    expect(dist(pos.get('iso')!)).toBeCloseTo(LAYOUT.RING_GAP + LAYOUT.SATELLITE_GAP, 6);
  });
});

describe('computeRadialLayout：循环与异常边', () => {
  it('三角形纯环不会导致无限递归/重复摆放：全部落在 root 的 0/1 层', () => {
    const pos = computeRadialLayout({
      nodes: ['a', 'b', 'c'],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    });
    expect(pos.size).toBe(3);
    for (const p of pos.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    // 根 a 在原点；b、c 均在一环（BFS 已访问的邻居不入二层）
    const root = pos.get('a')!;
    expect(dist(root)).toBeLessThan(EPS);
    expect(dist(pos.get('b')!)).toBeCloseTo(LAYOUT.RING_GAP, 6);
    expect(dist(pos.get('c')!)).toBeCloseTo(LAYOUT.RING_GAP, 6);
  });

  it('自环边（a→a）：不产生新层级，节点正常摆放', () => {
    const pos = computeRadialLayout({ nodes: ['a', 'b'], edges: [{ from: 'a', to: 'a' }] });
    expect(pos.size).toBe(2);
    expect(dist(pos.get('a')!)).toBeLessThan(EPS);
    expect(dist(pos.get('b')!)).toBeCloseTo(LAYOUT.SATELLITE_GAP, 6);
  });

  it('重复边（a-b 两次）：BFS 只访问一次，坐标与单链一致', () => {
    const dup = computeRadialLayout({
      nodes: ['a', 'b'],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'b' },
      ],
    });
    expect(dup.size).toBe(2);
    expect(dist(dup.get('a')!)).toBeLessThan(EPS);
    expect(dist(dup.get('b')!)).toBeCloseTo(LAYOUT.RING_GAP, 6);
  });

  it('边端点引用不存在节点：邻接表仍会收录该端点，ghost 被摆到一环（实际语义）；真实节点不受丢', () => {
    const pos = computeRadialLayout({
      nodes: ['a', 'b'],
      edges: [{ from: 'ghost', to: 'a' }],
    });
    // a 为主分量根（0 层），ghost 经 a 的邻接表进入 1 层；b 独立分量为卫星
    expect(pos.has('a')).toBe(true);
    expect(pos.has('b')).toBe(true);
    expect(pos.has('ghost')).toBe(true);
    expect(dist(pos.get('a')!)).toBeLessThan(EPS);
    expect(dist(pos.get('ghost')!)).toBeCloseTo(LAYOUT.RING_GAP, 6);
    expect(dist(pos.get('b')!)).toBeCloseTo(LAYOUT.RING_GAP + LAYOUT.SATELLITE_GAP, 6);
  });

  it('两端都不存在的边：对布局完全无影响', () => {
    const pos = computeRadialLayout({ nodes: ['a'], edges: [{ from: 'g1', to: 'g2' }] });
    expect(pos.size).toBe(1);
    expect(pos.has('g1')).toBe(false);
    expect(dist(pos.get('a')!)).toBeLessThan(EPS);
  });
});

describe('computeRadialLayout：拆环容量边界（RING_CAPACITY）', () => {
  function hubSpoke(leafCount: number): GraphData {
    const nodes = ['hub', ...Array.from({ length: leafCount }, (_, i) => `l${i}`)];
    const edges = Array.from({ length: leafCount }, (_, i) => ({ from: 'hub', to: `l${i}` }));
    return { nodes, edges };
  }

  it('恰好 RING_CAPACITY（24）个邻居：不拆环，全部在同一半径', () => {
    const pos = computeRadialLayout(hubSpoke(LAYOUT.RING_CAPACITY));
    const radii = new Set<number>();
    for (let i = 0; i < LAYOUT.RING_CAPACITY; i++) {
      radii.add(Math.round(dist(pos.get(`l${i}`)!)));
    }
    expect([...radii]).toHaveLength(1);
    expect([...radii][0]).toBe(LAYOUT.RING_GAP);
  });

  it('RING_CAPACITY+1（25）个邻居：第 25 个被外扩 NODE_SPACING 到第二子环', () => {
    const pos = computeRadialLayout(hubSpoke(LAYOUT.RING_CAPACITY + 1));
    const r0 = Math.round(dist(pos.get('l0')!));
    const r24 = Math.round(dist(pos.get(`l${LAYOUT.RING_CAPACITY}`)!));
    expect(r0).toBe(LAYOUT.RING_GAP);
    expect(r24).toBe(LAYOUT.RING_GAP + LAYOUT.NODE_SPACING);
  });

  it('卫星为 2 节点小链：其内部径向展开叠加到星群中心（主半径+卫星半径+GAP）', () => {
    const data: GraphData = {
      nodes: ['h', 'x', 's1', 's2'],
      edges: [
        { from: 'h', to: 'x' },
        { from: 's1', to: 's2' },
      ],
    };
    const pos = computeRadialLayout(data);
    // 卫星分量：s1 为根（0 层），s2 在 1 层 → 卫星半径 = RING_GAP
    // 星群中心距 = 主 90 + 卫星 90 + SATELLITE_GAP 80 = 260，角度 -π/2（唯一卫星）
    const centerDist = LAYOUT.RING_GAP + LAYOUT.RING_GAP + LAYOUT.SATELLITE_GAP;
    expect(dist(pos.get('s1')!)).toBeCloseTo(centerDist, 6);
    // s2 在卫星内部再向外（同角度 -π/2 方向）→ 距原点 centerDist + RING_GAP
    expect(dist(pos.get('s2')!)).toBeCloseTo(centerDist + LAYOUT.RING_GAP, 6);
  });
});

describe('computeRadialLayout：椭圆化与确定性', () => {
  const data: GraphData = {
    nodes: ['h', 'a', 'b'],
    edges: [
      { from: 'h', to: 'a' },
      { from: 'h', to: 'b' },
    ],
  };

  it('仅 fy≠1（fx=1）时只缩放 y 坐标，x 不变', () => {
    const base = computeRadialLayout(data);
    const flat = computeRadialLayout(data, 1, 0.5);
    for (const n of ['a', 'b']) {
      expect(flat.get(n)!.x).toBeCloseTo(base.get(n)!.x, 6);
      expect(flat.get(n)!.y).toBeCloseTo(base.get(n)!.y * 0.5, 6);
    }
  });

  it('默认参数（fx=fy=1）与显式传入 (1,1) 结果一致（缩放分支跳过）', () => {
    const implicit = computeRadialLayout(data);
    const explicit = computeRadialLayout(data, 1, 1);
    expect([...explicit.entries()]).toEqual([...implicit.entries()]);
  });

  it('同一输入两次计算结果逐点相等（确定性布局，杜绝物理引擎抖动）', () => {
    const big = hubLike(30);
    const p1 = computeRadialLayout(big);
    const p2 = computeRadialLayout(big);
    expect([...p2.entries()]).toEqual([...p1.entries()]);
  });

  function hubLike(n: number): GraphData {
    const nodes = ['hub', ...Array.from({ length: n }, (_, i) => `l${i}`)];
    const edges = Array.from({ length: n }, (_, i) => ({ from: 'hub', to: `l${i}` }));
    return { nodes, edges };
  }
});

describe('computeStretch：防御分支（实际数值语义）', () => {
  it('极端窄高画布（宽高比 0.1）被夹到下限 0.25 → fx=0.5、fy=2', () => {
    const { fx, fy } = computeStretch(100, 1000);
    expect(fx).toBeCloseTo(0.5, 10);
    expect(fy).toBeCloseTo(2, 10);
    expect(fx * fy).toBeCloseTo(1, 10);
  });

  it('负尺寸视为无效并回退默认 1200x600 → aspect=2 → fx=√2、fy=1/√2', () => {
    const { fx, fy } = computeStretch(-5, 600);
    expect(fx).toBeCloseTo(Math.SQRT2, 10);
    expect(fy).toBeCloseTo(1 / Math.SQRT2, 10);
  });

  it('NaN/Infinity 输入被 Number.isFinite 拦截，输出仍为有限正值', () => {
    const { fx, fy } = computeStretch(NaN, Infinity);
    expect(Number.isFinite(fx)).toBe(true);
    expect(Number.isFinite(fy)).toBe(true);
    expect(fx).toBeGreaterThan(0);
    expect(fy).toBeGreaterThan(0);
    // 双双回退默认 1200/600 → fx=√2
    expect(fx).toBeCloseTo(Math.SQRT2, 10);
  });

  it('正方形画布不拉伸（fx=fy=1）', () => {
    const { fx, fy } = computeStretch(800, 800);
    expect(fx).toBe(1);
    expect(fy).toBe(1);
  });

  it('aspect 上限 4 夹住后 fx=2，恰等于 MAX_STRETCH', () => {
    const { fx } = computeStretch(4000, 1000); // aspect=4 → √4=2，未超 MAX_STRETCH
    expect(fx).toBe(2);
  });
});

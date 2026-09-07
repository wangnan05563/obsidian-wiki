// 图谱确定性径向布局：纯逻辑，不依赖 vis-network 运行时（便于单测）。
// 核心思路：预计算每个节点的坐标，交给 vis-network 时物理引擎关闭，
// 使"预置坐标即最终布局"，从根上杜绝"物理常开把节点拉回中心成团"。

import type { GraphData } from '../types';

// ===== 布局魔法参数集中管理（单一数据源）=====
// 为什么集中在这里而非散落在 Graph.vue：历史教训是两处各维护一套参数、
// 甚至连数值都不同步，导致双模式布局不一致、反复调参无效果。集中后，
// 所有使用者（图谱/测试）共用同一批常量。
// 值的依据（2026-08 实测 200 节点/56 连通分量/hub88 度/一环45 邻居）：
// - RING_CAPACITY 约束单环节点数，超限拆环，避免"45 邻居挤单环→弧间距 26px 糊成色团"
// - RING_GAP/NODE_SPACING 决定环层间距与节点间距，过小则糊团
// - SATELLITE_GAP 决定卫星小分量与主分量的间距，过大浪费 fit 空间、主分量被压小
export const LAYOUT = {
  /** 单环最大容纳节点数：超过即在同层再开一个内/外子环 */
  RING_CAPACITY: 24,
  /** 相邻两层（BFS level）之间的环距（布局坐标单位） */
  RING_GAP: 90,
  /** 节点间距基数（布局坐标单位） */
  NODE_SPACING: 55,
  /** 卫星小分量中心离主分量最外环的最小间距 */
  SATELLITE_GAP: 80,
  /** 椭圆化 fx 上限：防过度压扁导致纵向堆叠 */
  MAX_STRETCH: 2,
} as const;

/**
 * 按容器宽高比计算面积守恒椭圆化系数（fx·fy=1）。
 * 为什么面积守恒：fx*fy=1 时包围盒周长近似不变、同环弧向间距不缩水，
 * 仅整体形状从圆变椭，适配扁矩形画布（宽图时 fit 的 scale 不再被高度压小）。
 * 边界防御：容器未布局时尺寸为 0，需回退并夹在合理区间，避免 fx=0/fy=Infinity
 * 导致坐标 NaN、整图空白。
 * @returns {fx, fy} 两个非零有限值
 */
export function computeStretch(cw: number, ch: number): { fx: number; fy: number } {
  const w = Number.isFinite(cw) && cw > 0 ? cw : 1200;
  const h = Number.isFinite(ch) && ch > 0 ? ch : 600;
  const aspect = Math.min(Math.max(w / h, 0.25), 4); // 夹在 [0.25,4]，防极端比例
  const fx = Math.min(Math.sqrt(aspect), LAYOUT.MAX_STRETCH);
  return { fx, fy: 1 / fx };
}

/**
 * 计算确定性径向布局。
 * 算法：
 * 1. 找连通分量；取节点数最多的为主分量，其余为卫星分量。
 * 2. 主分量内以其最大度节点为根做 BFS，按 BFS 层级排环；单环超 RING_CAPACITY 拆子环。
 * 3. 各卫星分量同样径向铺开，其"星群中心"围绕主分量最外环，间距取 SATELLITE_GAP。
 * 4. 整体按 fx/fy 椭圆化，贴合画布。
 * @returns 节点 id -> {x,y}（所有节点必有值）
 */
export function computeRadialLayout(
  data: GraphData,
  fx = 1,
  fy = 1,
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const { nodes, edges } = data;
  if (!nodes.length) return pos;

  // 无向邻接表（图谱关注双向可见性，忽略边的方向性）
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    adj.get(e.from)?.push(e.to);
    adj.get(e.to)?.push(e.from);
  }

  // 找连通分量（并查集比递归 DFS 更稳，避免深递归爆栈）
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(x)!); // 路径压缩
      x = parent.get(x)!;
    }
    return x;
  };
  for (const n of nodes) parent.set(n, n);
  for (const e of edges) {
    const [ra, rb] = [find(e.from), find(e.to)];
    if (ra !== rb) parent.set(ra, rb);
  }
  const comps = new Map<string, string[]>();
  for (const n of nodes) {
    const r = find(n);
    const arr = comps.get(r);
    if (arr) arr.push(n);
    else comps.set(r, [n]);
  }
  const compList = [...comps.values()].sort((a, b) => b.length - a.length);

  // 每个分量的布局：返回 { nodes, radius, placed }，placed 是该分量内节点相对自身中心的坐标
  const layoutComp = (comp: string[]) => {
    // 以最大度节点为根，保证 hub 居中所见层次清晰
    let root = comp[0];
    let maxDeg = -1;
    for (const n of comp) {
      const d = adj.get(n)?.length ?? 0;
      if (d > maxDeg) {
        maxDeg = d;
        root = n;
      }
    }
    // BFS 分层
    const level = new Map<string, number>([[root, 0]]);
    const queue = [root];
    const byLevel = new Map<number, string[]>();
    byLevel.set(0, [root]);
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const lv = level.get(cur)!;
      for (const nb of adj.get(cur) ?? []) {
        if (!level.has(nb)) {
          level.set(nb, lv + 1);
          byLevel.set(lv + 1, [...(byLevel.get(lv + 1) ?? []), nb]);
          queue.push(nb);
        }
      }
    }
    // 单环超容量则拆子环；子环半径在基础环半径上再外扩
    const placed = new Map<string, { x: number; y: number }>();
    const maxLevel = Math.max(0, ...level.values());
    let maxR = 0;
    for (const [lv, arr] of byLevel) {
      const baseR = lv * LAYOUT.RING_GAP;
      const subCount = Math.ceil(arr.length / LAYOUT.RING_CAPACITY);
      for (let s = 0; s < subCount; s++) {
        const sub = arr.slice(s * LAYOUT.RING_CAPACITY, (s + 1) * LAYOUT.RING_CAPACITY);
        const r = baseR + s * LAYOUT.NODE_SPACING;
        maxR = Math.max(maxR, r);
        sub.forEach((n, i) => {
          const a = (i / sub.length) * Math.PI * 2 - Math.PI / 2;
          placed.set(n, { x: Math.cos(a) * r, y: Math.sin(a) * r });
        });
      }
    }
    void maxLevel;
    return { comp, placed, radius: maxR };
  };

  const main = layoutComp(compList[0]);
  for (const [n, p] of main.placed) pos.set(n, p);

  // 卫星分量围绕主分量外环摆放
  if (compList.length > 1) {
    const satellites = compList.slice(1).map((c) => layoutComp(c));
    satellites.forEach((sat, idx) => {
      // 星群中心放于以主分量中心为圆心的环上，角度均匀分布
      const a = (idx / satellites.length) * Math.PI * 2 - Math.PI / 2;
      const r = main.radius + sat.radius + LAYOUT.SATELLITE_GAP;
      const cx = Math.cos(a) * r;
      const cy = Math.sin(a) * r;
      for (const [n, p] of sat.placed) pos.set(n, { x: cx + p.x, y: cy + p.y });
    });
  }

  // 椭圆化（面积守恒）：shape 适配画布，同时不改变节点相对分散度
  if (fx !== 1 || fy !== 1) {
    for (const p of pos.values()) {
      p.x *= fx;
      p.y *= fy;
    }
  }
  return pos;
}
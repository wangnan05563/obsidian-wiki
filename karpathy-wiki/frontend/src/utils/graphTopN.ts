import type { GraphData } from '../types';

// T02464（G1/R-C5）：取连接度（出链+入链数）最高的前 n 个节点及其之间的边，
// 使默认视图为「高连接度核心」，而非数百节点堆成的无标签毛球。
// 节点数本就不超 n 时原样返回；返回的新对象不修改入参。
export function topNGraphData(data: GraphData, n: number): GraphData {
  if (data.nodes.length <= n) return data;
  const deg = new Map<string, number>();
  for (const e of data.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  const ranked = [...data.nodes].sort((a, b) => (deg.get(b) ?? 0) - (deg.get(a) ?? 0));
  const kept = new Set(ranked.slice(0, n));
  const nodes = data.nodes.filter((x) => kept.has(x));
  const edges = data.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
  return { nodes, edges };
}

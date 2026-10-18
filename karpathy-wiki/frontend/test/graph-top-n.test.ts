import { describe, it, expect } from 'vitest';
import { topNGraphData } from '../src/utils/graphTopN';
import type { GraphData } from '../src/types';

// T02464（G1/R-C5）：Top-N 高连接度选取纯函数测试
describe('topNGraphData', () => {
  it('节点数不超 n 时原样返回（数量与内容一致）', () => {
    const data: GraphData = {
      nodes: ['a', 'b', 'c'],
      edges: [{ from: 'a', to: 'b' }],
    };
    const out = topNGraphData(data, 70);
    expect(out.nodes).toHaveLength(3);
    expect(out.edges).toHaveLength(1);
  });

  it('保留连接度最高的前 N 个节点', () => {
    // a 度=3, c 度=2, b 度=1, d 度=0（孤立）
    const data: GraphData = {
      nodes: ['a', 'b', 'c', 'd', 'e'],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'a', to: 'e' },
        { from: 'c', to: 'e' },
      ],
    };
    const out = topNGraphData(data, 3);
    expect(out.nodes.sort()).toEqual(['a', 'c', 'e']);
  });

  it('只保留 kept 节点之间的边（孤立/低连接度节点被剔除且不带入跨界边）', () => {
    const data: GraphData = {
      nodes: ['hub', 'x', 'y', 'z'],
      edges: [
        { from: 'hub', to: 'x' },
        { from: 'hub', to: 'y' },
        { from: 'x', to: 'z' }, // z 仅与 x 相连，度=1，若 x 被保留此边才会保留
      ],
    };
    // hub(度2) > x(度2, 与 hub,z) = y(度1) > z(度1)：并列时按数组序，取前 2 = hub,x
    const out = topNGraphData(data, 2);
    expect(out.nodes.sort()).toEqual(['hub', 'x']);
    expect(out.edges).toEqual([{ from: 'hub', to: 'x' }]);
  });

  it('不修改入参（返回新对象/新数组）', () => {
    const data: GraphData = {
      nodes: ['a', 'b', 'c'],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    };
    const snapshot = JSON.stringify(data);
    topNGraphData(data, 1);
    expect(JSON.stringify(data)).toBe(snapshot);
  });
});

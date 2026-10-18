// T02457（PRD B1，P0）：目录分布条宽度计算
// 背景：原实现 Math.min(100, count * 10) 与组内最大值无关——「概念 166」与「实体 44」
// 都顶满 100%，小类（对比 8 → 80%）被夸大，读者会得出错误结论。
// 口径：占本组最大值的百分比（最大值项恒 100%），视觉编码与真实占比一致。
export function dirBarWidth(count: number, max: number): number {
  if (max <= 0) return 0;
  if (count <= 0) return 0;
  return Math.round((count / max) * 100);
}

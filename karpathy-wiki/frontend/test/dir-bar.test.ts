// T02457（PRD B1）：分布条宽度计算测试
// 背景：原 Math.min(100, count*10) 口径下 166 与 44 都顶满（视觉失真，P0）；
// 新口径为「占组内最大值比例」，最大值项恒 100%，小类按真实占比收缩。
import { describe, it, expect } from 'vitest';
import { dirBarWidth } from '../src/utils/dirBar';

describe('dirBarWidth', () => {
  it('最大值项恒为 100%', () => {
    expect(dirBarWidth(166, 166)).toBe(100);
  });

  it('按真实占比收缩（修复 44 也顶满的失真）', () => {
    // 概念 166 / 实体 44：原实现两者都顶满；新口径实体应为 27%
    expect(dirBarWidth(44, 166)).toBe(27);
    // 对比 8 / 问答 9 相对 166：原实现画到 63%~90% 被夸大；新口径 5% / 5%
    expect(dirBarWidth(8, 166)).toBe(5);
    expect(dirBarWidth(9, 166)).toBe(5);
  });

  it('组内无数据（max<=0）时全部为 0', () => {
    expect(dirBarWidth(0, 0)).toBe(0);
    expect(dirBarWidth(5, 0)).toBe(0);
  });

  it('count<=0 为 0，四舍五入为整数百分比', () => {
    expect(dirBarWidth(0, 100)).toBe(0);
    expect(dirBarWidth(1, 3)).toBe(33);
    expect(dirBarWidth(2, 3)).toBe(67);
  });
});

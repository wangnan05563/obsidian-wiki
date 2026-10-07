// computeTipPlacement 的边缘分支行为测试（与 tipPosition.test.ts 的常规场景互补）。
// 聚焦既有测试未触达的实际语义：超窄视口下 clamp 顺序产生的负坐标、
// 底部翻转的严格大于边界、翻转后恰贴安全边距、Math.round 小数取整、
// anchorOrigin 仅单轴非零也触发 absolute、以及显式传 {0,0} 仍为 fixed 的判定方式。
import { describe, it, expect } from 'vitest';
import { computeTipPlacement } from '../src/directives/tipPosition';

describe('computeTipPlacement：视口极端的实际 clamp 语义', () => {
  it('超窄视口（宽 10 < 2*MARGIN）：先贴左 8 再被右 clamp 压到 vw-effectiveWidth-MARGIN → 输出负 left（源码顺序语义）', () => {
    const p = computeTipPlacement(
      { left: 0, top: 100, width: 10, height: 20 },
      { width: 50, height: 30 },
      { width: 10, height: 800 },
    );
    expect(p.position).toBe('fixed');
    // maxWidth=max(10-16,8)=8 → effectiveWidth=8 → left=min(max(-20,8), 10-8-8)= -6
    expect(p.left).toBe(-6);
    expect(p.top).toBe(128); // 100+20+8，底部空间充足不翻转
  });

  it('视口宽度恰容纳 2*MARGIN+effectiveWidth 时，左右 clamp 收敛于同一值 8', () => {
    // vw=100，tip=200 → maxWidth=84 → 右边界 100-84-8=8 == 左边界 8
    const p = computeTipPlacement(
      { left: 40, top: 100, width: 20, height: 20 },
      { width: 200, height: 30 },
      { width: 100, height: 600 },
    );
    expect(p.left).toBe(8);
  });

  it('底部空间恰等于 tip 高度（top+height === vh-MARGIN）：不翻转（严格大于才翻）', () => {
    // vh=800：elRect.bottom=754 → 默认 top=762；762+30=792 === 800-8 → 边界不翻
    const noFlip = computeTipPlacement(
      { left: 100, top: 714, width: 40, height: 40 },
      { width: 120, height: 30 },
      { width: 500, height: 800 },
    );
    expect(noFlip.top).toBe(762);
    // 下移 1px 即越界 → 翻到按钮上方 715-30-8=677
    const flip = computeTipPlacement(
      { left: 100, top: 715, width: 40, height: 40 },
      { width: 120, height: 30 },
      { width: 500, height: 800 },
    );
    expect(flip.top).toBe(677);
  });

  it('翻转结果恰好落在 MARGIN=8：贴边但不被再抬升（top<8 才贴顶）', () => {
    // vh=100, tip=30：elRect.top=46 → flip 值 46-30-8=8
    const p = computeTipPlacement(
      { left: 100, top: 46, width: 40, height: 46 },
      { width: 120, height: 30 },
      { width: 400, height: 100 },
    );
    expect(p.top).toBe(8);
    // left = 100+20-60 = 60（400-120-8=272 之内）
    expect(p.left).toBe(60);
  });
});

describe('computeTipPlacement：取整与 absolute 触发条件', () => {
  it('fixed 模式对小数坐标做 Math.round', () => {
    const p = computeTipPlacement(
      { left: 100.3, top: 50.4, width: 40.2, height: 20 },
      { width: 60, height: 30 },
      { width: 1000, height: 600 },
    );
    // top=78.4→78；left=90.4→90
    expect(p.top).toBe(78);
    expect(p.left).toBe(90);
  });

  it('anchorOrigin 仅 x 非零（y=0）也判定为非 fixed：left 扣减而 top 原样', () => {
    const p = computeTipPlacement(
      { left: 200, top: 200, width: 80, height: 32 },
      { width: 120, height: 30 },
      { width: 500, height: 400 },
      { x: 20, y: 0 },
    );
    expect(p.position).toBe('absolute');
    expect(p.left).toBe(160); // 180-20
    expect(p.top).toBe(240); // 不翻转、不扣减
  });

  it('anchorOrigin 仅 y 非零（x=0）：absolute + 翻转后 top 扣减原点', () => {
    // vh=520：默认 top=548，548+30=578>512 → 翻转 500-30-8=462 → 相对 y=10 → 452
    const p = computeTipPlacement(
      { left: 100, top: 500, width: 40, height: 40 },
      { width: 120, height: 30 },
      { width: 500, height: 520 },
      { x: 0, y: 10 },
    );
    expect(p.position).toBe('absolute');
    expect(p.top).toBe(452);
    expect(p.left).toBe(60); // 100+20-60=60，减 x=0
  });

  it('absolute 模式小数先扣原点再整体取整（round 作用于差值）', () => {
    const p = computeTipPlacement(
      { left: 100.3, top: 50.4, width: 40.2, height: 20 },
      { width: 60, height: 30 },
      { width: 1000, height: 600 },
      { x: 7.5, y: 2.4 },
    );
    expect(p.position).toBe('absolute');
    // top = 78.4-2.4 = 76 → 76；left = 90.4-7.5 = 82.9 → 83
    expect(p.top).toBe(76);
    expect(p.left).toBe(83);
  });

  it('显式传入 {x:0,y:0} 仍是 fixed（按值判等而非按引用判默认参数）', () => {
    const p = computeTipPlacement(
      { left: 100, top: 100, width: 80, height: 32 },
      { width: 120, height: 30 },
      { width: 1280, height: 800 },
      { x: 0, y: 0 },
    );
    expect(p.position).toBe('fixed');
    expect(p.top).toBe(140);
    expect(p.left).toBe(80);
  });
});

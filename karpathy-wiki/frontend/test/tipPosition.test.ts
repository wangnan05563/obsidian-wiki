import { describe, it, expect } from 'vitest';
import { computeTipPlacement } from '../src/directives/tipPosition';

// tooltip 定位纯函数单测：正下方居中、边缘自适应、底部翻转、transform 祖先换算

const vp = { width: 1280, height: 800 };

describe('computeTipPlacement（默认 fixed，视口坐标系）', () => {
  it('按钮正下方水平居中', () => {
    const p = computeTipPlacement(
      { left: 100, top: 100, width: 80, height: 32 },
      { width: 120, height: 30 },
      vp,
    );
    expect(p.position).toBe('fixed');
    expect(p.top).toBe(140); // 100 + 32 + 8
    expect(p.left).toBe(80); // 100 + 40 - 60
  });

  it('靠近左边缘时贴左（≥8px 安全边距）', () => {
    const p = computeTipPlacement(
      { left: 2, top: 100, width: 80, height: 32 },
      { width: 120, height: 30 },
      vp,
    );
    expect(p.left).toBe(8);
  });

  it('靠近右边缘时贴右（不溢出屏幕）', () => {
    const p = computeTipPlacement(
      { left: 1250, top: 100, width: 80, height: 32 },
      { width: 120, height: 30 },
      vp,
    );
    expect(p.left).toBe(1152); // 1280 - 120 - 8
  });

  it('底部空间不足时翻到按钮上方', () => {
    const p = computeTipPlacement(
      { left: 100, top: 750, width: 80, height: 32 },
      { width: 120, height: 30 },
      vp,
    );
    expect(p.top).toBe(712); // 750 - 30 - 8
  });

  it('翻到上方后仍不足则贴顶（8px）', () => {
    const p = computeTipPlacement(
      { left: 0, top: 5, width: 10, height: 10 },
      { width: 60, height: 40 },
      { width: 400, height: 50 },
    );
    expect(p.top).toBe(8);
  });

  it('超宽浮层（宽于可视区）贴左边缘，不产生负坐标', () => {
    const p = computeTipPlacement(
      { left: 400, top: 100, width: 80, height: 32 },
      { width: 2000, height: 30 },
      vp,
    );
    expect(p.left).toBe(8);
  });
});

describe('computeTipPlacement（transform 祖先，absolute 换算）', () => {
  it('坐标换算为相对祖先 padding-box（含边界 clamp 以祖先盒为准）', () => {
    const p = computeTipPlacement(
      { left: 400, top: 220, width: 80, height: 32 },
      { width: 120, height: 30 },
      { width: 500, height: 400 },
      { x: 300, y: 200 },
    );
    expect(p.position).toBe('absolute');
    // left: 400+40-60=380 → clamp 到 500-120-8=372 → 相对 300 → 72
    expect(p.left).toBe(72);
    // top: 220+32+8=260（不翻转）→ 相对 200 → 60
    expect(p.top).toBe(60);
  });

  // 说明：DOM 层面的 backdrop-filter/transform 包含块建立者由 tip.ts::findTransformAncestor
  // 检测（已覆盖 transform/filter/backdrop-filter/perspective/will-change），本纯函数只负责
  // 收到 anchorOrigin 后正确换算。下面验证 absolute 模式下底部翻转 + 顶部 clamp 的语义。
  it('absolute 模式：底部空间不足时翻到按钮上方（含负 top 由 caller 自行处理）', () => {
    // 按钮贴近祖先盒底部：anchorOrigin.y=350，按钮 top=360，按钮 bottom=392，
    // tip 默认 top=400，400+30=430>392 翻到按钮上方 top=360-30-8=322 → 相对 350 → -28
    const p = computeTipPlacement(
      { left: 50, top: 360, width: 80, height: 32 },
      { width: 120, height: 30 },
      { width: 500, height: 400 },
      { x: 0, y: 350 },
    );
    expect(p.position).toBe('absolute');
    expect(p.top).toBe(-28);
  });
});

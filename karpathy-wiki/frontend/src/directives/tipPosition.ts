// tooltip 定位纯逻辑（与 DOM 解耦，便于单测）。
// 规则：
//   - 默认在触发元素正下方居中（gap=8px），左右边缘留 8px 安全边距；
//   - 底部空间不足时翻到元素上方；顶部不足时贴顶（8px）；
//   - 超宽浮层（宽度大于可视区-安全边距）时靠左贴边，不再居中；
//   - transform/filter/backdrop-filter/perspective 祖先会使 position:fixed 失去视口基准，
//     此时需用 position:absolute 并以该祖先为坐标原点（anchorOrigin 为该祖先 border-box 的视口坐标）。

export interface TipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TipPlacement {
  position: 'fixed' | 'absolute';
  top: number;
  left: number;
}

const GAP = 8;
const MARGIN = 8;

export function computeTipPlacement(
  elRect: TipRect,
  tipSize: { width: number; height: number },
  viewport: { width: number; height: number },
  anchorOrigin: { x: number; y: number } = { x: 0, y: 0 },
): TipPlacement {
  const fixedMode = anchorOrigin.x === 0 && anchorOrigin.y === 0;

  // 默认：按钮正下方水平居中
  let top = elRect.top + elRect.height + GAP;
  let left = elRect.left + elRect.width / 2 - tipSize.width / 2;

  const vw = viewport.width;
  const vh = viewport.height;

  // 超宽处理：浮层比可视区还宽时贴左边缘，避免 left 为负
  const maxWidth = Math.max(vw - MARGIN * 2, MARGIN);
  const effectiveWidth = Math.min(tipSize.width, maxWidth);
  left = Math.max(left, MARGIN);
  left = Math.min(left, vw - effectiveWidth - MARGIN);

  // 底部空间不足 → 翻到按钮上方；顶部不足 → 贴顶
  if (top + tipSize.height > vh - MARGIN) {
    top = elRect.top - tipSize.height - GAP;
  }
  if (top < MARGIN) top = MARGIN;

  if (fixedMode) {
    return { position: 'fixed', top: Math.round(top), left: Math.round(left) };
  }
  // transform 祖先场景：换算为相对该祖先 padding-box 左上角的坐标
  return {
    position: 'absolute',
    top: Math.round(top - anchorOrigin.y),
    left: Math.round(left - anchorOrigin.x),
  };
}

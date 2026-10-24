// wiki四期 T02916：断点单一来源
//
// 背景：全仓曾有 480/500/600/640/700/760/768/900/1100 九档接近值各写各的字面量，
// 「平板 768-1100」区间实际只有 900 一档生效，且新增页面时无人知道该用哪一档。
// 这里把档位收敛为四个语义层，所有 @media 字面量必须等于本表中的值
// （由 test/breakpoints-single-source.test.ts 守护）。
//
// 为什么不用 CSS 变量：@media 的条件值不接受 var()，所以档位只能以「常量 + 守护用例」
// 的形式收敛；需要 JS 侧判定的地方（useIsMobile）直接引用本表。

export const BREAKPOINTS = {
  /** 窄手机：进一步压缩次要信息 */
  xs: 480,
  /** 便携屏上界：手机与平板竖屏，同时是 MobileShell 的切换阈值 */
  portable: 768,
  /** 紧凑壳：桌面侧栏收成顶部横条，把垂直空间还给内容 */
  compact: 900,
  /** 窄桌面：平板横屏与小笔记本，多列降为单列 */
  laptop: 1100,
} as const;

export type BreakpointTier = keyof typeof BREAKPOINTS;

/** 允许出现在 `@media (max-width: Npx)` 里的全部字面量 */
export const CANONICAL_MAX_WIDTHS: readonly number[] = Object.values(BREAKPOINTS);

/** 生成 max-width 查询串，供 matchMedia / JS 侧监听使用 */
export function maxWidthQuery(tier: BreakpointTier): string {
  return `(max-width: ${BREAKPOINTS[tier]}px)`;
}

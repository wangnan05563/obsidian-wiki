// 配置生效方式：前端渲染层（T02467 / PRD §10 C1 / REQ-032）
// ------------------------------------------------------------------
// 数据来自 GET /api/config/effects（服务端 config-effects 登记表），本模块只做「取数 + 展示口径」，
// 不副本化字段表——否则服务端改了生效方式，界面会静默说谎（正是 C1 抱怨的三套口径并存）。
// 拉取失败时视图隐藏徽标而不是猜一个，避免误导。
//
// 两种展示面（surface）：
//   ui   —— 可编辑字段旁：告诉用户「在这个界面上保存后何时生效」→ 即时生效 / 需重启服务。
//   file —— 只读展示 config.json 现值的行：告诉用户「要改这个值得怎么办」→ 改文件需热加载 / 改文件需重启。

export type ConfigEffect = 'instant' | 'restart';
// 与服务端登记表同构：instant（改文件本身即生效）/ reload（需点热加载）/ restart（需重启）。
export type ConfigFileEffect = 'instant' | 'reload' | 'restart';

export interface ConfigEffectItem {
  key: string;
  label: string;
  effect: ConfigEffect;
  viaFile: ConfigFileEffect;
  tab: string;
  reason: string;
}

export type EffectTone = 'instant' | 'reload' | 'restart';

export interface EffectBadge {
  /** 徽标文案 */
  label: string;
  /** 配色类名后缀：effect-tag--instant / --reload / --restart */
  tone: EffectTone;
  /** tooltip：一句话说清「改了要做什么」 */
  tip: string;
}

export const EFFECT_BADGES: Record<'ui_instant' | 'ui_restart' | 'file_instant' | 'file_reload' | 'file_restart', EffectBadge> = {
  ui_instant: {
    label: '即时生效',
    tone: 'instant',
    tip: '保存即写入运行时，下一次使用就是新值，无需额外操作',
  },
  ui_restart: {
    label: '需重启服务',
    tone: 'restart',
    tip: '该值在进程启动时固定，保存后仍需重启服务才完全生效，已记入页顶待重启清单',
  },
  file_instant: {
    label: '改文件即生效',
    tone: 'instant',
    tip: '这项配置就是那份文件本身，保存后下一次读取就是新内容，没有热加载这一步',
  },
  file_reload: {
    label: '改文件需热加载',
    tone: 'reload',
    tip: '直接改 config.json 只落盘，需点「热加载配置」才会被运行时读到；在本页保存则即时生效',
  },
  file_restart: {
    label: '改文件需重启',
    tone: 'restart',
    tip: '该值在进程启动时固定，无论改文件还是热加载都仍需重启服务',
  },
};

/** 取某字段在某展示面上的徽标；未登记（老服务端 / 新字段漏登记）时返回 undefined，视图不猜 */
export function badgeFor(item: ConfigEffectItem | undefined, surface: 'ui' | 'file'): EffectBadge | undefined {
  if (!item) return undefined;
  if (surface === 'ui') return item.effect === 'restart' ? EFFECT_BADGES.ui_restart : EFFECT_BADGES.ui_instant;
  if (item.viaFile === 'restart') return EFFECT_BADGES.file_restart;
  return item.viaFile === 'instant' ? EFFECT_BADGES.file_instant : EFFECT_BADGES.file_reload;
}

/** 服务端 items 建索引，模板按 key 取，避免每个字段 O(n) 查找 */
export function indexEffectItems(items: readonly ConfigEffectItem[]): Map<string, ConfigEffectItem> {
  const map = new Map<string, ConfigEffectItem>();
  for (const item of items) map.set(item.key, item);
  return map;
}

export function effectOf(items: Map<string, ConfigEffectItem>, key: string): ConfigEffectItem | undefined {
  return items.get(key);
}

/** 登记表里某 tab 下界面保存仍需重启的字段（tab 顶部一次性提示用） */
export function restartItemsOfTab(items: readonly ConfigEffectItem[], tab: string): ConfigEffectItem[] {
  return items.filter((item) => item.tab === tab && item.effect === 'restart');
}

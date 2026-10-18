// 配置中心结构重组单测（T02467 / PRD §10 C1+C2+C3 / REQ-032+033+034）
// 三块都写成纯函数测试：tab 元数据、生效徽标渲染口径、待重启清单持久化。
// 这些正是原来散在模板 11 个 v-if 与 onMounted 一句赋值里的逻辑，收敛后必须能在无浏览器下锁住。
import { describe, it, expect } from 'vitest';
import {
  CONFIG_TAB_GROUPS,
  LOCKED_TAB_HINT,
  allConfigTabs,
  configTabNames,
  findTabMeta,
  isTabLocked,
  lockedTabLabel,
  navGroupsFor,
  resolveInitialTab,
} from '../src/utils/configTabs';
import { EFFECT_BADGES, badgeFor, indexEffectItems, restartItemsOfTab, type ConfigEffectItem } from '../src/utils/configEffects';
import {
  PENDING_RESTART_STORAGE_KEY,
  loadPendingRestart,
  mergePendingRestart,
  pendingRestartSummary,
  removePendingRestart,
  restartGuideText,
  savePendingRestart,
  type PendingRestartEntry,
} from '../src/utils/configPendingRestart';

function memStore(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    removeItem: (k: string) => {
      delete data[k];
    },
    dump: () => data,
  };
}

describe('configTabs：分组与权限（REQ-033/REQ-034）', () => {
  it('三组齐全，展平后 11 个 tab 一个不少（原来横向溢出被截断的那批）', () => {
    expect(CONFIG_TAB_GROUPS.map((g) => g.label)).toEqual(['个人偏好', 'AI 服务', '系统']);
    expect(allConfigTabs()).toHaveLength(11);
    expect(configTabNames()).toEqual(
      expect.arrayContaining(['schema', 'config', 'migrate', 'mcp', 'ai', 'sharedAi', 'tts', 'tools', 'theme', 'qq', 'prompts']),
    );
    // tab 名唯一，否则导航 key 与徽标索引都会撞车
    expect(new Set(configTabNames()).size).toBe(11);
  });

  it('每组都有面向用户的说明（让用户一眼看出改的是「只有我」还是「所有人」）', () => {
    for (const group of CONFIG_TAB_GROUPS) {
      expect(group.desc.length).toBeGreaterThan(4);
      expect(group.tabs.length).toBeGreaterThan(0);
    }
  });

  it('adminOnly 逐项对齐改造前的 v-if="isAdmin"（7 项锁定、4 项开放）', () => {
    const locked = allConfigTabs().filter((t) => t.adminOnly).map((t) => t.name);
    expect(locked.sort()).toEqual(['config', 'mcp', 'migrate', 'prompts', 'qq', 'schema', 'sharedAi']);
    expect(allConfigTabs().filter((t) => !t.adminOnly).map((t) => t.name).sort())
      .toEqual(['ai', 'theme', 'tools', 'tts']);
  });

  it('锁定项在导航里保留并标注「仅管理员」，而不是消失', () => {
    const groups = navGroupsFor(false);
    const flat = groups.flatMap((g) => g.items);
    expect(flat).toHaveLength(11);
    const configItem = flat.find((i) => i.name === 'config');
    expect(configItem?.locked).toBe(true);
    expect(configItem?.label).toBe('系统配置');
    expect(lockedTabLabel(findTabMeta('config')!)).toContain(LOCKED_TAB_HINT);
    // 管理员视角：一个都不锁
    expect(navGroupsFor(true).flatMap((g) => g.items).every((i) => !i.locked)).toBe(true);
  });

  it('isTabLocked 只锁「管理员专属 + 当前不是管理员」', () => {
    expect(isTabLocked(findTabMeta('schema')!, false)).toBe(true);
    expect(isTabLocked(findTabMeta('schema')!, true)).toBe(false);
    expect(isTabLocked(findTabMeta('tts')!, false)).toBe(false);
  });

  describe('resolveInitialTab：不再有静默跳 tab', () => {
    it('无外部指定时按角色落点（管理员→系统配置，普通用户→朗读设置）', () => {
      expect(resolveInitialTab(null, true)).toBe('config');
      expect(resolveInitialTab(undefined, false)).toBe('tts');
    });

    it('深链到未锁定 tab 时按用户意图落过去', () => {
      expect(resolveInitialTab('theme', false)).toBe('theme');
      expect(resolveInitialTab('prompts', true)).toBe('prompts');
    });

    it('深链到锁定 tab / 不存在的 tab 时回落，且不会落进无权面板', () => {
      expect(resolveInitialTab('config', false)).toBe('tts');
      expect(resolveInitialTab('不存在的tab', false)).toBe('tts');
      expect(resolveInitialTab('mcp', false)).toBe('tts');
      // 回落对管理员是「系统配置」，同样不该是那个不存在的 tab
      expect(resolveInitialTab('不存在的tab', true)).toBe('config');
    });
  });
});

describe('configEffects：徽标渲染口径（REQ-032）', () => {
  const items: ConfigEffectItem[] = [
    { key: 'adapter', label: '编译引擎', effect: 'restart', viaFile: 'restart', tab: 'config', reason: '启动时创建' },
    { key: 'budget.maxSteps', label: '最大步数', effect: 'instant', viaFile: 'reload', tab: 'config', reason: '保存即同步' },
    { key: 'schema', label: 'SCHEMA 规范', effect: 'instant', viaFile: 'instant', tab: 'schema', reason: '文件本身' },
  ];
  const index = indexEffectItems(items);

  it('界面保存面：只有「即时 / 需重启」两种', () => {
    expect(badgeFor(index.get('adapter'), 'ui')).toBe(EFFECT_BADGES.ui_restart);
    expect(badgeFor(index.get('budget.maxSteps'), 'ui')).toBe(EFFECT_BADGES.ui_instant);
  });

  it('改文件面：区分「即生效 / 需热加载 / 需重启」，与界面保存面互不冒充', () => {
    expect(badgeFor(index.get('schema'), 'file')).toBe(EFFECT_BADGES.file_instant);
    expect(badgeFor(index.get('budget.maxSteps'), 'file')).toBe(EFFECT_BADGES.file_reload);
    expect(badgeFor(index.get('adapter'), 'file')).toBe(EFFECT_BADGES.file_restart);
    // 最大步数在界面上是「即时」，在文件上是「需热加载」——两条路径各说各的
    expect(badgeFor(index.get('budget.maxSteps'), 'ui')!.label).toBe('即时生效');
    expect(badgeFor(index.get('budget.maxSteps'), 'file')!.label).toBe('改文件需热加载');
  });

  it('未登记字段返回 undefined（视图不猜，宁可不显示徽标）', () => {
    expect(badgeFor(undefined, 'ui')).toBeUndefined();
    expect(badgeFor(undefined, 'file')).toBeUndefined();
    expect(indexEffectItems([]).size).toBe(0);
  });

  it('每个徽标都有文案与配色档位，tooltip 说明「改了要做什么」', () => {
    for (const badge of Object.values(EFFECT_BADGES)) {
      expect(badge.label).toBeTruthy();
      expect(['instant', 'reload', 'restart']).toContain(badge.tone);
      expect(badge.tip.length).toBeGreaterThan(6);
    }
  });

  it('restartItemsOfTab 按 tab 汇总需重启项（数据迁移等整页提示用）', () => {
    expect(restartItemsOfTab(items, 'config').map((i) => i.key)).toEqual(['adapter']);
    expect(restartItemsOfTab(items, 'schema')).toEqual([]);
  });
});

describe('configPendingRestart：页顶待重启清单（REQ-032 汇总侧）', () => {
  const entry: PendingRestartEntry = { key: 'server.port', label: '服务端口', reason: '端口启动时占用', at: 1 };

  it('空清单不写存储，且读取脏数据不会卡死横幅', () => {
    const store = memStore();
    savePendingRestart([], store);
    expect(store.dump()[PENDING_RESTART_STORAGE_KEY]).toBeUndefined();
    expect(loadPendingRestart(memStore({ [PENDING_RESTART_STORAGE_KEY]: '{坏数据' }))).toEqual([]);
    expect(loadPendingRestart(memStore({ [PENDING_RESTART_STORAGE_KEY]: '{"不是数组":1}' }))).toEqual([]);
    expect(loadPendingRestart(memStore())).toEqual([]);
  });

  it('读档时补齐缺失字段，丢弃结构不符的条目', () => {
    const store = memStore({
      [PENDING_RESTART_STORAGE_KEY]: JSON.stringify([
        { key: 'a', label: 'A 项' },
        { key: 2, label: '脏' },
        null,
      ]),
    });
    expect(loadPendingRestart(store)).toEqual([{ key: 'a', label: 'A 项', reason: '', at: 0 }]);
  });

  it('按 key 去重并刷新时间；老后端只回字符串名也兼容', () => {
    const merged = mergePendingRestart([entry], [{ key: 'server.port', label: '服务端口', reason: '换了个说法' }], 99);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ key: 'server.port', label: '服务端口', reason: '换了个说法', at: 99 });

    const withOld = mergePendingRestart([entry], ['vaultPath', 'logging.level'], 7);
    expect(withOld.map((e) => e.key)).toEqual(['server.port', 'vaultPath', 'logging.level']);
    // 字符串形态没有中文来源 → label 暂用 key，视图侧再由登记表换中文名
    expect(withOld[1].label).toBe('vaultPath');
    expect(withOld[1].at).toBe(7);
  });

  it('汇总文案：0 项时为空串（横幅不显示），N 项时给出数量', () => {
    expect(pendingRestartSummary([])).toBe('');
    expect(pendingRestartSummary([entry, { ...entry, key: 'adapter', label: '编译引擎' }])).toBe('有 2 项改动需重启服务才完全生效');
  });

  it('重启指引包含每项名称、可执行步骤，并提示热加载这条更轻的路', () => {
    const guide = restartGuideText([entry]);
    expect(guide).toContain('服务端口');
    expect(guide).toContain('重启步骤');
    expect(guide).toContain('热加载配置');
    expect(restartGuideText([])).toContain('（无）');
  });

  it('removePendingRestart 只摘掉指定 key，其余保留', () => {
    const list = [entry, { ...entry, key: 'adapter', label: '编译引擎' }];
    expect(removePendingRestart(list, ['adapter']).map((e) => e.key)).toEqual(['server.port']);
  });
});

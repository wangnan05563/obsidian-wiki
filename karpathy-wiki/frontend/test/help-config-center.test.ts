// T02623：帮助文档「配置中心」章节同步 T02467 的新结构
// ------------------------------------------------------------------
// 这一章原来描述的是改造前的「11 个 tab 单行平铺」，且把「联网搜索」「批量编译」写成了页签、
// 把「工具」写成了 tab 名（实名是「工具配置」）——用户照文档找不到东西。
// 文案改了容易，回退更容易：所以这里把文档口径**钉在代码的单一来源上**——
// 分组名、tab 实名、adminOnly 数量、生效标签文案、锁定页签的提示语，全部从 configTabs /
// configEffects 导出反查，任何一侧改名而另一侧没跟上，本用例即红。
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import Help from '../src/views/Help.vue';
import {
  CONFIG_TAB_GROUPS,
  LOCKED_TAB_HINT,
  allConfigTabs,
  configTabNames,
  resolveInitialTab,
} from '../src/utils/configTabs';
import { EFFECT_BADGES } from '../src/utils/configEffects';

function mountHelp() {
  setActivePinia(createPinia());
  return mount(Help, { global: { plugins: [ElementPlus] }, attachTo: document.body });
}

/** 只取「配置中心」章节的渲染文本（:id="section.id"），避免全站文本把断言稀释掉 */
function configSectionText(wrapper: ReturnType<typeof mountHelp>): string {
  const el = wrapper.find('#config');
  expect(el.exists(), '帮助文档必须有 id=config 的「配置中心」章节').toBe(true);
  return el.text();
}

describe('T02623 文档口径 = configTabs 单一来源', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    while (document.body.firstElementChild) document.body.firstElementChild.remove();
  });

  it('三个分组名逐字出现在章节里（与 CONFIG_TAB_GROUPS 同源）', async () => {
    const text = configSectionText(mountHelp());
    await flushPromises();
    for (const group of CONFIG_TAB_GROUPS) {
      expect(text, `文档缺分组名「${group.label}」`).toContain(group.label);
    }
  });

  it('12 个 tab 实名逐个能在文档里找到（改名未同步文档时这里先红）', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = configSectionText(wrapper);
    const tabs = allConfigTabs();
    // T02482（PRD D4x）新增「数据备份」：11 → 12。数量在这里显式钉住，是「加了页签没同步文档」的哨兵。
    expect(tabs).toHaveLength(12);
    for (const tab of tabs) {
      expect(text, `文档缺页签实名「${tab.label}」`).toContain(tab.label);
    }
  });

  it('「联网搜索」「批量编译」写明是分区而不是页签（原来写成 tab 的那两处）', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = configSectionText(wrapper);
    expect(text).toContain('联网搜索是「AI 服务」页签内的分区');
    expect(text).toContain('批量编译是「系统配置」页签内「高级配置」的分区');
    expect(text).toContain('它们都不是独立页签');
    // 旧口径：把 联网搜索 当成可点进去的页签
    expect(text).not.toContain('在「联网搜索」配置');
    expect(text).not.toContain('（个人）可选在「联网搜索」');
    // 工具 tab 实名是「工具配置」，文档不再用「工具」指代页签
    expect(text).not.toContain('在「工具」配置');
    expect(text).toContain('在「工具配置」页签配置');
  });

  it('生效标签与待重启清单：文档用词与 configEffects 导出一致', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = configSectionText(wrapper);
    // 页顶图例只解释这三档，文档也只能承诺这三档
    const legend = [EFFECT_BADGES.ui_instant, EFFECT_BADGES.file_reload, EFFECT_BADGES.ui_restart];
    for (const badge of legend) {
      expect(text, `文档缺生效标签「${badge.label}」`).toContain(badge.label);
    }
    expect(text).toContain('待重启');
    expect(text).toContain('我已重启，清除');
    expect(text).toContain('热加载配置');
  });

  it('文档说「7 个页签仅管理员」，代码里 adminOnly 就正好 7 个', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const adminOnlyCount = allConfigTabs().filter((t) => t.adminOnly).length;
    expect(configSectionText(wrapper)).toContain(`${adminOnlyCount} 个页签`);
  });

  it('文档承诺「不会静默送走」：resolveInitialTab 对非管理员深链给回落而不是照收', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = configSectionText(wrapper);
    // 提示语取自 configTabs，文档只引用其关键片段（改名会在这里暴露）
    expect(LOCKED_TAB_HINT).toContain('仅管理员可查看和修改');
    expect(text).toContain('仅管理员可查看和修改');
    // 行为侧：非管理员被深链到管理员 tab 一定回落到个人可达页签，不是停留在管理员 tab
    expect(resolveInitialTab('config', false)).toBe('tts');
    expect(resolveInitialTab('nope', false)).toBe('tts');
    expect(resolveInitialTab('config', true)).toBe('config');
  });
});

describe('T02623 「前往：配置中心 → X」直达全部合法', () => {
  it('章节自身新增的直达指向「系统配置」，tab 名在 configTabNames 内', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const jumps = wrapper.findAll('.block-jump');
    // 快速开始（AI 服务）+ 配置中心（系统配置）
    expect(jumps.length).toBeGreaterThanOrEqual(2);
    const mine = jumps.find((b) => b.text().includes('前往：配置中心 → 系统配置'));
    expect(mine, '配置中心章节应提供指向「系统配置」的直达').toBeTruthy();

    let navDetail: string | null = null;
    const onNav = (e: Event) => {
      navDetail = (e as CustomEvent<string>).detail;
    };
    globalThis.addEventListener('karpathy:navigate', onNav);
    await mine!.trigger('click');
    globalThis.removeEventListener('karpathy:navigate', onNav);

    expect(navDetail).toBe('config');
    const raw = sessionStorage.getItem('karpathy:navigate-tab');
    expect(raw).toBeTruthy();
    const nav = JSON.parse(raw!) as { view: string; tab: string };
    expect(nav.view).toBe('config');
    expect(configTabNames()).toContain(nav.tab);
    expect(nav.tab).toBe('config');
  });
});

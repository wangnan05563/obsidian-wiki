// T02914（PRD R-MOB 补功能入口）：移动端「我的 → 功能入口」挂载回归。
// ------------------------------------------------------------------
// 此前技能/数据清洗/缓存清理在移动端零入口，且 MobileQuery 会话失效提示指向
// 移动端根本不存在的「配置中心」页（错指引）。本期口径（T02480 用户裁决）：只补
// 功能入口——MobileMe 按权限渲染入口，MobileShell 全宽挂载对应桌面视图。
// 入口显隐复用 authStore.hasPermission（与桌面 filterVisibleMenus 同一权限口径）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MobileMe from '../src/components/mobile/MobileMe.vue';
import MobileShell from '../src/components/mobile/MobileShell.vue';
import { useAuthStore } from '../src/stores/auth';
import type { UserInfo } from '../src/types';

// MobileMe 依赖的外部面：模型预设（走 API）与 per-user IndexedDB 配置——全部桩化，
// 只保留「权限 → 入口渲染 → emit」这条被测链路。
vi.mock('../src/stores/model', () => ({
  useModelStore: () => ({ presets: [], selectedPresetKey: '', loadPresets: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../src/services/userConfig', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadAiUserConfigForPreset: vi.fn().mockResolvedValue({ provider: 'glm', baseUrl: '', model: '', apiKey: '' }),
    saveAiUserConfigForPreset: vi.fn().mockResolvedValue(undefined),
  };
});

// MobileShell 集成面：重型子组件全部桩化（含被挂载的三个桌面视图），
// MobileMe 也桩化——它自身的入口渲染由上面第一组用例真实挂载覆盖。
vi.mock('../src/components/mobile/MobileQuery.vue', () => ({ default: { template: '<div class="stub-query" />' } }));
vi.mock('../src/components/mobile/MobileBrowse.vue', () => ({ default: { template: '<div class="stub-browse" />' } }));
vi.mock('../src/components/mobile/MobileIngest.vue', () => ({ default: { template: '<div class="stub-ingest" />' } }));
vi.mock('../src/components/mobile/MobileListen.vue', () => ({ default: { template: '<div class="stub-listen" />' } }));
vi.mock('../src/components/mobile/MobileLogin.vue', () => ({ default: { template: '<div class="stub-login" />' } }));
vi.mock('../src/views/Skill.vue', () => ({ default: { template: '<div class="stub-view-skill" />' } }));
vi.mock('../src/views/Cleanup.vue', () => ({ default: { template: '<div class="stub-view-cleanup" />' } }));
vi.mock('../src/views/DataClean.vue', () => ({ default: { template: '<div class="stub-view-dataclean" />' } }));

function makeUser(permissions: string[]): UserInfo {
  return {
    id: 'u1', username: 'admin', role: 'admin', enabled: true,
    createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    permissions: permissions as UserInfo['permissions'],
  };
}

describe('MobileMe 功能入口（T02914）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  async function mountMe(permissions: string[]) {
    const authStore = useAuthStore();
    authStore.token = 't02914';
    authStore.user = makeUser(permissions);
    const w = mount(MobileMe, { global: { plugins: [] } });
    await flushPromises();
    return w;
  }

  it('admin（含 skill+cleanup 权限）看到 3 个入口，点击 emit 对应 key', async () => {
    const w = await mountMe(['skill', 'cleanup']);
    const items = w.findAll('.mme-feature-item');
    expect(items.map((i) => i.text().replace('›', '').trim())).toEqual(['技能管理', '缓存与日志清理', '页面质量清洗']);
    await items[0]!.trigger('click');
    expect(w.emitted('open-feature')).toEqual([['skill']]);
    await items[2]!.trigger('click');
    expect(w.emitted('open-feature')![1]).toEqual(['dataclean']);
  });

  it('只有 cleanup 权限的用户：两个清理入口可见，技能管理不可见', async () => {
    const w = await mountMe(['cleanup']);
    const labels = w.findAll('.mme-feature-item').map((i) => i.text().replace('›', '').trim());
    expect(labels).toEqual(['缓存与日志清理', '页面质量清洗']);
    expect(w.text()).not.toContain('技能管理');
  });

  it('无相关权限的用户：整个功能入口区不渲染（不出现越权入口）', async () => {
    const w = await mountMe(['query']);
    expect(w.find('.mme-features').exists()).toBe(false);
  });
});

describe('MobileShell 功能视图承载（T02914）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  async function mountShell() {
    const authStore = useAuthStore();
    authStore.token = 't02914';
    authStore.user = makeUser(['skill', 'cleanup']);
    const w = mount(MobileShell, { global: { plugins: [] } });
    await flushPromises();
    // 入口在「我的」Tab 内：先切过去再找功能入口
    const meTab = w.findAll('.tab-item').find((t) => t.attributes('aria-label') === '我的')!;
    await meTab.trigger('click');
    await flushPromises();
    return w;
  }

  it('真实 MobileMe 入口 emit 后主区域切换为桌面视图（标题 + 返回条），原 Tab 视图隐藏；点返回还原', async () => {
    const w = await mountShell();
    const skillEntry = w.findAll('.mme-feature-item').find((i) => i.text().includes('技能管理'))!;
    expect(skillEntry, 'admin 应看到技能管理入口').toBeTruthy();
    await skillEntry.trigger('click');
    expect(w.find('.mobile-feature').exists()).toBe(true);
    expect(w.find('.mf-title')!.text()).toBe('技能管理');
    expect(w.find('.stub-view-skill').exists()).toBe(true);
    expect(w.find('.stub-query').exists()).toBe(false);
    await w.find('.mf-back').trigger('click');
    expect(w.find('.mobile-feature').exists()).toBe(false);
    // 功能视图从「我的」打开，返回后回到的还是「我的」Tab（MobileMe 真实组件回归）
    expect(w.find('.mme-root').exists()).toBe(true);
    expect(w.find('.stub-query').exists()).toBe(false);
  });

  it('功能视图打开时点任意 Tab 直接回到该 Tab（5 Tab 布局不被顶坏）', async () => {
    const w = await mountShell();
    const skillEntry = w.findAll('.mme-feature-item').find((i) => i.text().includes('技能管理'))!;
    await skillEntry.trigger('click');
    expect(w.find('.mobile-feature').exists()).toBe(true);
    const browseTab = w.findAll('.tab-item').find((t) => t.attributes('aria-label') === '浏览')!;
    await browseTab.trigger('click');
    expect(w.find('.mobile-feature').exists()).toBe(false);
    expect(w.find('.stub-browse').exists()).toBe(true);
  });
});

describe('T02914 源码守护（错指引不回潮）', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

  it('MobileQuery 自产文案不再指向移动端不存在的「配置中心」', () => {
    const src = read('../src/components/mobile/MobileQuery.vue');
    expect(src).not.toContain('请先登录并在「配置中心');
    expect(src).toContain('「我的 → AI 服务」');
    // 后端 BYOK 原文检测保留，但展示侧必须替换为移动端真实入口
    expect(src).toContain("errMsg.includes('配置中心 → AI 服务')");
    expect(src).toContain("errMsg.replaceAll('配置中心 → AI 服务', '我的 → AI 服务')");
  });

  it('MobileShell 三个桌面视图已接线且聆听页在功能视图打开时隐藏', () => {
    const src = read('../src/components/mobile/MobileShell.vue');
    for (const view of ['Skill.vue', 'Cleanup.vue', 'DataClean.vue']) {
      expect(src).toContain(view);
    }
    expect(src).toMatch(/v-show="activeTab === 'listen' && !featureView"/);
    expect(src).toContain('@click="onTab(tab.key)"');
  });
});

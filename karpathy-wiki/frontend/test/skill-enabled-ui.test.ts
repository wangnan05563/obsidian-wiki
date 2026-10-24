// T02917「技能启用状态」前端挂载回归。
// ------------------------------------------------------------------
// 工单第 3 条要求「列表页每项显式状态标识，禁用时页头『可用技能数』同步下降，
// 不得只改图标不改计数」。本文件按真实渲染断言三件事：
//   ① 页头出现「可用技能」且数值 = 启用条目数（不是总数）；
//   ② 禁用条目在列表里可见、有文字状态、整行降透明度；
//   ③ 开关走 PATCH 且不做乐观更新——服务端失败时计数与状态都不许先翻。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const api = vi.hoisted(() => ({
  fetchSkills: vi.fn(),
  patchEnabled: vi.fn(),
}));

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/wiki/api',
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return api.patchEnabled(url, init);
    return api.fetchSkills(url);
  }),
}));
vi.mock('../src/components/StateBlock.vue', () => ({
  default: { props: ['state', 'emptyTitle', 'emptyDesc'], template: '<div class="stub-state-block">{{ emptyTitle }}</div>' },
}));

import Skill from '../src/views/Skill.vue';

const base = {
  description: '把三段材料合成一页',
  format: 'md' as const,
  importedAt: '2026-10-24T10:00:00.000Z',
  size: 2048,
  entryFile: 'SKILL.md',
};

const onSkill = { ...base, id: 'on-skill', name: '启用中的技能', enabled: true };
const offSkill = { ...base, id: 'off-skill', name: '已关掉的技能', enabled: false };

function okJson(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const SwitchStub = {
  props: ['modelValue'],
  emits: ['change'],
  template: '<button type="button" class="stub-switch" @click="$emit(\'change\', !modelValue)" />',
};

async function mountPage() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(Skill, {
    global: { plugins: [pinia], stubs: { 'el-switch': SwitchStub, 'el-button': true } },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  api.fetchSkills.mockReset();
  api.patchEnabled.mockReset();
  api.fetchSkills.mockResolvedValue(okJson({ skills: [onSkill, offSkill] }));
});

describe('页头「可用技能」计数', () => {
  it('按 enabled 现算：2 条里 1 条被禁用 ⇒ 可用 1', async () => {
    const wrapper = await mountPage();
    const stats = wrapper.findAll('.stat-item').map((n) => n.text());
    expect(stats.some((t) => t.includes('技能总数') && t.includes('2'))).toBe(true);
    expect(stats.some((t) => t.includes('可用技能') && t.includes('1'))).toBe(true);
  });
});

describe('列表状态标识', () => {
  it('禁用条目可见、有文字状态、整行降透明度', async () => {
    const wrapper = await mountPage();
    const items = wrapper.findAll('.skill-item');
    expect(items).toHaveLength(2); // 禁用的不能被过滤掉，否则没有再次启用的入口

    const off = items.find((n) => n.text().includes('已关掉的技能'))!;
    expect(off.classes()).toContain('is-disabled');
    expect(off.find('.status-badge').text()).toBe('已禁用');

    const on = items.find((n) => n.text().includes('启用中的技能'))!;
    expect(on.classes()).not.toContain('is-disabled');
    expect(on.find('.status-badge').text()).toBe('启用');
  });
});

describe('开关行为', () => {
  it('启用被禁用的技能：PATCH 打对端点与 body，成功后计数回升', async () => {
    api.patchEnabled.mockResolvedValue(okJson({ ...offSkill, enabled: true }));
    const wrapper = await mountPage();

    const off = wrapper.findAll('.skill-item').find((n) => n.text().includes('已关掉的技能'))!;
    await off.find('.stub-switch').trigger('click');
    await flushPromises();

    expect(api.patchEnabled).toHaveBeenCalledTimes(1);
    const [url, init] = api.patchEnabled.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/wiki/api/skills/off-skill/enabled');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true });

    const stats = wrapper.findAll('.stat-item').map((n) => n.text());
    expect(stats.some((t) => t.includes('可用技能') && t.includes('2'))).toBe(true);
    expect(
      wrapper.findAll('.skill-item').find((n) => n.text().includes('已关掉的技能'))!.classes(),
    ).not.toContain('is-disabled');
  });

  it('服务端失败：不乐观更新（状态与计数都保持原样）', async () => {
    api.patchEnabled.mockResolvedValue(okJson({ error: '写盘失败' }, 500));
    const wrapper = await mountPage();

    const off = wrapper.findAll('.skill-item').find((n) => n.text().includes('已关掉的技能'))!;
    await off.find('.stub-switch').trigger('click');
    await flushPromises();

    const after = wrapper.findAll('.skill-item').find((n) => n.text().includes('已关掉的技能'))!;
    expect(after.classes()).toContain('is-disabled');
    expect(after.find('.status-badge').text()).toBe('已禁用');
    const stats = wrapper.findAll('.stat-item').map((n) => n.text());
    expect(stats.some((t) => t.includes('可用技能') && t.includes('1'))).toBe(true);
  });
});

// T02915（PRD 缺口3：浏览页筛选可见化）挂载回归。
// ------------------------------------------------------------------
// 此前来源/状态/类型三个筛选全部收在 el-popover 里，触发器无 active 态、
// 收起后页面看不出「还在筛」，筛出 0 条时易误判为「知识库没内容」。
// 本改动：chip 行挂在 popover 外（单个 × 清除 + 清除全部），按钮 active 态 +
// 条数角标，0 条且在筛时空态文案区分并给清除入口。
// 状态源只有三个 filter ref（activeFilters 是派生 computed，不建第二套筛选状态）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import Browse from '../src/views/Browse.vue';
import { useAuthStore } from '../src/stores/auth';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/wiki/api',
  downloadVaultFile: vi.fn(),
  apiFetch: vi.fn(async (url: string) => {
    if (url.includes('/files/tree')) {
      return { ok: true, json: async () => ({ tree: [] }) };
    }
    if (url.includes('/files/pages')) {
      return { ok: true, json: async () => ({ pages: [] }) };
    }
    if (url.includes('/search')) {
      return { ok: true, json: async () => ({ hits: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }),
}));
vi.mock('../src/utils/sse', () => ({ consumeSSE: vi.fn() }));
vi.mock('../src/utils/nav', () => ({ gotoView: vi.fn() }));
vi.mock('../src/stores/compile', () => ({
  useCompileStore: () => ({
    draftBatchItems: [],
    draftIsPublishing: false,
    draftProgressMessage: '',
    loadDraftPublishState: vi.fn(),
  }),
}));
vi.mock('../src/services/userConfig', () => ({
  loadEmbeddingConfigForSearch: vi.fn().mockResolvedValue(null),
  loadAiUserConfigForPreset: vi.fn().mockResolvedValue(null),
}));

// 挂载面重型子件全部桩化；StateBlock 桩透出 empty-title 与 action 插槽，
// 用于断言「被筛选过滤」的空态文案与清除入口。
vi.mock('../src/components/DocumentTabs.vue', () => ({ default: { template: '<div class="stub-doc-tabs" />' } }));
vi.mock('../src/components/IconActionButton.vue', () => ({ default: { template: '<button class="stub-icon-action" />' } }));
vi.mock('../src/components/TocTree.vue', () => ({ default: { template: '<div class="stub-toc-tree" />' } }));
vi.mock('../src/components/StateBlock.vue', () => ({
  default: {
    props: ['state', 'emptyTitle', 'emptyDesc', 'compact'],
    template: `<div class="stub-state-block" :data-state="state">{{ emptyTitle }}<slot name="action" /></div>`,
  },
}));

// el-select 桩：点击即按 placeholder 模拟选中一项并派发 change（走 handleFilterChange 链路）
const NEXT_BY_PLACEHOLDER: Record<string, string> = {
  来源筛选: 'qq-chat',
  状态筛选: 'published',
  类型筛选: 'entity',
};
const selectStub = {
  props: ['modelValue'],
  emits: ['update:modelValue', 'change'],
  template: `<button class="stub-select" type="button" @click="emitPick">选择</button>`,
  methods: {
    emitPick(this: { $attrs: Record<string, unknown>; $emit: (e: string, v?: unknown) => void }) {
      const next = NEXT_BY_PLACEHOLDER[String(this.$attrs.placeholder)] ?? 'picked';
      this.$emit('update:modelValue', next);
      this.$emit('change', next);
    },
  },
};

async function mountBrowse() {
  const authStore = useAuthStore();
  authStore.token = 't02915';
  authStore.user = {
    id: 'u1',
    username: 'admin',
    role: 'admin',
    enabled: true,
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
  } as never;
  const w = mount(Browse, {
    global: {
      stubs: {
        'el-select': selectStub,
        // el-popover 未注册时 #reference 具名插槽不渲染（筛选按钮不在 DOM），桩成透出两个插槽
        'el-popover': { template: '<span class="stub-popover"><slot name="reference" /><slot /></span>' },
        // el-tree 未注册时作用域插槽 #default="{ data }" 会以 undefined 解构崩溃，直接整树桩掉
        'el-tree': { template: '<div class="stub-tree" />' },
        // el-button 未注册时渲染为 <el-button> 自定义元素，button 查询找不到，桩成真 button
        'el-button': { template: '<button class="stub-el-btn" type="button"><slot /></button>' },
      },
    },
  });
  await flushPromises();
  return w;
}

describe('浏览页筛选可见化（T02915）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('无筛选时：无 chip 行、按钮无 active 态无角标', async () => {
    const w = await mountBrowse();
    expect(w.find('.filter-chips').exists()).toBe(false);
    expect(w.find('.filter-more-btn').classes()).not.toContain('is-active');
    expect(w.find('.filter-badge').exists()).toBe(false);
  });

  it('选一个筛选：chip 行出现（字段+选项），按钮 active 且角标=1', async () => {
    const w = await mountBrowse();
    await w.find('.stub-select').trigger('click'); // 来源筛选 → qq-chat
    await flushPromises();
    const chips = w.findAll('.filter-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.text()).toContain('来源');
    expect(chips[0]!.text()).toContain('QQ 聊天');
    expect(w.find('.filter-more-btn').classes()).toContain('is-active');
    expect(w.find('.filter-badge').text()).toBe('1');
  });

  it('两个筛选：两条 chip、角标=2；单个 × 清除一条后角标回 1', async () => {
    const w = await mountBrowse();
    const selects = w.findAll('.stub-select');
    await selects[0]!.trigger('click'); // 来源 → qq-chat
    await selects[1]!.trigger('click'); // 状态 → published
    await flushPromises();
    expect(w.findAll('.filter-chip')).toHaveLength(2);
    expect(w.find('.filter-badge').text()).toBe('2');
    await w.find('.filter-chip .filter-chip-clear').trigger('click');
    await flushPromises();
    expect(w.findAll('.filter-chip')).toHaveLength(1);
    expect(w.find('.filter-badge').text()).toBe('1');
    expect(w.findAll('.filter-chip')[0]!.text()).toContain('状态');
  });

  it('筛选后 0 条：空态区分「被筛选过滤」并带清除入口，点清除后回目录（chip 行消失）', async () => {
    const w = await mountBrowse();
    await w.find('.stub-select').trigger('click');
    await flushPromises();
    const block = w.find('.stub-state-block');
    expect(block.attributes('data-state')).toBe('empty');
    expect(block.text()).toContain('筛选条件下没有匹配页面');
    expect(block.text()).not.toContain('未找到匹配页面');
    const clearBtn = block.findAll('button').find((b) => b.text() === '清除筛选条件');
    expect(clearBtn).toBeTruthy();
    await clearBtn!.trigger('click');
    await flushPromises();
    expect(w.find('.filter-chips').exists()).toBe(false);
    expect(w.find('.filter-badge').exists()).toBe(false);
    expect(w.find('.filter-more-btn').classes()).not.toContain('is-active');
  });

  it('清除全部：chip 行整行消失，按钮退回无状态', async () => {
    const w = await mountBrowse();
    const selects = w.findAll('.stub-select');
    await selects[0]!.trigger('click');
    await selects[2]!.trigger('click'); // 类型 → entity
    await flushPromises();
    expect(w.findAll('.filter-chip')).toHaveLength(2);
    await w.find('.filter-chip-clear-all').trigger('click');
    await flushPromises();
    expect(w.find('.filter-chips').exists()).toBe(false);
    expect(w.find('.filter-badge').exists()).toBe(false);
    expect(w.find('.filter-more-btn').classes()).not.toContain('is-active');
  });
});

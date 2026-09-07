// 回归测试：验证数据清洗页「查看差异」「合并」等后台任务按钮在点击后立即进入
// 加载态（spinner + 禁用），且在该后台任务完成前持续显示，完成后自动隐藏。
//
// 设计口径（沿用 dataclean-ai-analysis.test.ts）：
//   1. vi.mock 拦截 apiBase（捕获请求体）、userConfig / autoModel（隔离 IndexedDB）；
//   2. ElMessage / ElMessageBox 中性化为 no-op（确认弹窗默认 resolve(true)）；
//   3. 用可控的 pending Promise 卡住后台请求，断言「任务进行中」按钮 loading，
//      再 resolve 请求、flush，断言 loading 已清除。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import DataClean from '../src/views/DataClean.vue';
import { useAuthStore } from '../src/stores/auth';
import { useModelStore } from '../src/stores/model';
import { apiFetch } from '../src/utils/apiBase';
import { loadAiUserConfigForPreset } from '../src/services/userConfig';
import { AUTO_MODEL, resolveAutoPresetForUser } from '../src/utils/autoModel';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/wiki/api',
  apiFetch: vi.fn(),
}));
vi.mock('../src/services/userConfig', () => ({
  loadAiUserConfigForPreset: vi.fn(),
}));
vi.mock('../src/utils/autoModel', () => ({
  AUTO_MODEL: 'auto',
  resolveAutoPresetForUser: vi.fn(),
}));
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
    ElMessageBox: { confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn(), alert: vi.fn() },
  };
});

function makeResponse(data: any) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) } as any;
}

// 后端 /data-clean/deduplicate 的标准返回 shape（runDeduplication 会读取 matches / duplicateGroups）
const DEDUP_EMPTY = { matches: [], duplicateGroups: [], scannedPages: 0, uniquePages: 0 };

// 默认 apiFetch 路由：去重扫描返回标准空结构，避免 duplicates 被置为 undefined
function defaultApiFetch(url: string) {
  if (url.includes('/data-clean/deduplicate')) return Promise.resolve(makeResponse(DEDUP_EMPTY));
  if (url.includes('/data-clean/pages')) return Promise.resolve(makeResponse([]));
  return Promise.resolve(makeResponse({}));
}

// 一个可控的 pending 响应，用于把后台任务「卡」在 await 处
function pendingResponse() {
  let resolve: (v: any) => void;
  const promise = new Promise<any>((r) => { resolve = r; });
  const ctrl = {
    resolve: (data: any) => resolve(makeResponse(data)),
    promise,
  };
  return ctrl;
}

const DUP = {
  pageA: { path: 'concepts/a.md', title: 'A', qualityScore: 80 },
  pageB: { path: 'concepts/a-copy.md', title: 'A Copy', qualityScore: 40 },
  similarity: 0.95,
  matchType: 'near-duplicate',
  reason: '内容高度重复',
};

const DIFF_RESULT = {
  pathA: 'concepts/a.md',
  pathB: 'concepts/a-copy.md',
  summary: { unchanged: 10, removed: 2, added: 1, similarity: 0.9 },
  lines: [{ type: 'ctx', oldLine: 1, newLine: 1, content: 'x' }],
};

function findButton(wrapper: any, label: string) {
  return wrapper.findAll('button').find((b: any) => (b.text() || '').includes(label));
}

describe('数据清洗页后台任务按钮即时加载反馈', () => {
  let fetchCtrl: ReturnType<typeof pendingResponse> | null = null;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    fetchCtrl = null;

    // 默认：所有 apiFetch 走空成功；去重扫描返回标准空结构
    (apiFetch as any).mockImplementation(defaultApiFetch);
    (loadAiUserConfigForPreset as any).mockResolvedValue({});
    (resolveAutoPresetForUser as any).mockResolvedValue({ preset: { key: 'p1' }, config: {} });

    // 拦截全局 fetch（viewDiff 直接调用 fetch 拉差异）
    vi.stubGlobal('fetch', vi.fn((_url: string) => {
      fetchCtrl = pendingResponse();
      return fetchCtrl.promise;
    }));
  });

  it('点击「查看差异」：按钮立即进入 loading/禁用，差异返回后自动隐藏并渲染结果', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    (useAuthStore() as any).user = { id: 'u1', role: 'admin' };
    useModelStore().$patch({ selectedPresetKey: 'p1' });

    const wrapper = mount(DataClean, {
      global: { plugins: [pinia, ElementPlus] },
      attachTo: document.body,
    });
    await flushPromises();

    // 注入一个重复对并切到配对视图
    (wrapper.vm as any).dedupViewMode = 'pairs';
    (wrapper.vm as any).duplicates = [DUP];
    await nextTick();

    const viewBtn = findButton(wrapper, '查看差异');
    expect(viewBtn, '应存在「查看差异」按钮').toBeTruthy();

    // 点击 → 触发布局同步设置 diffingKey 并 await fetch（pending）
    await viewBtn!.trigger('click');
    await nextTick();
    await new Promise((r) => setTimeout(r, 10));
    await nextTick();

    // 后台任务进行中：按钮应处于 loading + 禁用态
    expect(viewBtn!.classes().includes('is-loading'), '查看差异按钮应处于加载态').toBe(true);
    expect(viewBtn!.attributes('disabled') !== undefined, '查看差异按钮应被禁用').toBe(true);

    // 抽屉应处于加载态（spinner），尚未渲染结果
    expect((wrapper.vm as any).diffLoading, 'diffLoading 应为 true').toBe(true);
    expect(wrapper.text(), '后台任务中不应渲染差异行').not.toContain('A 独有');

    // 差异返回 → 任务结束 → loading 清除 + 结果渲染
    fetchCtrl!.resolve(DIFF_RESULT);
    await flushPromises();
    await new Promise((r) => setTimeout(r, 10));
    await nextTick();

    expect((wrapper.vm as any).diffLoading, 'diffLoading 应已清除').toBe(false);
    expect(viewBtn!.classes().includes('is-loading'), '完成后应退出加载态').toBe(false);
    expect(wrapper.text(), '应渲染差异结果（A 独有行数）').toContain('A 独有');

    wrapper.unmount();
  });

  it('点击「合并到 X」：二次确认后按钮进入 loading/禁用，合并请求返回后自动隐藏', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    (useAuthStore() as any).user = { id: 'u1', role: 'admin' };
    useModelStore().$patch({ selectedPresetKey: 'p1' });

    const wrapper = mount(DataClean, {
      global: { plugins: [pinia, ElementPlus] },
      attachTo: document.body,
    });
    await flushPromises();

    (wrapper.vm as any).dedupViewMode = 'pairs';
    (wrapper.vm as any).duplicates = [DUP];
    await nextTick();

    const mergeBtn = findButton(wrapper, '合并到');
    expect(mergeBtn, '应存在「合并到 X」按钮').toBeTruthy();

    // 合并请求卡在 pending，保持 loading
    const mergeCtrl = pendingResponse();
    (apiFetch as any).mockImplementation((url: string) => {
      if (url.includes('/data-clean/merge')) return mergeCtrl.promise;
      return defaultApiFetch(url);
    });

    await mergeBtn!.trigger('click');
    // ElMessageBox.confirm 默认 resolve(true)；之后 mergingKey 被置位并 await merge（pending）
    await flushPromises();
    await new Promise((r) => setTimeout(r, 10));
    await nextTick();

    expect(mergeBtn!.classes().includes('is-loading'), '合并按钮应处于加载态').toBe(true);
    expect(mergeBtn!.attributes('disabled') !== undefined, '合并按钮应被禁用').toBe(true);

    // 合并请求返回 → 任务结束（合并会把该重复对从列表移除，按钮随之从 DOM 卸载）
    mergeCtrl.resolve({ errors: [], linkReplacements: 3 });
    await flushPromises();
    await new Promise((r) => setTimeout(r, 10));
    await nextTick();

    // 以数据源 mergingKey 为真相源：完成后必为 null（按钮若仍在 DOM，也不应再 loading）
    expect((wrapper.vm as any).mergingKey, 'mergingKey 应已清除').toBeNull();
    const mergeBtnAfter = findButton(wrapper, '合并到');
    if (mergeBtnAfter) {
      expect(mergeBtnAfter.classes().includes('is-loading'), '完成后应退出加载态').toBe(false);
    }

    wrapper.unmount();
  });
});

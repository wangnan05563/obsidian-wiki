// T02797 真挂载回归：DataClean 页「子目录中的页面」这一块必须**渲染得出来、点得动**。
// ------------------------------------------------------------------
// 为什么单独立一个挂载级用例：api 侧的检测/归位已有 misplaced-pages.test.ts 覆盖，
// 前端纯函数（可归位集合、汇总文案）在 dataclean-scope-and-table.test.ts 覆盖，
// 但「接口返回的数组能不能变成用户看得见的一块、按钮带的参数对不对」只有真挂载才验得到——
// 模板里写错一个变量名不会有任何测试变红（本块正是靠 v-if="misplaced.length > 0" 才显示）。
// 口径沿用 dataclean-interaction-loading.test.ts：mock apiBase 捕获请求体、中性化弹窗。
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus';
import DataClean from '../src/views/DataClean.vue';
import { createPinia, setActivePinia } from 'pinia';
import { useAuthStore } from '../src/stores/auth';
import { apiFetch } from '../src/utils/apiBase';
import { loadAiUserConfigForPreset } from '../src/services/userConfig';
import { resolveAutoPresetForUser } from '../src/utils/autoModel';
import { MISPLACED_ISSUE_TEXT } from '../src/utils/dataCleanPresentation';
import type { MisplacedPage } from '../src/types';

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

function ok(data: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) } as any;
}

const STRAY: MisplacedPage = {
  path: 'concepts/entity/bill-recourse.md',
  title: '票据追索权',
  type: 'entity',
  suggestedPath: 'entities/bill-recourse.md',
  conflict: null,
};
const STRAY_CLASH: MisplacedPage = {
  path: 'concepts/comparisons/recourse-comparison.md',
  title: '完全追索与有限追索对比',
  type: 'comparison',
  suggestedPath: 'comparisons/recourse-comparison.md',
  conflict: '目标位置已有同名页面：comparisons/recourse-comparison.md',
};

/** 错位清单可变的假接口：GET misplaced 返回当前值，POST promote 记录请求体 */
let misplacedList: MisplacedPage[] = [];
let promoteBodies: string[] = [];
function routeFetch(url: string, init?: any) {
  if (url.includes('/data-clean/misplaced/promote')) {
    promoteBodies.push(String(init?.body ?? ''));
    return Promise.resolve(ok({ promoted: misplacedList.filter((m) => !m.conflict).map((m) => ({ from: m.path, to: m.suggestedPath })), skipped: misplacedList.filter((m) => m.conflict).map((m) => ({ path: m.path, reason: m.conflict ?? '' })), errors: [], dryRun: false }));
  }
  if (url.includes('/data-clean/misplaced')) return Promise.resolve(ok(misplacedList));
  if (url.includes('/data-clean/deduplicate')) return Promise.resolve(ok({ matches: [], duplicateGroups: [], scannedPages: 0, uniquePages: 0 }));
  if (url.includes('/data-clean/pages')) return Promise.resolve(ok([]));
  return Promise.resolve(ok({}));
}

async function mountAs(role: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  (useAuthStore() as any).user = { id: 'u1', role };
  const wrapper = mount(DataClean, { global: { plugins: [pinia, ElementPlus] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

function findButton(wrapper: any, label: string) {
  return wrapper.findAll('button').find((b: any) => (b.text() || '').includes(label));
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  misplacedList = [];
  promoteBodies = [];
  (apiFetch as any).mockImplementation((url: string, init?: any) => routeFetch(url, init));
  (loadAiUserConfigForPreset as any).mockResolvedValue({});
  (resolveAutoPresetForUser as any).mockResolvedValue({ preset: { key: 'p1' }, config: {} });
});

describe('DataClean 子目录页面块（T02797 真挂载）', () => {
  it('检测到错位页时成块显示：标题、汇总、逐条去向，冲突条只标不并页', async () => {
    misplacedList = [STRAY, STRAY_CLASH];
    const wrapper = await mountAs('admin');

    expect(wrapper.find('.misplaced-block').exists(), '应渲染错位页区块').toBe(true);
    expect(wrapper.find('.misplaced-title').text()).toBe(`${MISPLACED_ISSUE_TEXT}（2 个）`);
    // 汇总里两个数必须分开：可自动归位 1 个、需人工确认 1 个
    expect(wrapper.find('.misplaced-meta').text()).toContain('1 个可直接归位');
    expect(wrapper.find('.misplaced-meta').text()).toContain('需人工确认');

    const rows = wrapper.findAll('.misplaced-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain('concepts/entity/bill-recourse.md');
    expect(rows[0].text()).toContain('entities/bill-recourse.md');
    expect(rows[1].text()).toContain('目标位置已有同名页面');
    expect(wrapper.text(), '不得出现术语表里的旧口径词').not.toContain('知识库体检');

    const batch = findButton(wrapper, '一键归位');
    expect(batch, '应有批量归位按钮').toBeTruthy();
    expect(batch!.text()).toContain('一键归位 (1)');
    expect(batch!.attributes('disabled'), '有可归位项时不应禁用').toBeUndefined();
  });

  it('批量归位只提交无冲突的路径，且显式 dry_run=false，完成后重新拉取清单', async () => {
    misplacedList = [STRAY, STRAY_CLASH];
    const wrapper = await mountAs('admin');
    await findButton(wrapper, '一键归位')!.trigger('click');
    await flushPromises();

    expect(ElMessageBox.confirm).toHaveBeenCalled();
    expect(promoteBodies).toHaveLength(1);
    const sent = JSON.parse(promoteBodies[0]);
    expect(sent.paths).toEqual(['concepts/entity/bill-recourse.md']);
    expect(sent.dry_run, '真实归位必须显式关掉预演').toBe(false);
    expect(ElMessage.success).toHaveBeenCalledWith(expect.stringContaining('已把 1 个页面搬回顶层目录'));
    expect(ElMessage.success).toHaveBeenCalledWith(expect.stringContaining('1 个需人工确认'));

    // 归位后接口返回空清单 → 区块必须消失，否则用户以为没生效
    misplacedList = [];
    await (wrapper.vm as any).loadPages();
    await flushPromises();
    expect(wrapper.find('.misplaced-block').exists()).toBe(false);
  });

  it('非管理员：批量按钮禁用，单条归位只提示不动手', async () => {
    misplacedList = [STRAY, STRAY_CLASH];
    const wrapper = await mountAs('viewer');

    expect(findButton(wrapper, '一键归位')!.attributes('disabled'), '非管理员应禁用批量归位').not.toBeUndefined();
    await (wrapper.vm as any).promoteMisplaced([STRAY.path]);
    expect(ElMessage.warning).toHaveBeenCalledWith(expect.stringContaining('需要管理员账户'));
    expect(promoteBodies, '非管理员不得发出归位请求').toHaveLength(0);
  });

  it('检测接口失败时不判整页失败：主表格照常渲染，只提示一次', async () => {
    misplacedList = [];
    (apiFetch as any).mockImplementation((url: string) =>
      url.includes('/data-clean/misplaced')
        ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as any)
        : routeFetch(url));
    const wrapper = await mountAs('admin');

    expect(wrapper.find('.misplaced-block').exists(), '检测失败时不渲染该块').toBe(false);
    expect(ElMessage.warning).toHaveBeenCalledWith(expect.stringContaining('子目录页面的检测未完成'));
    expect((wrapper.vm as any).loading).toBe(false);
  });
});

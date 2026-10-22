// T02907 预检分类计数真挂载回归：预检卡只显条数不显内容，但「条数」必须能对上内容。
// ------------------------------------------------------------------
// 为什么真挂载：precheckCategoryLines / precheckToastSummary 是纯函数（口径锁在
// dataclean-scope-and-table.test.ts），但「接口返回的分类能不能变成用户看得见的一行、
// misplaced 行的数字与下方错位块是不是同一个数」只有真挂载才验得到。
// 关键锁点：misplaced 行的文案由前端 key 映射出（MISPLACED_ISSUE_TEXT），不用服务端 label——
// 桩接口故意给一个「错误的服务端说法」，若前端偷懒直接渲染 label 本用例就红。
// 口径沿用 dataclean-misplaced-block.test.ts：mock apiBase、中性化弹窗。
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

/** 服务端 label 故意写成错的：前端必须用自己的常量逐字出文案，不能透传 */
const PRECHECK_BODY = {
  scannedFiles: 245,
  passed: false,
  errors: [],
  blocked: false,
  warnings: [
    'concepts/entity/a.md: Contains UTF-8 BOM',
    'concepts/entity/a.md: Unresolved link [[不存在]]',
    `3 个${MISPLACED_ISSUE_TEXT}`,
  ],
  warningCategories: [
    { key: 'bom', label: '页面带 UTF-8 BOM', count: 1 },
    { key: 'unresolvedLink', label: '未解析双链（目标页还没建）', count: 1 },
    { key: 'misplaced', label: '服务端说法（前端不得透传）', count: 3 },
  ],
};

let misplacedList: MisplacedPage[] = [];
let precheckBody: Record<string, unknown> | null = null;
function routeFetch(url: string) {
  if (url.includes('/data-clean/precheck')) {
    return precheckBody ? Promise.resolve(ok(precheckBody)) : Promise.resolve(ok({}));
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

async function runPrecheck(wrapper: any) {
  await (wrapper.vm as any).runPrecheck();
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  misplacedList = [STRAY, STRAY, STRAY];
  precheckBody = { ...PRECHECK_BODY, warningCategories: PRECHECK_BODY.warningCategories.map((c) => ({ ...c })) };
  (apiFetch as any).mockImplementation((url: string, init?: any) => routeFetch(url, init));
  (loadAiUserConfigForPreset as any).mockResolvedValue({});
  (resolveAutoPresetForUser as any).mockResolvedValue({ preset: { key: 'p1' }, config: {} });
});

describe('DataClean 预检分类计数（T02907 真挂载）', () => {
  it('预检卡逐行渲染分类计数，misplaced 行文案与下方错位块逐字同源', async () => {
    const wrapper = await mountAs('admin');
    await runPrecheck(wrapper);

    const lines = wrapper.findAll('.precheck-category-line');
    expect(lines).toHaveLength(3);
    // key 映射出前端自己的文案，服务端 label 不透传
    expect(lines[2].text()).toBe(`${MISPLACED_ISSUE_TEXT}：3`);
    expect(wrapper.text()).not.toContain('服务端说法');
    expect(lines[0].text()).toBe('页面带 UTF-8 BOM：1');
    expect(lines[1].text()).toBe('未解析双链（目标页还没建）：1');
  });

  it('misplaced 行的数字与 GET /api/data-clean/misplaced 的清单同数（3）', async () => {
    const wrapper = await mountAs('admin');
    await runPrecheck(wrapper);

    expect(misplacedList).toHaveLength(3);
    expect(wrapper.findAll('.precheck-category-line')[2].text()).toContain('：3');
    expect(wrapper.find('.misplaced-title').text()).toBe(`${MISPLACED_ISSUE_TEXT}（3 个）`);
    // 同屏两处数字必须一致：预检分类行 3 === 错位块标题 3
    expect(wrapper.text()).not.toContain(`${MISPLACED_ISSUE_TEXT}：${misplacedList.length + 1}`);
  });

  it('toast 摘要带分类计数，不再只给「N 个警告」总数', async () => {
    const wrapper = await mountAs('admin');
    await runPrecheck(wrapper);

    expect(ElMessage.warning).toHaveBeenCalledWith(expect.stringContaining(`预检发现 0 个错误，3 个警告`));
    expect(ElMessage.warning).toHaveBeenCalledWith(expect.stringContaining(`${MISPLACED_ISSUE_TEXT}：3`));
  });

  it('无分类（旧响应体/全部为零）时优雅降级：预检卡照常，不渲染分类行', async () => {
    precheckBody = { scannedFiles: 245, passed: true, errors: [], blocked: false, warnings: [] };
    const wrapper = await mountAs('admin');
    await runPrecheck(wrapper);

    expect(wrapper.find('.el-alert').exists(), '预检卡本身照常渲染').toBe(true);
    expect(wrapper.findAll('.precheck-category-line')).toHaveLength(0);
    expect(ElMessage.success).toHaveBeenCalledWith(expect.stringContaining('预检通过'));
  });
});

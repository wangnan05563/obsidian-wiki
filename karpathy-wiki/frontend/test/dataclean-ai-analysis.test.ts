// 回归测试：真实挂载 DataClean.vue，验证「AI分析」按钮在 BYOK 场景下正确向
// /data-clean/ai-analyze 请求体注入 llmConfig，并正确渲染分析结论 + 批量操作按钮。
//
// 设计口径（与 floating-chat-llmconfig.test.ts 一致）：
//   1. vi.mock 拦截 apiBase（捕获请求体）、userConfig / autoModel（隔离 IndexedDB / 真实读取）；
//   2. 部分 mock element-plus：保留组件注册（ElementPlus 插件），仅把 ElMessage / ElMessageBox 置为 no-op，
//      避免挂载即触发的 loadPages 成功提示、以及批量操作的确认弹窗干扰断言；
//   3. 触发「AI分析」→ runAiAnalysis → 断言请求体含 llmConfig.apiKey，且结论区渲染三类结果 + 批量按钮。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import DataClean from '../src/views/DataClean.vue';
import { useAuthStore } from '../src/stores/auth';
import { useModelStore } from '../src/stores/model';
import { apiFetch } from '../src/utils/apiBase';
import { loadAiUserConfigForPreset } from '../src/services/userConfig';
import { AUTO_MODEL, resolveAutoPresetForUser } from '../src/utils/autoModel';

// 拦截 apiBase：捕获 /data-clean/ai-analyze 请求体，并分路由返回 mock 响应
vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/wiki/api',
  apiFetch: vi.fn(),
}));

// 拦截 userConfig / autoModel：隔离 IndexedDB 依赖，直接返回可控的 BYOK 配置
vi.mock('../src/services/userConfig', () => ({
  loadAiUserConfigForPreset: vi.fn(),
}));
vi.mock('../src/utils/autoModel', () => ({
  AUTO_MODEL: 'auto',
  resolveAutoPresetForUser: vi.fn(),
}));

// 部分 mock element-plus：保留真实组件 + 插件，仅中性化 ElMessage / ElMessageBox
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

// AI 分析后端的返回样例（字段与 backend AiCleanAnalysisResult 对齐）
const AI_RESULT = {
  analyzedAt: new Date().toISOString(),
  summary: {
    totalPages: 3,
    scannedCandidatePages: 3,
    redundantCount: 1,
    duplicateGroupsCount: 1,
    renameCount: 1,
  },
  redundant: [
    { path: 'entities/trash-old.md', title: 'Trash', reason: '内容几乎为空，可安全删除', score: 5, wordCount: 0, fileSizeBytes: 30 },
  ],
  duplicates: [
    { representativePath: 'concepts/a.md', paths: ['concepts/a.md', 'concepts/a-copy.md'], reason: '内容重复，建议合并去重' },
  ],
  renames: [
    {
      path: 'concepts/My Note.md',
      title: 'My Note',
      currentName: 'My Note.md',
      suggestedName: 'my-note.md',
      suggestedPath: 'concepts/my-note.md',
      reason: '文件名含空格，建议规范化为 kebab-case',
    },
  ],
};

const BYOK_CONFIG = {
  apiKey: 'sk-test-byok-123',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
};

// 捕获最近一次 /data-clean/ai-analyze 请求体
function lastAnalyzeBody(): any {
  const call = (apiFetch as any).mock.calls.find(
    (c: any[]) => typeof c[0] === 'string' && c[0].includes('/data-clean/ai-analyze'),
  );
  if (!call) return null;
  const init = call[1];
  return typeof init?.body === 'string' ? JSON.parse(init.body) : null;
}

function findButton(wrapper: any, label: string) {
  return wrapper.findAll('button').find((b: any) => (b.text() || '').includes(label));
}

describe('DataClean AI 分析 BYOK llmConfig 注入 + 结论渲染', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();

    // 路由：pages 返回空列表（避免 el-table 渲染负担），ai-analyze 返回样例结论
    (apiFetch as any).mockImplementation((url: string) => {
      if (url.includes('/data-clean/pages')) return Promise.resolve(makeResponse([]));
      if (url.includes('/data-clean/ai-analyze')) return Promise.resolve(makeResponse(AI_RESULT));
      return Promise.resolve(makeResponse({}));
    });

    // 具体预设已配置 apiKey → 走 loadAiUserConfigForPreset 分支
    (loadAiUserConfigForPreset as any).mockResolvedValue({ ...BYOK_CONFIG });
    (resolveAutoPresetForUser as any).mockResolvedValue({ preset: { key: 'p1' }, config: { ...BYOK_CONFIG } });
  });

  it('点击「AI分析」向 /data-clean/ai-analyze 下发 llmConfig（含 apiKey），且结论区渲染三类结果 + 批量按钮', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);

    const authStore = useAuthStore();
    const modelStore = useModelStore();
    (authStore as any).user = { id: 'u1', role: 'admin' };
    modelStore.$patch({ selectedPresetKey: 'p1' });

    const wrapper = mount(DataClean, {
      global: { plugins: [pinia, ElementPlus] },
      attachTo: document.body,
    });
    await flushPromises();

    // 1) 找到「AI分析」按钮并点击
    const aiBtn = findButton(wrapper, 'AI分析');
    expect(aiBtn, '应存在「AI分析」按钮').toBeTruthy();
    await aiBtn!.trigger('click');
    await flushPromises();
    await new Promise((r) => setTimeout(r, 10));
    await flushPromises();

    // 2) 后端 ai-analyze 被调用，且请求体注入 BYOK llmConfig
    expect(apiFetch).toHaveBeenCalled();
    const body = lastAnalyzeBody();
    expect(body, '应调用 /data-clean/ai-analyze 并带请求体').toBeTruthy();
    expect(body.llmConfig?.apiKey, '应下发 llmConfig.apiKey（BYOK）').toBe('sk-test-byok-123');
    expect(body.llmConfig?.provider, '应下发 provider').toBe('openai');
    expect(body.llmConfig?.model, '应下发 model').toBe('gpt-4o');

    // 3) 结论区渲染出冗余 / 重复 / 重命名三类结果
    const text = wrapper.text();
    expect(text, '应渲染冗余文档路径').toContain('entities/trash-old.md');
    expect(text, '应渲染重复组代表路径').toContain('concepts/a.md');
    expect(text, '应渲染重命名建议（当前名 → 建议名）').toContain('My Note.md');
    expect(text, '应渲染规范化建议名').toContain('my-note.md');

    // 4) 配套批量操作按钮存在（管理员态下可点击，管理员以外 disabled，但 DOM 始终存在）
    const delBtn = findButton(wrapper, '批量删除');
    const dedupBtn = findButton(wrapper, '批量去重');
    const renameBtn = findButton(wrapper, '批量重命名');
    expect(delBtn, '应渲染「批量删除」按钮').toBeTruthy();
    expect(dedupBtn, '应渲染「批量去重」按钮').toBeTruthy();
    expect(renameBtn, '应渲染「批量重命名」按钮').toBeTruthy();

    // 5) 批量按钮带上数量统计
    expect(delBtn!.text(), '批量删除按钮应带数量').toContain('1');
    expect(dedupBtn!.text(), '批量去重按钮应带数量').toContain('1');
    expect(renameBtn!.text(), '批量重命名按钮应带数量').toContain('1');

    wrapper.unmount();
  });

  it('未配置 apiKey → 点击「AI分析」不下发 llmConfig（交后端 400 拦截），结论区不渲染', async () => {
    (loadAiUserConfigForPreset as any).mockResolvedValue({
      apiKey: '', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o',
    });

    const pinia = createPinia();
    setActivePinia(pinia);
    const authStore = useAuthStore();
    const modelStore = useModelStore();
    (authStore as any).user = { id: 'u1', role: 'admin' };
    modelStore.$patch({ selectedPresetKey: 'p1' });

    const wrapper = mount(DataClean, {
      global: { plugins: [pinia, ElementPlus] },
      attachTo: document.body,
    });
    await flushPromises();

    const aiBtn = findButton(wrapper, 'AI分析');
    await aiBtn!.trigger('click');
    await flushPromises();
    await new Promise((r) => setTimeout(r, 10));
    await flushPromises();

    // 无 apiKey → runAiAnalysis 提前 return，不应调用 ai-analyze
    const body = lastAnalyzeBody();
    expect(body, '无 apiKey 不应调用 /data-clean/ai-analyze').toBeNull();
    expect(wrapper.text(), '无结论时不应渲染冗余文档路径').not.toContain('entities/trash-old.md');

    wrapper.unmount();
  });
});

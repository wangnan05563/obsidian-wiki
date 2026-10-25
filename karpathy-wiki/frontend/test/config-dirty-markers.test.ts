// T02918 页面级验收：改任一字段 → 不滚到保存按钮也能在二级导航看见未保存标记。
// ------------------------------------------------------------------
// 为什么必须挂载真实 Config.vue：源码断言只能证明「传了 prop」，证明不了
// 「表单字段 → 快照 diff → 页签聚合 → 导航圆点」这条链真的通。这里用真实组件 + 真实 Pinia +
// 桩 fetch（后端响应形状照 GET/PUT /api/config* 抄），走完整交互：
//   1) 改「过期阈值」→ 系统配置页签出现标记、页顶汇总条出现；
//   2) 带着未保存改动切到别的页签 → 只有一条「提醒不阻断」的提示，切换本身照常发生；
//   3) 点该块的保存 → 标记清零、汇总条消失。
// 另附源码守护：标记只读不写盘（禁止「碰表单即 POST」回潮）。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus, { ElMessage } from 'element-plus';
import Config from '../src/views/Config.vue';
import { useAuthStore } from '../src/stores/auth';

vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
    ElMessageBox: { confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn(), alert: vi.fn() },
  };
});

const CONFIG_FIXTURE = {
  vaultPath: '/tmp/vault',
  adapter: 'claude',
  llm: { provider: 'glm', baseUrl: 'https://example.invalid/v1', model: 'glm-4', apiKeyRef: 'env:GLM', apiKeySet: true, stream: false },
  budget: { maxSteps: 20, tokenBudget: 200000 },
  server: { host: 'localhost', port: 3000 },
  localOnly: true,
  healthCheck: { staleDays: 30 },
  batch: { allowedExtensions: ['md', 'txt'], maxBatchSize: 50, maxFileSizeMb: 10 },
  logging: { level: 'info', enableRequestLog: true },
  enableSubAgents: false,
};

const QQ_FIXTURE = {
  noise_rules: { 'NR-1': true },
  privacy_patterns: { phone: '1[3-9]\\d{9}' },
  max_batch_size: 20,
  chunk_threshold: 200,
  extract_model: 'glm-4-plus',
  extract_base_url: '',
  extract_token_budget: 50000,
};

function json(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

let configFetchCount = 0;
let healthCheckSaved: unknown = null;

function installFetchStub(): void {
  configFetchCount = 0;
  healthCheckSaved = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/api/config/health-check') && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { staleDays: number };
        healthCheckSaved = body;
        return json({ ok: true, config: { staleDays: body.staleDays } });
      }
      if (url.endsWith('/api/config') && method === 'GET') {
        configFetchCount += 1;
        // 每个用例都拿新对象：Config.vue 保存成功会就地改写 config.value.*，
        // 直接返回共享 fixture 会把上一用例的 45 天带进下一用例的基线。
        return json(structuredClone(CONFIG_FIXTURE));
      }
      if (url.endsWith('/api/config/effects')) return json({ items: [] });
      if (url.endsWith('/api/schema')) return json({ content: '' });
      if (url.endsWith('/api/schema/history')) return json({ commits: [], gitEnabled: false });
      if (url.endsWith('/api/prompts')) return json({ prompts: [] });
      if (url.endsWith('/api/qq-ingest/config')) return json({ qq: QQ_FIXTURE });
      if (url.endsWith('/api/ai/presets')) return json({ presets: [] });
      if (url.endsWith('/api/ai/config')) return json({ provider: 'glm', baseUrl: '', model: '', apiKeyMasked: '', apiKeySet: false });
      if (url.endsWith('/api/media/shared')) return json({ image: {}, video: {} });
      if (url.endsWith('/api/media/presets')) return json({ imagePresets: [], videoPresets: [] });
      if (url.endsWith('/api/search/status')) return json({ indexedPages: 0, pendingPages: 0, totalChunks: 0 });
      if (url.endsWith('/api/config/mcp')) {
        return json({ enabled: false, endpointPath: '/mcp', name: 'karpathy-wiki', version: '1.0.0', authenticated: false, userTokenMasked: '', adminTokenMasked: '' });
      }
      return json({});
    }),
  );
}

async function mountConfig(): Promise<VueWrapper> {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.token = 'test-token';
  auth.user = {
    id: 'u-t02918',
    username: 'admin',
    role: 'admin',
    enabled: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    permissions: [],
  };
  const wrapper = mount(Config, {
    global: {
      plugins: [ElementPlus],
      stubs: { MarkdownRenderer: true, LocalDataBackupPanel: true, ThemeSwitcher: true },
    },
    attachTo: document.body,
  });
  // onMounted 里是多段并发加载：等两轮微任务把 config / 各表单基线都灌进来
  await flushPromises();
  await flushPromises();
  await nextTick();
  return wrapper;
}

function navItem(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('.nav-item').find((node) => node.text().includes(label));
  expect(found, `导航里必须有「${label}」`).toBeTruthy();
  return found!;
}

function hasDirtyMark(wrapper: VueWrapper, label: string): boolean {
  return navItem(wrapper, label).find('[data-testid="nav-dirty"]').exists();
}

describe('T02918 配置页逐页签未保存标记', () => {
  let wrapper: VueWrapper | null = null;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    while (document.body.firstElementChild) document.body.firstElementChild.remove();
    installFetchStub();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('基线干净：配置加载完成后没有任何未保存标记，也没有汇总条', async () => {
    wrapper = await mountConfig();
    expect(configFetchCount).toBeGreaterThan(0);
    expect(wrapper.find('.unsaved-bar').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="nav-dirty"]')).toHaveLength(0);
  });

  it('改一个字段（过期阈值）⇒ 系统配置页签立刻出现标记，汇总条点名页签与项数', async () => {
    wrapper = await mountConfig();
    const input = wrapper.find('#cfg-stale-days');
    expect(input.exists(), '系统配置页签应有「过期阈值」输入框').toBe(true);

    await input.setValue('45');
    await nextTick();

    expect(hasDirtyMark(wrapper, '系统配置')).toBe(true);
    // 其它页签不受牵连
    expect(hasDirtyMark(wrapper, '朗读设置')).toBe(false);

    const bar = wrapper.find('.unsaved-bar');
    expect(bar.exists()).toBe(true);
    expect(bar.text()).toContain('1 个页签有未保存改动');
    expect(bar.text()).toContain('系统配置');
    expect(bar.text()).toContain('过期阈值');
  });

  it('带着未保存改动切页签：只提醒不阻断（切换照常发生，且提示里点名上一页签）', async () => {
    wrapper = await mountConfig();
    await wrapper.find('#cfg-stale-days').setValue('45');
    await nextTick();

    const warning = vi.mocked(ElMessage.warning);
    warning.mockClear();

    await navItem(wrapper, 'Prompt IDE').trigger('click');
    await nextTick();

    // 不阻断：确实切到了 Prompt IDE（面板 aria-label 可见）
    expect(wrapper.find('[role="tabpanel"][aria-label="Prompt IDE"]').exists()).toBe(true);
    // 但明确告知上一页签还有改动
    expect(warning).toHaveBeenCalled();
    const text = String(warning.mock.calls.at(-1)?.[0] ?? '');
    expect(text).toContain('系统配置');
    expect(text).toContain('1 项改动未保存');
  });

  it('保存该块后标记清零、汇总条消失（保存动作只发一次对应子资源 PUT）', async () => {
    wrapper = await mountConfig();
    await wrapper.find('#cfg-stale-days').setValue('45');
    await nextTick();
    expect(hasDirtyMark(wrapper, '系统配置')).toBe(true);

    const saveButton = wrapper.findAll('button').find((b) => (b.attributes('data-tip') ?? '').includes('保存健康检查'));
    expect(saveButton, '健康检查块必须有保存按钮').toBeTruthy();
    await saveButton!.trigger('click');
    await flushPromises();
    await nextTick();

    expect(healthCheckSaved).toEqual({ staleDays: 45 });
    expect(hasDirtyMark(wrapper, '系统配置')).toBe(false);
    expect(wrapper.find('.unsaved-bar').exists()).toBe(false);
    // 保存后基线前移，不应再次标脏
    await nextTick();
    expect(wrapper.findAll('[data-testid="nav-dirty"]')).toHaveLength(0);
  });

  it('刷新前有未保存改动 ⇒ 触发 beforeunload 默认提示（preventDefault）', async () => {
    wrapper = await mountConfig();
    await wrapper.find('#cfg-stale-days').setValue('45');
    await nextTick();
    // 先确认此刻确实处于「有未保存改动」状态（否则下面的断言会误判成事件没接上）
    expect(wrapper.find('.unsaved-bar').exists()).toBe(true);

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent & { returnValue?: string };
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    // 保存后不再拦截
    const saveButton = wrapper.findAll('button').find((b) => (b.attributes('data-tip') ?? '').includes('保存健康检查'))!;
    await saveButton.trigger('click');
    await flushPromises();
    await nextTick();

    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });
});

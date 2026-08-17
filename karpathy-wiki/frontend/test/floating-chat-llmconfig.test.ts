// 回归测试：真实挂载 FloatingChat.vue，验证 sendQuestion 在 BYOK 场景下正确向 /query
// 请求体注入 llmConfig（及 searchConfig/toolsConfig 的条件注入），与 Query.vue 口径一致，
// 杜绝「FloatingChat 不下发 llmConfig → 后端 BYOK 校验 400」。
// 思路：vi.mock 拦截 apiBase（捕获请求体）、userConfig / autoModel（隔离 IndexedDB 依赖），
// 触发 handleSubmit → sendQuestion，断言请求体字段。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import FloatingChat from '../src/components/FloatingChat.vue';
import { useAuthStore } from '../src/stores/auth';
import { useConversationsStore } from '../src/stores/conversations';
import { useModelStore } from '../src/stores/model';
import { apiFetch } from '../src/utils/apiBase';
import { loadAiUserConfigForPreset, loadSearchUserConfig, loadToolsUserConfig } from '../src/services/userConfig';
import { resolveAutoPresetForUser } from '../src/utils/autoModel';

// 拦截依赖，隔离 IndexedDB / 真实 fetch：捕获 /query 请求体，断言 llmConfig 注入
vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/wiki/api',
  apiFetch: vi.fn(),
}));
vi.mock('../src/services/userConfig', () => ({
  loadAiUserConfigForPreset: vi.fn(),
  loadSearchUserConfig: vi.fn(),
  loadToolsUserConfig: vi.fn(),
}));
vi.mock('../src/utils/autoModel', () => ({
  AUTO_MODEL: 'auto',
  resolveAutoPresetForUser: vi.fn(),
}));

// 最小可消费 SSE 响应（同 query-edit-resend-flow.test.ts）：成功结束，不依赖 happy-dom 的 Response 实现
function fakeResponse() {
  const enc = new TextEncoder();
  const chunk =
    'event: answer\ndata: {"type":"answer","text":"ok"}\n\n' +
    'event: done\ndata: {"type":"done"}\n\n';
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const stubs = {
  RobotAvatar: true,
  ThinkingBlock: true,
  MessageToolbar: true,
  RefsList: true,
};

// 捕获最近一次 /query 请求体
function lastQueryBody(): any {
  const call = (apiFetch as any).mock.calls.find(
    (c: any[]) => typeof c[0] === 'string' && c[0].includes('/query'),
  );
  if (!call) return null;
  const init = call[1];
  return typeof init?.body === 'string' ? JSON.parse(init.body) : null;
}

describe('FloatingChat BYOK llmConfig 注入', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    (apiFetch as any).mockImplementation(() => Promise.resolve(fakeResponse()));
  });

  async function setupAndSend(question: string, presetKey: string) {
    const pinia = createPinia();
    setActivePinia(pinia);
    const authStore = useAuthStore();
    const convStore = useConversationsStore();
    const modelStore = useModelStore();

    convStore.loadConversations = vi.fn().mockResolvedValue(undefined);
    convStore.persistConversation = vi.fn().mockResolvedValue(undefined);
    (authStore as any).user = { id: 'u1', role: 'admin' };
    modelStore.$patch({
      presets: [{ key: 'p1', model: 'gpt-4o' }] as any,
      selectedPresetKey: presetKey,
    });

    const wrapper = mount(FloatingChat, {
      global: { plugins: [pinia, ElementPlus], stubs },
      attachTo: document.body,
    });
    await flushPromises();

    wrapper.vm.inputQuestion = question;
    wrapper.vm.handleSubmit();
    await flushPromises();
    await new Promise((r) => setTimeout(r, 10));
    await flushPromises();

    wrapper.unmount();
  }

  it('具体预设且已配置 apiKey → 下发 llmConfig，且无 key/工具的配置不下发', async () => {
    (loadAiUserConfigForPreset as any).mockResolvedValue({
      apiKey: 'sk-test-123', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o',
    });
    (loadSearchUserConfig as any).mockResolvedValue({ apiKey: '' });
    (loadToolsUserConfig as any).mockResolvedValue({ mcpServers: [], cliTools: [], scenes: [] });

    await setupAndSend('具体问题', 'p1');

    expect(apiFetch).toHaveBeenCalled();
    const body = lastQueryBody();
    expect(body, '请求体应存在').toBeTruthy();
    expect(body.llmConfig?.apiKey, '应下发 llmConfig.apiKey').toBe('sk-test-123');
    expect(body.searchConfig, '无 search key 不应下发 searchConfig').toBeUndefined();
    expect(body.toolsConfig, '无工具不应下发 toolsConfig').toBeUndefined();
  });

  it('auto 模式且已配置 → resolveAutoPresetForUser 选中并下发 llmConfig', async () => {
    (resolveAutoPresetForUser as any).mockResolvedValue({
      preset: { key: 'p1' }, config: { apiKey: 'sk-auto', provider: 'openai', baseUrl: 'x', model: 'gpt-4o' },
    });
    (loadSearchUserConfig as any).mockResolvedValue({ apiKey: '' });
    (loadToolsUserConfig as any).mockResolvedValue({ mcpServers: [], cliTools: [], scenes: [] });

    await setupAndSend('auto 问题', 'auto');

    expect(resolveAutoPresetForUser).toHaveBeenCalled();
    const body = lastQueryBody();
    expect(body.llmConfig?.apiKey, 'auto 应下发选中的 llmConfig.apiKey').toBe('sk-auto');
  });

  it('已配置但未填 apiKey → 不下发 llmConfig（交后端 400 拦截）', async () => {
    (loadAiUserConfigForPreset as any).mockResolvedValue({
      apiKey: '', provider: 'openai', baseUrl: 'x', model: 'gpt-4o',
    });
    (loadSearchUserConfig as any).mockResolvedValue({ apiKey: '' });
    (loadToolsUserConfig as any).mockResolvedValue({ mcpServers: [], cliTools: [], scenes: [] });

    await setupAndSend('无 key 问题', 'p1');

    const body = lastQueryBody();
    expect(body.llmConfig, '无 apiKey 不应下发 llmConfig').toBeUndefined();
  });
});

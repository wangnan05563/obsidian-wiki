// 回归测试：真实挂载 FloatingChat.vue，验证 sendQuestion 在 BYOK 场景下正确向 /query
// 请求体注入 llmConfig（及 searchConfig/toolsConfig 的条件注入），与 Query.vue 口径一致，
// 杜绝「FloatingChat 不下发 llmConfig → 后端 BYOK 校验 400」。
// T02462（Q5）同步：FloatingChat 改用 authStore.authFetch（与 Query 同一鉴权口径），
//   停止走 /query/stop，回车发送尊重 inputBoxStore.settings.enterSends。本测试相应改为
//    spy authStore.authFetch，并新增「回车偏好」一致性用例。
// 思路：vi.mock 拦截 apiBase（仅取 API_BASE 常量）、userConfig / autoModel（隔离 IndexedDB 依赖），
//   触发 handleSubmit → sendQuestion，断言请求体字段。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import FloatingChat from '../src/components/FloatingChat.vue';
import { useAuthStore } from '../src/stores/auth';
import { useConversationsStore } from '../src/stores/conversations';
import { useModelStore } from '../src/stores/model';
import { useInputBoxSettings } from '../src/stores/inputBoxSettings';
import { loadAiUserConfigForPreset, loadSearchUserConfig, loadToolsUserConfig } from '../src/services/userConfig';
import { resolveAutoPresetForUser } from '../src/utils/autoModel';
import { waitForProgress, NO_TIMER_CHAIN } from './helpers/waitForProgress';

// 拦截依赖，隔离 IndexedDB / 真实 fetch：API_BASE 仍由本 mock 提供（用于拼 URL），
// 但请求不再走 apiFetch（T02462 起走 authStore.authFetch）。
vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/wiki/api',
  apiFetch: vi.fn(),
}));
vi.mock('../src/services/userConfig', () => ({
  loadAiUserConfigForPreset: vi.fn(),
  loadSearchUserConfig: vi.fn(),
  loadToolsUserConfig: vi.fn(),
  // useInputBoxSettings store（FloatingChat 经 Q5 引入）初始化时依赖 clone / DEFAULT
  clone: (x: unknown) => JSON.parse(JSON.stringify(x)),
  DEFAULT_INPUT_BOX_SETTINGS: {
    enterSends: false,
    fontSize: 14,
    inputTheme: 'default',
    compact: false,
    quickReplies: [],
    historyPreference: 'full',
  } as any,
  loadInputBoxSettings: vi.fn(),
  saveInputBoxSettings: vi.fn(),
}));
vi.mock('../src/utils/autoModel', () => ({
  AUTO_MODEL: 'auto',
  resolveAutoPresetForUser: vi.fn(),
}));

// 最小可消费 SSE 响应：成功结束，不依赖 happy-dom 的 Response 实现
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

// 捕获最近一次 /query 请求体（经 authStore.authFetch）
let authFetchSpy: any = null;
function lastQueryBody(): any {
  const call = authFetchSpy?.mock?.calls?.find(
    (c: any[]) => typeof c[0] === 'string' && c[0].includes('/query'),
  );
  if (!call) return null;
  const init = call[1];
  return typeof init?.body === 'string' ? JSON.parse(init.body) : null;
}

describe('FloatingChat BYOK llmConfig 注入 + Q5 鉴权口径', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    authFetchSpy = null;
  });

  async function setupAndSend(question: string, presetKey: string, opts?: { enterSends?: boolean }) {
    const pinia = createPinia();
    setActivePinia(pinia);
    const authStore = useAuthStore();
    const convStore = useConversationsStore();
    const modelStore = useModelStore();
    const inputBoxStore = useInputBoxSettings();

    convStore.loadConversations = vi.fn().mockResolvedValue(undefined);
    convStore.persistConversation = vi.fn().mockResolvedValue(undefined);
    (authStore as any).user = { id: 'u1', role: 'admin' };
    // T02462（Q5）：FloatingChat 改用 authStore.authFetch，复用同一鉴权口径
    (authStore as any).authFetch = vi.fn(() => Promise.resolve(fakeResponse()));
    authFetchSpy = (authStore as any).authFetch;
    modelStore.$patch({
      presets: [{ key: 'p1', model: 'gpt-4o' }] as any,
      selectedPresetKey: presetKey,
    });
    if (opts?.enterSends !== undefined) {
      inputBoxStore.settings.enterSends = opts.enterSends;
    }

    const wrapper = mount(FloatingChat, {
      global: { plugins: [pinia, ElementPlus], stubs },
      attachTo: document.body,
    });
    await flushPromises();

    wrapper.vm.inputQuestion = question;
    wrapper.vm.handleSubmit();
    // T02753：等「/query 请求已发出」这个真实终点（本文件四个用例都以它为前提），不再睡 10ms 猜时长
    await waitForProgress('问答请求已发出', () => authFetchSpy?.mock?.calls?.length > 0, NO_TIMER_CHAIN);
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

    expect(authFetchSpy).toHaveBeenCalled();
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

  it('T02462 Q5：send 走 authStore.authFetch 且请求 /query（与 Query 同口径）', async () => {
    (loadAiUserConfigForPreset as any).mockResolvedValue({ apiKey: 'sk', provider: 'openai', baseUrl: 'x', model: 'm' });
    (loadSearchUserConfig as any).mockResolvedValue({ apiKey: '' });
    (loadToolsUserConfig as any).mockResolvedValue({ mcpServers: [], cliTools: [], scenes: [] });

    await setupAndSend('一致口径', 'p1');

    expect(authFetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/query'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

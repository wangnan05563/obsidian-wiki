// REQ-007/N8（T02730）FAB 一次性红点引导回归测试：
//   未展开过面板 → FAB 显示红点；首次展开 → 红点消失 + seen 标记落盘；
//   关闭后再挂载 → 不再有红点；老用户（面板默认展开偏好）不显示红点。
// 挂载模式沿用 floating-chat-llmconfig.test.ts（拦截 IndexedDB / fetch 依赖）。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import FloatingChat from '../src/components/FloatingChat.vue';
import { useAuthStore } from '../src/stores/auth';
import { useConversationsStore } from '../src/stores/conversations';
import { STORAGE_KEYS } from '../src/constants/storageKeys';

vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/wiki/api',
  apiFetch: vi.fn(),
}));
vi.mock('../src/services/userConfig', () => ({
  loadAiUserConfigForPreset: vi.fn(),
  loadSearchUserConfig: vi.fn(),
  loadToolsUserConfig: vi.fn(),
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

const stubs = {
  RobotAvatar: true,
  ThinkingBlock: true,
  MessageToolbar: true,
  RefsList: true,
};

async function mountChat() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const authStore = useAuthStore();
  const convStore = useConversationsStore();
  convStore.loadConversations = vi.fn().mockResolvedValue(undefined);
  convStore.persistConversation = vi.fn().mockResolvedValue(undefined);
  (authStore as any).user = { id: 'u1', role: 'admin' };
  (authStore as any).authFetch = vi.fn();

  const wrapper = mount(FloatingChat, {
    global: { plugins: [pinia, ElementPlus], stubs },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

describe('FloatingChat FAB 一次性红点引导（REQ-007/N8）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('新用户未展开过面板 → FAB 渲染红点', async () => {
    const wrapper = await mountChat();
    const fab = wrapper.find('.float-btn');
    expect(fab.exists(), '面板未展开时应渲染 FAB').toBe(true);
    expect(wrapper.find('.fab-guide-dot').exists(), '未看过引导时应显示红点').toBe(true);
    wrapper.unmount();
  });

  it('首次点击展开 → 红点消失，seen 标记落盘；关闭再挂载不再显示红点', async () => {
    const wrapper = await mountChat();
    await wrapper.find('.float-btn').trigger('click');
    await flushPromises();
    expect(wrapper.find('.floating-panel').exists(), '点击后面板应展开').toBe(true);
    expect(wrapper.find('.fab-guide-dot').exists(), '面板展开时 FAB 卸载，红点随之消失').toBe(false);
    expect(
      localStorage.getItem(STORAGE_KEYS.FLOATING_CHAT_GUIDE_SEEN),
      '首次展开应写入 seen 标记',
    ).toBe('true');

    // 模拟用户关闭面板后刷新（卸载 + 重挂载，localStorage 保留 seen 标记）
    await wrapper.find('.panel-actions .el-button[title="关闭"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.float-btn').exists(), '关闭后 FAB 回归').toBe(true);
    wrapper.unmount();

    const wrapper2 = await mountChat();
    expect(wrapper2.find('.float-btn').exists()).toBe(true);
    expect(
      wrapper2.find('.fab-guide-dot').exists(),
      '看过引导后重挂载不应再显示红点',
    ).toBe(false);
    wrapper2.unmount();
  });

  it('老用户（面板默认展开偏好）挂载即标记已看过，关闭后无红点', async () => {
    localStorage.setItem(STORAGE_KEYS.FLOATING_CHAT_OPEN, 'true');
    const wrapper = await mountChat();
    expect(wrapper.find('.floating-panel').exists(), '展开偏好下面板应直接展开').toBe(true);
    expect(
      localStorage.getItem(STORAGE_KEYS.FLOATING_CHAT_GUIDE_SEEN),
      '老用户挂载即标记已看过引导',
    ).toBe('true');

    await wrapper.find('.panel-actions .el-button[title="关闭"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.float-btn').exists()).toBe(true);
    expect(
      wrapper.find('.fab-guide-dot').exists(),
      '老用户关闭面板后不应看到红点',
    ).toBe(false);
    wrapper.unmount();
  });
});

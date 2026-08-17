import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, reactive } from 'vue';
import type { LlmPreset } from '../src/types';

// vi.hoisted 仅放「纯值 + holder 容器」，避免在其中调用被 hoist 的导入（ref/reactive 尚未初始化）。
// ref 在 vi.mock 工厂内创建（工厂在 import 阶段执行，此时 vue 已可用），并通过 holder 暴露给测试用例变更。
const hoist = vi.hoisted(() => ({
  presets: [
    {
      key: 'openai',
      label: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKeyRef: 'OPENAI_API_KEY',
      apiKeyUrl: 'https://platform.openai.com/api-keys',
      vision: true,
    },
    {
      key: 'glm',
      label: '智谱 GLM',
      provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-flash',
      apiKeyRef: 'GLM_KEY',
      apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
      vision: true,
    },
  ] as LlmPreset[],
  holder: {
    selectedPresetKey: undefined as ReturnType<typeof ref<string>> | undefined,
    presetsRef: undefined as ReturnType<typeof ref<LlmPreset[]>> | undefined,
    loadError: undefined as ReturnType<typeof ref<string>> | undefined,
  },
}));

vi.mock('../src/stores/model', () => {
  const selectedPresetKey = ref('openai');
  const presetsRef = ref<LlmPreset[]>(hoist.presets);
  const loadError = ref('');
  // 暴露给测试用例，便于按场景变更
  hoist.holder.selectedPresetKey = selectedPresetKey;
  hoist.holder.presetsRef = presetsRef;
  hoist.holder.loadError = loadError;
  return {
    useModelStore: () => reactive({
      selectedPresetKey,
      presets: presetsRef,
      loadError,
      // 展开面板后渲染「服务商真实模型」分组所需的字段（先前下拉框修复新增），
      // 缺失会导致 store.availableModels 为 undefined、渲染 340 行 .length 时崩溃。
      availableModels: [] as { id: string }[],
      modelsLoading: false,
      modelsError: '',
      currentModel: '',
      selectAuto: vi.fn(),
      fetchModels: vi.fn(async () => false),
      loadPresets: vi.fn(async () => {}),
      switchModel: vi.fn(async () => {}),
    }),
  };
});

vi.mock('../src/stores/query', () => ({
  useQueryStore: () => reactive({ isLoading: false }),
}));

// 组件新增 useAuthStore 用于切换成功时校验 BYOK llmConfig；测试场景未触发切换，
// 仅需提供 user 默认 null（userId 回退 'guest'），与上方 model/query mock 保持一致。
vi.mock('../src/stores/auth', () => ({
  useAuthStore: () => reactive({ user: null }),
}));

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

// 组件展开面板时会调用 loadRealModels → loadAiUserConfigForPreset（依赖 IndexedDB）。
// 在测试环境直接 stub 掉，避免真实 IndexedDB 依赖与异步噪声，使测试完全隔离。
vi.mock('../services/userConfig', () => ({
  loadAiUserConfigForPreset: vi.fn(async () => ({})),
  saveAiUserConfigForPreset: vi.fn(async () => {}),
}));

import ModelSelector from '../src/components/ModelSelector.vue';

describe('ModelSelector 显示规范', () => {
  beforeEach(() => {
    // 复位为默认正常态（通过 holder 上暴露的 ref）
    if (hoist.holder.selectedPresetKey) hoist.holder.selectedPresetKey.value = 'openai';
    if (hoist.holder.presetsRef) hoist.holder.presetsRef.value = hoist.presets;
    if (hoist.holder.loadError) hoist.holder.loadError.value = '';
  });

  it('收起态触发器仅显示模型名称，不含厂商', () => {
    const wrapper = mount(ModelSelector);
    const label = wrapper.find('.ms-label').text();
    // 仅模型名
    expect(label).toBe('gpt-4o-mini');
    // 不含厂商
    expect(label).not.toContain('OpenAI');
    // 触发器整体文本也不含厂商
    expect(wrapper.find('.model-selector-trigger').text()).not.toContain('OpenAI');
  });

  it('展开态下拉列表每项显示「模型名称 · 厂商名称」', async () => {
    const wrapper = mount(ModelSelector);
    await wrapper.find('.model-selector-trigger').trigger('click');

    const items = wrapper.findAll('.model-selector-item');
    // 列表 = [系统自动选择(auto)] + 已配置预设（openai、glm），共 3 项
    expect(items).toHaveLength(3);

    // 第 0 项：系统自动选择（auto 哨兵，模型名「自动」· 厂商「系统自动选择」）
    expect(items[0].find('.ms-item-model').text()).toBe('自动');
    expect(items[0].find('.ms-item-provider').text()).toBe('系统自动选择');
    expect(items[0].text()).toContain('·');

    // 第 1 项：gpt-4o-mini（模型） · OpenAI（厂商）
    expect(items[1].find('.ms-item-model').text()).toBe('gpt-4o-mini');
    expect(items[1].find('.ms-item-provider').text()).toBe('OpenAI');
    expect(items[1].text()).toContain('·');
    expect(items[1].text()).toContain('gpt-4o-mini');
    expect(items[1].text()).toContain('OpenAI');

    // 第 2 项：glm-4-flash（模型） · 智谱 GLM（厂商）
    expect(items[2].find('.ms-item-model').text()).toBe('glm-4-flash');
    expect(items[2].find('.ms-item-provider').text()).toBe('智谱 GLM');
  });

  it('展开态文本与收起态文本格式明确区分（展开含厂商，收起不含）', async () => {
    const wrapper = mount(ModelSelector);
    const collapsed = wrapper.find('.ms-label').text();
    await wrapper.find('.model-selector-trigger').trigger('click');
    const firstItem = wrapper.find('.model-selector-item').text();
    // 收起态缺厂商/分隔符，展开态包含，二者不同
    expect(collapsed).not.toContain('·');
    expect(firstItem).toContain('·');
    expect(collapsed).not.toBe(firstItem);
  });

  it('加载/错误态给出占位文本而非模型名', () => {
    if (hoist.holder.loadError) hoist.holder.loadError.value = '模型服务不可用';
    const wrapper = mount(ModelSelector);
    expect(wrapper.find('.ms-label').text()).toBe('模型服务不可用');
  });

  it('面板展开后可通过点击外部收起', async () => {
    const wrapper = mount(ModelSelector, { attachTo: document.body });
    await wrapper.find('.model-selector-trigger').trigger('click');
    expect(wrapper.find('.model-selector-panel').exists()).toBe(true);
    // 在组件外派发 document 点击
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.model-selector-panel').exists()).toBe(false);
    outside.remove();
    wrapper.unmount();
  });
});

describe('ModelSelector 展开方向自适应', () => {
  // 用 nextTick 让 toggle 内的方向计算在绘制前完成；再借 resize 事件重算方向。
  function mockRect(el: Element, rect: Partial<DOMRect>) {
    (el as HTMLElement).getBoundingClientRect = vi.fn(
      () =>
        ({
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
          ...rect,
        }) as DOMRect,
    );
  }

  it('下方空间充足时向下展开（不含 drop-up 类）', async () => {
    const wrapper = mount(ModelSelector, { attachTo: document.body });
    await wrapper.find('.model-selector-trigger').trigger('click');
    const root = wrapper.element as HTMLElement;
    const panel = wrapper.find('.model-selector-panel').element as HTMLElement;
    // 触发器位于视口中上部（bottom=120），面板高 200：下方空间 ≈ 768-120-4=644 ≥ 200
    mockRect(root, { top: 100, bottom: 120 });
    mockRect(panel, { top: 124, bottom: 324, height: 200 });
    window.dispatchEvent(new Event('resize'));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.model-selector-panel').classes()).not.toContain('drop-up');
    wrapper.unmount();
  });

  it('下方空间不足（触发器贴近视口底部）时自动向上展开', async () => {
    const wrapper = mount(ModelSelector, { attachTo: document.body });
    await wrapper.find('.model-selector-trigger').trigger('click');
    const root = wrapper.element as HTMLElement;
    const panel = wrapper.find('.model-selector-panel').element as HTMLElement;
    // 触发器贴近底部（bottom=760），面板高 200：下方空间 ≈ 768-760-4=4 < 200，应向上
    mockRect(root, { top: 740, bottom: 760 });
    mockRect(panel, { top: 764, bottom: 964, height: 200 });
    window.dispatchEvent(new Event('resize'));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.model-selector-panel').classes()).toContain('drop-up');
    wrapper.unmount();
  });

  it('视口缩小导致下方空间不足时，方向从向下翻转为向上', async () => {
    const wrapper = mount(ModelSelector, { attachTo: document.body });
    await wrapper.find('.model-selector-trigger').trigger('click');
    const root = wrapper.element as HTMLElement;
    const panel = wrapper.find('.model-selector-panel').element as HTMLElement;
    mockRect(root, { top: 400, bottom: 420 });
    mockRect(panel, { top: 424, bottom: 624, height: 200 });
    // 初始空间足（768-420-4=344 ≥ 200）→ 向下
    window.dispatchEvent(new Event('resize'));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.model-selector-panel').classes()).not.toContain('drop-up');

    // 模拟视口缩小到 500：下方空间 ≈ 500-420-4=76 < 200 → 翻转为向上
    const orig = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    window.dispatchEvent(new Event('resize'));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.model-selector-panel').classes()).toContain('drop-up');
    Object.defineProperty(window, 'innerHeight', { value: orig, configurable: true });
    wrapper.unmount();
  });
});

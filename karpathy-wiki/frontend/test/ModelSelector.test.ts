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
    expect(items).toHaveLength(2);

    // 第 1 项：gpt-4o-mini（模型） · OpenAI（厂商）
    expect(items[0].find('.ms-item-model').text()).toBe('gpt-4o-mini');
    expect(items[0].find('.ms-item-provider').text()).toBe('OpenAI');
    expect(items[0].text()).toContain('·');
    expect(items[0].text()).toContain('gpt-4o-mini');
    expect(items[0].text()).toContain('OpenAI');

    // 第 2 项：glm-4-flash（模型） · 智谱 GLM（厂商）
    expect(items[1].find('.ms-item-model').text()).toBe('glm-4-flash');
    expect(items[1].find('.ms-item-provider').text()).toBe('智谱 GLM');
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

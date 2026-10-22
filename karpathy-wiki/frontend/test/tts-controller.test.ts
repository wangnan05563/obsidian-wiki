// T02824：TtsController 接线（FR-QRY-06）——组件渲染级验证。
// 背景：该组件曾完整可用却零挂载（孤儿），PRD 明确要求「朗读时底部浮现迷你控制器」。
// 本用例锁三件事：idle 不占位、playing/paused 状态文案与控制按钮、stop 后消失。
// 策略沿用 ttsStore-isolation.test.ts：fake-indexeddb 供真实 ttsConfig 存储，useTTS 打桩。
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import fs from 'node:fs';
import path from 'node:path';
import { setActivePinia, createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import TtsController from '../src/components/TtsController.vue';
import { useTtsStore } from '../src/stores/tts';

const ttsApi = vi.hoisted(() => ({
  providerName: { value: 'edge' as const },
  loading: { value: false },
  setProvider: vi.fn(),
  setRate: vi.fn(),
  speak: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../src/composables/useTTS', () => ({
  useTTS: () => ({
    state: { value: 'idle' as const },
    rate: { value: 1 },
    providerName: ttsApi.providerName,
    loading: ttsApi.loading,
    setProvider: ttsApi.setProvider,
    setRate: ttsApi.setRate,
    speak: ttsApi.speak,
    pause: ttsApi.pause,
    resume: ttsApi.resume,
    stop: ttsApi.stop,
  }),
}));

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
};

describe('TtsController 渲染（T02824 接线守护）', () => {
  it('桌面 Query 与移动端 MobileQuery 都在模板中挂载了 TtsController（FR-QRY-06）', () => {
    for (const rel of ['views/Query.vue', 'components/mobile/MobileQuery.vue']) {
      const src = fs.readFileSync(path.resolve(__dirname, '../src', rel), 'utf8');
      expect(src, `${rel} 缺少 TtsController import`).toMatch(/import TtsController from/);
      const template = src.slice(src.indexOf('<template>'), src.lastIndexOf('</template>'));
      expect(template, `${rel} 模板未挂载 <TtsController`).toContain('<TtsController');
    }
  });

  beforeEach(() => {
    setActivePinia(createPinia());
    ttsApi.pause.mockClear();
    ttsApi.resume.mockClear();
    ttsApi.stop.mockClear();
  });

  it('idle 时不渲染（不遮挡内容）', async () => {
    const wrapper = mount(TtsController, { global: { plugins: [createPinia(), ElementPlus] }, attachTo: document.body });
    const store = useTtsStore();
    await flush();
    expect(store.state).toBe('idle');
    expect(wrapper.find('.tts-controller').exists()).toBe(false);
    wrapper.unmount();
  });

  it('朗读中：显示「朗读中」与暂停/停止两个控制按钮', async () => {
    const wrapper = mount(TtsController, { global: { plugins: [createPinia(), ElementPlus] }, attachTo: document.body });
    const store = useTtsStore();
    await flush();
    store.speak('第一段朗读文本', 'msg-1');
    await flush();
    expect(wrapper.find('.tts-controller').exists()).toBe(true);
    expect(wrapper.find('.tts-status').text()).toBe('朗读中');
    const btns = wrapper.findAll('.ctrl-btn');
    expect(btns).toHaveLength(2);
    expect(btns[0].attributes('title')).toBe('暂停');
    expect(btns[1].attributes('title')).toBe('停止');
    wrapper.unmount();
  });

  it('点击暂停 → 已暂停，再点 → 继续朗读；点击停止 → 控制器消失', async () => {
    const wrapper = mount(TtsController, { global: { plugins: [createPinia(), ElementPlus] }, attachTo: document.body });
    const store = useTtsStore();
    await flush();
    store.speak('内容', 'msg-1');
    await flush();

    await wrapper.findAll('.ctrl-btn')[0].trigger('click');
    expect(ttsApi.pause).toHaveBeenCalled();
    expect(store.state).toBe('paused');
    expect(wrapper.find('.tts-status').text()).toBe('已暂停');
    expect(wrapper.findAll('.ctrl-btn')[0].attributes('title')).toBe('继续');

    await wrapper.findAll('.ctrl-btn')[0].trigger('click');
    expect(ttsApi.resume).toHaveBeenCalled();
    expect(store.state).toBe('playing');
    expect(wrapper.find('.tts-status').text()).toBe('朗读中');

    await wrapper.findAll('.ctrl-btn')[1].trigger('click');
    expect(ttsApi.stop).toHaveBeenCalled();
    expect(store.state).toBe('idle');
    await flush();
    expect(wrapper.find('.tts-controller').exists()).toBe(false);
    wrapper.unmount();
  });
});

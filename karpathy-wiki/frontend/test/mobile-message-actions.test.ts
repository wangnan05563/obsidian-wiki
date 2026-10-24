// T02942（FR-QRY-06 前半句）：移动端消息级朗读 + 加入聆听。
// 组件渲染级证据：按钮三态、ttsStore 调用与浮动控制器浮现、加入聆听写入共享队列并去重。
// 另加源码护栏：MobileQuery 必须为助手消息渲染入口，MobileListen 必须用共享队列而非组件内 ref。
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import fs from 'node:fs';
import path from 'node:path';
import { setActivePinia, createPinia, type Pinia } from 'pinia';
import ElementPlus from 'element-plus';
import MobileMessageActions from '../src/components/mobile/MobileMessageActions.vue';
import TtsController from '../src/components/TtsController.vue';
import { useTtsStore } from '../src/stores/tts';
import { useListenQueueStore } from '../src/stores/listenQueue';

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

let pinia: Pinia;

// 所有挂载共用同一个 pinia：否则 useTtsStore() 读到的实例与组件内不是同一个
function mountActions(id = 'msg-1', content = '# 票据市场\n\n票据市场本周成交活跃。') {
  return mount(MobileMessageActions, {
    props: { message: { id, content } },
    global: { plugins: [pinia, ElementPlus] },
    attachTo: document.body,
  });
}

function mountController() {
  return mount(TtsController, { global: { plugins: [pinia, ElementPlus] }, attachTo: document.body });
}

describe('移动端消息朗读入口（T02942）', () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    [ttsApi.setProvider, ttsApi.setRate, ttsApi.speak, ttsApi.pause, ttsApi.resume, ttsApi.stop].forEach((fn) => fn.mockClear());
  });

  it('助手消息渲染「朗读 / 加入聆听」两个入口', async () => {
    const wrapper = mountActions();
    await flush();
    const btns = wrapper.findAll('.mq-msg-btn');
    expect(btns).toHaveLength(2);
    expect(btns[0].text()).toBe('朗读');
    expect(btns[1].text()).toBe('加入聆听');
    wrapper.unmount();
  });

  it('点朗读 → speak(正文)，按钮转「停止」，浮动控制器浮现；再点 → stop 且控制器消失', async () => {
    const wrapper = mountActions('msg-9', '待朗读的回答');
    const controller = mountController();
    const store = useTtsStore();
    await flush();
    expect(controller.find('.tts-controller').exists()).toBe(false);

    await wrapper.findAll('.mq-msg-btn')[0].trigger('click');
    await flush();
    expect(ttsApi.speak).toHaveBeenCalledWith('待朗读的回答', expect.objectContaining({ lang: 'zh-CN' }));
    expect(store.state).toBe('playing');
    expect(store.currentMsgId).toBe('msg-9');
    expect(wrapper.findAll('.mq-msg-btn')[0].text()).toBe('停止');
    expect(controller.find('.tts-controller').exists()).toBe(true);

    await wrapper.findAll('.mq-msg-btn')[0].trigger('click');
    await flush();
    expect(ttsApi.stop).toHaveBeenCalled();
    expect(store.state).toBe('idle');
    expect(controller.find('.tts-controller').exists()).toBe(false);
    wrapper.unmount();
    controller.unmount();
  });

  it('暂停中再点同一按钮 → 继续（resume），而不是重新合成', async () => {
    const wrapper = mountActions('msg-2', '第二段');
    const store = useTtsStore();
    await flush();
    store.speak('第二段', 'msg-2');
    store.pause();
    await flush();
    expect(wrapper.findAll('.mq-msg-btn')[0].text()).toBe('继续');

    await wrapper.findAll('.mq-msg-btn')[0].trigger('click');
    await flush();
    expect(ttsApi.resume).toHaveBeenCalled();
    expect(store.state).toBe('playing');
    wrapper.unmount();
  });

  it('切换消息朗读：store 先停旧朗读，同一时刻只有一条 currentMsgId', async () => {
    const a = mountActions('msg-a', '甲');
    const b = mountActions('msg-b', '乙');
    const store = useTtsStore();
    await flush();
    await a.findAll('.mq-msg-btn')[0].trigger('click');
    expect(store.currentMsgId).toBe('msg-a');
    ttsApi.stop.mockClear();

    await b.findAll('.mq-msg-btn')[0].trigger('click');
    expect(ttsApi.stop).toHaveBeenCalled();
    expect(store.currentMsgId).toBe('msg-b');
    expect(a.findAll('.mq-msg-btn')[0].text()).toBe('朗读');
    expect(b.findAll('.mq-msg-btn')[0].text()).toBe('停止');
    a.unmount();
    b.unmount();
  });

  it('加入聆听 → 写入共享队列（标题取首行去 Markdown），按钮转「已在聆听」且不重复入列', async () => {
    const wrapper = mountActions('msg-7', '# 票据市场\n\n正文内容。');
    const listenQueue = useListenQueueStore();
    await flush();
    expect(listenQueue.queue).toHaveLength(0);

    await wrapper.findAll('.mq-msg-btn')[1].trigger('click');
    expect(listenQueue.queue).toHaveLength(1);
    expect(listenQueue.queue[0]).toMatchObject({ path: 'message:msg-7', title: '票据市场', body: '# 票据市场\n\n正文内容。' });
    expect(wrapper.findAll('.mq-msg-btn')[1].text()).toBe('已在聆听');
    expect(wrapper.findAll('.mq-msg-btn')[1].attributes('disabled')).toBeDefined();

    await wrapper.findAll('.mq-msg-btn')[1].trigger('click');
    expect(listenQueue.queue).toHaveLength(1);
    wrapper.unmount();
  });

  it('源码护栏：MobileQuery 为助手消息渲染入口；MobileListen 使用共享队列（不再是组件内 ref）', () => {
    const root = path.resolve(__dirname, '../src');
    const query = fs.readFileSync(path.join(root, 'components/mobile/MobileQuery.vue'), 'utf8');
    const template = query.slice(query.indexOf('<template>'), query.lastIndexOf('</template>'));
    expect(template).toMatch(/<MobileMessageActions\b[^>]*v-if="msg\.role === 'assistant'/);
    expect(template).toContain('<TtsController');

    const listen = fs.readFileSync(path.join(root, 'components/mobile/MobileListen.vue'), 'utf8');
    expect(listen).toContain('useListenQueueStore');
    expect(listen).toMatch(/const \{ queue \} = storeToRefs\(listenQueueStore\)/);
    expect(listen).not.toMatch(/const queue = ref</);
  });
});

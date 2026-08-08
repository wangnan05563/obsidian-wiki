import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import MessageToolbar from '../src/components/MessageToolbar.vue';

describe('MessageToolbar 用户消息编辑按钮', () => {
  it('user 角色应渲染“编辑并重新发送”按钮且工具栏带基础 msg-toolbar 类', () => {
    const wrapper = mount(MessageToolbar, {
      props: {
        role: 'user',
        content: '你好，这是一条用户消息',
        // 不传 canEdit（与 Query.vue 实际用法一致，应默认 true → 编辑按钮可见）
      },
      global: { plugins: [createPinia()] },
    });
    const editBtn = wrapper.find('button[title="编辑并重新发送"]');
    console.log('=== DEBUG user toolbar html ===');
    console.log(wrapper.html());
    expect(editBtn.exists(), '编辑按钮应存在').toBe(true);
    // 需求：用户工具栏不再带强制常显的 msg-toolbar--user 类，与 AI 工具栏统一
    // 由 Query.vue 的 hover 规则控制显隐；此处仅断言基础 msg-toolbar 类存在
    expect(wrapper.find('.msg-toolbar').exists(), '工具栏应带基础 msg-toolbar 类').toBe(true);
    expect(wrapper.find('.msg-toolbar--user').exists(), '不应再带 msg-toolbar--user 强制常显类').toBe(false);
  });

  it('canEdit=false 时不渲染编辑按钮（悬浮窗场景）', () => {
    const wrapper = mount(MessageToolbar, {
      props: { role: 'user', content: 'hi', canEdit: false },
      global: { plugins: [createPinia()] },
    });
    expect(wrapper.find('button[title="编辑并重新发送"]').exists()).toBe(false);
  });
});

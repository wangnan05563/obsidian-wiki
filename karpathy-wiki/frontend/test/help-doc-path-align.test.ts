// T02455（PRD D1x/D2x/D3x）：帮助文档路径对齐测试
// D1x：快速开始路径精确到 tab（配置中心 → AI 服务）+ 可点击直达按钮（事件 + sessionStorage 指令）
// D2x：MCP 接口作为配置中心子功能缩进显示（section-sub）
// D3x：文档全文不再出现内部实现词（read_schema / generate_page / update_index）
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import Help from '../src/views/Help.vue';

function mountHelp() {
  setActivePinia(createPinia());
  return mount(Help, { global: { plugins: [ElementPlus] }, attachTo: document.body });
}

describe('Help.vue 路径对齐（T02455）', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    while (document.body.firstElementChild) document.body.firstElementChild.remove();
  });

  it('D1x：快速开始步骤路径精确到「配置中心 → AI 服务」标签页', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('进入「配置中心 → AI 服务」标签页');
    // 旧版「进入「配置」页面」的模糊路径不应再出现在快速开始步骤中
    expect(text).not.toContain('进入「配置」页面');
  });

  it('D1x：直达按钮存在，点击后广播 navigate 事件并写入 tab 指令', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const btn = wrapper.find('.block-jump');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain('前往：配置中心 → AI 服务');

    let navDetail: string | null = null;
    const onNav = (e: Event) => { navDetail = (e as CustomEvent<string>).detail; };
    globalThis.addEventListener('karpathy:navigate', onNav);
    await btn.trigger('click');
    globalThis.removeEventListener('karpathy:navigate', onNav);

    expect(navDetail).toBe('config');
    const raw = sessionStorage.getItem('karpathy:navigate-tab');
    expect(raw).toBeTruthy();
    const nav = JSON.parse(raw!) as { view: string; tab: string };
    expect(nav.view).toBe('config');
    expect(nav.tab).toBe('ai');
  });

  it('D2x：MCP 接口作为子功能缩进显示（不与一级菜单平级）', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const sub = wrapper.find('h3.section-sub');
    expect(sub.exists()).toBe(true);
    expect(sub.text()).toBe('MCP 接口');
  });

  it('D3x：文档全文无内部实现词（read_schema / extract / generate_page / update_index）', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = wrapper.text();
    expect(text).not.toContain('read_schema');
    expect(text).not.toContain('generate_page');
    expect(text).not.toContain('update_index');
    // 用户化表述已就位
    expect(text).toContain('读取结构');
    expect(text).toContain('生成页面');
  });
});

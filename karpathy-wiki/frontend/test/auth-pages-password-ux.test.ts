// T02454（PRD A2/A3）：登录/注册页密码体验测试
// A2：忘记密码「联系管理员」说明文案（无自助找回，避免断头路）
// A3：登录/注册密码框 show-password 切换（与配置中心密钥框基线对齐），注册双字段独立切换
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import Login from '../src/views/Login.vue';
import Register from '../src/views/Register.vue';

function mountPage(comp: typeof Login | typeof Register) {
  setActivePinia(createPinia());
  return mount(comp, { attachTo: document.body });
}

// el-input 无关：原生 input 直接 setValue 即可
async function mountLogin() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true, showDefaultAccountHint: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ));
  const wrapper = mountPage(Login);
  await flushPromises();
  return wrapper;
}

describe('Login.vue 密码体验（T02454）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    while (document.body.firstElementChild) document.body.firstElementChild.remove();
  });

  it('A2：展示「联系管理员重置」说明，避免忘记密码断头路', async () => {
    const wrapper = await mountLogin();
    expect(wrapper.text()).toContain('忘记密码？请联系管理员在「用户管理」中重置');
  });

  it('A3：密码框初始隐藏，点击眼睛按钮切换可见且 aria 语义正确', async () => {
    const wrapper = await mountLogin();
    const pwd = wrapper.find('#login-password');
    expect(pwd.attributes('type')).toBe('password');

    const toggle = wrapper.find('.pwd-toggle');
    expect(toggle.attributes('aria-label')).toBe('显示密码');
    await toggle.trigger('click');
    expect(pwd.attributes('type')).toBe('text');
    expect(toggle.attributes('aria-label')).toBe('隐藏密码');
    expect(toggle.attributes('aria-pressed')).toBe('true');

    await toggle.trigger('click');
    expect(pwd.attributes('type')).toBe('password');
    expect(toggle.attributes('aria-pressed')).toBe('false');
  });

  it('A3：用户名框不受密码切换影响', async () => {
    const wrapper = await mountLogin();
    await wrapper.find('.pwd-toggle').trigger('click');
    expect(wrapper.find('#login-username').attributes('type')).toBe('text');
  });
});

describe('Register.vue 密码体验（T02454）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    while (document.body.firstElementChild) document.body.firstElementChild.remove();
  });

  it('A3：密码与确认密码两个字段独立切换可见性', async () => {
    const wrapper = mountPage(Register);
    const pwd = wrapper.find('#reg-password');
    const confirm = wrapper.find('#reg-confirm');
    expect(pwd.attributes('type')).toBe('password');
    expect(confirm.attributes('type')).toBe('password');

    const toggles = wrapper.findAll('.pwd-toggle');
    expect(toggles.length).toBe(2);

    // 只切密码字段：确认字段保持隐藏
    await toggles[0].trigger('click');
    expect(pwd.attributes('type')).toBe('text');
    expect(confirm.attributes('type')).toBe('password');

    // 再切确认字段：两个都可见
    await toggles[1].trigger('click');
    expect(confirm.attributes('type')).toBe('text');
    expect(toggles[1].attributes('aria-label')).toBe('隐藏确认密码');
  });
});

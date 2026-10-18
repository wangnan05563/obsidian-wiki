// T02453（PRD A1）：ForceChangePassword 强制改密对话框测试
// 覆盖：不可跳过形态（无关闭入口）/ 三项前端预校验 / 401 旧密码错误文案 / 成功 emit changed
// 注意：AppModal 的 el-dialog 带 append-to-body，内容传送至 body 遮罩层下，
//       故查询走 document（.el-overlay .app-modal），与 app-modal 测试同模式。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import ForceChangePassword from '../src/components/ForceChangePassword.vue';

function mountComp() {
  return mount(ForceChangePassword, { global: { plugins: [ElementPlus] }, attachTo: document.body });
}

async function dialogEl(): Promise<HTMLElement> {
  await flushPromises();
  const dlg = document.querySelector('.el-overlay .app-modal') as HTMLElement | null;
  expect(dlg, '对话框应挂在 body 遮罩层下').not.toBeNull();
  return dlg!;
}

// el-input 兼容赋值：走原生 setter + input 事件（Vue 响应式可感知）
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function fill(dlg: HTMLElement, oldPwd: string, newPwd: string, confirmPwd: string) {
  const inputs = Array.from(dlg.querySelectorAll('input')) as HTMLInputElement[];
  expect(inputs.length, '应有 3 个密码输入框').toBe(3);
  setInput(inputs[0], oldPwd);
  setInput(inputs[1], newPwd);
  setInput(inputs[2], confirmPwd);
}

async function submit(dlg: HTMLElement) {
  const btn = dlg.querySelector('.el-button') as HTMLButtonElement;
  expect(btn, '应有提交按钮').not.toBeNull();
  btn.click();
  await flushPromises();
}

describe('ForceChangePassword', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    // 清掉上一用例传送在 body 下的弹窗残留（append-to-body 不随 wrapper 卸载）
    while (document.body.firstElementChild) document.body.firstElementChild.remove();
  });

  it('渲染强制改密形态：标题 + 三字段 + 提交按钮，无关闭入口', async () => {
    mountComp();
    const dlg = await dialogEl();
    expect(dlg.textContent).toContain('为了账户安全，请先修改密码');
    expect(dlg.textContent).toContain('仍在使用默认口令');
    expect(dlg.querySelectorAll('input').length).toBe(3);
    // 无 X 关闭按钮（show-close=false）
    expect(dlg.querySelector('.el-dialog__close')).toBeNull();
  });

  it('空旧密码被前端拦截且不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mountComp();
    const dlg = await dialogEl();
    fill(dlg, '', 'new-pass-123', 'new-pass-123');
    await submit(dlg);
    expect(dlg.querySelector('.fc-error')?.textContent).toContain('请输入当前密码');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('新密码过短 / 两次不一致 / 与旧密码相同均被前端拦截', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mountComp();
    const dlg = await dialogEl();

    fill(dlg, 'old-pass-1', 'short', 'short');
    await submit(dlg);
    expect(dlg.querySelector('.fc-error')?.textContent).toContain('新密码长度须为 8-64 位');

    fill(dlg, 'old-pass-1', 'new-pass-123', 'different-1');
    await submit(dlg);
    expect(dlg.querySelector('.fc-error')?.textContent).toContain('两次输入的新密码不一致');

    fill(dlg, 'old-pass-1', 'old-pass-1', 'old-pass-1');
    await submit(dlg);
    expect(dlg.querySelector('.fc-error')?.textContent).toContain('新密码不能与当前密码相同');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('旧密码错误（401）：展示后端文案且不 emit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, message: '当前密码不正确' }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    ));
    const wrapper = mountComp();
    const dlg = await dialogEl();
    fill(dlg, 'wrong-old-1', 'new-pass-123', 'new-pass-123');
    await submit(dlg);
    expect(dlg.querySelector('.fc-error')?.textContent).toContain('当前密码不正确');
    expect(wrapper.emitted('changed')).toBeUndefined();
  });

  it('改密成功：调用 change-password 端点并 emit changed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, message: '密码修改成功' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountComp();
    const dlg = await dialogEl();
    fill(dlg, 'old-pass-1', 'new-pass-123', 'new-pass-123');
    await submit(dlg);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/auth/change-password');
    expect(init.method).toBe('POST');
    const payload = JSON.parse(init.body as string) as { oldPassword: string; newPassword: string; confirmPassword: string };
    expect(payload).toEqual({ oldPassword: 'old-pass-1', newPassword: 'new-pass-123', confirmPassword: 'new-pass-123' });
    expect(wrapper.emitted('changed')).toHaveLength(1);
  });
});

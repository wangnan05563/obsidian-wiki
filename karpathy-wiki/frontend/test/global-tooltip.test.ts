// 回归测试：全局按钮悬浮提示（src/directives/tip.ts）
// 验证：鼠标移入带 data-tip 的按钮立即显示浮层且文案准确；移出后隐藏；
// 浮层 pointer-events:none（不拦截点击）；原生 title 不会触发双层提示。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import TipPlugin from '../src/directives/tip';

function tipEl(): HTMLElement | null {
  return document.querySelector('.app-global-tip');
}

describe('全局 tooltip 悬浮提示', () => {
  beforeEach(() => {
    // 清理可能残留的浮层
    const existing = tipEl();
    if (existing) existing.remove();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    const existing = tipEl();
    if (existing) existing.remove();
  });

  it('鼠标移入带 data-tip 的按钮 → 浮层显示且文案准确；移出 → 隐藏；悬浮期间点击仍生效', async () => {
    const Comp = {
      data: () => ({ clicks: 0 }),
      template: `<button data-tip="扫描并分析 vault 中的重复文档" @click="clicks++">去重</button>`,
    };
    const wrapper = mount(Comp, { global: { plugins: [TipPlugin] }, attachTo: document.body });
    const btn = wrapper.find('button').element as HTMLElement;

    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    // 浮层在 requestAnimationFrame 后加 is-visible；文案同步写入
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await nextTick();

    const tip = tipEl();
    expect(tip, '应渲染全局浮层').not.toBeNull();
    expect(tip!.classList.contains('app-global-tip'), '浮层应使用统一类名').toBe(true);
    expect(tip!.textContent, '浮层文案应等于 data-tip').toBe('扫描并分析 vault 中的重复文档');
    expect(tip!.classList.contains('is-visible'), '浮层应可见').toBe(true);

    // 悬浮期间点击按钮：浮层 pointer-events:none，不应拦截操作
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect((wrapper.vm as any).clicks, '悬浮显示期间点击应仍触发按钮逻辑').toBe(1);

    btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    // hide 有 80ms 宽限
    await new Promise((r) => setTimeout(r, 120));
    await nextTick();
    expect(tip!.style.display, '移出后浮层应隐藏').toBe('none');

    wrapper.unmount();
  });

  it('无 data-tip 的按钮不显示浮层', async () => {
    const Comp = { template: `<button>普通按钮</button>` };
    const wrapper = mount(Comp, { global: { plugins: [TipPlugin] }, attachTo: document.body });
    const btn = wrapper.find('button').element as HTMLElement;
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await nextTick();
    expect(tipEl(), '无说明文案不应渲染浮层').toBeNull();
    wrapper.unmount();
  });

  it('元素同时有原生 title 时，悬浮期间抑制原生提示（避免双层 tooltip）', async () => {
    const Comp = { template: `<button data-tip="合并重复文档" title="原生标题">合并</button>` };
    const wrapper = mount(Comp, { global: { plugins: [TipPlugin] }, attachTo: document.body });
    const btn = wrapper.find('button').element as HTMLElement;

    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await nextTick();
    expect(btn.getAttribute('title'), '悬浮期间原生 title 应被临时清空').toBe('');

    btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    await nextTick();
    expect(btn.getAttribute('title'), '隐藏后应恢复原生 title').toBe('原生标题');

    wrapper.unmount();
  });
});

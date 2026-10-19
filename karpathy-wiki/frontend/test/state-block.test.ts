import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import StateBlock from '../src/components/StateBlock.vue';

// T02476（PRD X2 / X8）：StateBlock 是全站加载态与空态的单一实现。
// 这里锁两件事：
// 1) 三态契约（loading / empty / error）各自渲染什么、ready 透传什么；
// 2) 失败态必须自带重试入口并往外发 retry 事件——原语里「失败=一行灰字」就是 X2 要消灭的方言。

function mountStateBlock(props: Record<string, unknown>, slots: Record<string, string> = {}) {
  return mount(StateBlock, {
    props,
    slots,
    global: { plugins: [ElementPlus] },
  });
}

describe('StateBlock 三态契约（PRD X2）', () => {
  it('loading：默认中文文案，role=status 可被读屏播报', () => {
    const w = mountStateBlock({ state: 'loading' });
    expect(w.text()).toContain('加载中…');
    expect(w.attributes('role')).toBe('status');
    expect(w.attributes('aria-live')).toBe('polite');
  });

  it('loading：给定 loading-text 时原样显示中文文案（不出现英文 LOADING/SEARCHING）', () => {
    const w = mountStateBlock({ state: 'loading', loadingText: '正在构建图谱…' });
    expect(w.text()).toContain('正在构建图谱…');
    expect(w.text()).not.toMatch(/LOADING|SEARCHING/i);
  });

  it('loading：skeleton-rows>0 走骨架屏，0 走spinner（两种加载形态同一组件出口）', () => {
    const withSkeleton = mountStateBlock({ state: 'loading', skeletonRows: 3 });
    expect(withSkeleton.find('.el-skeleton').exists()).toBe(true);
    const withSpinner = mountStateBlock({ state: 'loading', skeletonRows: 0 });
    expect(withSpinner.find('.el-skeleton').exists()).toBe(false);
    expect(withSpinner.find('.state-spin').exists()).toBe(true);
  });

  it('empty：一句现状 + 一句原因 + 一个主按钮（PRD X8 模板）', () => {
    const w = mountStateBlock(
      { state: 'empty', emptyTitle: '暂无页面', emptyDesc: '投递资料并编译后会出现在这里' },
      { action: '<button class="probe-cta">去投递资料</button>' },
    );
    expect(w.find('.state-title').text()).toBe('暂无页面');
    expect(w.find('.state-desc').text()).toBe('投递资料并编译后会出现在这里');
    expect(w.find('.state-action .probe-cta').exists()).toBe(true);
  });

  it('empty：未给 action 插槽时不渲染空的动作容器（不留一块空白点击区）', () => {
    const w = mountStateBlock({ state: 'empty', emptyTitle: '还没有打开页面' });
    expect(w.find('.state-action').exists()).toBe(false);
  });

  it('error：role=alert + 默认重试按钮，点击对外发 retry', async () => {
    const w = mountStateBlock({ state: 'error', errorText: '历史任务加载失败' });
    expect(w.attributes('role')).toBe('alert');
    expect(w.text()).toContain('历史任务加载失败');
    expect(w.text()).toContain('重试');
    await w.find('button').trigger('click');
    expect(w.emitted('retry')).toHaveLength(1);
  });

  it('error：可自定义重试按钮文案', () => {
    const w = mountStateBlock({ state: 'error', retryLabel: '重新加载' });
    expect(w.text()).toContain('重新加载');
  });

  it('ready：透传默认插槽内容，不渲染任何状态块', () => {
    const w = mountStateBlock({ state: 'ready' }, { default: '<div class="probe-body">真实内容</div>' });
    expect(w.find('.state-block').exists()).toBe(false);
    expect(w.find('.probe-body').text()).toBe('真实内容');
  });

  it('compact：改的是排布（横向），三态文案不受影响', () => {
    const w = mountStateBlock({ state: 'loading', compact: true, loadingText: '正在加载章节…' });
    expect(w.classes()).toContain('is-compact');
    expect(w.text()).toContain('正在加载章节…');
  });
});

// T02394：useHashView hash 路由同步单元测试
// 覆盖：hash 解析 / 格式化 / 初始挂载应用深链 / 非法 hash 初始不归一化 /
//       hashchange 驱动切换 / 非法 hash 归一化 / syncHash pushState 不反驱动 / 守卫拦截
// 注意：setup 返回渲染函数时绑定不暴露到 wrapper.vm，故经闭包引用断言（同 useFormDraft 测试模式）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineComponent, ref, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { parseHashView, formatViewHash, useHashView } from '../src/composables/useHashView';

describe('parseHashView', () => {
  it('parses #/query', () => {
    expect(parseHashView('#/query')).toBe('query');
  });
  it('lowercases view name', () => {
    expect(parseHashView('#/Query')).toBe('query');
  });
  it('ignores sub path', () => {
    expect(parseHashView('#/query/abc')).toBe('query');
  });
  it('rejects empty / bare / no-slash / non-ascii', () => {
    expect(parseHashView('')).toBeNull();
    expect(parseHashView('#')).toBeNull();
    expect(parseHashView('#query')).toBeNull();
    expect(parseHashView('#/查询')).toBeNull();
  });
});

describe('formatViewHash', () => {
  it('formats view to hash', () => {
    expect(formatViewHash('query')).toBe('#/query');
  });
});

function makeHost(guard?: (v: string) => boolean) {
  const currentView = ref('dashboard');
  let syncHash: (v: string) => void = () => {};
  const Host = defineComponent({
    setup() {
      const api = useHashView(currentView, {
        isValid: (v) => ['dashboard', 'query', 'browse'].includes(v),
        guard,
      });
      syncHash = api.syncHash;
      return () => null;
    },
  });
  const wrapper = mount(Host);
  created.push(wrapper);
  return { wrapper, currentView, syncHash };
}

// 跨用例隔离：宿主必须卸载，否则旧监听器与当用例监听器同窗并存，
// 旧的归一化（replaceState）会改写 URL 再被新宿主应用，造成串扰（实证：browse 泄漏）
const created: VueWrapper[] = [];
afterEach(() => {
  created.forEach((w) => w.unmount());
  created.length = 0;
  window.history.replaceState(null, '', '/');
  window.location.hash = '';
});

function fireHashChange() {
  window.dispatchEvent(new Event('hashchange'));
}

describe('useHashView integration', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.location.hash = '';
  });

  it('applies valid deep-link hash on mount', async () => {
    window.location.hash = '#/query';
    const { currentView } = makeHost();
    await nextTick();
    expect(currentView.value).toBe('query');
  });

  it('keeps invalid hash untouched on mount (waits for session restore)', async () => {
    window.location.hash = '#/nope';
    const { currentView } = makeHost();
    await nextTick();
    expect(currentView.value).toBe('dashboard');
    expect(window.location.hash).toBe('#/nope');
  });

  it('switches view on external hashchange', async () => {
    const { currentView } = makeHost();
    await nextTick();
    window.location.hash = '#/browse';
    fireHashChange();
    await nextTick();
    expect(currentView.value).toBe('browse');
  });

  it('normalizes invalid hash to current view on hashchange', async () => {
    const { currentView } = makeHost();
    await nextTick();
    window.location.hash = '#/nope';
    fireHashChange();
    await nextTick();
    expect(currentView.value).toBe('dashboard');
    expect(window.location.hash).toBe('#/dashboard');
  });

  it('syncHash pushes state without driving view (pushState fires no hashchange)', async () => {
    const { currentView, syncHash } = makeHost();
    await nextTick();
    syncHash('query');
    await nextTick();
    expect(window.location.hash).toBe('#/query');
    expect(currentView.value).toBe('dashboard');
  });

  it('guard blocks unauthorized hash without normalizing on mount', async () => {
    window.location.hash = '#/query';
    const { currentView } = makeHost(() => false);
    await nextTick();
    expect(currentView.value).toBe('dashboard');
    expect(window.location.hash).toBe('#/query');
  });

  it('guard-blocked view is normalized on hashchange', async () => {
    const { currentView } = makeHost(() => false);
    await nextTick();
    window.location.hash = '#/query';
    fireHashChange();
    await nextTick();
    expect(currentView.value).toBe('dashboard');
    expect(window.location.hash).toBe('#/dashboard');
  });

  it('removes hashchange listener on unmount', async () => {
    const { wrapper, currentView } = makeHost();
    await nextTick();
    wrapper.unmount();
    window.location.hash = '#/browse';
    fireHashChange();
    await nextTick();
    expect(currentView.value).toBe('dashboard');
  });
});

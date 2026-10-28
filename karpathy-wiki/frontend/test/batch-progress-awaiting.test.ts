import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import BatchProgressBar from '../src/components/BatchProgressBar.vue';
import { useCompileStore } from '../src/stores/compile';

// T03438：批量编译在「已提交、服务端还没回 batch_start」这段时间里，
// 旧 UI 显示「正在编译 0/0 个页面 0%」——和真卡死一模一样。
// 本用例锁定新表现：上传/校验阶段给出文件数 + 等待秒数，且不显示 0% 进度。

vi.mock('../src/utils/nav', () => ({ gotoView: vi.fn() }));

function makePayload(count: number): FormData {
  const fd = new FormData();
  for (let i = 0; i < count; i++) {
    fd.append('files', new File([`c${i}`], `f${i}.txt`));
  }
  return fd;
}

function mountBar() {
  return mount(BatchProgressBar, {
    global: {
      stubs: {
        'el-button': true,
        'el-icon': true,
        'el-progress': true,
        StateBlock: true,
      },
    },
  });
}

describe('BatchProgressBar - 上传/校验等待态 (T03438)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('已提交但 batch_start 未到：显示上传文件数与等待秒数，不显示 0%', async () => {
    const store = useCompileStore();
    store.prepareBatchCompile(makePayload(3));

    const wrapper = mountBar();
    await nextTick();

    const text = wrapper.text();
    expect(text).toContain('正在上传并解析 3 个文件');
    expect(text).toContain('已等待 0 秒');
    expect(text).not.toContain('0%');
    expect(text).not.toContain('正在编译 0/0');

    vi.advanceTimersByTime(3000);
    await nextTick();
    expect(wrapper.text()).toContain('已等待 3 秒');

    wrapper.unmount();
  });

  it('batch_start 到达后切回编译进度：恢复百分比与「正在编译 x/y」', async () => {
    const store = useCompileStore();
    store.prepareBatchCompile(makePayload(3));
    const wrapper = mountBar();
    await nextTick();

    store.handleEvent('batch_start', { data: { fileCount: 3 } });
    await nextTick();

    const text = wrapper.text();
    expect(text).toContain('正在编译 0/3 个页面');
    expect(text).toContain('0%');
    expect(text).not.toContain('正在上传并解析');

    wrapper.unmount();
  });

  it('卸载时停掉等待计时器（不泄漏 interval）', async () => {
    const store = useCompileStore();
    store.prepareBatchCompile(makePayload(2));
    const wrapper = mountBar();
    await nextTick();

    wrapper.unmount();
    const cleared = vi.getTimerCount();
    expect(cleared).toBe(0);
  });
});

// T02461（PRD Q1）：未完成功能此前 tooltip 直接写「暂未实现」摆在主路径上，
// 改为「即将上线」明示规划状态（配合 .tool-chip.disabled 灰显）。
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import InputToolbar from '../src/components/InputToolbar.vue';

function mountWith(tools: unknown[]) {
  return mount(InputToolbar, {
    props: { tools: tools as never, activeMode: '', iconOnly: false },
  });
}

describe('InputToolbar 工具提示（T02461 Q1）', () => {
  it('未实现工具 tooltip 明示「即将上线」而非「暂未实现」', () => {
    const wrapper = mountWith([{ key: 'soon', label: '敬请期待', disabled: true }]);
    const chip = wrapper.find('button.tool-chip');
    expect(chip.exists()).toBe(true);
    expect(chip.attributes('data-tip')).toBe('即将上线');
    expect(chip.attributes('data-tip')).not.toBe('暂未实现');
  });

  it('已禁用且带 disabledReason 时优先展示原因', () => {
    const wrapper = mountWith([
      { key: 'soon', label: '敬请期待', disabled: true, disabledReason: 'v3 规划中' },
    ]);
    expect(wrapper.find('button.tool-chip').attributes('data-tip')).toBe('v3 规划中');
  });

  it('普通工具 tooltip 为工具名', () => {
    const wrapper = mountWith([{ key: 'fast', label: '快速' }]);
    expect(wrapper.find('button.tool-chip').attributes('data-tip')).toBe('快速');
  });
});

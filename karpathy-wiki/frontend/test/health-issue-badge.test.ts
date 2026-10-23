// T02922：行徽标的三种结局必须一眼可分（已消解 / 未消解 / 失败）。
// 为什么挂在组件渲染层：这是用户唯一能看到的「修复成功与否」信号，
// 只锁 store 字段而不锁渲染文案，改坏模板时用例照样绿。
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import HealthIssueList from '../src/components/HealthIssueList.vue';
import { orphanKey } from '../src/utils/healthList';
import type { IssueRow } from '../src/utils/healthList';

const row: IssueRow = {
  key: orphanKey('entities/a.md'),
  kind: 'orphan',
  path: 'entities/a.md',
  dir: 'entities',
  fixable: true,
  fixTarget: 'entities/a.md',
};

function mountWith(state: 'done' | 'ineffective' | 'failed') {
  return mount(HealthIssueList, {
    props: {
      rows: [row],
      selected: new Set<string>(),
      fixingKey: '',
      anyFixing: false,
      jobStates: { [row.key]: state },
    },
  });
}

describe('HealthIssueList · T02922 结局徽标', () => {
  it('已消解 / 未消解 / 失败三种文案与样式互不相同', () => {
    const done = mountWith('done');
    expect(done.find('.row-badge.done').text()).toBe('已消解');

    const ineffective = mountWith('ineffective');
    expect(ineffective.find('.row-badge.ineffective').text()).toBe('未消解');

    const failed = mountWith('failed');
    expect(failed.find('.row-badge.failed').text()).toBe('失败');
  });

  it('未消解不能被渲染成成功态（T02605 实测的假绿场景）', () => {
    const wrapper = mountWith('ineffective');
    expect(wrapper.find('.row-badge.done').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('已消解');
  });
});

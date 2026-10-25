// T02918：导航组件「只读标记」与源码守护
// ------------------------------------------------------------------
// 两件事：
//   1) ConfigSideNav 收到 dirtyTabs 时只在对应页签渲染圆点/无障碍文案，不发事件、不落盘；
//   2) 源码守护锁住三处口径：Config 传了 dirtyTabs、dirty 判定用统一 composable、
//      不存在「碰表单即 POST」的自动保存（唯一例外是子智能体开关，它本来就是实时落盘）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mount } from '@vue/test-utils';
import ConfigSideNav from '../src/components/ConfigSideNav.vue';
import { navGroupsFor } from '../src/utils/configTabs';

// happy-dom 下 import.meta.url 是 http 协议，fileURLToPath 会抛 ERR_INVALID_URL_SCHEME；
// vitest 的 cwd 固定为 frontend 根目录。
const FRONTEND_ROOT = resolve(process.cwd());
const read = (rel: string): string => readFileSync(resolve(FRONTEND_ROOT, rel.replace(/^[/\\]/, '')), 'utf8');

function mountNav(dirtyTabs?: string[]) {
  return mount(ConfigSideNav, {
    props: { modelValue: 'config', groups: navGroupsFor(true), ...(dirtyTabs ? { dirtyTabs } : {}) },
  });
}

describe('ConfigSideNav：未保存标记（只读）', () => {
  it('只有 dirtyTabs 里的页签出现圆点，其余页签没有', () => {
    const wrapper = mountNav(['config', 'ai']);
    const dots = wrapper.findAll('[data-testid="nav-dirty"]');
    expect(dots).toHaveLength(2);
    expect(dots.map((d) => d.attributes('aria-label')).sort()).toEqual([
      'AI 服务：有未保存改动',
      '系统配置：有未保存改动',
    ]);
    expect(wrapper.findAll('.nav-item').find((n) => n.text().includes('朗读设置'))!.find('[data-testid="nav-dirty"]').exists()).toBe(false);
  });

  it('未传 dirtyTabs（或空数组）⇒ 一个圆点都没有（默认干净）', () => {
    expect(mountNav().findAll('[data-testid="nav-dirty"]')).toHaveLength(0);
    expect(mountNav([]).findAll('[data-testid="nav-dirty"]')).toHaveLength(0);
  });

  it('提示文案在锁定语义上叠加而未覆盖：锁定项仍说「仅管理员可修改」', () => {
    const wrapper = mount(ConfigSideNav, {
      props: { modelValue: 'config', groups: navGroupsFor(false), dirtyTabs: ['config'] },
    });
    const item = wrapper.findAll('.nav-item').find((n) => n.text().includes('系统配置'))!;
    expect(item.attributes('data-tip')).toContain('仅管理员可修改');
    expect(item.attributes('data-tip')).toContain('有未保存改动');
  });

  it('标记只读：点击页签只发 select/update，不产生任何写盘事件', async () => {
    const wrapper = mountNav(['config']);
    await wrapper.findAll('.nav-item').find((n) => n.text().includes('AI 服务'))!.trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['ai']);
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['ai']);
    // 只有一个 locked 事件通道，没有任何 save/persist 通道
    expect(Object.keys(wrapper.emitted())).not.toContain('save');
    expect(Object.keys(wrapper.emitted())).not.toContain('persist');
  });
});

describe('源码守护：T02918 口径不得回退', () => {
  const configSource = read('src/views/Config.vue');
  const navSource = read('src/components/ConfigSideNav.vue');
  const tunnelSource = read('src/views/Tunnel.vue');

  it('Config 把 dirtyTabNames 传给二级导航，且页顶有未保存汇总条', () => {
    expect(configSource).toContain(':dirty-tabs="dirtyTabNames"');
    expect(configSource).toContain('class="unsaved-bar"');
    expect(configSource).toContain('dirtyTabSummary');
  });

  it('Config 与 Tunnel 共用 useDirtyFields（禁止各自再写一份 diff）', () => {
    expect(configSource).toContain("from '../composables/useDirtyFields'");
    expect(tunnelSource).toContain("from '../composables/useDirtyFields'");
    expect(tunnelSource).toContain('useDirtyFields(tunnelSavedSnapshot, tunnelFormSnapshot');
    // Tunnel 不再内联逐字段 if 比较
    expect(tunnelSource).not.toContain("if (formProvider.value !== saved.provider) out.push('Provider')");
  });

  it('禁止「碰表单即 POST」：输入类事件不得触发保存（唯一例外：子智能体实时开关）', () => {
    const autoSave = [...configSource.matchAll(/@(input|blur|change)="(save\w*)/g)].map((m) => m[2]);
    expect(autoSave).toEqual(['saveSubAgents']);
    // 子智能体确实是实时落盘（不是本单引入的未保存态）
    expect(configSource).toContain('@change="saveSubAgents"');
  });

  it('导航组件保持只读：不引 api/store、不发写盘事件、圆点只由 prop 决定', () => {
    expect(navSource).not.toContain('utils/apiBase');
    expect(navSource).not.toContain("from '../stores/");
    expect(navSource).not.toContain("emit('save'");
    expect(navSource).toContain('dirtyTabs?: string[]');
    expect(navSource).toContain('v-if="isDirtyTab(item.name)"');
  });

  it('刷新前提示已接线（beforeunload 注册与移除成对）', () => {
    expect(configSource).toContain("window.addEventListener('beforeunload', onBeforeUnload)");
    expect(configSource).toContain("window.removeEventListener('beforeunload', onBeforeUnload)");
  });
});

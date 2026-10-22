// T02698：用户管理的帮助文档章节 + 首次访问导览补齐（T02473 规则的文档侧收尾）
// ------------------------------------------------------------------
// 这一章原来还停在 T02473 之前：没有口令/用户名规则、没有「当前登录账户 / 最后一个启用管理员」
// 四条红线、没讲停用与删除的差别、也没交代审计日志到底在哪看。
// 文档最坏的回退不是「少写一句」，而是**写了一套和页面上不一样的规则**——用户照文档操作却发现
// 按钮是灰的。所以本章的规则原文全部从 userManagePresentation 取，断言也比着导出值做：
// 规则改了而文档没跟上，这里先红。
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import Help from '../src/views/Help.vue';
import { GUIDE_DEFINITIONS } from '../src/guides';
import {
  PASSWORD_RULE,
  SEED_ACCOUNT_HINT,
  SEED_ACCOUNT_NAMES,
  USERNAME_RULE,
  deleteGuard,
  disableGuard,
  roleLabel,
} from '../src/utils/userManagePresentation';
import type { AuthRole } from '../src/types';

/** 与 Help.vue 同源的四条红线原文（用「必然被拦」的上下文算出来） */
const GUARDS = [
  deleteGuard({ id: 'someone', role: 'user' }, { currentUserId: 'someone', adminCount: 2, activeAdminCount: 2 }),
  deleteGuard({ id: 'admin1', role: 'admin' }, { currentUserId: 'someone', adminCount: 1, activeAdminCount: 1 }),
  disableGuard({ id: 'someone', role: 'user', enabled: true }, { currentUserId: 'someone', adminCount: 2, activeAdminCount: 2 }),
  disableGuard({ id: 'admin1', role: 'admin', enabled: true }, { currentUserId: 'someone', adminCount: 2, activeAdminCount: 1 }),
];

function mountHelp() {
  setActivePinia(createPinia());
  return mount(Help, { global: { plugins: [ElementPlus] }, attachTo: document.body });
}

function usersSectionText(wrapper: ReturnType<typeof mountHelp>): string {
  const el = wrapper.find('#users');
  expect(el.exists(), '帮助文档必须有 id=users 的「用户管理」章节').toBe(true);
  return el.text();
}

describe('T02698 用户管理章节 = 页面规则同源', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    while (document.body.firstElementChild) document.body.firstElementChild.remove();
  });

  it('用户名/口令规则直接引用导出常量（不另抄一份）', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = usersSectionText(wrapper);
    expect(USERNAME_RULE).toContain('3-32');
    expect(PASSWORD_RULE).toContain('8-64');
    expect(text).toContain(USERNAME_RULE);
    expect(text).toContain(PASSWORD_RULE);
  });

  it('出厂账号：名单与告警语与 userManagePresentation 一致', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = usersSectionText(wrapper);
    expect(SEED_ACCOUNT_NAMES.length).toBeGreaterThan(0);
    for (const name of SEED_ACCOUNT_NAMES) {
      expect(text, `文档缺出厂账号名「${name}」`).toContain(name);
    }
    expect(text).toContain(SEED_ACCOUNT_HINT);
  });

  it('文档绝不写出默认口令本身（P0-13 同源要求）', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = usersSectionText(wrapper);
    for (const pwd of ['admin123', 'user123', 'guest123']) {
      expect(text, `文档不应出现默认口令 ${pwd}`).not.toContain(pwd);
    }
  });

  it('四条红线逐字与守卫函数返回的原因一致', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = usersSectionText(wrapper);
    for (const g of GUARDS) {
      expect(g.blocked, '构造上下文应当全部命中拦截').toBe(true);
      expect(text, `文档缺红线原因「${g.reason}」`).toContain(g.reason);
    }
  });

  it('三个角色实名取自 roleLabel', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = usersSectionText(wrapper);
    for (const role of ['admin', 'user', 'guest'] as AuthRole[]) {
      expect(text).toContain(roleLabel(role));
    }
  });

  it('讲清停用与删除的差别，以及重置口令不会踢人下线', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = usersSectionText(wrapper);
    expect(text).toContain('立即失效');
    expect(text).toContain('随时可以「启用」恢复');
    expect(text).toContain('不可撤销');
    expect(text).toContain('已登录的会话继续有效');
    // 旧口径：把停用/删除只写成「启用 / 禁用开关」，看不出代价差别
    expect(text).not.toContain('启用 / 禁用开关');
  });

  it('审计日志口径如实：保留窗口 + 应用内有审计面板（T02782 落地后口径）', async () => {
    const wrapper = mountHelp();
    await flushPromises();
    const text = usersSectionText(wrapper);
    // T02782：写入侧保留窗口（最近 1 万条）+ 用户管理页「审计日志」面板
    expect(text).toContain('保留最近 1 万条');
    expect(text).toContain('审计日志');
    expect(text).toContain('用户管理」页点「审计日志」');
    // 旧口径：应用内无审计页面（T02782 已补面板，这句话会变成错误描述）
    expect(text).not.toContain('暂无审计页面');
    expect(text).not.toContain('只追加不自动清理');
  });
});

describe('T02698 首次访问导览覆盖红线与出厂账号', () => {
  const guide = GUIDE_DEFINITIONS.users;

  it('导览步骤提到受保护按钮与出厂账号告警', () => {
    expect(guide).toBeTruthy();
    const all = guide!.steps.map((s) => `${s.title} ${s.description}`).join('\n');
    expect(all).toContain('置灰');
    expect(all).toContain('出厂账号');
    expect(all).toContain('唯一启用的管理员');
    expect(all).toContain('当前登录账户');
  });

  it('选择器只用既有锚点（菜单 data-guide 或主内容区 .content）', () => {
    for (const step of guide!.steps) {
      const ok = step.target === '.content' || step.target === `[data-guide="${guide!.view}"]`;
      expect(ok, `导览步骤「${step.title}」的 target ${step.target} 无对应锚点`).toBe(true);
    }
  });
});

// wiki三期 T02473（PRD §13 用户管理规范化）单测：
//   U1 删除确认文案带影响说明；U2 自删/最后一个管理员守卫；U3 出厂种子账号识别与可停用性；
//   U8 搜索/排序/分页与相对时间；U7 输入校验与后端规则同源。
// 约定：被测逻辑全部是 frontend/src/utils/userManagePresentation.ts 的纯函数（本项目不挂载 SFC）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { UserInfo } from '../src/types';
import {
  PASSWORD_RULE,
  SEED_ACCOUNT_NAMES,
  USER_PAGE_SIZE_OPTIONS,
  USERNAME_RULE,
  absoluteTime,
  defaultUserTableQuery,
  deleteConfirmMessage,
  deleteGuard,
  disableGuard,
  editGuard,
  filterUsers,
  hasErrors,
  relativeTime,
  roleLabel,
  seedRiskUsers,
  sliceUsers,
  sortUsers,
  validateUserForm,
} from '../src/utils/userManagePresentation';

const NOW = new Date('2026-10-19T12:00:00.000Z').getTime();

function makeUser(over: Partial<UserInfo> & { id: string; username: string }): UserInfo {
  return {
    role: 'user',
    enabled: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    permissions: [],
    ...over,
  };
}

const ctx = { currentUserId: 'u-admin', adminCount: 2, activeAdminCount: 2 };

describe('U1 删除确认文案', () => {
  const target = makeUser({ id: 'u2', username: 'auditor', role: 'admin', createdAt: '2026-03-05T08:00:00.000Z' });

  it('把影响写进文案：会话失效 + 不可撤销 + 角色与创建时间', () => {
    const msg = deleteConfirmMessage(target, ctx);
    expect(msg).toContain('auditor');
    expect(msg).toContain('管理员');
    expect(msg).toContain('会话立即失效');
    expect(msg).toContain('不可撤销');
  });

  it('删除自己时先给警示行（虽然按钮已置灰，兜底路径仍要说清）', () => {
    const msg = deleteConfirmMessage(makeUser({ id: 'u-admin', username: 'admin' }), ctx);
    expect(msg.split('\n')[0]).toContain('当前登录的账户');
  });
});

describe('U2 删除/停用守卫', () => {
  const me = makeUser({ id: 'u-admin', username: 'admin', role: 'admin' });
  const other = makeUser({ id: 'u-other', username: 'other', role: 'admin' });
  const guest = makeUser({ id: 'u-guest', username: 'guest', role: 'guest' });

  it('当前登录账户不可删，且给出原因', () => {
    const g = deleteGuard(me, ctx);
    expect(g.blocked).toBe(true);
    expect(g.reason).toContain('当前登录账户');
  });

  it('最后一个管理员不可删（含已禁用的管理员不计入可用数，与后端 deleteUser 同口径）', () => {
    const onlyAdmin = deleteGuard(other, { currentUserId: 'u-guest', adminCount: 1, activeAdminCount: 1 });
    expect(onlyAdmin.blocked).toBe(true);
    expect(onlyAdmin.reason).toContain('至少保留一个管理员');
    // 还有第二个管理员时放行
    expect(deleteGuard(other, ctx).blocked).toBe(false);
  });

  it('非管理员账户不受删除守卫影响', () => {
    expect(deleteGuard(guest, ctx).blocked).toBe(false);
  });

  it('不可停用当前登录账户', () => {
    const g = disableGuard(me, ctx);
    expect(g.blocked).toBe(true);
    expect(g.reason).toContain('登出');
  });

  it('唯一启用的管理员不可停用；已停用的账户无需守卫（可重新启用）', () => {
    expect(disableGuard(other, { currentUserId: 'u-guest', adminCount: 2, activeAdminCount: 1 }).blocked).toBe(true);
    expect(disableGuard(other, ctx).blocked).toBe(false);
    const disabled = makeUser({ id: 'u-x', username: 'off', role: 'admin', enabled: false });
    expect(disableGuard(disabled, { currentUserId: 'u-guest', adminCount: 3, activeAdminCount: 0 }).blocked).toBe(false);
  });

  it('放行时 reason 是正常操作说明，可直接用作 data-tip', () => {
    expect(deleteGuard(other, ctx).reason).toContain('不可撤销');
    expect(disableGuard(other, ctx).reason).toContain('会话立即失效');
  });
});

describe('U2 编辑守卫（T02935：提权不得被停用守卫误拦）', () => {
  const onlyOne = { currentUserId: 'u-admin', adminCount: 1, activeAdminCount: 1 };
  const normal = makeUser({ id: 'u2', username: 't02697', role: 'user' });
  const admin = makeUser({ id: 'u-admin', username: 'admin', role: 'admin' });

  it('仅 1 个启用管理员时，编辑普通用户提权为管理员必须放行', () => {
    const g = editGuard(normal, { role: 'admin', enabled: true }, onlyOne);
    expect(g.blocked).toBe(false);
  });

  it('降级最后一个启用管理员被拦（与后端 PUT 的 otherActiveAdmins 同口径）', () => {
    const g = editGuard(admin, { role: 'user', enabled: true }, {
      currentUserId: 'u-other',
      adminCount: 1,
      activeAdminCount: 1,
    });
    expect(g.blocked).toBe(true);
    expect(g.reason).toContain('至少保留一个启用的管理员');
  });

  it('还有其它启用管理员时降级放行', () => {
    expect(
      editGuard(admin, { role: 'user', enabled: true }, { currentUserId: 'u-other', adminCount: 2, activeAdminCount: 2 })
        .blocked,
    ).toBe(false);
  });

  it('停用当前登录账户仍被拦（提权放行不能顺带放开自停用）', () => {
    const self = editGuard(admin, { role: 'admin', enabled: false }, onlyOne);
    expect(self.blocked).toBe(true);
    expect(self.reason).toContain('登出');
  });

  it('提权同时停用不误报「唯一启用管理员」：目标账户原本不是管理员', () => {
    expect(editGuard(normal, { role: 'admin', enabled: false }, onlyOne).blocked).toBe(false);
  });

  it('接线守护：submitEdit 与弹窗开关都用 editGuard，不再用 disableGuard 判角色变更', () => {
    const src = readFileSync(resolve(__dirname, '../src/views/Users.vue'), 'utf8');
    const submit = src.slice(src.indexOf('async function submitEdit'), src.indexOf('// ===== U1 + U2：删除'));
    expect(submit).toContain('editGuard(');
    expect(submit).not.toContain('disableGuard(');
    const switchGuard = src.slice(src.indexOf('const editEnableGuard'), src.indexOf('async function submitEdit'));
    expect(switchGuard).toContain('editGuard(');
  });
});

describe('U3 出厂种子账号', () => {
  const users = [
    makeUser({ id: '1', username: 'guest', role: 'guest' }),
    makeUser({ id: '2', username: 'user', role: 'user' }),
    // 当前登录的正是出厂 admin：它既是风险项，又必须被停用守卫护住
    makeUser({ id: 'u-admin', username: 'admin', role: 'admin' }),
    makeUser({ id: '4', username: 'alice', role: 'user' }),
    makeUser({ id: '5', username: 'user2', role: 'user', enabled: false }),
  ];

  it('只认种子名且仍启用的账户，按管理员→普通用户→游客排序', () => {
    const risks = seedRiskUsers(users, ctx);
    expect(risks.map(r => r.user.username)).toEqual(['admin', 'user', 'guest']);
  });

  it('逐个带上停用守卫：当前登录账户被标为不可停用', () => {
    const risks = seedRiskUsers(users, ctx);
    expect(risks[0].guard.blocked).toBe(true);
    expect(risks[0].user.username).toBe('admin');
    expect(risks[1].guard.blocked).toBe(false);
  });

  it('种子名清单与后端 SEED_USERS 同源（防止前端漏掉新加的出厂账号）', () => {
    expect(SEED_ACCOUNT_NAMES).toEqual(['admin', 'user', 'guest']);
  });
});

describe('U8 搜索 / 排序 / 分页', () => {
  const users = [
    makeUser({ id: '1', username: 'zoe', role: 'guest', createdAt: '2026-01-01T00:00:00.000Z' }),
    makeUser({ id: '2', username: 'Admin', role: 'admin', createdAt: '2026-02-01T00:00:00.000Z', lastLoginAt: '2026-10-19T11:00:00.000Z' }),
    makeUser({ id: '3', username: 'bob', role: 'user', createdAt: '2026-03-01T00:00:00.000Z' }),
  ];

  it('搜索不区分大小写、忽略首尾空格，空串返回全部', () => {
    expect(filterUsers(users, ' adm ').map(u => u.username)).toEqual(['Admin']);
    expect(filterUsers(users, '')).toHaveLength(3);
    expect(filterUsers(users, '  ')).toHaveLength(3);
  });

  it('角色排序按层级（管理员→普通用户→游客）而非字典序', () => {
    expect(sortUsers(users, 'role', 'ascending').map(u => u.username)).toEqual(['Admin', 'bob', 'zoe']);
    expect(sortUsers(users, 'role', 'descending').map(u => u.username)).toEqual(['zoe', 'bob', 'Admin']);
  });

  it('时间排序把缺失时间当 0：从未登录在倒序里沉底', () => {
    const byLogin = sortUsers(users, 'lastLoginAt', 'descending').map(u => u.username);
    expect(byLogin[byLogin.length - 1]).not.toBe('Admin');
    expect(sortUsers(users, 'createdAt', 'descending').map(u => u.username)).toEqual(['bob', 'Admin', 'zoe']);
  });

  it('同值按用户名升序 tie-break，翻页顺序稳定', () => {
    const same = [makeUser({ id: 'a', username: 'bbb' }), makeUser({ id: 'b', username: 'aaa' })];
    expect(sortUsers(same, 'role', 'ascending').map(u => u.username)).toEqual(['aaa', 'bbb']);
  });

  it('分页切片越界返回空而不是回绕', () => {
    expect(sliceUsers(users, 1, 2)).toHaveLength(2);
    expect(sliceUsers(users, 3, 2)).toHaveLength(0);
    expect(USER_PAGE_SIZE_OPTIONS).toContain(20);
  });

  it('默认查询是关键字为空 + 用户名升序（与表格 default-sort 一致）', () => {
    expect(defaultUserTableQuery()).toEqual({ keyword: '', sortProp: 'username', sortOrder: 'ascending' });
  });

  it('相对时间：分钟/小时/天三档 + 超过 30 天降级为日期；缺失显示占位', () => {
    expect(relativeTime('2026-10-19T11:57:00.000Z', NOW)).toBe('3 分钟前');
    expect(relativeTime('2026-10-19T09:00:00.000Z', NOW)).toBe('3 小时前');
    expect(relativeTime('2026-10-09T12:00:00.000Z', NOW)).toBe('10 天前');
    expect(relativeTime('2026-01-01T00:00:00.000Z', NOW)).toBe('2026-01-01');
    expect(relativeTime(undefined, NOW)).toBe('—');
    expect(relativeTime('not-a-date', NOW)).toBe('—');
  });

  it('未来时间戳不显示负数分钟（客户端时钟漂移）', () => {
    expect(relativeTime('2026-10-19T12:30:00.000Z', NOW)).toBe('刚刚');
  });

  it('absoluteTime 给出可读完整时间，缺失时同样占位', () => {
    expect(absoluteTime('2026-10-19T11:57:00.000Z')).not.toBe('—');
    expect(absoluteTime('')).toBe('—');
  });
});

describe('U7 表单校验与后端规则同源', () => {
  it('新建：用户名与密码都必填，且各自给出规则文案', () => {
    const e = validateUserForm({ username: '', password: '', requirePassword: true });
    expect(e.username).toBe('用户名不能为空');
    expect(e.password).toBe('密码不能为空');
    expect(hasErrors(e)).toBe(true);
  });

  it('用户名格式与密码长度分别命中对应提示', () => {
    expect(validateUserForm({ username: 'a b', password: 'abcdefghijkl', requirePassword: true }).username).toBe(USERNAME_RULE);
    expect(validateUserForm({ username: 'good_name', password: 'short', requirePassword: true }).password).toBe(PASSWORD_RULE);
    expect(validateUserForm({ username: 'good_name', password: 'abcdefghijkl', requirePassword: true }).password).toBeUndefined();
  });

  it('编辑态密码留空 = 不修改，填了才校验长度；没有用户名字段时不校验用户名', () => {
    expect(hasErrors(validateUserForm({ password: '', requirePassword: false }))).toBe(false);
    expect(validateUserForm({ password: '123', requirePassword: false }).password).toBe(PASSWORD_RULE);
    // 传了 username 才校验（新建表单）
    expect(validateUserForm({ username: 'x', password: '', requirePassword: false }).username).toBe(USERNAME_RULE);
  });

  it('hasErrors 对空对象返回 false', () => {
    expect(hasErrors({})).toBe(false);
  });
});

describe('角色文案', () => {
  it('三种角色都有中文标签（原来表格只写英文 role，普通用户读不懂 guest 与 user 的差别）', () => {
    expect(roleLabel('admin')).toBe('管理员');
    expect(roleLabel('user')).toBe('普通用户');
    expect(roleLabel('guest')).toBe('游客');
  });
});

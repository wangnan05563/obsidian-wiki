// T02782：用户管理「审计日志」面板回归测试。
// 此前 GET /api/auth/audit-log 无任何前端消费者（应用内零入口）；
// 本测试锁定：入口按钮存在、面板五列齐备、动作实名映射、按动作筛选生效、失败态有出口。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ElementPlus from 'element-plus';
import Users from '../src/views/Users.vue';
import { useAuthStore } from '../src/stores/auth';
import { AUDIT_ACTION_LABELS, auditActionLabel } from '../src/utils/labels';
import type { AuditLogEntry } from '../src/types';

const entries: AuditLogEntry[] = [
  { ts: '2026-10-22T08:00:00.000Z', userId: 'u1', username: 'admin', action: 'login', resource: '/api/auth/login', ip: '192.168.1.2', result: 'success' },
  { ts: '2026-10-22T08:05:00.000Z', userId: 'u2', username: 'alice', action: 'user_create', resource: '/api/auth/users', ip: '192.168.1.3', result: 'success' },
  { ts: '2026-10-22T08:06:00.000Z', userId: null, username: null, action: 'permission_denied', resource: '/api/cleanup', ip: '10.0.0.9', result: 'fail', message: '需要管理员权限' },
];

// mock 的引用存模块级，用例内直接断言调用
let fetchAuditLogMock: ReturnType<typeof vi.fn>;

async function mountUsers(auditResult?: { entries: AuditLogEntry[]; count: number } | null) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const authStore = useAuthStore();
  (authStore as any).user = { id: 'u1', role: 'admin', username: 'admin' };
  (authStore as any).isAdmin = true;
  authStore.listUsers = vi.fn().mockResolvedValue([]);
  fetchAuditLogMock = vi.fn().mockResolvedValue(auditResult === undefined ? { entries, count: entries.length } : auditResult);
  authStore.fetchAuditLog = fetchAuditLogMock;

  const wrapper = mount(Users, {
    global: { plugins: [pinia, ElementPlus] },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

async function openAuditPanel(wrapper: Awaited<ReturnType<typeof mountUsers>>) {
  const btn = wrapper.findAll('button').find((b) => b.text().includes('审计日志'));
  expect(btn, '用户管理页应有「审计日志」入口按钮').toBeTruthy();
  await btn!.trigger('click');
  await flushPromises();
}

describe('Users.vue 审计日志面板（T02782）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.textContent = '';
  });

  it('动作实名映射：沿用既有口径（登录/登出/越权），未知动作回退原始值', () => {
    expect(auditActionLabel('login')).toBe('登录');
    expect(auditActionLabel('logout')).toBe('登出');
    expect(auditActionLabel('user_delete')).toBe('用户删除');
    expect(auditActionLabel('future_action')).toBe('future_action');
    expect(AUDIT_ACTION_LABELS.permission_denied).toBe('越权拒绝');
  });

  it('点「审计日志」打开面板并拉取接口；时间/动作/账户/IP/结果五列齐备', async () => {
    const wrapper = await mountUsers();
    await openAuditPanel(wrapper);
    expect(fetchAuditLogMock).toHaveBeenCalledTimes(1);

    // AppModal 走 teleport，渲染在 document.body
    const text = document.body.textContent || '';
    for (const col of ['时间', '动作', '账户', 'IP', '结果']) {
      expect(text).toContain(col);
    }
    // 实名：不显示英文枚举
    expect(text).toContain('用户创建');
    expect(text).toContain('越权拒绝');
    expect(text).not.toContain('user_create');
    expect(text).not.toContain('permission_denied');
    // 匿名账户兜底（username=null）
    expect(text).toContain('(匿名)');
    // 失败结果有标记
    expect(text).toContain('失败');
    // 保留口径说明
    expect(text).toContain('保留最近 1 万条');
    wrapper.unmount();
  });

  it('按动作筛选：只看「登录」时条数收窄到 1/3，其余记录不再渲染', async () => {
    const wrapper = await mountUsers();
    await openAuditPanel(wrapper);
    // el-select 交互在 happy-dom 下不可靠，经组件实例直接驱动同一 v-model（语义等价）
    (wrapper.vm as any).auditActionFilter = 'login';
    await flushPromises();
    const text = document.body.textContent || '';
    expect(text).toContain('筛出 1 / 3 条');
    // 被筛掉的行不再渲染：用「只出现在表格行」的标记（IP/资源）断言——
    // 账户名与动作实名会同时出现在 el-select 下拉选项里（popper 常驻 body），不能当缺席判据
    expect(text).not.toContain('192.168.1.3');
    expect(text).not.toContain('10.0.0.9');
    expect(text).not.toContain('/api/auth/users');
    expect(text).not.toContain('/api/cleanup');
    expect(text).toContain('登录');
    wrapper.unmount();
  });

  it('接口失败时面板内出错误态（StateBlock），不留白屏', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const authStore = useAuthStore();
    (authStore as any).user = { id: 'u1', role: 'admin', username: 'admin' };
    (authStore as any).isAdmin = true;
    (authStore as any).auditError = '加载审计日志失败';
    authStore.listUsers = vi.fn().mockResolvedValue([]);
    fetchAuditLogMock = vi.fn().mockResolvedValue(null);
    authStore.fetchAuditLog = fetchAuditLogMock;

    const wrapper = mount(Users, { global: { plugins: [pinia, ElementPlus] }, attachTo: document.body });
    await flushPromises();
    const btn = wrapper.findAll('button').find((b) => b.text().includes('审计日志'));
    await btn!.trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('加载审计日志失败');
    wrapper.unmount();
  });
});

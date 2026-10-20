// T02482（PRD D4x）：帮助文档「本地数据保护」表单迁至配置中心「数据备份」页签
// ------------------------------------------------------------------
// 迁移类改动最怕两件事：① 新家没接上（页签加了但面板没挂）；② 老行为丢了（解锁门、独立口令、
// 导入后 reload 等）。所以这里三层各测一层：
//   configTabs 元数据（导航/深链/回落的唯一来源）→ Help 文案与直达（只留说明）→
//   LocalDataBackupPanel 行为（与依赖模块解耦的 mock 下逐项复现旧 Help 的反馈路径）。
// Config.vue 的挂接用源码断言（本仓库对超大 SFC 的既有测试口径，见 p0-regression readSrc 系列）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Help from '../src/views/Help.vue';
import LocalDataBackupPanel from '../src/components/LocalDataBackupPanel.vue';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { allConfigTabs, findTabMeta, resolveInitialTab, CONFIG_TAB_GROUPS } from '../src/utils/configTabs';

const readSrc = (p: string) => readFileSync(resolve(__dirname, '../src', p), 'utf8');

// ---- 面板测试用 mock：只 mock 面板直接依赖的三个模块，组件逻辑本身全真 ----
const unlockSpy = vi.fn(async () => {});
const loadSpy = vi.fn(async () => {});
const localLockedRef = { value: false };
const createBackupSpy = vi.fn(async (_pwd: string) => ({ fake: 'backup' }) as never);
const downloadSpy = vi.fn((_b: unknown) => {});
const readFileSpy = vi.fn(async (_f: File) => ({ fake: 'file' }) as never);
const restoreSpy = vi.fn(async (_b: unknown, _pwd: string) => ({ conversations: 3, attachments: 1 }));

vi.mock('../src/services/localVault', () => ({ isUnlocked: () => false }));
vi.mock('../src/services/backup', () => ({
  createBackup: (pwd: string) => createBackupSpy(pwd),
  downloadBackup: (b: unknown) => downloadSpy(b),
  readBackupFile: (f: File) => readFileSpy(f),
  restoreBackup: (b: unknown, pwd: string) => restoreSpy(b, pwd),
}));
vi.mock('../src/stores/conversations', () => ({
  useConversationsStore: () => ({
    // Pinia 对 setup store 的 ref 属性做了解包；裸 mock 必须用 getter 等价模拟
    // （否则组件里拿到的永远是 ref 对象本身 → 「已锁定」恒真）
    get localLocked() {
      return localLockedRef.value;
    },
    unlockLocalData: unlockSpy,
    loadConversations: loadSpy,
  }),
}));
vi.mock('../src/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 'u1', username: 'tester' } }),
}));

function mountPanel() {
  return mount(LocalDataBackupPanel, { global: { plugins: [ElementPlus] }, attachTo: document.body });
}

function pwdInputs(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper.findAllComponents({ name: 'ElInput' }).filter((w) => w.props('type') === 'password');
}

describe('T02482 元数据：数据备份进入个人偏好组', () => {
  it('backup 页签存在、归入个人偏好、不锁管理员', () => {
    const meta = findTabMeta('backup');
    expect(meta).toBeTruthy();
    expect(meta!.label).toBe('数据备份');
    expect(meta!.adminOnly).toBe(false);
    const personal = CONFIG_TAB_GROUPS.find((g) => g.key === 'personal');
    expect(personal!.tabs.map((t) => t.name)).toContain('backup');
    expect(allConfigTabs()).toHaveLength(12);
  });

  it('深链/直达对普通用户也有效：resolveInitialTab 不回落', () => {
    expect(resolveInitialTab('backup', false)).toBe('backup');
    expect(resolveInitialTab('backup', true)).toBe('backup');
  });
});

describe('T02482 挂接与搬家完整性（源码层）', () => {
  it('Config.vue 把面板挂进 backup 页签（懒访问 + 权限门与其他页签同构）', () => {
    const cfg = readSrc('views/Config.vue');
    expect(cfg).toContain("activeTab === 'backup'");
    expect(cfg).toContain("visitedTabs.includes('backup')");
    expect(cfg).toContain("canOpenTab('backup')");
    expect(cfg).toContain('<LocalDataBackupPanel');
    expect(cfg).toContain("aria-label=\"数据备份\"");
  });

  it('Help.vue 不再直连备份/解锁服务（表单确实搬走了，不是复制两份）', () => {
    const help = readSrc('views/Help.vue');
    expect(help).not.toMatch(/from '\.\.\/services\/backup'/);
    expect(help).not.toMatch(/from '\.\.\/services\/localVault'/);
    // 迁移说明留痕：指向新家的组件名
    expect(help).toContain('LocalDataBackupPanel');
  });
});

describe('T02482 帮助页：只留说明 + 直达', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    while (document.body.firstElementChild) document.body.firstElementChild.remove();
  });

  it('#local-data 卡片不再有输入表单（口令框与文件选择框都已迁走）', async () => {
    const wrapper = mount(Help, { global: { plugins: [ElementPlus] }, attachTo: document.body });
    await flushPromises();
    const card = wrapper.find('#local-data');
    expect(card.exists()).toBe(true);
    expect(card.find('input[type="file"]').exists()).toBe(false);
    expect(card.find('input[type="password"]').exists()).toBe(false);
    expect(card.text()).toContain('配置中心 → 数据备份');
  });

  it('直达按钮写 sessionStorage tab=backup 并广播 navigate(config)', async () => {
    const wrapper = mount(Help, { global: { plugins: [ElementPlus] }, attachTo: document.body });
    await flushPromises();
    const btn = wrapper.find('#local-data .block-jump');
    expect(btn.exists()).toBe(true);
    let nav: string | null = null;
    const onNav = (e: Event) => {
      nav = (e as CustomEvent<string>).detail;
    };
    globalThis.addEventListener('karpathy:navigate', onNav);
    await btn.trigger('click');
    globalThis.removeEventListener('karpathy:navigate', onNav);
    expect(nav).toBe('config');
    const raw = sessionStorage.getItem('karpathy:navigate-tab');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual({ view: 'config', tab: 'backup' });
  });
});

describe('T02482 面板行为：旧 Help 的反馈路径逐条复现', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localLockedRef.value = false;
    while (document.body.firstElementChild) document.body.firstElementChild.remove();
  });

  it('状态行口径不变：本地加密未启用 / 数据锁定正常；锁定块不出现', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('本地加密：未启用');
    expect(text).toContain('数据锁定：正常');
    expect(text).not.toContain('解锁本地数据');
  });

  it('localLocked=true 出现解锁块；口令为空按钮禁用，填口令后点击走 unlockLocalData 并清空输入', async () => {
    localLockedRef.value = true;
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('解锁本地数据');
    const unlockBtn = wrapper.findAll('button').find((b) => b.text().includes('解锁'))!;
    expect(unlockBtn.attributes('disabled')).toBeDefined();
    const loginInput = pwdInputs(wrapper).find((w) => w.props('placeholder') === '登录密码')!;
    await loginInput.vm.$emit('update:modelValue', 'pw123');
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text().includes('解锁'))!.trigger('click');
    await flushPromises();
    expect(unlockSpy).toHaveBeenCalledWith('pw123');
  });

  it('导出：口令空 → 按钮禁用；填备份口令 → createBackup(pwd) + downloadBackup 同链路', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const exportBtn = () => wrapper.findAll('button').find((b) => b.text().includes('导出'))!;
    expect(exportBtn().attributes('disabled')).toBeDefined();
    const exportInput = pwdInputs(wrapper).find((w) => w.element.querySelector('input')?.getAttribute('placeholder') === '备份口令')!;
    await exportInput.vm.$emit('update:modelValue', 'bak-pw');
    await flushPromises();
    await exportBtn().trigger('click');
    await flushPromises();
    expect(createBackupSpy).toHaveBeenCalledWith('bak-pw');
    expect(downloadSpy).toHaveBeenCalledWith({ fake: 'backup' });
    expect(document.body.textContent).toContain('备份已导出（请用安全方式保存该文件）');
  });

  it('导入：文件+口令齐 → readBackupFile → restoreBackup → 完成后 reload 会话', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const fileInput = wrapper.find('input[type="file"]');
    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    Object.defineProperty(fileInput.element, 'files', { value: [file], configurable: true });
    await fileInput.trigger('change');
    const importPwdInput = pwdInputs(wrapper)
      .filter((w) => w.element.querySelector('input')?.getAttribute('placeholder') === '备份口令')
      .pop()!;
    await importPwdInput.vm.$emit('update:modelValue', 'bak-pw');
    await flushPromises();
    const importBtn = wrapper.findAll('button').find((b) => b.text().includes('导入'))!;
    expect(importBtn.attributes('disabled')).toBeUndefined();
    await importBtn.trigger('click');
    await flushPromises();
    expect(readFileSpy).toHaveBeenCalled();
    expect(restoreSpy).toHaveBeenCalledWith({ fake: 'file' }, 'bak-pw');
    expect(loadSpy).toHaveBeenCalled();
    expect(document.body.textContent).toContain('导入完成：会话 3 条、附件 1 条');
  });

  it('登录态变化的按 owner 重载 watch 随面板一起搬家（authStore 引用存在）', () => {
    const src = readSrc('components/LocalDataBackupPanel.vue');
    expect(src).toContain('authStore.user?.id');
    expect(src).toContain('loadConversations');
    // 行为口径的关键字符串与迁移前逐字一致（改文案必须同步文档）
    expect(src).toContain('备份已导出（请用安全方式保存该文件）');
    expect(src).toContain('导入完成：会话');
    expect(src).toContain('本地数据已解锁');
  });
});

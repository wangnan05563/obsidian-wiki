// T02913（PRD R-F4 第 4 条另一半）：删除固定域名（Named）隧道的挂载回归。
// ------------------------------------------------------------------
// 此前 named 字段「只进不出」：route-dns 成功后界面没有任何解除手段，用户只能去 CLI
// 手工 cloudflared tunnel delete。本单补齐：删除入口（仅 named 配置可见）+ 确认弹窗
// （必须说明「域名变化会让已分享链接失效」与 CNAME 需控制台手工删）+ 失败走内联告警条。
// 删除属于写盘操作，只能由按钮显式触发——与 T02637 的显式保存语义同源。
// 假接口口径沿用 tunnel-provider-save.test.ts。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus, { ElMessageBox } from 'element-plus';
import Tunnel from '../src/views/Tunnel.vue';
import type { TunnelConfigData } from '../src/types';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock('../src/utils/apiBase', () => ({ API_BASE: '/api', apiFetch: apiFetchMock }));
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
    ElMessageBox: { confirm: vi.fn(), prompt: vi.fn(), alert: vi.fn() },
  };
});

const NAMED_CONFIG: TunnelConfigData = {
  provider: 'cloudflare', localPort: 0, serverPort: 3000, cpolarAuthtokenMasked: '', cpolarAuthtokenConfigured: false,
  binaryPath: '', autoStart: false, tunnelMode: 'named', tunnelName: 'my-wiki-tunnel', tunnelId: '0123abcd-12ab-34cd-56ef-123456abcdef',
  credentialsFile: 'cred.json', hostname: 'wiki.example.com', certFileConfigured: true,
};

const QUICK_CONFIG: TunnelConfigData = { ...NAMED_CONFIG, tunnelMode: 'quick', tunnelName: '', tunnelId: '', credentialsFile: '', hostname: '' };

let deleteRequested = 0;

function ok(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

interface Install { config?: TunnelConfigData; deleteFails?: boolean }

function install(opts: Install = {}) {
  deleteRequested = 0;
  let current: TunnelConfigData = { ...(opts.config ?? NAMED_CONFIG) };
  apiFetchMock.mockImplementation((url: string, o?: { method?: string }) => {
    const method = o?.method ?? 'GET';
    const u = String(url);
    if (u.endsWith('/tunnel/status')) {
      return ok({ status: 'stopped', publicUrl: current.hostname ? `https://${current.hostname}` : null, provider: current.provider, lastStartError: null });
    }
    if (u.endsWith('/tunnel/config') && method === 'GET') return ok({ ...current });
    if (u.endsWith('/tunnel/named/delete') && method === 'POST') {
      if (opts.deleteFails) return ok({ detail: '删除隧道失败: cloudflared 报错' }, 500);
      deleteRequested += 1;
      // 与后端同口径：删除成功即切回 quick 并清空 named 字段
      current = { ...QUICK_CONFIG };
      return ok({ ok: true, message: '隧道已删除，本地已切回快速模式。DNS 的 CNAME 记录请到 Cloudflare 控制台手工删除' });
    }
    if (u.endsWith('/tunnel/prerequisites')) {
      return ok({ provider: current.provider, checkedAt: Date.now(), items: [], allSatisfied: true });
    }
    return ok({ detail: `unexpected url ${u}` }, 404);
  });
}

async function nextTickFlush() {
  await flushPromises();
  await flushPromises();
}

async function mountTunnel(opts: Install = {}) {
  install(opts);
  const wrapper = mount(Tunnel, { global: { plugins: [ElementPlus] }, attachTo: document.body });
  await nextTickFlush();
  return wrapper;
}

// IconActionButton 是「仅图标」外观：按钮名在 aria-label 上，不在可见文本里
function deleteButton(w: Awaited<ReturnType<typeof mountTunnel>>) {
  return w.find('button[aria-label="删除隧道"]');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  while (document.body.firstElementChild) document.body.firstElementChild.remove();
  ElMessageBox.confirm.mockResolvedValue('confirm');
});

describe('A · 删除入口与确认弹窗', () => {
  it('named 配置下显示「删除隧道」按钮；确认弹窗写明域名失效与 CNAME 控制台口径', async () => {
    const w = await mountTunnel();
    expect(w.text()).toContain('wiki.example.com');
    expect(deleteButton(w).exists(), 'named 配置必须有删除出口').toBeTruthy();

    await deleteButton(w).trigger('click');
    await nextTickFlush();
    const [message, title] = (ElMessageBox.confirm as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(title).toBe('删除固定域名隧道');
    expect(String(message)).toContain('域名变化会让已分享出去的固定域名链接永久失效');
    expect(String(message)).toContain('CNAME');
    expect(String(message)).toContain('Cloudflare 控制台');
    w.unmount();
  });

  it('取消弹窗：不发删除请求，配置原样', async () => {
    ElMessageBox.confirm.mockRejectedValueOnce('cancel');
    const w = await mountTunnel();
    await deleteButton(w).trigger('click');
    await nextTickFlush();
    expect(deleteRequested, '取消就是取消，一个请求都不能发').toBe(0);
    expect(w.find('.named-config-info').exists(), 'named 信息块还在').toBe(true);
    w.unmount();
  });
});

describe('B · 删除成功：字段真的清掉', () => {
  it('确认后 POST /tunnel/named/delete 一次；回读配置回到 quick，named 信息块消失，无残留告警', async () => {
    const w = await mountTunnel();
    await deleteButton(w).trigger('click');
    await nextTickFlush();

    expect(deleteRequested).toBe(1);
    expect(w.find('.named-config-info').exists(), '删除后 named 信息块必须消失，不能留下「域名还在」的错觉').toBe(false);
    expect(w.find('.named-config-error').exists()).toBe(false);
    w.unmount();
  });
});

describe('C · 删除失败：内联告警条而不是静默', () => {
  it('cloudflared 报错时 detail 原文展示在删除按钮上方，named 配置不动', async () => {
    const w = await mountTunnel({ deleteFails: true });
    await deleteButton(w).trigger('click');
    await nextTickFlush();

    expect(deleteRequested, '失败也要看得出请求确实发出去了').toBe(0);
    const alert = w.find('.named-config-error');
    expect(alert.exists(), '失败必须内联可见，不能只闪一个 toast').toBe(true);
    expect(alert.text()).toContain('删除隧道失败: cloudflared 报错');
    expect(w.find('.named-config-info').exists(), '失败后配置原样，信息块不消失').toBe(true);
    w.unmount();
  });
});

describe('D · 非 named 配置不出现删除入口', () => {
  it('quick 模式无 hostname：固定域名行整个不渲染', async () => {
    const w = await mountTunnel({ config: QUICK_CONFIG });
    expect(deleteButton(w).exists(), '没有可删的东西就不该出现删除按钮').toBe(false);
    w.unmount();
  });
});

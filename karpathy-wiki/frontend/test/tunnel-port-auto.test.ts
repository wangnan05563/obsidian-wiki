// T02912（PRD R-F4 第 3 条）：本地端口「自动」复选框挂载回归。
// ------------------------------------------------------------------
// 这一单改的是**表达方式**而不是存储语义：勾选「自动」→ 输入框禁用并显示实际继承的服务端口；
// 存储侧仍是 localPort=0 哨兵（api routes/tunnel.ts 兜底 config.server.port），不许动。
// 三条判据只有真挂载才证得到：
//   ① 页面上不再出现「0 = 自动继承服务端口」这种要用户记哨兵值的写法；
//   ② 勾选自动时输入框禁用且能看出实际端口；取消勾选预填服务端口，可手填并被 POST 持久化；
//   ③ 取消→再勾选的往返不产生「未保存改动」（哨兵值没变就不算脏）。
// 假接口口径沿用 tunnel-provider-save.test.ts（config GET/POST 逐字段合并）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
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

const SAVED: TunnelConfigData = {
  provider: 'cpolar', localPort: 0, serverPort: 3000, cpolarAuthtokenMasked: '****', cpolarAuthtokenConfigured: true,
  binaryPath: '', autoStart: false, tunnelMode: 'quick', tunnelName: '', tunnelId: '',
  credentialsFile: '', hostname: '', certFileConfigured: false,
};

let posted: Array<Record<string, unknown>> = [];

function ok(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

interface Install { saved?: TunnelConfigData }

function install(opts: Install = {}) {
  posted = [];
  const current: TunnelConfigData = { ...(opts.saved ?? SAVED) };
  apiFetchMock.mockImplementation((url: string, o?: { method?: string; body?: string }) => {
    const method = o?.method ?? 'GET';
    const u = String(url);
    if (u.endsWith('/tunnel/status')) {
      return ok({ status: 'stopped', publicUrl: null, provider: current.provider, lastStartError: null });
    }
    if (u.endsWith('/tunnel/config') && method === 'GET') return ok({ ...current });
    if (u.endsWith('/tunnel/config') && method === 'POST') {
      const body = JSON.parse(String(o?.body ?? '{}')) as Partial<TunnelConfigData>;
      posted.push(body);
      Object.assign(current, { localPort: body.localPort ?? current.localPort });
      return ok({ ...current });
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
  const wrapper = mount(Tunnel, { global: { plugins: [ElementPlus, createPinia()] }, attachTo: document.body });
  await nextTickFlush();
  return wrapper;
}

type TunnelVm = { formPort: number; portAuto: boolean };
const vmOf = (w: Awaited<ReturnType<typeof mountTunnel>>) => w.vm as unknown as TunnelVm;
// el-input-number 的 id 落点随版本可能在内层 input 或外层容器上，两层都找一遍
const portInput = (w: Awaited<ReturnType<typeof mountTunnel>>) => {
  const byId = w.find('#tunnel-port');
  return byId.classes().includes('el-input__inner') ? byId : byId.find('.el-input__inner');
};
// 端口行的提示是 port-auto-row 的下一个兄弟——不能放宽到任意 .config-row .hint，
// 否则会按 DOM 顺序先撞上 cpolar authtoken 行的提示
const hintOf = (w: Awaited<ReturnType<typeof mountTunnel>>) => w.find('.port-auto-row + .hint').text();

async function saveViaUnsavedBar(w: Awaited<ReturnType<typeof mountTunnel>>) {
  await w.find('#tunnel-unsaved [aria-label="保存配置"]').trigger('click');
  await nextTickFlush();
}

beforeEach(() => {
  vi.clearAllMocks();
  while (document.body.firstElementChild) document.body.firstElementChild.remove();
  ElMessageBox.confirm.mockResolvedValue('confirm');
});

describe('A · 自动勾选态（localPort=0 存量配置读回）', () => {
  it('配置 localPort=0 时复选框勾上、输入框禁用、提示写明继承的服务端口', async () => {
    const w = await mountTunnel();
    expect(vmOf(w).portAuto, '存量 0 就是自动，必须读成勾选').toBe(true);
    expect(portInput(w).attributes('disabled'), '勾选自动后输入框禁用').toBeDefined();
    expect(hintOf(w)).toContain('继承服务端口 3000');
    w.unmount();
  });

  it('页面不得出现哨兵值写法：任何地方都没有「0 =」或「留 0」这种要用户记 0 的文案', async () => {
    const w = await mountTunnel();
    expect(w.text()).not.toContain('0 =');
    expect(w.text()).not.toContain('留 0');
    w.unmount();
  });
});

describe('B · 取消勾选：手填并被正确持久化', () => {
  it('取消勾选后输入框解禁并预填服务端口，保存时 POST localPort=3000', async () => {
    const w = await mountTunnel();
    vmOf(w).portAuto = false;
    await nextTickFlush();

    expect(vmOf(w).portAuto).toBe(false);
    expect(vmOf(w).formPort, '取消自动应预填服务端口，不让用户从 0 猜').toBe(3000);
    expect(portInput(w).attributes('disabled'), '取消勾选后输入框可用').toBeUndefined();
    expect(w.find('#tunnel-unsaved').exists(), '端口值变了就是脏表单，要说出来').toBe(true);

    await saveViaUnsavedBar(w);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ localPort: 3000 });
    w.unmount();
  });

  it('取消后手动改成别的端口也能持久化', async () => {
    const w = await mountTunnel();
    vmOf(w).portAuto = false;
    vmOf(w).formPort = 8080;
    await nextTickFlush();
    await saveViaUnsavedBar(w);
    expect(posted[posted.length - 1]).toMatchObject({ localPort: 8080 });
    w.unmount();
  });

  it('手填 0 会被「自动」接住：复选框自动勾回、输入框禁用（哨兵 0 不以手填形态出现在界面上）', async () => {
    // el-input-number 的 min 必须留 0：watch(immediate) 会把 < min 的 modelValue 钳到 min 并回写，
    // min=1 会把哨兵 0 悄悄改成 1，制造一个永远消不掉的假脏表单
    const w = await mountTunnel();
    vmOf(w).portAuto = false;
    vmOf(w).formPort = 0;
    await nextTickFlush();
    expect(vmOf(w).portAuto, '填 0 即视为自动，复选框勾回').toBe(true);
    expect(portInput(w).attributes('disabled')).toBeDefined();
    w.unmount();
  });
});

describe('C · 重新勾选：回到哨兵但不惊动脏检查', () => {
  it('取消→再勾选的往返不产生未保存提示，保存时 POST localPort=0（哨兵语义不变）', async () => {
    const w = await mountTunnel();
    vmOf(w).portAuto = false;
    await nextTickFlush();
    expect(w.find('#tunnel-unsaved').exists()).toBe(true);

    vmOf(w).portAuto = true;
    await nextTickFlush();
    expect(vmOf(w).formPort).toBe(0);
    expect(w.find('#tunnel-unsaved').exists(), '值回到已保存的 0，就不算改动').toBe(false);

    // 表单已干净、没有提示条可点：直接走页面上唯一写盘出口 saveConfig，验证存储侧仍是哨兵 0
    await (w.vm as unknown as { saveConfig: () => Promise<boolean> }).saveConfig();
    await nextTickFlush();
    expect(posted[posted.length - 1]).toMatchObject({ localPort: 0 });
    w.unmount();
  });
});

describe('D · 旧响应体（无 serverPort）优雅降级', () => {
  it('取消勾选时预填兜底 3000 而不是把哨兵 0 留在输入框里', async () => {
    const { serverPort: _omit, ...legacy } = SAVED;
    const w = await mountTunnel({ saved: legacy });
    vmOf(w).portAuto = false;
    await nextTickFlush();
    expect(vmOf(w).formPort, '旧后端没有 serverPort 时预填兜底值，绝不能填回 0').toBe(3000);
    w.unmount();
  });
});

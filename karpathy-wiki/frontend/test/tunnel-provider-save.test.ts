// T02637：内网穿透页改为「显式保存 + 脏检查」的挂载回归。
// ------------------------------------------------------------------
// 这一单改的是**写盘语义**而不是外观，三条判据只有真挂载 + 真事件才证得到：
//   ① 切换 Provider 不再顺手 POST /tunnel/config，也不再顺手停掉正在跑的隧道；
//   ② 「改动停在表单里」必须变成用户看得见的一条提示（含脏字段名），并能一键放弃；
//   ③ 脏表单上点启动走三分岔：保存并启动 / 按已保存配置启动 / 取消——
//      后端 POST /tunnel/start 只读 config.json、不收请求体，默默用旧配置启动
//      会产生「下拉框选 Tailscale、报错却是 cloudflared 下载失败」这种指错地方的失败。
// 另加一条源码守护：写盘出口只能有 saveConfig 一处（防止以后有人把隐式落盘加回来）。
// 假接口口径沿用 tunnel-self-check-ui.test.ts，弹窗沿用 dataclean-misplaced-block.test.ts 的部分 mock。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus, { ElMessageBox, ElSelect } from 'element-plus';
import Tunnel from '../src/views/Tunnel.vue';
import type { TunnelConfigData } from '../src/types';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock('../src/utils/apiBase', () => ({ API_BASE: '/api', apiFetch: apiFetchMock }));
// 只中性化弹窗与 toast：el-select / el-alert 等组件必须是真的，否则「接上了没」测不到
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
    ElMessageBox: { confirm: vi.fn(), prompt: vi.fn(), alert: vi.fn() },
  };
});

const SAVED: TunnelConfigData = {
  provider: 'cpolar', localPort: 0, cpolarAuthtokenMasked: '****', cpolarAuthtokenConfigured: true,
  binaryPath: '', autoStart: false, tunnelMode: 'quick', tunnelName: '', tunnelId: '',
  credentialsFile: '', hostname: '', certFileConfigured: false,
};

/** 记录三类副作用：写盘、启动、停止——本单的核心断言全是「有没有发生」而不是返回值 */
let posted: Array<Record<string, unknown>> = [];
let started = 0;
let stopped = 0;

function ok(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

interface Install {
  saved?: TunnelConfigData;
  running?: boolean;
  saveFails?: boolean;
}

function install(opts: Install = {}) {
  posted = [];
  started = 0;
  stopped = 0;
  // 可变「已落盘配置」：POST config 要真的改掉它，否则保存后再 GET 还是旧值，
  // 「保存后提示条收起」这类断言会假红——接口形状照抄 api/src/routes/tunnel.ts 的逐字段合并
  const current: TunnelConfigData = { ...(opts.saved ?? SAVED) };
  apiFetchMock.mockImplementation((url: string, o?: { method?: string; body?: string }) => {
    const method = o?.method ?? 'GET';
    const u = String(url);
    if (u.endsWith('/tunnel/status')) {
      return ok({ status: opts.running ? 'running' : 'stopped', publicUrl: opts.running ? 'https://demo.cpolar.top' : null, provider: current.provider, lastStartError: null });
    }
    if (u.endsWith('/tunnel/config') && method === 'GET') return ok({ ...current });
    if (u.endsWith('/tunnel/config') && method === 'POST') {
      if (opts.saveFails) return ok({ detail: '配置写入失败（磁盘只读）' }, 500);
      const body = JSON.parse(String(o?.body ?? '{}')) as Partial<TunnelConfigData> & { cpolarAuthtoken?: string };
      posted.push(body);
      Object.assign(current, {
        provider: body.provider ?? current.provider,
        localPort: body.localPort ?? current.localPort,
        binaryPath: body.binaryPath ?? current.binaryPath,
        autoStart: body.autoStart ?? current.autoStart,
        tunnelMode: body.tunnelMode ?? current.tunnelMode,
      });
      // 空串=不修改已有 token（与后端 saveTunnelConfig 同一口径）
      if (body.cpolarAuthtoken) current.cpolarAuthtokenConfigured = true;
      return ok({ ...current, detail: '配置已保存，下次启动隧道时生效' });
    }
    if (u.endsWith('/tunnel/prerequisites')) {
      return ok({ provider: current.provider, checkedAt: Date.now(), items: [], allSatisfied: true });
    }
    if (u.endsWith('/tunnel/start') && method === 'POST') {
      started += 1;
      return ok({ status: 'running', publicUrl: 'https://demo.cpolar.top', provider: current.provider, lastStartError: null });
    }
    if (u.endsWith('/tunnel/stop') && method === 'POST') {
      stopped += 1;
      return ok({ status: 'stopped', publicUrl: null, provider: current.provider, lastStartError: null });
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

type TunnelVm = { formProvider: string; formAuthtoken: string; formAutoStart: boolean };
const vmOf = (w: Awaited<ReturnType<typeof mountTunnel>>) => w.vm as unknown as TunnelVm;

/** 复现 el-select 的真实事件顺序：v-model 先写值，再发 change */
async function switchProvider(w: Awaited<ReturnType<typeof mountTunnel>>, next: string) {
  vmOf(w).formProvider = next;
  w.findComponent(ElSelect).vm.$emit('change', next);
  await nextTickFlush();
}

function startButton(w: Awaited<ReturnType<typeof mountTunnel>>) {
  // 状态卡里两个图标按钮：[0] 启动、[1] 停止（与 data-tip 容器一一对应）
  return w.findAll('.tunnel-action-wrap button')[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  while (document.body.firstElementChild) document.body.firstElementChild.remove();
  // 默认当作「用户点了确认」，需要取消/关闭的用例各自覆盖
  ElMessageBox.confirm.mockResolvedValue('confirm');
});

describe('A · 切换 Provider 不再隐式落盘', () => {
  it('确认后：表单变了，但一次 POST /tunnel/config 都没发（旧行为是换一下就写盘）', async () => {
    const w = await mountTunnel();
    expect(w.find('#tunnel-unsaved').exists(), '刚读回配置时不该报未保存').toBe(false);

    await switchProvider(w, 'tailscale');

    expect(vmOf(w).formProvider, '表单要留下用户选的新服务商').toBe('tailscale');
    expect(posted, '切换不得写盘——本页唯一写盘入口是「保存配置」').toHaveLength(0);
    const alert = w.find('#tunnel-unsaved');
    expect(alert.exists(), '表单与已保存配置不一致必须说出来').toBe(true);
    expect(alert.text()).toContain('1 项改动尚未保存');
    expect(alert.text()).toContain('Provider');
    w.unmount();
  });

  it('确认文案带上 PRD R-F4 要求的那句话：换服务商等于换域名，已分享出去的链接会失效', async () => {
    const w = await mountTunnel();
    await switchProvider(w, 'tailscale');
    const [message, title] = (ElMessageBox.confirm as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(String(message)).toContain('已分享出去的链接会失效');
    expect(String(message)).toContain('Tailscale Funnel');
    expect(String(message)).toContain('只是改表单');
    expect(title).toBe('切换服务商');
    w.unmount();
  });

  it('取消切换：下拉框退回原值，既不写盘也不出现未保存提示（不能留下「看着切了其实没确认」的表单）', async () => {
    ElMessageBox.confirm.mockRejectedValueOnce('cancel');
    const w = await mountTunnel();
    await switchProvider(w, 'tailscale');
    expect(vmOf(w).formProvider, '没同意就一个字段都不动').toBe('cpolar');
    expect(posted).toHaveLength(0);
    expect(w.find('#tunnel-unsaved').exists()).toBe(false);
    w.unmount();
  });

  it('隧道运行中切换：不停当前隧道，并在提示里说清「运行的还是旧服务商、保存后需重启」', async () => {
    const w = await mountTunnel({ running: true });
    await switchProvider(w, 'tailscale');
    expect(stopped, '切换服务商不该把正在跑的隧道停掉（旧行为会）').toBe(0);
    expect(posted).toHaveLength(0);
    expect(w.find('#tunnel-unsaved').text()).toContain('当前运行的隧道还在跑已保存的 cpolar（国内推荐）');
    expect(w.find('#tunnel-unsaved').text()).toContain('停止并重新启动');
    w.unmount();
  });
});

describe('B · 脏表单上点启动：三分岔各走各的', () => {
  it('按已保存配置启动（点 cancel）→ 只发 start，不写盘', async () => {
    const w = await mountTunnel();
    await switchProvider(w, 'tailscale');
    // 切换确认与启动确认共用 ElMessageBox.confirm：once 实现要按弹窗出现顺序排在切换之后
    ElMessageBox.confirm.mockRejectedValueOnce('cancel');
    expect(w.find('#tunnel-unsaved').exists(), '前提：此时确实带着未保存改动').toBe(true);
    await startButton(w).trigger('click');
    await nextTickFlush();
    expect(started).toBe(1);
    expect(posted).toHaveLength(0);
    w.unmount();
  });

  it('关掉弹窗（右上角 / ESC）→ 既不启动也不写盘', async () => {
    const w = await mountTunnel();
    await switchProvider(w, 'tailscale');
    ElMessageBox.confirm.mockRejectedValueOnce('close');
    await startButton(w).trigger('click');
    await nextTickFlush();
    expect(started, 'close 不是「按已保存配置启动」，不能顺手启动').toBe(0);
    expect(posted).toHaveLength(0);
    w.unmount();
  });

  it('保存并启动（点 confirm）→ 先写盘、后启动，且提示条随之收起', async () => {
    const w = await mountTunnel();
    await switchProvider(w, 'tailscale');
    await startButton(w).trigger('click');
    await nextTickFlush();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ provider: 'tailscale' });
    expect(started, '保存成功后必须接着把隧道起起来，否则等于没兑现承诺').toBe(1);
    expect(w.find('#tunnel-unsaved').exists(), '保存后表单与配置一致，提示条该消失').toBe(false);
    w.unmount();
  });

  it('保存失败 → 绝不带着旧配置启动', async () => {
    const w = await mountTunnel({ saveFails: true });
    await switchProvider(w, 'tailscale');
    await startButton(w).trigger('click');
    await nextTickFlush();
    expect(started, '写盘失败还启动，就是拿旧服务商的配置骗用户一次').toBe(0);
    w.unmount();
  });

  it('没有改动时点启动：不多问一句（守卫不能被加在正常路径上）', async () => {
    const w = await mountTunnel();
    await startButton(w).trigger('click');
    await nextTickFlush();
    expect(ElMessageBox.confirm, '干净表单不该被脏检查拦住').not.toHaveBeenCalled();
    expect(started).toBe(1);
    w.unmount();
  });

  it('启动前的问话要能读出「哪几项没保存」和「现在启动用的是哪个服务商」', async () => {
    const w = await mountTunnel();
    vmOf(w).formAutoStart = true;
    await nextTickFlush();
    await startButton(w).trigger('click');
    await nextTickFlush();
    const [message, title] = (ElMessageBox.confirm as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(title).toBe('配置未保存');
    expect(String(message)).toContain('开机自启');
    expect(String(message)).toContain('cpolar（国内推荐）');
    expect(String(message)).toContain('启动隧道读的是已保存配置');
    w.unmount();
  });
});

describe('C · 未保存提示条的两个出口', () => {
  it('「保存配置」写盘并带上新服务商；「放弃修改」读回已保存配置、提示条收起', async () => {
    const w = await mountTunnel();
    await switchProvider(w, 'tailscale');
    vmOf(w).formAuthtoken = 'tk-secret';
    await nextTickFlush();
    expect(w.find('#tunnel-unsaved').text()).toContain('Authtoken');

    await w.find('[aria-label="放弃修改"]').trigger('click');
    await nextTickFlush();
    expect(vmOf(w).formProvider, '放弃后回到已保存的那一份').toBe('cpolar');
    expect(vmOf(w).formAuthtoken).toBe('');
    expect(w.find('#tunnel-unsaved').exists()).toBe(false);
    expect(posted).toHaveLength(0);

    await switchProvider(w, 'tailscale');
    await w.find('#tunnel-unsaved [aria-label="保存配置"]').trigger('click');
    await nextTickFlush();
    expect(posted[posted.length - 1]).toMatchObject({ provider: 'tailscale', cpolarAuthtoken: '' });
    expect(w.find('#tunnel-unsaved').exists()).toBe(false);
    w.unmount();
  });

  it('Provider 下拉旁写清「切换只改表单」——否则用户仍然只能靠踩坑才知道', async () => {
    const w = await mountTunnel();
    expect(w.find('#tunnel-config-card').text()).toContain('切换服务商只改这个表单，要点下方「保存配置」才会写入配置');
    w.unmount();
  });
});

describe('D · 单一写盘出口（源码守护）', () => {
  const src = () => readFileSync(resolve(__dirname, '../src/views/Tunnel.vue'), 'utf8');

  it('onProviderChange 里不许再出现 saveConfig 或 /tunnel/stop（隐式落盘/隐式停隧道都已下线）', () => {
    const fn = src().match(/async function onProviderChange[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn, '找不到函数体说明写法被改动，本守护需同步调整').toContain('ElMessageBox.confirm');
    expect(fn).not.toMatch(/saveConfig/);
    expect(fn).not.toMatch(/tunnel\/stop/);
  });

  it('POST /tunnel/config 只有一处出口，且启动前守卫挂在 startTunnel 上', () => {
    // GET 一次 + POST 一次：出现第三处即有人另开了写盘口子
    expect(src().match(/\/tunnel\/config/g)?.length).toBe(2);
    expect(src().match(/async function startTunnel\(\)[\s\S]*?\n  starting\.value = true;/)?.[0]).toMatch(/isDirty\.value/);
  });
});

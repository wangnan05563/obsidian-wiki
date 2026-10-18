// 内网穿透「失败可见 + 前置条件自检」单测（T02469 / PRD §11 T1+T4）
// ------------------------------------------------------------------
// 两层：
//   1) utils/tunnelDiagnostics.ts 纯函数——后端错误串到「人话建议」的映射必须逐条锁住，
//      这些字符串写死在 tunnel-service.ts 的 throw 点上，措辞一改这里就该报警；
//   2) Tunnel.vue 挂载测试——告警条/自检清单是「进页面就能看到」的东西，只测纯函数证不了
//      「视图真的接上了接口字段」。fetch 走 mock，不依赖后端。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import Tunnel from '../src/views/Tunnel.vue';
import {
  adviceFor,
  buildStartErrorView,
  classifyStartError,
  focusTarget,
  formatCheckedAt,
  formatErrorAgo,
  prereqTone,
  startErrorTitle,
  summarizePrereq,
} from '../src/utils/tunnelDiagnostics';
import type { TunnelPrereqItem, TunnelStartError } from '../src/types';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock('../src/utils/apiBase', () => ({
  API_BASE: '/api',
  apiFetch: apiFetchMock,
}));

// ===== 纯函数层 =====

describe('classifyStartError：后端原文 → 分类（关键字表与 throw 点同步）', () => {
  // 逐条取自 api/src/tunnel/tunnel-service.ts 的真实抛出文案
  const CASES: Array<[string, string, ReturnType<typeof classifyStartError>]> = [
    ['未检测到 Tailscale。请先安装并登录 Tailscale：https://tailscale.com/download/windows', 'tailscale', 'tailscale_install'],
    ['请先打开并登录 Tailscale，然后重新启动隧道', 'tailscale', 'tailscale_login'],
    ['Tailscale 尚未启用 MagicDNS，无法生成固定 ts.net 地址', 'tailscale', 'magicdns'],
    ['配置的 Tailscale 路径不存在: D:/gone/tailscale.exe', 'tailscale', 'bad_binary_path'],
    ['Tailscale 二进制未检测到', 'tailscale', 'tailscale_install'],
    ['首次启用 Funnel 需要在浏览器完成授权，请点击下方链接完成授权后重新启动隧道', 'tailscale', 'funnel_auth'],
    ['cpolar 需要 authtoken，请到 https://dashboard.cpolar.com/signup 注册获取', 'cpolar', 'authtoken_missing'],
    ['zip 解压后未找到 cpolar.exe', 'cpolar', 'binary_download'],
    ['cloudflared.exe 所有下载源均失败: 连接超时', 'cloudflare', 'binary_download'],
    ['隧道启动失败: 完全没见过的报错', undefined, 'generic'],
  ];

  it.each(CASES)('「%s」判为 %s', (message, provider, expected) => {
    expect(classifyStartError(message, provider)).toBe(expected);
  });

  it('带下载链接的 Tailscale 报错不能被「下载」关键字抢走（建议会指错地方）', () => {
    const m = '未检测到 Tailscale。请先安装并登录 Tailscale：https://tailscale.com/download/windows';
    expect(classifyStartError(m, 'tailscale')).not.toBe('binary_download');
    expect(adviceFor(classifyStartError(m, 'tailscale'))).toContain('没装 Tailscale');
  });

  it('服务商是 tailscale 但报错没特征时，先怀疑客户端没登录，而不是泛泛「原因不明」', () => {
    expect(classifyStartError('Something went wrong', 'tailscale')).toBe('tailscale_login');
  });

  it('空/异常输入不抛错（防御：告警条本身不该成为第二个故障点）', () => {
    expect(classifyStartError('')).toBe('generic');
    expect(classifyStartError(undefined as unknown as string)).toBe('generic');
  });
});

describe('告警条文案：来源不同、语气不同', () => {
  const at = 1700000000000;
  function err(over: Partial<TunnelStartError> = {}): TunnelStartError {
    return { message: '请先打开并登录 Tailscale，然后重新启动隧道', at, provider: 'tailscale', source: 'manual', ...over };
  }

  it('开机自启失败要说「当前未对外开放」——这是它和手动失败最大的区别', () => {
    expect(startErrorTitle(err({ source: 'boot' }))).toBe('开机自动建立隧道失败（当前未对外开放）');
    expect(startErrorTitle(err({ source: 'manual' }))).toBe('隧道启动失败');
  });

  it('视图带齐四件事：标题 / 建议 / 时间 / 直达落点', () => {
    const v = buildStartErrorView(err({ source: 'boot' }), at + 60000);
    expect(v.kind).toBe('tailscale_login');
    expect(v.advice).toContain('任务栏打开 Tailscale');
    expect(v.when).toBe('发生于 1 分钟前');
    expect(v.focus).toBe('login');
  });

  it('每种分类都有建议，且建议不为空（漏一种就会显示空白）', () => {
    const kinds = ['binary_download', 'funnel_auth', 'tailscale_install', 'tailscale_login', 'magicdns', 'bad_binary_path', 'authtoken_missing', 'provider_start', 'generic'] as const;
    for (const k of kinds) expect(adviceFor(k).length).toBeGreaterThan(6);
  });
});

describe('自检灯：三态各有说法，且不只靠颜色', () => {
  it('ok / fail / unknown → 已满足 / 未满足 / 待确认', () => {
    expect(prereqTone('ok')).toMatchObject({ type: 'success', label: '已满足' });
    expect(prereqTone('fail')).toMatchObject({ type: 'danger', label: '未满足' });
    expect(prereqTone('unknown')).toMatchObject({ type: 'warning', label: '待确认' });
    expect(prereqTone('unknown').ariaLabel).toContain('判断不了');
  });

  it('摘要给一句话结论，unknown 不算满足', () => {
    const items: TunnelPrereqItem[] = [
      { id: 'a', label: 'A', state: 'ok', detail: '', fix: '', focus: 'binary' },
      { id: 'b', label: 'B', state: 'fail', detail: '', fix: '', focus: 'login' },
      { id: 'c', label: 'C', state: 'unknown', detail: '', fix: '', focus: 'port' },
    ];
    expect(summarizePrereq(items)).toMatchObject({ ok: 1, fail: 1, unknown: 1, total: 3, allSatisfied: false });
    expect(summarizePrereq(items).headline).toBe('有 1 项没满足');
    expect(summarizePrereq([items[0], items[2]]).headline).toBe('有 1 项暂时判断不了');
    expect(summarizePrereq([items[0]]).headline).toBe('全部满足，可以直接启动');
    expect(summarizePrereq([]).headline).toBe('还没有检测过');
  });

  it('检测时间：刚刚 / 分钟 / 小时 / 超过一天给绝对时间（旧灯必须看得出是旧的）', () => {
    const now = 1700000000000;
    expect(formatCheckedAt(0, now)).toBe('尚未检测');
    expect(formatCheckedAt(now - 5000, now)).toBe('刚刚检测');
    expect(formatCheckedAt(now - 5 * 60000, now)).toBe('5 分钟前检测');
    expect(formatCheckedAt(now - 3 * 3600000, now)).toBe('3 小时前检测');
    expect(formatCheckedAt(now - 30 * 86400000, now)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} 检测$/);
  });

  it('失败时间不借用「检测」措辞（UI 实测抓到的原缺陷：启动失败旁写着「18 分钟前检测」）', () => {
    const now = 1700000000000;
    expect(formatErrorAgo(0, now)).toBe('时间未知');
    expect(formatErrorAgo(now - 5000, now)).toBe('刚刚发生');
    expect(formatErrorAgo(now - 18 * 60000, now)).toBe('发生于 18 分钟前');
    expect(formatErrorAgo(now - 3 * 3600000, now)).toBe('发生于 3 小时前');
    expect(formatErrorAgo(now - 30 * 86400000, now)).not.toContain('检测');
  });

  it('落点表：页面上没有控件的项（登录/MagicDNS/授权）不给「去处理」按钮', () => {
    expect(focusTarget('binary')).toEqual({ selector: '#tunnel-binary-path', label: '改二进制路径' });
    expect(focusTarget('port')?.selector).toBe('#tunnel-port');
    expect(focusTarget('authtoken')?.selector).toBe('#tunnel-authtoken');
    expect(focusTarget('wizard')?.selector).toBe('#tunnel-mode');
    expect(focusTarget('login')).toBeNull();
    expect(focusTarget('magicDns')).toBeNull();
    expect(focusTarget('funnelAuth')).toBeNull();
  });
});

// ===== 视图层 =====

function clearBody(): void {
  while (document.body.firstElementChild) document.body.firstElementChild.remove();
}

function json(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

interface Routes {
  status?: unknown;
  config?: unknown;
  prereq?: unknown;
  prereqStatus?: number;
}

function routeResponder(routes: Routes) {
  apiFetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
    const method = opts?.method ?? 'GET';
    if (url.endsWith('/tunnel/status') && method === 'GET') return Promise.resolve(json(routes.status ?? { status: 'stopped', publicUrl: null, provider: '' }));
    if (url.endsWith('/tunnel/config') && method === 'GET') {
      return Promise.resolve(json(routes.config ?? {
        provider: 'tailscale', localPort: 0, cpolarAuthtokenMasked: '', cpolarAuthtokenConfigured: false,
        binaryPath: '', autoStart: true, tunnelMode: 'quick', tunnelName: '', tunnelId: '',
        credentialsFile: '', hostname: '', certFileConfigured: false,
      }));
    }
    if (url.endsWith('/tunnel/prerequisites')) {
      return Promise.resolve(json(routes.prereq ?? { provider: 'tailscale', checkedAt: Date.now(), items: [], allSatisfied: false }, routes.prereqStatus ?? 200));
    }
    if (url.endsWith('/tunnel/start-error/clear')) {
      return Promise.resolve(json({ status: 'stopped', publicUrl: null, provider: 'tailscale', lastStartError: null }));
    }
    return Promise.resolve(json({ detail: 'unexpected url' }, 404));
  });
}

async function mountTunnel(routes: Routes) {
  routeResponder(routes);
  const wrapper = mount(Tunnel, { global: { plugins: [ElementPlus] }, attachTo: document.body });
  await flushPromises();
  await nextTickFlush();
  return wrapper;
}

async function nextTickFlush() {
  await flushPromises();
  await flushPromises();
}

function calls(urlSuffix: string, method = 'GET'): number {
  return apiFetchMock.mock.calls.filter(([u, o]: [string, { method?: string }?]) =>
    String(u).endsWith(urlSuffix) && (o?.method ?? 'GET') === method).length;
}

describe('Tunnel.vue 启动失败告警条（PRD §11 T1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBody();
  });

  it('开机自启失败：不点任何按钮，进页面就能看到原因 + 建议 + 三个动作', async () => {
    const wrapper = await mountTunnel({
      status: {
        status: 'stopped',
        publicUrl: null,
        provider: 'tailscale',
        lastStartError: {
          message: '请先打开并登录 Tailscale，然后重新启动隧道',
          at: Date.now() - 90000,
          provider: 'tailscale',
          source: 'boot',
        },
      },
    });
    const card = wrapper.find('#tunnel-start-error');
    expect(card.exists(), '告警条应常驻，而不是转瞬即逝的 toast').toBe(true);
    expect(card.text()).toContain('开机自动建立隧道失败（当前未对外开放）');
    expect(card.text()).toContain('请先打开并登录 Tailscale，然后重新启动隧道');
    expect(card.text()).toContain('任务栏打开 Tailscale');
    expect(card.text()).toContain('来自服务启动时的自动尝试');
    expect(card.find('[aria-label="查看前置条件"]').exists()).toBe(true);
    expect(card.find('[aria-label="重新启动"]').exists()).toBe(true);
    expect(card.find('[aria-label="知道了"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('点「知道了」→ 调清除接口 → 告警条收起', async () => {
    const wrapper = await mountTunnel({
      status: {
        status: 'stopped', publicUrl: null, provider: 'tailscale',
        lastStartError: { message: 'Tailscale 尚未启用 MagicDNS，无法生成固定 ts.net 地址', at: Date.now(), provider: 'tailscale', source: 'manual' },
      },
    });
    expect(wrapper.find('#tunnel-start-error').exists()).toBe(true);
    await wrapper.find('[aria-label="知道了"]').trigger('click');
    await nextTickFlush();
    expect(calls('/tunnel/start-error/clear', 'POST'), '必须真的通知后端，否则刷新又会亮').toBe(1);
    expect(wrapper.find('#tunnel-start-error').exists()).toBe(false);
    wrapper.unmount();
  });

  it('没有失败记录时不渲染空告警条', async () => {
    const wrapper = await mountTunnel({ status: { status: 'running', publicUrl: 'https://x.ts.net/wiki/', provider: 'tailscale', lastStartError: null } });
    expect(wrapper.find('#tunnel-start-error').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('Tunnel.vue 前置条件自检（PRD §11 T4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBody();
  });

  const threeStatePrereq = {
    provider: 'tailscale',
    checkedAt: Date.now() - 120000,
    allSatisfied: false,
    items: [
      { id: 'binary', label: 'Tailscale 客户端', state: 'ok', detail: '已找到：C:/Program Files/Tailscale/tailscale.exe', fix: '', focus: 'binary' },
      { id: 'login', label: '已登录 Tailscale 账号', state: 'fail', detail: '后台服务状态：NeedsLogin', fix: '在任务栏打开 Tailscale 图标并登录账号，然后回来点「重新检测」', focus: 'login' },
      { id: 'magicDns', label: '启用 MagicDNS', state: 'unknown', detail: '还查不到这台机器的域名', fix: '登录 Tailscale 后点「重新检测」', focus: 'magicDns', fixUrl: 'https://login.tailscale.com/admin/machines' },
    ] as TunnelPrereqItem[],
  };

  it('进页面自动检测一次，三态灯 + 事实 + 指引都渲染出来', async () => {
    const wrapper = await mountTunnel({ prereq: threeStatePrereq });
    expect(calls('/tunnel/prerequisites'), '自检应在挂载时静默跑一次，不用用户先点启动再猜').toBe(1);
    const card = wrapper.find('#tunnel-prereq-card');
    expect(card.text()).toContain('已满足');
    expect(card.text()).toContain('未满足');
    expect(card.text()).toContain('待确认');
    expect(card.text()).toContain('已找到：C:/Program Files/Tailscale/tailscale.exe');
    expect(card.text()).toContain('2 分钟前检测');
    // unknown 项的外部处理页给链接；只有「页面上真有控件」的项才给「去处理」
    // （login / magicDns 的处理都在 Tailscale 客户端与后台，页面上没有可点的东西）
    expect(card.find('.prereq-link').exists()).toBe(true);
    const gotos = card.findAll('.prereq-goto');
    expect(gotos).toHaveLength(1);
    expect(gotos[0].text()).toBe('改二进制路径');
    wrapper.unmount();
  });

  it('有落点的项才显示「去处理」，点击滚到配置卡片', async () => {
    const wrapper = await mountTunnel({
      prereq: { ...threeStatePrereq, items: [{ id: 'port', label: '本地服务端口', state: 'fail', detail: '8787 连不上', fix: '改端口', focus: 'port' }] },
    });
    const goto = wrapper.find('.prereq-goto');
    expect(goto.text()).toBe('改本地端口');
    await goto.trigger('click');
    await nextTickFlush();
    // happy-dom 不实现 scrollIntoView，方法里做了存在性判断；这里只要求「点了不炸」
    expect(wrapper.find('#tunnel-config-card').exists()).toBe(true);
    wrapper.unmount();
  });

  it('原来写死的 4 行 Tailscale 清单已下线，换成一句指路（同一要求不说两遍）', async () => {
    const wrapper = await mountTunnel({ prereq: threeStatePrereq });
    const text = wrapper.text();
    expect(text).not.toContain('1. 需预装 Tailscale');
    expect(text).not.toContain('4. 首次启动隧道时需在浏览器完成 Funnel 授权');
    expect(text).toContain('这几项是否已经满足，看上方「前置条件自检」的实测结果');
    wrapper.unmount();
  });

  it('Tailscale 也显示「程序路径」输入框——自检报了路径问题，页面上得能改', async () => {
    const wrapper = await mountTunnel({ prereq: threeStatePrereq });
    expect(wrapper.find('#tunnel-binary-path').exists()).toBe(true);
    expect(wrapper.text()).toContain('Tailscale 由你自己安装，本程序不会替你装');
    wrapper.unmount();
  });

  it('非管理员 403：说清是权限问题，不甩后端错误串、也不弹 toast 刷屏', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapper = await mountTunnel({ prereq: { detail: 'Forbidden' }, prereqStatus: 403 });
    const card = wrapper.find('#tunnel-prereq-card');
    expect(card.text()).toContain('需要管理员权限才能检测前置条件');
    expect(card.text()).not.toContain('Forbidden');
    spy.mockRestore();
    wrapper.unmount();
  });

  it('点「重新检测」再跑一次；切换服务商后旧灯要标注是谁的结果', async () => {
    const wrapper = await mountTunnel({
      config: {
        provider: 'tailscale', localPort: 0, cpolarAuthtokenMasked: '', cpolarAuthtokenConfigured: false, binaryPath: '',
        autoStart: false, tunnelMode: 'quick', tunnelName: '', tunnelId: '', credentialsFile: '', hostname: '', certFileConfigured: false,
      },
      prereq: threeStatePrereq,
    });
    await wrapper.find('[aria-label="重新检测"]').trigger('click');
    await nextTickFlush();
    expect(calls('/tunnel/prerequisites')).toBe(2);
    // 把下拉选择改成 cloudflare（已保存仍是 tailscale）→ 结果标成 tailscale 的，避免被当成新服务商的现状
    const vm = wrapper.vm as unknown as { formProvider: string };
    vm.formProvider = 'cloudflare';
    await nextTickFlush();
    const text = wrapper.find('#tunnel-prereq-card').text();
    expect(text).toContain('这是 Tailscale Funnel');
    expect(text).toContain('的结果');
    wrapper.unmount();
  });
});

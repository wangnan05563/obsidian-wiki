// 内网穿透前置条件自检单测（T02469 / PRD §11 T4）
// ------------------------------------------------------------------
// 为什么这样切：probeTailscaleFacts 要跑真实 tailscale CLI，本机大概率没装，
// 因此把「事实采集」与「结论生成」拆开——buildTailscaleItems / buildCloudflareItems /
// buildCpolarItems 是纯函数，用例喂不同事实组合即可覆盖全部三态分支；
// checkTunnelPrerequisites 用 PrereqIo 注入 exists/probeTailscale/probePort，不碰真实文件系统与网络。
// 另有一条真网络用例（probeLocalPort）：它是最容易「mock 通过后线上不成立」的一环，值得实测。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import {
  buildCloudflareItems,
  buildCpolarItems,
  buildTailscaleItems,
  checkTunnelPrerequisites,
  probeLocalPort,
  readFunnelAllowed,
  type TailscaleFacts,
} from '../src/tunnel/tunnel-prerequisites.js';
import type { TunnelConfig } from '../src/types.js';

function baseTunnelConfig(overrides?: Partial<TunnelConfig>): TunnelConfig {
  return {
    provider: 'cloudflare',
    localPort: 0,
    cpolarAuthtoken: '',
    binaryPath: '',
    autoStart: false,
    tunnelMode: 'quick',
    tunnelName: '',
    tunnelId: '',
    credentialsFile: '',
    hostname: '',
    certFile: '',
    pathPrefix: '/wiki/',
    ...overrides,
  };
}

function baseFacts(overrides?: Partial<TailscaleFacts>): TailscaleFacts {
  return {
    configuredPath: '',
    detectedBinary: null,
    configuredPathMissing: false,
    backendState: null,
    dnsName: '',
    funnelAllowed: null,
    probeError: '',
    ...overrides,
  };
}

function itemById(items: ReturnType<typeof buildTailscaleItems>, id: string) {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`缺少自检项：${id}`);
  return found;
}

describe('buildTailscaleItems（四盏灯 + 三态）', () => {
  it('未安装客户端：二进制 fail，其余一律 unknown（不假装知道）', () => {
    const items = buildTailscaleItems(baseFacts());
    expect(items).toHaveLength(4);
    expect(itemById(items, 'binary').state).toBe('fail');
    expect(itemById(items, 'binary').fixUrl).toContain('tailscale.com/download');
    expect(itemById(items, 'login').state).toBe('unknown');
    expect(itemById(items, 'magicDns').state).toBe('unknown');
    expect(itemById(items, 'funnelAuth').state).toBe('unknown');
  });

  it('配置路径填了但文件已不存在：与「没装」区分开，指引也不同', () => {
    const items = buildTailscaleItems(
      baseFacts({ configuredPath: 'D:/gone/tailscale.exe', configuredPathMissing: true }),
    );
    const binary = itemById(items, 'binary');
    expect(binary.state).toBe('fail');
    expect(binary.detail).toContain('已经不存在');
    expect(binary.detail).toContain('D:/gone/tailscale.exe');
    expect(binary.fix).toContain('清空该路径');
    // 路径写错 ≠ 没装：此时不该再甩下载地址误导用户
    expect(binary.fixUrl).toBeUndefined();
  });

  it('全部满足：四项皆 ok 且给出「凭什么说满足」的事实', () => {
    const items = buildTailscaleItems(
      baseFacts({
        detectedBinary: 'C:/Program Files/Tailscale/tailscale.exe',
        backendState: 'Running',
        dnsName: 'host.tailnet-name.ts.net',
        funnelAllowed: true,
      }),
    );
    expect(items.every((i) => i.state === 'ok')).toBe(true);
    expect(itemById(items, 'binary').detail).toContain('tailscale.exe');
    expect(itemById(items, 'magicDns').detail).toContain('.ts.net');
    // ok 项不需要 fix 文案
    expect(itemById(items, 'login').fix).toBe('');
  });

  it('客户端在但没登录：login fail，MagicDNS 仍 unknown（不是 fail）', () => {
    const items = buildTailscaleItems(
      baseFacts({ detectedBinary: 'C:/Tailscale/tailscale.exe', backendState: 'NeedsLogin' }),
    );
    expect(itemById(items, 'login').state).toBe('fail');
    expect(itemById(items, 'login').detail).toContain('NeedsLogin');
    expect(itemById(items, 'magicDns').state).toBe('unknown');
    expect(itemById(items, 'funnelAuth').state).toBe('unknown');
  });

  it('已登录但域名不是 ts.net：MagicDNS fail 并给管理后台链接', () => {
    const items = buildTailscaleItems(
      baseFacts({
        detectedBinary: 'C:/Tailscale/tailscale.exe',
        backendState: 'Running',
        dnsName: 'office.example.com',
      }),
    );
    const md = itemById(items, 'magicDns');
    expect(md.state).toBe('fail');
    expect(md.detail).toContain('office.example.com');
    expect(md.fixUrl).toContain('login.tailscale.com/admin');
  });

  it('Funnel 明确未开启：fail + 「点启动隧道会引导授权」，而不是 unknown', () => {
    const items = buildTailscaleItems(
      baseFacts({
        detectedBinary: 'C:/Tailscale/tailscale.exe',
        backendState: 'Running',
        dnsName: 'host.ts.net',
        funnelAllowed: false,
      }),
    );
    const fa = itemById(items, 'funnelAuth');
    expect(fa.state).toBe('fail');
    expect(fa.fix).toContain('启动隧道');
  });

  it('CLI 探测失败（超时/未登录）：如实带出原因，降级 unknown 而非报错', () => {
    const items = buildTailscaleItems(
      baseFacts({ detectedBinary: 'C:/Tailscale/tailscale.exe', probeError: 'Command timed out' }),
    );
    expect(itemById(items, 'login').state).toBe('unknown');
    expect(itemById(items, 'login').detail).toContain('Command timed out');
  });
});

describe('buildCloudflareItems / buildCpolarItems', () => {
  const exists = (p: string) => p.includes('exists');

  it('quick 模式：只有两条，且不要求任何账号凭证', () => {
    const items = buildCloudflareItems(baseTunnelConfig(), exists);
    expect(items.map((i) => i.id)).toEqual(['binary', 'wizard']);
    expect(items[1].state).toBe('ok');
  });

  it('quick 模式且二进制未下载：unknown（会自动下载），不是 fail', () => {
    const items = buildCloudflareItems(baseTunnelConfig(), () => false);
    expect(items[0].state).toBe('unknown');
    expect(items[0].detail).toContain('自动下载');
  });

  it('named 模式：证书/隧道/DNS 三项按配置实况判定', () => {
    const items = buildCloudflareItems(
      baseTunnelConfig({ tunnelMode: 'named', certFile: '/p/exists/cert.pem', tunnelId: 'tid', credentialsFile: '/p/exists/creds.json', hostname: 'wiki.example.com' }),
      exists,
    );
    expect(items.map((i) => i.id)).toEqual(['binary', 'cert', 'tunnel', 'dns']);
    expect(items.find((i) => i.id === 'cert')!.state).toBe('ok');
    expect(items.find((i) => i.id === 'tunnel')!.detail).toContain('wiki.example.com');
    // DNS 是否真正生效无法本机判断 → unknown
    expect(items.find((i) => i.id === 'dns')!.state).toBe('unknown');
  });

  it('named 模式但完全没配：三项 fail 且都指向同一个「三步向导」落点', () => {
    const items = buildCloudflareItems(baseTunnelConfig({ tunnelMode: 'named' }), () => false);
    const wizardItems = items.filter((i) => i.focus === 'wizard');
    expect(wizardItems).toHaveLength(3);
    expect(wizardItems.every((i) => i.state === 'fail')).toBe(true);
  });

  it('cpolar：authtoken 缺失是 fail（不是 unknown），二进制缺失是 unknown', () => {
    const items = buildCpolarItems(baseTunnelConfig(), () => false);
    expect(items.find((i) => i.id === 'authtoken')!.state).toBe('fail');
    expect(items.find((i) => i.id === 'binary')!.state).toBe('unknown');
    const ok = buildCpolarItems(baseTunnelConfig({ cpolarAuthtoken: 'tok' }), (p) => p.includes('cpolar.exe'));
    expect(ok.find((i) => i.id === 'authtoken')!.state).toBe('ok');
  });
});

describe('checkTunnelPrerequisites（provider 分派 + 端口项 + allSatisfied）', () => {
  const savedTunnelPort = process.env.TUNNEL_PORT;
  beforeEach(() => {
    delete process.env.TUNNEL_PORT;
  });
  afterEach(() => {
    if (savedTunnelPort !== undefined) process.env.TUNNEL_PORT = savedTunnelPort;
  });

  it('按 provider 分派到对应清单，并在末尾追加本地端口检查', async () => {
    const result = await checkTunnelPrerequisites(
      baseTunnelConfig({ provider: 'cloudflare' }),
      { exists: () => true, probePort: async () => true, serverPort: 8787, now: () => 1700000000000 },
    );
    expect(result.provider).toBe('cloudflare');
    expect(result.checkedAt).toBe(1700000000000);
    expect(result.items[result.items.length - 1].id).toBe('port');
    expect(result.items[result.items.length - 1].state).toBe('ok');
    expect(result.allSatisfied).toBe(true);
  });

  it('unknown 不算满足：allSatisfied 必须 false（否则「重新检测」永远没意义）', async () => {
    const result = await checkTunnelPrerequisites(
      baseTunnelConfig({ provider: 'cpolar', cpolarAuthtoken: 'tok' }),
      { exists: () => false, probePort: async () => true, serverPort: 8787 },
    );
    expect(result.items.some((i) => i.state === 'unknown')).toBe(true);
    expect(result.allSatisfied).toBe(false);
  });

  it('端口连不上：即使其他项全 ok 也要 fail（隧道指向死端口是最隐蔽的故障）', async () => {
    const result = await checkTunnelPrerequisites(
      baseTunnelConfig({ provider: 'cpolar', cpolarAuthtoken: 'tok' }),
      { exists: () => true, probePort: async () => false, serverPort: 8787 },
    );
    const port = result.items.find((i) => i.id === 'port')!;
    expect(port.state).toBe('fail');
    expect(port.detail).toContain('8787');
    expect(port.fix).toContain('本地端口');
    expect(result.allSatisfied).toBe(false);
  });

  it('localPort 优先于 serverPort（与 TunnelService.resolvePort 同口径）', async () => {
    const probed: number[] = [];
    await checkTunnelPrerequisites(baseTunnelConfig({ localPort: 9000 }), {
      exists: () => true,
      probePort: async (p) => {
        probed.push(p);
        return true;
      },
      serverPort: 8787,
    });
    expect(probed).toEqual([9000]);
  });

  it('TUNNEL_PORT 环境变量最高优先（同样复用 resolvePort，避免两处口径漂移）', async () => {
    process.env.TUNNEL_PORT = '9111';
    const probed: number[] = [];
    await checkTunnelPrerequisites(baseTunnelConfig({ localPort: 9000 }), {
      exists: () => true,
      probePort: async (p) => {
        probed.push(p);
        return true;
      },
      serverPort: 8787,
    });
    expect(probed).toEqual([9111]);
  });

  it('未传 serverPort 且 localPort=0：不硬凑一条「端口 0 无效」的假问题', async () => {
    const result = await checkTunnelPrerequisites(baseTunnelConfig(), {
      exists: () => true,
      probePort: async () => false,
    });
    expect(result.items.some((i) => i.id === 'port')).toBe(false);
  });

  it('tailscale provider 走注入的事实采集，不碰真实 CLI', async () => {
    const result = await checkTunnelPrerequisites(baseTunnelConfig({ provider: 'tailscale' }), {
      probeTailscale: async () => baseFacts({ detectedBinary: 'x', backendState: 'Running', dnsName: 'a.ts.net', funnelAllowed: true }),
      probePort: async () => true,
      serverPort: 8787,
      exists: () => true,
    });
    expect(result.items.map((i) => i.id)).toEqual(['binary', 'login', 'magicDns', 'funnelAuth', 'port']);
    expect(result.allSatisfied).toBe(true);
  });
});

describe('probeLocalPort（真实网络冒烟）', () => {
  let server: net.Server | null = null;
  let openPort = 0;

  beforeAll(async () => {
    server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    openPort = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('监听中的端口 → true', async () => {
    expect(await probeLocalPort(openPort, 1500)).toBe(true);
  });

  it('非法端口号 → false（不发 socket）', async () => {
    expect(await probeLocalPort(0)).toBe(false);
    expect(await probeLocalPort(70000)).toBe(false);
    expect(await probeLocalPort(1.5)).toBe(false);
  });

  it('关闭后的端口 → false（超时/拒连都算不通）', async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    expect(await probeLocalPort(openPort, 1500)).toBe(false);
  });
});

// Phase B 真机实测抓到的假红灯：隧道明明在跑（公网 URL 可访问），Funnel 灯却报「未满足」。
// 原因是 CLI 的 AllowFunnel 键带 `:443` 端口后缀，裸域名查表必然 miss。这里把真实返回形状钉住。
describe('readFunnelAllowed：按 CLI 真实键形状判定（T02469 Phase B 回归）', () => {
  const realMap = { 'desktop-g10o4nl.tailbca47.ts.net:443': true };

  it('键带 :443 后缀也要认——这正是假红灯的成因', () => {
    expect(readFunnelAllowed(realMap, 'desktop-g10o4nl.tailbca47.ts.net')).toBe(true);
  });

  it('大小写与尾点不影响判定', () => {
    expect(readFunnelAllowed(realMap, 'DESKTOP-G10O4NL.tailbca47.ts.net.')).toBe(true);
  });

  it('显式 false 就是没开', () => {
    expect(readFunnelAllowed({ 'host.ts.net:443': false }, 'host.ts.net')).toBe(false);
  });

  it('表里只有别的主机 → 这台确实没开（false，不是判断不了）', () => {
    expect(readFunnelAllowed({ 'other-host.ts.net:443': true }, 'host.ts.net')).toBe(false);
  });

  it('空表 → null（判断不了，灯应「待确认」而不是「未满足」）', () => {
    expect(readFunnelAllowed({}, 'host.ts.net')).toBeNull();
  });
});

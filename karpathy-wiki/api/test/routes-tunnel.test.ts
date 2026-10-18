// 内网穿透路由层测试（T02469 新增用例 / 手法与 routes-config.test.ts 一致）
// ------------------------------------------------------------------
// Fastify + inject，不 listen。三处 mock：
//   ../src/config.js        → loadConfig/getConfigPath，防止测试写进真实 config.json；
//   ../src/tunnel/tunnel-prerequisites.js → 自检模块自身有单测，这里只验「路由如何调用它」；
//   TunnelService           → 用结构化 stub（cast）替代，因为真例会 spawn 外部进程。
// 断言重点是 T02469 新增的三件事：status 带 lastStartError、start 传 source='manual'、
// 以及两个新端点（prerequisites / start-error/clear）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerTunnelRoute } from '../src/routes/tunnel.js';
import {
  BinaryDownloadError,
  TailscaleFunnelAuthError,
  type TunnelService,
  type TunnelStartError,
} from '../src/tunnel/tunnel-service.js';
import type { AppConfig } from '../src/types.js';

const { loadConfigMock, getConfigPathMock, checkPrereqMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  getConfigPathMock: vi.fn(),
  checkPrereqMock: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
    getConfigPath: getConfigPathMock,
  };
});

vi.mock('../src/tunnel/tunnel-prerequisites.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tunnel/tunnel-prerequisites.js')>();
  return { ...actual, checkTunnelPrerequisites: checkPrereqMock };
});

function baseAppConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    vaultPath: 'C:/tmp/vault',
    adapter: 'harness',
    llm: { provider: 'glm', baseUrl: 'https://example.test/v4', model: 'glm-4-plus', apiKeyRef: 'CFG_TEST_KEY_REF' },
    budget: { maxSteps: 20, tokenBudget: 50000 },
    server: { port: 8787 },
    tunnel: {
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
    },
    ...overrides,
  } as AppConfig;
}

// TunnelService stub：只实现路由真正读写的成员，其余留给 cast 兜住
function makeTunnelStub() {
  return {
    status: 'stopped' as TunnelService['status'],
    publicUrl: null as string | null,
    providerName: null as string | null,
    startError: null as TunnelStartError | null,
    start: vi.fn(async (_config: unknown, _port: number, _opts?: { source?: 'boot' | 'manual' }) => {}),
    stop: vi.fn(),
    clearStartError: vi.fn(),
  };
}

type Stub = ReturnType<typeof makeTunnelStub>;

async function buildApp(stub: Stub): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // 不传 guards：走默认 createIsolationGuards()（auth 未启用 → 放行），与单租户部署形态一致
  registerTunnelRoute(app, stub as unknown as TunnelService);
  return app;
}

// 让 stub 的 getter 语义与真实类一致：startError 由 clearStartError 归零
function wireStartError(stub: Stub): void {
  stub.clearStartError.mockImplementation(() => {
    stub.startError = null;
  });
}

describe('/api/tunnel/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockResolvedValue(baseAppConfig());
    getConfigPathMock.mockReturnValue('C:/tmp/tunnel-test-config.json');
  });

  it('带出 lastStartError —— 开机自启失败后刷新页面仍然看得见', async () => {
    const stub = makeTunnelStub();
    stub.status = 'stopped';
    stub.startError = {
      message: '请先打开并登录 Tailscale，然后重新启动隧道',
      at: 1700000000000,
      provider: 'tailscale',
      source: 'boot',
    };
    const app = await buildApp(stub);
    const res = await app.inject({ method: 'GET', url: '/api/tunnel/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'stopped',
      publicUrl: null,
      provider: null,
      lastStartError: {
        message: '请先打开并登录 Tailscale，然后重新启动隧道',
        at: 1700000000000,
        provider: 'tailscale',
        source: 'boot',
      },
    });
    await app.close();
  });
});

describe('POST /api/tunnel/start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockResolvedValue(baseAppConfig());
    getConfigPathMock.mockReturnValue('C:/tmp/tunnel-test-config.json');
  });

  it('手动启动以 source=manual 记账，成功后返回含 lastStartError:null 的状态', async () => {
    const stub = makeTunnelStub();
    stub.start.mockImplementation(async (_config: unknown, _port: number, opts?: { source?: string }) => {
      expect(opts).toEqual({ source: 'manual' });
      stub.status = 'running';
      stub.publicUrl = 'https://demo.trycloudflare.com';
      stub.providerName = 'cloudflare';
    });
    const app = await buildApp(stub);
    const res = await app.inject({ method: 'POST', url: '/api/tunnel/start' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'running',
      publicUrl: 'https://demo.trycloudflare.com',
      provider: 'cloudflare',
      lastStartError: null,
    });
    // 端口取自 config.server.port，不是硬编码
    expect(stub.start.mock.calls[0][1]).toBe(8787);
    await app.close();
  });

  it('二进制下载失败：结构化 errorType + 手动路径 + 下载链接 + 失败已记账', async () => {
    const stub = makeTunnelStub();
    stub.start.mockRejectedValue(new BinaryDownloadError('下载失败', 'D:/data/cloudflared.exe', ['https://mirror.test/a']));
    const app = await buildApp(stub);
    const res = await app.inject({ method: 'POST', url: '/api/tunnel/start' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.errorType).toBe('binary_download_failed');
    expect(body.manualPath).toBe('D:/data/cloudflared.exe');
    expect(body.downloadUrls).toEqual(['https://mirror.test/a']);
    expect(body.lastStartError).toBeNull();
    await app.close();
  });

  it('Tailscale Funnel 首次授权：返回 authUrl 供前端渲染授权向导', async () => {
    const stub = makeTunnelStub();
    stub.start.mockRejectedValue(new TailscaleFunnelAuthError('需要授权', 'https://login.tailscale.com/funnel'));
    const app = await buildApp(stub);
    const res = await app.inject({ method: 'POST', url: '/api/tunnel/start' });
    expect(res.statusCode).toBe(500);
    expect(res.json().errorType).toBe('tailscale_funnel_auth');
    expect(res.json().authUrl).toBe('https://login.tailscale.com/funnel');
    await app.close();
  });

  it('普通失败：detail 带原因（前端不再只有一条转瞬即逝的 toast）', async () => {
    const stub = makeTunnelStub();
    stub.start.mockRejectedValue(new Error('请先打开并登录 Tailscale'));
    stub.startError = { message: '请先打开并登录 Tailscale', at: 1700000000000, provider: 'tailscale', source: 'manual' };
    const app = await buildApp(stub);
    const res = await app.inject({ method: 'POST', url: '/api/tunnel/start' });
    expect(res.statusCode).toBe(500);
    expect(res.json().detail).toBe('隧道启动失败: 请先打开并登录 Tailscale');
    expect(res.json().lastStartError.source).toBe('manual');
    await app.close();
  });
});

describe('POST /api/tunnel/stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockResolvedValue(baseAppConfig());
  });

  it('停止后返回同一份状态字段（含 lastStartError）', async () => {
    const stub = makeTunnelStub();
    stub.status = 'running';
    stub.providerName = 'cloudflare';
    const app = await buildApp(stub);
    const res = await app.inject({ method: 'POST', url: '/api/tunnel/stop' });
    expect(res.statusCode).toBe(200);
    expect(stub.stop).toHaveBeenCalledTimes(1);
    expect(res.json().provider).toBe('cloudflare');
    expect(res.json()).toHaveProperty('lastStartError');
    await app.close();
  });
});

describe('GET /api/tunnel/prerequisites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockResolvedValue(baseAppConfig());
    getConfigPathMock.mockReturnValue('C:/tmp/tunnel-test-config.json');
  });

  it('用已保存配置 + 真实服务端口调用自检', async () => {
    checkPrereqMock.mockResolvedValue({
      provider: 'cloudflare',
      checkedAt: 1700000000000,
      items: [],
      allSatisfied: true,
    });
    const app = await buildApp(makeTunnelStub());
    const res = await app.inject({ method: 'GET', url: '/api/tunnel/prerequisites' });
    expect(res.statusCode).toBe(200);
    expect(checkPrereqMock).toHaveBeenCalledWith(expect.objectContaining({ provider: 'cloudflare' }), {
      serverPort: 8787,
    });
    expect(res.json().allSatisfied).toBe(true);
    await app.close();
  });

  it('自检本身抛错 → 500 + detail，而不是让前端拿到半截 JSON', async () => {
    checkPrereqMock.mockRejectedValue(new Error('读配置失败'));
    const app = await buildApp(makeTunnelStub());
    const res = await app.inject({ method: 'GET', url: '/api/tunnel/prerequisites' });
    expect(res.statusCode).toBe(500);
    expect(res.json().detail).toBe('前置条件自检失败: 读配置失败');
    await app.close();
  });
});

describe('POST /api/tunnel/start-error/clear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockResolvedValue(baseAppConfig());
  });

  it('点「知道了」后清除失败记录并回最新状态', async () => {
    const stub = makeTunnelStub();
    wireStartError(stub);
    stub.startError = { message: '启动失败', at: 1700000000000, provider: 'tailscale', source: 'boot' };
    const app = await buildApp(stub);
    const res = await app.inject({ method: 'POST', url: '/api/tunnel/start-error/clear' });
    expect(res.statusCode).toBe(200);
    expect(stub.clearStartError).toHaveBeenCalledTimes(1);
    expect(res.json().lastStartError).toBeNull();
    await app.close();
  });
});

describe('GET /api/tunnel/config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockResolvedValue(baseAppConfig());
    getConfigPathMock.mockReturnValue('C:/tmp/tunnel-test-config.json');
  });

  it('authtoken 只回末 4 位，不回明文（本次改动不得回归这条既有约定）', async () => {
    loadConfigMock.mockResolvedValue(
      baseAppConfig({ tunnel: { ...baseAppConfig().tunnel, cpolarAuthtoken: 'abcdef1234' } }),
    );
    const app = await buildApp(makeTunnelStub());
    const res = await app.inject({ method: 'GET', url: '/api/tunnel/config' });
    expect(res.json().cpolarAuthtokenMasked).toBe('??????1234');
    expect(res.json().cpolarAuthtokenConfigured).toBe(true);
    expect(JSON.stringify(res.json())).not.toContain('abcdef1234');
    await app.close();
  });
});

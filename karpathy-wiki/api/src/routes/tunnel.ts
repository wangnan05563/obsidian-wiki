import type { FastifyInstance } from 'fastify';
import fsp from 'node:fs/promises';
import { loadConfig, getConfigPath } from '../config.js';
import {
  TunnelService,
  BinaryDownloadError,
  TailscaleFunnelAuthError,
  CloudflareLoginService,
} from '../tunnel/tunnel-service.js';
import type { TunnelConfig } from '../types.js';
import { checkTunnelPrerequisites } from '../tunnel/tunnel-prerequisites.js';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';

// 内网穿透路由（参考 17_xianyu api_tunnel.py，适配 Fastify）。
//   GET  /api/tunnel/status                    查询运行状态（含 lastStartError，T02469）
//   POST /api/tunnel/start                     启动隧道
//   POST /api/tunnel/stop                      停止隧道
//   GET  /api/tunnel/prerequisites             前置条件自检（只读，T02469 / PRD §11 T4）
//   POST /api/tunnel/start-error/clear         清除失败告警（T02469 / PRD §11 T1）
//   GET  /api/tunnel/config                    读取配置（authtoken 脱敏）
//   POST /api/tunnel/config                    保存配置
//   POST /api/tunnel/cloudflare/login          启动 login 子进程（非阻塞）
//   GET  /api/tunnel/cloudflare/login/status   轮询 login 状态
//   POST /api/tunnel/cloudflare/create         创建命名隧道
//   POST /api/tunnel/cloudflare/route-dns      配置 DNS CNAME
// 本项目无认证中间件，故免认证指后续接入认证时需白名单 status/start/stop 端点。

// 全局 loginService 单例：login 两阶段流程要求 start 和 status 在同一实例上调用，
// 因为 loginProcess / loginOutput / loginAuthUrl 状态保存在实例上。
let loginService: CloudflareLoginService | null = null;
function getLoginService(): CloudflareLoginService {
  loginService ??= new CloudflareLoginService();
  return loginService;
}

export function registerTunnelRoute(app: FastifyInstance, tunnel: TunnelService, guards: IsolationGuards = createIsolationGuards()) {
  app.get('/api/tunnel/status', async (_request, reply) => {
    return void reply.send(buildStatusPayload(tunnel));
  });

  // T02469（PRD §11 T4）：前置条件只读自检。拆成独立端点而非塞进 status，理由有两条：
  //   1. status 被前端 3s 轮询，自检要跑 CLI 探测（Tailscale 二进制/服务状态），不能进热路径；
  //   2. 自检是「按需点「重新检测」才跑」的交互，语义与轮询状态不同。
  // 该端点永不抛错：探测失败降级为 state='unknown'，保证前端拿到的永远是可渲染的清单。
  app.get('/api/tunnel/prerequisites', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    try {
      const config = await loadConfig();
      return void reply.send(await checkTunnelPrerequisites(config.tunnel, { serverPort: config.server.port }));
    } catch (err) {
      return void reply.code(500).send({
        detail: `前置条件自检失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // T02469（PRD §11 T1）：告警条「知道了」→ 清除 lastStartError，避免用户已处理后仍反复提示。
  app.post('/api/tunnel/start-error/clear', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    tunnel.clearStartError();
    return void reply.send(buildStatusPayload(tunnel));
  });

  app.post('/api/tunnel/start', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    try {
      // 从 config.json 读取 tunnel 配置和 server.port，路由自包含无需额外参数
      const config = await loadConfig();
      await tunnel.start(config.tunnel, config.server.port, { source: 'manual' });
      return void reply.send(buildStatusPayload(tunnel));
    } catch (err) {
      // 二进制下载失败：返回结构化指引，前端渲染手动下载链接
      if (err instanceof BinaryDownloadError) {
        return void reply.code(500).send({
          detail: err.message,
          errorType: 'binary_download_failed',
          manualPath: err.manualPath,
          downloadUrls: err.downloadUrls,
          lastStartError: tunnel.startError,
        });
      }
      // Tailscale Funnel 首次授权：返回授权链接，前端渲染授权向导
      if (err instanceof TailscaleFunnelAuthError) {
        return void reply.code(500).send({
          detail: err.message,
          errorType: 'tailscale_funnel_auth',
          authUrl: err.authUrl,
          lastStartError: tunnel.startError,
        });
      }
      return void reply.code(500).send({
        detail: `隧道启动失败: ${err instanceof Error ? err.message : String(err)}`,
        lastStartError: tunnel.startError,
      });
    }
  });

  app.post('/api/tunnel/stop', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    tunnel.stop();
    return void reply.send(buildStatusPayload(tunnel));
  });

  app.get('/api/tunnel/config', async (_request, reply) => {
    const config = await loadConfig();
    const t = config.tunnel;
    // authtoken 脱敏：仅返回末 4 位 + 是否已配置，避免明文回显
    return void reply.send({
      provider: t.provider,
      localPort: t.localPort,
      // T02912：界面「自动」复选框要显示实际继承哪个端口（localPort=0 仍是存储哨兵，语义不变）
      serverPort: config.server.port,
      cpolarAuthtokenMasked: maskToken(t.cpolarAuthtoken),
      cpolarAuthtokenConfigured: Boolean(t.cpolarAuthtoken),
      binaryPath: t.binaryPath,
      autoStart: t.autoStart,
      // Named Tunnel 字段：cert_file 只返回是否已配置（不回显路径，含敏感凭证）
      tunnelMode: t.tunnelMode,
      tunnelName: t.tunnelName,
      tunnelId: t.tunnelId,
      credentialsFile: t.credentialsFile,
      hostname: t.hostname,
      certFileConfigured: Boolean(t.certFile),
    });
  });

  app.post('/api/tunnel/config', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = request.body as Partial<TunnelConfig> | null;
    if (!body) {
      return void reply.code(400).send({ detail: '请求体为空' });
    }
    // 基本校验：provider 必须是支持的类型
    if (body.provider && body.provider !== 'cloudflare' && body.provider !== 'cpolar' && body.provider !== 'tailscale') {
      return void reply.code(400).send({ detail: `不支持的 provider: ${body.provider}` });
    }
    try {
      await saveTunnelConfig(body);
      return void reply.send({ ok: true, message: '配置已保存，下次启动隧道时生效' });
    } catch (err) {
      return void reply.code(500).send({
        detail: `配置保存失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // ===== Cloudflare Named Tunnel 向导端点 =====

  // 启动 cloudflared tunnel login（非阻塞），10s 内提取授权 URL
  app.post('/api/tunnel/cloudflare/login', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    const config = await loadConfig();
    const svc = getLoginService();
    try {
      const result = await svc.startLogin(config.tunnel.binaryPath);
      // failed 时清理 loginService 允许重试；waiting 时保留供 status 轮询
      if (result.status === 'failed') {
        loginService = null;
      }
      return void reply.send(result);
    } catch (err) {
      loginService = null;
      return void reply.code(500).send({
        detail: `login 启动失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // 轮询 login 状态：前端每 2-3s 调用一次，直到 success 或 failed
  app.get('/api/tunnel/cloudflare/login/status', async (_request, reply) => {
    const svc = getLoginService();
    const result = svc.checkLoginStatus();
    // success 时持久化 certFile 路径并清理 loginService
    if (result.status === 'success' && result.certFile) {
      await saveTunnelField('certFile', result.certFile);
      loginService = null;
    } else if (result.status === 'failed') {
      loginService = null;
    }
    return void reply.send(result);
  });

  // 创建命名隧道：cloudflared tunnel create <name>
  app.post('/api/tunnel/cloudflare/create', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = request.body as { tunnelName?: string; certFile?: string } | null;
    if (!body?.tunnelName?.trim()) {
      return void reply.code(400).send({ detail: '请输入隧道名称' });
    }
    const config = await loadConfig();
    // 请求体 certFile 优先于配置中的 certFile
    const certFile = body.certFile || config.tunnel.certFile;
    if (!certFile) {
      return void reply.code(400).send({ detail: '请先执行 login 步骤获取 cert.pem' });
    }
    const svc = getLoginService();
    try {
      const result = await svc.createTunnel(body.tunnelName.trim(), certFile, config.tunnel.binaryPath);
      // 持久化 tunnel_id + credentials_file + tunnel_name（增量写入，保留其他字段）
      await saveTunnelField('tunnelId', result.tunnelId);
      await saveTunnelField('credentialsFile', result.credentialsFile);
      await saveTunnelField('tunnelName', result.tunnelName);
      return void reply.send({
        ok: true,
        tunnelId: result.tunnelId,
        credentialsFile: result.credentialsFile,
        tunnelName: result.tunnelName,
        message: '隧道创建成功，可以继续配置 DNS 路由',
      });
    } catch (err) {
      return void reply.code(500).send({
        detail: `创建隧道失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // 配置 DNS CNAME：cloudflared tunnel route dns <name> <hostname>
  app.post('/api/tunnel/cloudflare/route-dns', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = request.body as { hostname?: string; certFile?: string } | null;
    if (!body?.hostname?.trim()) {
      return void reply.code(400).send({ detail: '请输入固定域名' });
    }
    const config = await loadConfig();
    const certFile = body.certFile || config.tunnel.certFile;
    if (!certFile) {
      return void reply.code(400).send({ detail: '请先执行 login 步骤获取 cert.pem' });
    }
    const svc = getLoginService();
    // 优先用 tunnelName，回退到 tunnelId（兼容 cloudflared 不同版本）
    const tunnelNameOrId = config.tunnel.tunnelName || config.tunnel.tunnelId;
    if (!tunnelNameOrId) {
      return void reply.code(400).send({ detail: '请先执行创建隧道步骤' });
    }
    try {
      const publicUrl = await svc.routeDns(tunnelNameOrId, body.hostname.trim(), certFile, config.tunnel.binaryPath);
      // 持久化 hostname + 自动切换到 named 模式
      await saveTunnelField('hostname', body.hostname.trim());
      await saveTunnelField('tunnelMode', 'named');
      return void reply.send({
        ok: true,
        publicUrl,
        message: 'DNS 路由配置成功，已自动切换到固定域名模式',
      });
    } catch (err) {
      return void reply.code(500).send({
        detail: `DNS 路由配置失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // 删除命名隧道（T02913，PRD R-F4 第 4 条另一半）：named 字段此前「只进不出」，
  // 绑定 hostname 后界面没有任何手段解除，只能去 CLI 手工删。守卫顺序：先本地状态
  // 后远端资源；远端删除成功才清本地字段，避免「远端还在、本地已清」的漂移。
  app.post('/api/tunnel/named/delete', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    const config = await loadConfig();
    const t = config.tunnel;
    if (t.tunnelMode !== 'named' && !t.hostname && !t.tunnelName && !t.tunnelId && !t.credentialsFile) {
      return void reply.code(400).send({ detail: '当前没有已配置的固定域名（Named）隧道，无需删除' });
    }
    if (tunnel.status === 'running') {
      return void reply.code(400).send({ detail: '隧道正在运行，请先停止再删除' });
    }
    const nameOrId = t.tunnelName || t.tunnelId;
    if (nameOrId) {
      if (!t.certFile) {
        return void reply.code(400).send({
          detail: '缺少 cert.pem 登录凭证，无法删除 Cloudflare 侧隧道资源；请重新执行 login 步骤后再删除',
        });
      }
      const svc = getLoginService();
      try {
        await svc.deleteTunnel(nameOrId, t.certFile, t.binaryPath);
      } catch (err) {
        return void reply.code(500).send({
          detail: `删除隧道失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    await saveTunnelField('tunnelMode', 'quick');
    await saveTunnelField('hostname', '');
    await saveTunnelField('tunnelName', '');
    await saveTunnelField('tunnelId', '');
    await saveTunnelField('credentialsFile', '');
    return void reply.send({
      ok: true,
      message: nameOrId
        ? '隧道已删除，本地已切回快速模式。DNS 的 CNAME 记录 cloudflared 删不了，请到 Cloudflare 控制台 DNS 页手工删除；已分享出去的固定域名链接会失效'
        : '本地固定域名配置已清除，切回快速模式（Cloudflare 侧未发现可删除的隧道资源）',
    });
  });
}

// T02469：状态响应统一由 buildStatusPayload 构造，status/start/stop/clear 四处共享同一份字段，
// 避免前端轮询时字段漂移。lastStartError 让「启动失败」常驻可见——原先只有 start 的即时
// 响应里有，页面刷新/开机自启失败即彻底静默（PRD §11 T1 的根因）。
interface TunnelStatusView {
  readonly status: TunnelService['status'];
  readonly publicUrl: TunnelService['publicUrl'];
  readonly providerName: TunnelService['providerName'];
  readonly startError: TunnelService['startError'];
}
function buildStatusPayload(tunnel: TunnelStatusView) {
  return {
    status: tunnel.status,
    publicUrl: tunnel.publicUrl,
    provider: tunnel.providerName,
    lastStartError: tunnel.startError,
  };
}

// authtoken 脱敏：长度 > 4 显示末 4 位，长度 <= 4 全部遮罩（避免短 token 泄露）
function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 4) return '?'.repeat(token.length);
  return token.slice(-4).padStart(token.length, '?');
}

// 增量持久化单个 tunnel 字段（参考 17_xianyu _save_tunnel_field）。
// 用于向导：每步成功后立即持久化，避免后续步骤失败时丢失前序成果。
async function saveTunnelField(field: keyof TunnelConfig, value: string): Promise<void> {
  const configPath = getConfigPath();
  if (!configPath) {
    throw new Error('无法定位 config.json 路径');
  }
  let raw: Record<string, unknown> = {};
  try {
    const content = await fsp.readFile(configPath, 'utf8');
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // 文件不存在或解析失败，从空对象开始
  }
  const existing = (raw.tunnel ?? {}) as Record<string, unknown>;
  existing[field] = value;
  raw.tunnel = existing;
  await fsp.writeFile(configPath, JSON.stringify(raw, null, 2), 'utf8');
}

// 保存 tunnel 配置到 config.json（保留其他段不动）。
// cpolarAuthtoken 空串表示"不修改已有 token"，避免前端回传脱敏串覆盖真实值。
async function saveTunnelConfig(body: Partial<TunnelConfig>): Promise<void> {
  const configPath = getConfigPath();
  if (!configPath) {
    throw new Error('无法定位 config.json 路径');
  }

  // 读取现有 config.json，保留其他段（llm/budget/server 等）不动
  let raw: Record<string, unknown> = {};
  try {
    const content = await fsp.readFile(configPath, 'utf8');
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // 文件不存在或解析失败，从空对象开始
  }

  const existing = (raw.tunnel ?? {}) as Partial<TunnelConfig>;
  // body.cpolarAuthtoken 空串时保留 existing.cpolarAuthtoken
  raw.tunnel = {
    provider: body.provider ?? existing.provider ?? 'cloudflare',
    localPort: body.localPort ?? existing.localPort ?? 0,
    cpolarAuthtoken: body.cpolarAuthtoken || existing.cpolarAuthtoken || '',
    binaryPath: body.binaryPath ?? existing.binaryPath ?? '',
    autoStart: body.autoStart ?? existing.autoStart ?? false,
    // Named Tunnel 字段：保留已有值，前端切换模式时才传新值
    tunnelMode: body.tunnelMode ?? existing.tunnelMode ?? 'quick',
    tunnelName: body.tunnelName ?? existing.tunnelName ?? '',
    tunnelId: body.tunnelId ?? existing.tunnelId ?? '',
    credentialsFile: body.credentialsFile ?? existing.credentialsFile ?? '',
    hostname: body.hostname ?? existing.hostname ?? '',
    certFile: existing.certFile ?? '',
    // certFile 不由前端表单修改，只由向导 login 步骤持久化
  };

  await fsp.writeFile(configPath, JSON.stringify(raw, null, 2), 'utf8');
}

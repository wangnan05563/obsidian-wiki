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

// 内网穿透路由（参考 17_xianyu api_tunnel.py，适配 Fastify）。
//   GET  /api/tunnel/status                    查询运行状态
//   POST /api/tunnel/start                     启动隧道
//   POST /api/tunnel/stop                      停止隧道
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

export function registerTunnelRoute(app: FastifyInstance, tunnel: TunnelService) {
  app.get('/api/tunnel/status', async (_request, reply) => {
    return reply.send({
      status: tunnel.status,
      publicUrl: tunnel.publicUrl,
      provider: tunnel.providerName,
    });
  });

  app.post('/api/tunnel/start', async (_request, reply) => {
    try {
      // 从 config.json 读取 tunnel 配置和 server.port，路由自包含无需额外参数
      const config = await loadConfig();
      await tunnel.start(config.tunnel, config.server.port);
      return reply.send({
        status: tunnel.status,
        publicUrl: tunnel.publicUrl,
        provider: tunnel.providerName,
      });
    } catch (err) {
      // 二进制下载失败：返回结构化指引，前端渲染手动下载链接
      if (err instanceof BinaryDownloadError) {
        return reply.code(500).send({
          detail: err.message,
          errorType: 'binary_download_failed',
          manualPath: err.manualPath,
          downloadUrls: err.downloadUrls,
        });
      }
      // Tailscale Funnel 首次授权：返回授权链接，前端渲染授权向导
      if (err instanceof TailscaleFunnelAuthError) {
        return reply.code(500).send({
          detail: err.message,
          errorType: 'tailscale_funnel_auth',
          authUrl: err.authUrl,
        });
      }
      return reply.code(500).send({
        detail: `隧道启动失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.post('/api/tunnel/stop', async (_request, reply) => {
    tunnel.stop();
    return reply.send({
      status: tunnel.status,
      publicUrl: tunnel.publicUrl,
      provider: tunnel.providerName,
    });
  });

  app.get('/api/tunnel/config', async (_request, reply) => {
    const config = await loadConfig();
    const t = config.tunnel;
    // authtoken 脱敏：仅返回末 4 位 + 是否已配置，避免明文回显
    return reply.send({
      provider: t.provider,
      localPort: t.localPort,
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

  app.post('/api/tunnel/config', async (request, reply) => {
    const body = request.body as Partial<TunnelConfig> | null;
    if (!body) {
      return reply.code(400).send({ detail: '请求体为空' });
    }
    // 基本校验：provider 必须是支持的类型
    if (body.provider && body.provider !== 'cloudflare' && body.provider !== 'cpolar' && body.provider !== 'tailscale') {
      return reply.code(400).send({ detail: `不支持的 provider: ${body.provider}` });
    }
    try {
      await saveTunnelConfig(body);
      return reply.send({ ok: true, message: '配置已保存，下次启动隧道时生效' });
    } catch (err) {
      return reply.code(500).send({
        detail: `配置保存失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // ===== Cloudflare Named Tunnel 向导端点 =====

  // 启动 cloudflared tunnel login（非阻塞），10s 内提取授权 URL
  app.post('/api/tunnel/cloudflare/login', async (_request, reply) => {
    const config = await loadConfig();
    const svc = getLoginService();
    try {
      const result = await svc.startLogin(config.tunnel.binaryPath);
      // failed 时清理 loginService 允许重试；waiting 时保留供 status 轮询
      if (result.status === 'failed') {
        loginService = null;
      }
      return reply.send(result);
    } catch (err) {
      loginService = null;
      return reply.code(500).send({
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
    return reply.send(result);
  });

  // 创建命名隧道：cloudflared tunnel create <name>
  app.post('/api/tunnel/cloudflare/create', async (request, reply) => {
    const body = request.body as { tunnelName?: string; certFile?: string } | null;
    if (!body?.tunnelName?.trim()) {
      return reply.code(400).send({ detail: '请输入隧道名称' });
    }
    const config = await loadConfig();
    // 请求体 certFile 优先于配置中的 certFile
    const certFile = body.certFile || config.tunnel.certFile;
    if (!certFile) {
      return reply.code(400).send({ detail: '请先执行 login 步骤获取 cert.pem' });
    }
    const svc = getLoginService();
    try {
      const result = await svc.createTunnel(body.tunnelName.trim(), certFile, config.tunnel.binaryPath);
      // 持久化 tunnel_id + credentials_file + tunnel_name（增量写入，保留其他字段）
      await saveTunnelField('tunnelId', result.tunnelId);
      await saveTunnelField('credentialsFile', result.credentialsFile);
      await saveTunnelField('tunnelName', result.tunnelName);
      return reply.send({
        ok: true,
        tunnelId: result.tunnelId,
        credentialsFile: result.credentialsFile,
        tunnelName: result.tunnelName,
        message: '隧道创建成功，可以继续配置 DNS 路由',
      });
    } catch (err) {
      return reply.code(500).send({
        detail: `创建隧道失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // 配置 DNS CNAME：cloudflared tunnel route dns <name> <hostname>
  app.post('/api/tunnel/cloudflare/route-dns', async (request, reply) => {
    const body = request.body as { hostname?: string; certFile?: string } | null;
    if (!body?.hostname?.trim()) {
      return reply.code(400).send({ detail: '请输入固定域名' });
    }
    const config = await loadConfig();
    const certFile = body.certFile || config.tunnel.certFile;
    if (!certFile) {
      return reply.code(400).send({ detail: '请先执行 login 步骤获取 cert.pem' });
    }
    const svc = getLoginService();
    // 优先用 tunnelName，回退到 tunnelId（兼容 cloudflared 不同版本）
    const tunnelNameOrId = config.tunnel.tunnelName || config.tunnel.tunnelId;
    if (!tunnelNameOrId) {
      return reply.code(400).send({ detail: '请先执行创建隧道步骤' });
    }
    try {
      const publicUrl = await svc.routeDns(tunnelNameOrId, body.hostname.trim(), certFile, config.tunnel.binaryPath);
      // 持久化 hostname + 自动切换到 named 模式
      await saveTunnelField('hostname', body.hostname.trim());
      await saveTunnelField('tunnelMode', 'named');
      return reply.send({
        ok: true,
        publicUrl,
        message: 'DNS 路由配置成功，已自动切换到固定域名模式',
      });
    } catch (err) {
      return reply.code(500).send({
        detail: `DNS 路由配置失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
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

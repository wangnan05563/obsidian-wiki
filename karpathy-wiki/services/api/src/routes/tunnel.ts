import type { FastifyInstance } from 'fastify';
import fsp from 'node:fs/promises';
import { loadConfig, getConfigPath } from '../config.js';
import { TunnelService, BinaryDownloadError } from '../tunnel/tunnel-service.js';
import type { TunnelConfig } from '../types.js';

// 内网穿透路由（参考 17_xianyu api_tunnel.py，适配 Fastify）。
//   GET  /api/tunnel/status  查询运行状态（免认证：远程访问引导场景需先建隧道）
//   POST /api/tunnel/start   启动隧道（免认证）
//   POST /api/tunnel/stop    停止隧道（免认证）
//   GET  /api/tunnel/config  读取配置（authtoken 脱敏）
//   POST /api/tunnel/config  保存配置（落盘到 config.json，authtoken 空串=不修改）
// 本项目无认证中间件，故免认证指后续接入认证时需白名单这三个端点。
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
    });
  });

  app.post('/api/tunnel/config', async (request, reply) => {
    const body = request.body as Partial<TunnelConfig> | null;
    if (!body) {
      return reply.code(400).send({ detail: '请求体为空' });
    }
    // 基本校验：provider 必须是支持的类型
    if (body.provider && body.provider !== 'cloudflare' && body.provider !== 'cpolar') {
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
}

// authtoken 脱敏：长度 > 4 显示末 4 位，长度 <= 4 全部遮罩（避免短 token 泄露）
function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 4) return '?'.repeat(token.length);
  return token.slice(-4).padStart(token.length, '?');
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
  };

  await fsp.writeFile(configPath, JSON.stringify(raw, null, 2), 'utf8');
}

// MCP Server 端点（Streamable HTTP）：对外暴露知识库能力给外部 AI Agent。
//
// 为什么用 POST /mcp + JSON-RPC：主流 MCP 客户端（Claude Desktop/Cline 等）以
// Streamable HTTP 传输连接，POST 单条 JSON-RPC 即可完成 initialize → tools/list → tools/call
// 全流程，服务端始终回 application/json（不做服务端主动推送，故 GET 通道仅做协议占位）。
//
// 鉴权：外部 Agent 无法走 Web 登录流程，用配置式 Bearer Token 双轨鉴权：
//   - userToken   → 查询/检索类工具
//   - adminToken  → 全部工具（含写/维护类），未配置时写工具回退 userToken
//   - authenticated=false 且未配置任何 token → 对内网开放全部工具（本地方便）

import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import type { VaultService } from '../vault/vault-service.js';
import type { EngineAdapter, AppConfig, McpConfig } from '../types.js';
import { parseRequest, success, failure, ErrCodes, isNotification, isBatch } from '../mcp/json-rpc.js';
import { listTools, callTool, getTool } from '../mcp/tools.js';
import type { McpToolContext } from '../mcp/tools.js';

const PROTOCOL_VERSION = '2025-03-26';
// 自定义鉴权错误码（非标准库，仅供客户端区分授权失败）
const AUTH_ERROR = -32801;

export function registerMcpRoute(
  app: FastifyInstance,
  vault: VaultService,
  adapter: EngineAdapter,
  config: AppConfig,
): void {
  const endpointPath = config.mcp?.endpointPath || '/mcp';
  const serverName = config.mcp?.name || 'karpathy-wiki';
  const serverVersion = config.mcp?.version || '1.0.0';

  // 鉴权上下文：从最新配置与请求头推导授权级别。openAll 仅当显式放行内网且无 token 时成立。
  // 用参数传入 mcp（而非闭包快照）：请求时热读 config.json，保证「配置页保存 token 后免重启生效」。
  const resolveAuth = (mcp: McpConfig, request: FastifyRequest): { isAdmin: boolean; isUser: boolean; openAll: boolean } => {
    const hasUser = !!mcp.userToken;
    const hasAdmin = !!mcp.adminToken;
    const openAll = !mcp.authenticated && !hasUser && !hasAdmin;

    const header = request.headers.authorization;
    const token = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : null;
    if (!token) return { isAdmin: false, isUser: false, openAll };

    const match = (expected: string | undefined): boolean =>
      !!token && !!expected && token.length === expected.length && crypto.timingSafeEqual(
        Buffer.from(token), Buffer.from(expected),
      );

    // 写工具的 admin 判定：精确匹配 adminToken；未配置 adminToken 时回退 userToken
    const isAdmin = match(mcp.adminToken) || (!hasAdmin && match(mcp.userToken));
    // 读工具的 user 判定：匹配任一 token
    const isUser = match(mcp.userToken) || match(mcp.adminToken);
    return { isAdmin, isUser, openAll };
  };

  // 判断某工具对当前授权是否放行：写=admin，读=user||admin，openAll 全部放行
  const toolAllowed = (write: boolean, a: { isAdmin: boolean; isUser: boolean; openAll: boolean }): boolean =>
    a.openAll || (write ? a.isAdmin : a.isUser || a.isAdmin);

  const deny = (id: string | number | null, message: string) => ({ jsonrpc: '2.0', id, error: { code: AUTH_ERROR, message } });

  // GET：Streamable HTTP 的服务端事件流通道。本服务不主动推送，仅做协议占位（客户端大多用 POST 单响应）。
  app.get(endpointPath, async (_req, reply) => {
    const mcp = (await loadConfig()).mcp ?? { enabled: false };
    if (!mcp.enabled) return reply.code(503).send({ error: 'MCP 端点未启用' });
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.end(`event: endpoint\ndata: ${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} } })}\n\n`);
  });

  app.post(endpointPath, { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (request: FastifyRequest, reply) => {
    // 每次请求热读最新 mcp 配置（由 /api/config/mcp 保存到 config.json），保存 token/开关后免重启生效
    const mcp = (await loadConfig()).mcp ?? { enabled: false };
    if (!mcp.enabled) {
      return reply.code(503).send({ error: 'MCP 端点未启用，请在「配置 → MCP 接口」开启，或编辑 config.json 的 mcp.enabled' });
    }

    let raw: unknown;
    try {
      raw = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    } catch {
      return reply.code(400).send(failure(null, ErrCodes.parse, '无效 JSON'));
    }

    if (isBatch(raw)) {
      return reply.code(400).send(failure(null, ErrCodes.invalidRequest, '不支持批量请求'));
    }

    const req = parseRequest(raw);
    if (!req) {
      return reply.code(400).send(failure(null, ErrCodes.invalidRequest, '非法请求'));
    }

    if (isNotification(raw)) {
      reply.code(202).send();
      return;
    }

    const id = req.id ?? null;
    const a = resolveAuth(mcp, request);

    if (req.method === 'initialize') {
      return reply.send(success(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: serverVersion },
      }));
    }
    if (req.method === 'ping') {
      return reply.send(success(id, {}));
    }
    if (req.method === 'tools/list') {
      return reply.send(success(id, listTools()));
    }
    if (req.method === 'tools/call') {
      const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
      const toolName = typeof params.name === 'string' ? params.name : '';
      if (!toolName) {
        return reply.send(failure(id, ErrCodes.invalidParams, '缺少 tools/call 参数 name'));
      }
      // 鉴权先于执行：写工具需 admin，读工具需 user/admin；未授信一律 401
      const tool = getTool(toolName);
      if (tool ? !toolAllowed(tool.write, a) : !(a.openAll || a.isUser || a.isAdmin)) {
        return reply.code(401).send(deny(id, '未授权：缺少有效凭据或该工具需要更高级别权限'));
      }
      const ctx: McpToolContext = { vault, adapter, config };
      const result = await callTool(toolName, params.arguments, ctx);
      return reply.send(success(id, result));
    }

    return reply.send(failure(id, ErrCodes.methodNotFound, `不存在的方法: ${req.method}`));
  });
}
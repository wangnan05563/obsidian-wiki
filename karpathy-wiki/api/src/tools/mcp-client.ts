// MCP (Model Context Protocol) 客户端。
// 为什么需要：让 LLM 能调用外部 MCP 服务器提供的工具（如数据库查询、API 调用等）。
// 支持三种 transport：
// - stdio：启动本地子进程，通过 stdin/stdout 交换 JSON-RPC 消息
// - sse：HTTP + Server-Sent Events（旧版 MCP 协议）
// - http：Streamable HTTP（新版 MCP 协议）
//
// 连接管理：懒连接（首次调用时建立）+ 缓存（按 server name 复用）+ 优雅关闭。
// 为什么不依赖 @modelcontextprotocol/sdk：该 SDK 体积大且本项目仅需 tools/list + tools/call 两个方法，
// 自实现 JSON-RPC 核心更轻量，避免引入额外依赖。

import { spawn, type ChildProcess } from 'node:child_process';
import type { McpServerEntry } from '../types.js';

// MCP 工具描述（JSON-RPC tools/list 响应项）
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: object;
}

// MCP 工具调用结果（JSON-RPC tools/call 响应）
export interface McpCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// 活跃连接的内部表示
interface McpConnection {
  serverName: string;
  transport: 'stdio' | 'sse' | 'http';
  // stdio 模式持有子进程；http/sse 模式仅持有 url
  process?: ChildProcess;
  url?: string;
  // JSON-RPC 请求 ID 自增计数器
  nextId: number;
  // stdio 模式：待响应的请求 Map<id, {resolve, reject, timeout}>
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  // 初始化是否完成
  initialized: boolean;
  // stdout 累积缓冲区（JSON-RPC 消息可能分多条到达）
  buffer: string;
  // RPC 超时（ms）：从 McpServerEntry.timeoutMs 读取，缺失时用 DEFAULT_RPC_TIMEOUT_MS
  rpcTimeoutMs: number;
}

// 连接缓存：按 server name 索引
const connections = new Map<string, McpConnection>();

// inflight 连接 Promise：防止并发调用 getOrConnect 时创建多个连接
// 为什么需要：多个工具同时调用 listMcpTools/callMcpTool 时，可能同时触发 connectMcpServer，
// 导致同一服务器被连接多次。inflight Promise 让并发调用复用同一个连接过程。
const inflightConnections = new Map<string, Promise<McpConnection>>();

// JSON-RPC 请求默认超时（ms）。
// 为什么保留默认值：McpServerEntry.timeoutMs 缺失时的 fallback，避免 config 未配置时崩溃。
// 实际值应从 config.json -> tools.mcpTimeoutMs 或 McpServerEntry.timeoutMs 读取（BR-034）。
const DEFAULT_RPC_TIMEOUT_MS = 30000;

// stdio 模式：向子进程 stdin 写入 JSON-RPC 消息并等待 stdout 响应。
// 为什么用换行分隔：JSON-RPC over stdio 约定每条消息以 \n 结尾，便于流式解析。
function sendRpcStdio(conn: McpConnection, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!conn.process?.stdin) {
      reject(new Error(`MCP server "${conn.serverName}" process not available`));
      return;
    }
    const id = conn.nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`MCP RPC "${method}" timed out after ${conn.rpcTimeoutMs}ms`));
    }, conn.rpcTimeoutMs);

    conn.pending.set(id, { resolve, reject, timer });
    conn.process.stdin.write(message);
  });
}

// http/sse 模式：用 fetch 发送 JSON-RPC 请求。
// 为什么不用长连接 SSE：tools/list 和 tools/call 是一次性请求-响应，普通 POST 即可。
// 为什么不传 env header：http/sse 模式下 env 通过 header 传输有泄露风险（env 可能含 API Key），
//   stdio 模式 env 通过子进程 stdin 注入更安全。http/sse 模式如需鉴权请在服务器端配置。
async function sendRpcHttp(conn: McpConnection, method: string, params: unknown): Promise<unknown> {
  const id = conn.nextId++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const res = await fetch(conn.url!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(conn.rpcTimeoutMs),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`MCP RPC error: ${json.error.message}`);
  return json.result;
}

// 统一的 JSON-RPC 调用入口
function sendRpc(conn: McpConnection, method: string, params: unknown = {}): Promise<unknown> {
  if (conn.transport === 'stdio') return sendRpcStdio(conn, method, params);
  return sendRpcHttp(conn, method, params);
}

// 处理 stdio stdout 的 JSON-RPC 响应（可能含多条消息粘连）
function handleStdioData(conn: McpConnection, data: string): void {
  conn.buffer += data;
  // 按换行分割，每行是一个完整的 JSON-RPC 消息
  const lines = conn.buffer.split('\n');
  // 最后一段可能不完整（无换行结尾），保留在 buffer
  conn.buffer = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id !== undefined) {
        const pending = conn.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          conn.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`MCP RPC error: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    } catch {
      // 非 JSON 行（如日志输出）忽略
    }
  }
}

// 建立 MCP 连接并完成 initialize 握手。
// 为什么需要握手：MCP 协议要求客户端先发 initialize 通知服务器能力，服务器响应后才能调用 tools/list。
// defaultTimeoutMs：从 ToolsConfig.mcpTimeoutMs 传入，作为 entry.timeoutMs 缺失时的 fallback。
export async function connectMcpServer(entry: McpServerEntry, defaultTimeoutMs?: number): Promise<McpConnection> {
  const conn: McpConnection = {
    serverName: entry.name,
    transport: entry.transport,
    nextId: 1,
    pending: new Map(),
    initialized: false,
    buffer: '',
    // 超时优先级：entry.timeoutMs > defaultTimeoutMs > DEFAULT_RPC_TIMEOUT_MS
    rpcTimeoutMs: entry.timeoutMs ?? defaultTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
  };

  if (entry.transport === 'stdio') {
    if (!entry.command) throw new Error(`MCP server "${entry.name}" stdio transport requires "command"`);
    // spawn 子进程，env 注入配置的环境变量（stdio 模式安全：env 经子进程 stdin 传递，不暴露）
    conn.process = spawn(entry.command, entry.args || [], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...entry.env },
    });
    conn.process.stdout?.on('data', (data) => {
      handleStdioData(conn, data.toString());
    });
    conn.process.on('error', (err) => {
      // 子进程启动失败：拒绝所有 pending 请求
      for (const [, p] of conn.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP process error: ${err.message}`));
      }
      conn.pending.clear();
    });
    conn.process.on('close', () => {
      for (const [, p] of conn.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP process closed unexpectedly`));
      }
      conn.pending.clear();
      connections.delete(entry.name);
    });
  } else {
    // sse / http 模式
    if (!entry.url) throw new Error(`MCP server "${entry.name}" ${entry.transport} transport requires "url"`);
    conn.url = entry.url;
    // http/sse 模式不传递 env：header 传输有泄露风险（env 可能含 API Key）
    // 如需传递 env，请改用 stdio 模式（env 通过子进程 stdin 注入）
    if (entry.env && Object.keys(entry.env).length > 0) {
      console.warn(`[MCP] Server "${entry.name}" env is not supported in ${entry.transport} transport (use stdio mode for env injection)`);
    }
  }

  // initialize 握手
  try {
    await sendRpc(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'karpathy-wiki', version: '1.0.0' },
    });
    // stdio 模式需发送 initialized 通知（无 id，无响应）
    if (conn.transport === 'stdio' && conn.process?.stdin) {
      conn.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    }
    conn.initialized = true;
  } catch (err) {
    // 握手失败：清理连接
    await disconnectMcpServer(entry.name);
    throw err;
  }

  connections.set(entry.name, conn);
  return conn;
}

// 获取或建立连接（懒连接）。
// 为什么用 inflightConnections：并发调用（如多个工具同时请求同一 MCP 服务器）时，
//   若仅检查 connections 缓存，所有调用都会触发 connectMcpServer，创建多个子进程。
//   inflight Promise 让并发调用复用同一个连接过程，连接成功后所有调用拿到同一 conn。
async function getOrConnect(entry: McpServerEntry, defaultTimeoutMs?: number): Promise<McpConnection> {
  const existing = connections.get(entry.name);
  if (existing?.initialized) return existing;

  const inflight = inflightConnections.get(entry.name);
  if (inflight) return inflight;

  // 连接成功后从 inflight 移除，失败也移除（让下次调用可重试）
  const promise = connectMcpServer(entry, defaultTimeoutMs).finally(() => {
    inflightConnections.delete(entry.name);
  });
  inflightConnections.set(entry.name, promise);
  return promise;
}

// 列出 MCP 服务器提供的所有工具。
// defaultTimeoutMs：从 ToolsConfig.mcpTimeoutMs 传入，仅首次连接时生效（已建立连接用其 rpcTimeoutMs）。
export async function listMcpTools(entry: McpServerEntry, defaultTimeoutMs?: number): Promise<McpToolInfo[]> {
  const conn = await getOrConnect(entry, defaultTimeoutMs);
  const result = await sendRpc(conn, 'tools/list') as { tools?: McpToolInfo[] } | undefined;
  return result?.tools || [];
}

// 调用 MCP 工具。
export async function callMcpTool(entry: McpServerEntry, toolName: string, args: unknown, defaultTimeoutMs?: number): Promise<McpCallResult> {
  const conn = await getOrConnect(entry, defaultTimeoutMs);
  const result = await sendRpc(conn, 'tools/call', { name: toolName, arguments: args }) as McpCallResult;
  return result;
}

// 断开指定 MCP 服务器连接。
export async function disconnectMcpServer(serverName: string): Promise<void> {
  const conn = connections.get(serverName);
  if (!conn) return;
  if (conn.process) {
    conn.process.stdin?.end();
    conn.process.kill('SIGTERM');
    // 给 1s 优雅退出，超时强杀
    setTimeout(() => {
      if (conn.process && !conn.process.killed) {
        conn.process.kill('SIGKILL');
      }
    }, 1000);
  }
  // 清理 pending 请求
  for (const [, p] of conn.pending) {
    clearTimeout(p.timer);
    p.reject(new Error('Connection closed'));
  }
  conn.pending.clear();
  connections.delete(serverName);
  // 同步清理 inflight（断开时 inflight Promise 应已被 finally 清理，此处兜底）
  inflightConnections.delete(serverName);
}

// 断开所有连接（优雅关闭钩子调用）。
export async function disconnectAllMcpServers(): Promise<void> {
  const names = Array.from(connections.keys());
  await Promise.all(names.map((n) => disconnectMcpServer(n)));
}

// 将 MCP 服务器 + 工具转为 ToolDefinition 供 harness 使用。
// 工具名格式：mcp__{serverName}__{toolName}，避免与内置工具名冲突。
// defaultTimeoutMs：从 ToolsConfig.mcpTimeoutMs 传入，传递给 callMcpTool 作为 RPC 超时 fallback。
//   为什么用闭包捕获而非全局变量：保持纯函数语义，避免全局状态污染，便于多实例测试。
export function buildMcpToolDefinition(
  serverEntry: McpServerEntry,
  tool: McpToolInfo,
  defaultTimeoutMs?: number,
) {
  const fullName = `mcp__${serverEntry.name}__${tool.name}`;
  return {
    name: fullName,
    description: `[MCP:${serverEntry.name}] ${tool.description || tool.name}`,
    parameters: tool.inputSchema ?? { type: 'object' as const, properties: {}, required: [] },
    // handler 接受可选 ctx 参数（与 ToolDefinition.handler 签名对齐），当前未使用但保留扩展点
    handler: async (args: unknown, _ctx?: unknown) => {
      try {
        const result = await callMcpTool(serverEntry, tool.name, args, defaultTimeoutMs);
        if (result.isError) {
          // MCP 工具返回错误：提取文本内容返回 error 字段
          const text = result.content.map((c) => c.text || '').join('\n');
          return { error: text || 'MCP tool returned an error' };
        }
        // 成功：提取文本内容返回 output 字段
        const text = result.content.map((c) => c.text || '').join('\n');
        return { output: text };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `MCP tool call failed: ${msg}` };
      }
    },
  };
}

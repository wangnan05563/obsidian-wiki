// JSON-RPC 2.0 编解码 / 校验工具，供 MCP Server 端点（Streamable HTTP）使用。
// 为什么单独拆出：MCP 端点的核心是协议层（消息校验 + 响应构造），
// 与具体工具（tools.ts）解耦，便于单测与后续扩展资源/提示方法。

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

// 是否为 MCP 通知（无 id）：客户端发 `notifications/initialized` 等时不期望响应
export function isNotification(msg: unknown): msg is JsonRpcRequest {
  return !!msg && typeof msg === 'object' && 'method' in (msg as object) && !('id' in (msg as object));
}

// 是否为批量请求（MCP 主要用单消息，这里保留识别以便安全拒绝）
export function isBatch(msg: unknown): boolean {
  return Array.isArray(msg);
}

// 解析入站消息为合法请求对象；非法时返回 null（调用方按错误响应处理）
export function parseRequest(raw: unknown): JsonRpcRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.jsonrpc !== '2.0' || typeof r.method !== 'string') return null;
  const id = r.id === undefined ? null : (r.id as string | number | null);
  // id 类型不合法则视为非法请求（通知除外）
  if (r.id !== undefined && !(typeof id === 'string' || typeof id === 'number')) return null;
  return { jsonrpc: '2.0', id, method: r.method, params: r.params };
}

// 错误码（MCP/JSON-RPC 标准）
export const ErrCodes = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  // MCP 保留码：客户端主动取消等
  requestCancelled: -32800,
} as const;

export function success(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function failure(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error: JsonRpcErrorPayload = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}
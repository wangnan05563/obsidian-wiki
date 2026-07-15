import type { FastifyReply } from 'fastify';

// SSE 响应头：防代理缓冲 + 保持连接
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

// 初始化 SSE 流：写入响应头
export function setupSSE(reply: FastifyReply): void {
  reply.raw.writeHead(200, SSE_HEADERS);
}

// 发送 SSE 事件：event + data 双行格式
export function sendSSE(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

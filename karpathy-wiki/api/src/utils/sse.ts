import type { FastifyReply, FastifyRequest } from 'fastify';

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
// 注意：本函数不检查流状态，调用方需自行确认流未销毁。
// 推荐使用 createSSESender 获得自动防护
export function sendSSE(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

// SSE 安全写入工厂：返回 send 函数与 aborted 检查器
// 为什么需要：客户端 abort 后 reply.raw 被销毁，继续 write/end 会抛 ERR_STREAM_DESTROYED，
// 被 Fastify 作为未捕获异常处理为 HTTP 500，污染日志并误导排障。
// 监听 request.raw 'close' 事件设置 aborted 标志，调用方可据此提前退出循环。
export function createSSESender(reply: FastifyReply, request: FastifyRequest) {
  let aborted = false;
  // 客户端断开（前端 abort / 网络中断 / 切换菜单触发 onBeforeUnmount）时触发
  request.raw.on('close', () => {
    aborted = true;
  });
  const send = (event: string, data: unknown): boolean => {
    if (aborted || reply.raw.destroyed || reply.raw.writableEnded) return false;
    try {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      // 写入失败（流已关闭/销毁），标记 aborted 避免后续重试
      aborted = true;
      return false;
    }
  };
  const isAborted = () => aborted;
  // 安全结束流：检查流状态避免重复 end 或对已销毁流 end 抛错
  const safeEnd = (): void => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return;
    try {
      reply.raw.end();
    } catch {
      // 流已销毁，忽略
    }
  };
  return { send, isAborted, safeEnd };
}

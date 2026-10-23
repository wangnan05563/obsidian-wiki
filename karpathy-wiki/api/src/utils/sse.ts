import type { FastifyReply, FastifyRequest } from 'fastify';

// SSE 响应头：防代理缓冲 + 保持连接
export const SSE_HEADERS = {
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

// T02930：在途 SSE 流的登记表。停服时先向客户端补一个终止事件再 end，
// 让浏览器/前端拿到「流正常结束」而不是进程退出时的 ECONNRESET。
// 为什么放在模块级而不是路由参数：13 处 SSE 路由共用 createSSESender，
// 单点登记才能在 shutdown 时一次收尾，不必给每条路由加关闭钩子。
const activeStreamClosers = new Set<(reason: string) => void>();

export function activeSSECount(): number {
  return activeStreamClosers.size;
}

// 结束所有在途 SSE 流，返回被收尾的流数量
export function closeAllSSEStreams(reason = 'server-shutdown'): number {
  const closers = [...activeStreamClosers];
  activeStreamClosers.clear();
  for (const close of closers) {
    try {
      close(reason);
    } catch {
      // 单个流写失败不影响其余流收尾
    }
  }
  return closers.length;
}

// SSE 安全写入工厂：返回 send 函数与 aborted 检查器
// 为什么需要：客户端 abort 后 reply.raw 被销毁，继续 write/end 会抛 ERR_STREAM_DESTROYED，
// 被 Fastify 作为未捕获异常处理为 HTTP 500，污染日志并误导排障。
// 为什么监听 reply.raw 而非 request.raw：request.raw（请求可读流）在有 body 的请求
// （如 multipart upload）中，body 读取完毕即触发 close，并不代表客户端断开；
// reply.raw（响应可写流）的 close 才是客户端断开连接的真实信号。
export function createSSESender(reply: FastifyReply, request: FastifyRequest) {
  let aborted = false;
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
  // T02930：停服收尾。先补一个终结事件告知客户端「是服务端主动关的」，
  // 再置 aborted 让上游迭代器尽快退出（不再发起 LLM 调用/写 Vault）。
  const closeForShutdown = (reason: string): void => {
    if (!aborted && !reply.raw.writableEnded && !reply.raw.destroyed) {
      send('server-shutdown', { reason });
    }
    aborted = true;
    safeEnd();
  };
  activeStreamClosers.add(closeForShutdown);
  // 客户端断开（前端 abort / 网络中断 / 切换菜单触发 onBeforeUnmount）时触发
  reply.raw.on('close', () => {
    aborted = true;
    activeStreamClosers.delete(closeForShutdown);
  });
  return { send, isAborted, safeEnd };
}

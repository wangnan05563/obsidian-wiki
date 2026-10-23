import { closeAllSSEStreams } from './sse.js';

// T02930：优雅停服。原实现直接 process.exit(0)，Fastify 监听套接字与在途请求不 drain，
// 流式问答/保存配置等请求被硬切（客户端看到 ECONNRESET 而不是回应）。
//
// 拆线顺序（不可调换）：
//   1. 停隧道：不再把新流量转发到一个正在关闭的服务；
//   2. 结束在途 SSE：补 server-shutdown 事件后 end，客户端拿到干净结束；
//   3. app.close()：停止接收新连接，drain 其余在途请求；
//   4. 关工具连接 / Vault / 日志流：这些是 app.close() 之后才安全释放的进程级资源。
//
// 超时兜底：装机版双击关窗、系统关机都要求进程能退出，不能被一条挂住的 SSE
// 或卡死的文件系统吊住——超时后以非 0 退出码强制结束，方便打包版判定未能干净拆线。
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 4000;

export interface ShutdownDeps {
  tunnelStop: () => void;
  closeServer: () => Promise<void>;
  shutdownTools: () => Promise<void>;
  disposeVault: () => Promise<void>;
  flushLogs?: () => Promise<void>;
  timeoutMs?: number;
  // 注入点：测试里替换 process.exit 才能断言退出码而不真的杀测试进程
  exit?: (code: number) => void;
  logError?: (message: string, err?: unknown) => void;
}

export type ShutdownOutcome = 'clean' | 'timeout' | 'error';

export async function runShutdown(deps: ShutdownDeps): Promise<ShutdownOutcome> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exit = deps.exit ?? ((code: number) => { process.exit(code); });
  const logError = deps.logError ?? ((message: string, err?: unknown) => {
    console.error(message, err);
  });

  const teardown = (async (): Promise<ShutdownOutcome> => {
    try {
      deps.tunnelStop();
      closeAllSSEStreams();
      await deps.closeServer();
      await deps.shutdownTools();
      await deps.disposeVault();
      await deps.flushLogs?.();
      return 'clean';
    } catch (err) {
      logError('[关闭] 拆线出错，强制退出', err);
      return 'error';
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ShutdownOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    // 不让兜底定时器自己成为「进程不退」的原因（正常拆线完成时会 clear）
    timer.unref?.();
  });

  const outcome = await Promise.race([teardown, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    logError(`[关闭] 拆线超时（${timeoutMs}ms），强制退出`);
  }
  exit(outcome === 'clean' ? 0 : 1);
  return outcome;
}

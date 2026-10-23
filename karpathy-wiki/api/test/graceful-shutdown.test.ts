// T02930 集成测试：真实监听 socket + 真实 HTTP 客户端。
// 为什么不用 app.inject()：本单要验证的是「在途连接被 drain 而不是被 process.exit 硬切」，
// inject 是内存调用，根本不存在套接字与 FIN/RST 的区别，测不出缺陷。
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import http from 'node:http';
import { setupSSE, createSSESender } from '../src/utils/sse.js';
import { runShutdown, type ShutdownDeps } from '../src/utils/shutdown.js';

async function startServer(): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify({ logger: false });
  // 模拟问答/compile 这类长流：写出首帧后一直开着，直到服务端主动收尾
  app.get('/stream', async (request, reply) => {
    setupSSE(reply);
    const { send } = createSSESender(reply, request);
    send('open', { ok: true });
    await new Promise<void>((resolve) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return resolve();
      reply.raw.on('close', () => resolve());
    });
    return reply;
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { app, port: address.port };
}

interface ClientResult {
  body: string;
  endedCleanly: boolean;
  error: Error | null;
}

// 真实 HTTP 客户端：记录「收到 FIN 正常结束」还是「被重置/中断」
function openStream(port: number): { result: Promise<ClientResult>; firstFrame: Promise<void> } {
  let firstFrameResolve: () => void = () => {};
  const firstFrame = new Promise<void>((resolve) => { firstFrameResolve = resolve; });
  const result = new Promise<ClientResult>((resolve) => {
    let body = '';
    let endedCleanly = false;
    let error: Error | null = null;
    const req = http.get({ host: '127.0.0.1', port, path: '/stream' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (chunk.includes('event: open')) firstFrameResolve();
      });
      res.on('end', () => { endedCleanly = true; });
      res.on('aborted', () => { endedCleanly = false; });
      res.on('error', (err) => { error = err; endedCleanly = false; });
      res.on('close', () => {
        // res.complete 为 false 表示响应体没传完就断了（对应 RST）
        resolve({ body, endedCleanly: endedCleanly && res.complete, error });
      });
    });
    req.on('error', (err) => {
      error = err;
      resolve({ body, endedCleanly: false, error });
    });
  });
  return { result, firstFrame };
}

function makeDeps(overrides: Partial<ShutdownDeps> & Pick<ShutdownDeps, 'closeServer'>): {
  deps: ShutdownDeps;
  events: string[];
  exitCodes: number[];
} {
  const events: string[] = [];
  const exitCodes: number[] = [];
  const deps: ShutdownDeps = {
    timeoutMs: 3000,
    tunnelStop: () => events.push('tunnel'),
    shutdownTools: async () => { events.push('shutdownTools'); },
    disposeVault: async () => { events.push('disposeVault'); },
    flushLogs: async () => { events.push('flushLogs'); },
    exit: (code) => { exitCodes.push(code); },
    logError: () => {},
    ...overrides,
  };
  return { deps, events, exitCodes };
}

describe('runShutdown 优雅停服（T02930）', () => {
  it('流进行中停服：客户端收到 server-shutdown 事件与干净结束，app.close 先于工具连接释放', async () => {
    const { app, port } = await startServer();
    try {
      const { result, firstFrame } = openStream(port);
      await firstFrame;

      const { deps, events, exitCodes } = makeDeps({
        closeServer: async () => {
          events.push('closeServer:start');
          await app.close();
          events.push('closeServer:end');
        },
        tunnelStop: () => events.push('tunnel'),
      });

      const [outcome, client] = await Promise.all([runShutdown(deps), result]);

      expect(outcome).toBe('clean');
      expect(exitCodes).toEqual([0]);
      // 顺序：停隧道 → 关监听并 drain → 才释放工具/Vault/日志
      expect(events).toEqual([
        'tunnel',
        'closeServer:start',
        'closeServer:end',
        'shutdownTools',
        'disposeVault',
        'flushLogs',
      ]);
      // 干净关闭：不是 RST；且客户端能识别出是服务端主动关的
      expect(client.error).toBeNull();
      expect(client.endedCleanly).toBe(true);
      expect(client.body).toContain('event: open');
      expect(client.body).toContain('event: server-shutdown');
    } finally {
      await app.close().catch(() => {});
    }
  });

  it('在途请求挂住时按超时兜底退出，不吊住进程（非 0 退出码）', async () => {
    const { deps, exitCodes } = makeDeps({
      timeoutMs: 50,
      // 模拟 drain 永远不结束（挂死的 SSE / 卡住的文件系统）
      closeServer: () => new Promise<void>(() => {}),
    });
    const startedAt = Date.now();
    const outcome = await runShutdown(deps);
    expect(outcome).toBe('timeout');
    expect(exitCodes).toEqual([1]);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('拆线步骤抛错时以非 0 退出码收口', async () => {
    const { deps, exitCodes } = makeDeps({
      closeServer: async () => { throw new Error('boom'); },
    });
    const outcome = await runShutdown(deps);
    expect(outcome).toBe('error');
    expect(exitCodes).toEqual([1]);
  });
});

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest, FastifyReply, InjectOptions } from 'fastify';
import http from 'node:http';
import { getApiDir } from './utils/runtime.js';
import { resolveSpaRoot, resolveSpaAsset } from './spa-resolver.js';

// 逐跳头只在单跳连接内有效，代理换一条连接后不能原样转发（RFC 9110 §7.6.1）
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// T03646：/wiki/api* 转发必须字节级透传 + 保持流式，app.inject 做不到这两点：
//   - inject 把响应体解码成字符串（binary 经 utf8 往返体积与内容都变），且只回 content-type
//   - inject 要等整条响应结束才 resolve（SSE 实测被整体缓冲，进度/日志不再增量）
// 因此监听态下改走本机回环转发：请求体按原字节（或已解析的 JSON 重新序列化）发出，
// 响应体 pipe 直通，除逐跳头外原样回传。
async function forwardApiViaLoopback(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  suffix: string,
): Promise<boolean> {
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') return false; // 未监听（单测/启动早期）：交给 inject 兜底
  // 用实际监听地址回连：host 配置可能是 localhost（解析成 ::1 或 127.0.0.1）或某个具体网卡 IP，
  // 写死 127.0.0.1 在只绑 ::1 / 指定网卡时会连不上；只有通配地址才落到回环。
  const listenAddress = addr.address;
  const loopbackHost = listenAddress === '0.0.0.0' || listenAddress === '::' ? '127.0.0.1' : listenAddress;

  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'host' || HOP_BY_HOP.has(lower)) continue;
    headers[lower] = value;
  }

  // 已有解析器（json/urlencoded）吃掉流的请求：用 request.body 重新取字节；
  // 没有解析器的（multipart）body 为 undefined，直接 pipe 原始请求流。
  const parsedBody = request.body as unknown;
  let payload: Buffer | null = null;
  if (parsedBody !== undefined && parsedBody !== null) {
    payload = Buffer.isBuffer(parsedBody)
      ? parsedBody
      : Buffer.from(typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody), 'utf8');
    headers['content-length'] = String(payload.length);
  }

  let hijacked = false;
  const upstream = http.request(
    {
      host: loopbackHost,
      port: addr.port,
      method: request.method,
      path: suffix,
      headers,
    },
    (res) => {
      hijacked = true;
      reply.hijack();
      const resHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
        resHeaders[key] = value;
      }
      reply.raw.writeHead(res.statusCode ?? 502, resHeaders);
      // pipe 而非 buffer：SSE 逐条到达即转发，下载流式落地且字节不变
      res.pipe(reply.raw);
    },
  );

  upstream.on('error', (err) => {
    if (hijacked) {
      reply.raw.destroy(err);
      return;
    }
    if (!reply.sent) reply.code(502).send({ error: 'Bad Gateway', message: err.message });
  });
  // 客户端断开（浏览器取消下载/关闭问答页）时同步掐断上游，避免连接泄漏。
  // 判据用「响应尚未写完」：正常结束也会触发 close，此时上游已经结束，无需处理。
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded && !upstream.destroyed) upstream.destroy();
  });

  if (payload) {
    upstream.end(payload);
  } else {
    request.raw.pipe(upstream);
  }
  return true;
}

/**
 * SPA 静态资源托管设置（从 index.ts 抽出为独立模块，便于进程内 app.inject 冒烟测试复用）
 * 探测顺序（动态，实际以 spa-resolver.ts 的 resolveSpaRoot 为准）：
 *   release/spa/public_live_<ts>（统一生成内容后的主要来源，每次部署全新时间戳目录，按数值倒序取最新）【首位】
 *            → getApiDir()/public_live_<ts>（兼容尚未迁移的旧部署）
 *            → getApiDir()/public_live（兼容旧部署，已被钩子锁定 index.html，仅作兜底）
 *            → release/spa/public（vite 新输出位置，_deploy_build.mjs 同步目标）
 *            → getApiDir()/../frontend/dist（vite 默认构建产物）
 *            → CWD/public（exe 运行模式）→ getApiDir()/public（开发/api/public 或 SEA/exe/public）
 *            → static/spa（兼容旧路径）
 *
 * opts.spaRoot：仅供测试注入固定资源根（避免用例依赖本地是否已构建 SPA）；生产调用不传。
 */
export async function setupSpaStatic(app: FastifyInstance, opts: { spaRoot?: string } = {}): Promise<void> {
  const _apiDir = getApiDir();
  const spaRoot = opts.spaRoot ?? resolveSpaRoot(_apiDir);
  if (spaRoot) {
    // 防 stale 缓存：index.html（SPA 壳）每次都重新校验，避免浏览器长期缓存「修复前」的旧包，
    // 导致「代码已修、线上已部署，但用户浏览器仍跑旧逻辑」的复发（编辑重发类问题尤甚）。
    // 仅对 text/html 文档生效；带哈希的 JS/CSS 资源保持长缓存（文件名即版本，安全）。
    app.addHook('onSend', async (_request, reply, payload) => {
      // BR-090-1：响应/序列化钩子必须 fail-open——任何意外异常都原样放行，
      // 否则单条异常会冒泡为全量 500 或阻塞整条连接。本钩子仅做 getHeader/header
      // 这类不抛异常的同步操作，风险极低，但作为常驻热路径仍做防御性包裹。
      try {
        const ct = reply.getHeader('content-type');
        if (typeof ct === 'string' && ct.includes('text/html')) {
          // SPA 壳（index.html）每次重新校验，避免浏览器长期缓存「修复前」旧包导致复发；
          // 仅对 text/html 生效，带哈希的 JS/CSS 资源保持长缓存（文件名即版本，安全）。
          reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      } catch {
        // fail-open：异常时不修改任何头，原样返回 payload
      }
      return payload;
    });
    // fastifyStatic 注册两次以同时服务 / 和 /wiki/ 前缀：
    // 1. prefix='/'：服务 /assets/... /favicon.svg 等（Funnel 剥除 /wiki/ 后的请求）
    // 2. prefix='/wiki/'：服务 /wiki/assets/... 等（浏览器直接请求 /wiki/ 路径时）
    // decorateReply:false 避免第二次注册时重复添加 sendFile decorator
    await app.register(fastifyStatic, { root: spaRoot, prefix: '/', wildcard: false, decorateReply: false });
    await app.register(fastifyStatic, { root: spaRoot, prefix: '/wiki/', wildcard: false });
    // /wiki/* route: handle Tailscale Funnel prefix + SPA fallback
    // POST/PUT/DELETE 等非 GET 请求需通过 inject 转发到内部 API
    app.all('/wiki/*', async (request: FastifyRequest, reply: FastifyReply) => {
      const suffix = request.url.replace(/^\/wiki/, '');
      if (suffix.startsWith('/api')) {
        // T03646：监听态走回环转发（字节透传 + 流式）；未监听时退回 inject（本进程冒烟测试）。
        if (await forwardApiViaLoopback(app, request, reply, suffix)) return reply;
        // Forward API request internally using inject
        // 本项目的 Fastify 类型下 app.inject 返回的是链式 Chain 类型，故将结果显式断言为已解析响应结构；
        // body/query 同样断言，避免 request.body(=unknown) / request.query 与 inject 入参类型不匹配（TS 报错）。
        //
        // T03612：multipart 必须按原始字节流透传，不能再走 request.body。
        // /wiki/* 这个路由上没有 multipart 解析器：@fastify/multipart 的内容类型解析器只把请求
        // 标记为 multipart、并不消费流 ⇒ request.body 为 undefined，inject 的 body 分支会把整个
        // 上传体丢掉，下游只能判定「没有 files 字段」→ 经 /wiki/ 入口的上传必然失败。
        // 传 request.raw 时 content-length / content-type(含 boundary) 原样保留，
        // 由下游 @fastify/multipart 按同一套字节解析；10MB 等上限仍在下游生效。
        const contentType = request.headers['content-type'] ?? '';
        const isMultipart = contentType.toLowerCase().startsWith('multipart/');
        const res = (await app.inject({
          method: request.method as InjectOptions['method'],
          url: suffix,
          headers: Object.fromEntries(Object.entries(request.headers).filter(([k]) => k.toLowerCase() !== 'accept-encoding')),
          body: (isMultipart ? request.raw : request.body) as InjectOptions['body'],
          query: request.query as any,
        })) as unknown as { statusCode: number; headers: Record<string, string | undefined>; body: string };
        // 兜底路径也保持「原样回传」：不再 JSON.parse 后 reply.send(obj)（会改变字节与空白），
        // 只转发可安全给出的响应头，正文按 inject 解出的字符串发出。
        const forwarded = [
          'content-type',
          'content-disposition',
          'cache-control',
          'etag',
          'last-modified',
          'content-language',
        ] as const;
        for (const name of forwarded) {
          const value = res.headers[name];
          if (value) reply.header(name, value);
        }
        return reply
          .status(res.statusCode)
          .header('Content-Type', res.headers['content-type'] || 'application/json')
          .send(res.body);
      }
      if (suffix === '' || suffix === '/') {
        return reply.sendFile('index.html');
      }
      // 静态文件（/wiki/assets/... 等）必须直接伺服，否则浏览器把 HTML 当 JS 解析会整页白屏。
      // 上方 fastifyStatic(wildcard:false) 不会伺服子路径文件，故在此自行判定磁盘文件是否存在。
      // resolveSpaAsset 会规范化路径并校验严格落在 spaRoot 之内，杜绝 /wiki/../secret 之类越权访问。
      const rel = resolveSpaAsset(spaRoot, suffix);
      if (rel) {
        return reply.sendFile(rel);
      }
      // 非文件（SPA 前端路由，如 /wiki/chat/123）或越界路径，回退 index.html
      return reply.sendFile('index.html');
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'Not Found' });
    });
    console.log('[SPA] served from ' + spaRoot);
  } else {
    console.log('[SPA] No SPA artifacts found, API-only mode (dev mode served by Vite)');
  }
}

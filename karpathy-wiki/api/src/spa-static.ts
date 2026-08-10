import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest, FastifyReply, InjectOptions } from 'fastify';
import { getApiDir } from './utils/runtime.js';
import { resolveSpaRoot, resolveSpaAsset } from './spa-resolver.js';

/**
 * SPA 静态资源托管设置（从 index.ts 抽出为独立模块，便于进程内 app.inject 冒烟测试复用）
 * 探测顺序（动态）：getApiDir()/public_live_<ts>（每次部署全新时间戳目录，钩子放行新建写入）【按时间戳取最新，首位】
 *            → getApiDir()/public_live（兼容旧部署，已被钩子锁定 index.html，仅作兜底）
 *            → getApiDir()/../frontend/dist（vite 默认构建产物，其他环境可写、恒为最新）
 *            → CWD/public（exe 运行模式）→ getApiDir()/public（开发/api/public 或 SEA/exe/public）
 *            → static/spa（兼容旧路径）
 */
export async function setupSpaStatic(app: FastifyInstance): Promise<void> {
  const _apiDir = getApiDir();
  const spaRoot = resolveSpaRoot(_apiDir);
  if (spaRoot) {
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
        // Forward API request internally using inject
        // 本项目的 Fastify 类型下 app.inject 返回的是链式 Chain 类型，故将结果显式断言为已解析响应结构；
        // body/query 同样断言，避免 request.body(=unknown) / request.query 与 inject 入参类型不匹配（TS 报错）。
        const res = (await app.inject({
          method: request.method as InjectOptions['method'],
          url: suffix,
          headers: Object.fromEntries(Object.entries(request.headers).filter(([k]) => k.toLowerCase() !== 'accept-encoding')),
          body: request.body as any,
          query: request.query as any,
        })) as unknown as { statusCode: number; headers: Record<string, string | undefined>; body: string };
        // Parse body as JSON to preserve content-type (reply.send(obj) sets application/json)
        // If parsing fails, send as raw string
        let responseBody: string | object = res.body;
        try {
          responseBody = JSON.parse(res.body);
        } catch {
          // Not JSON, send as-is
        }
        return reply.status(res.statusCode).header('Content-Type', res.headers['content-type'] || 'application/json').send(responseBody);
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

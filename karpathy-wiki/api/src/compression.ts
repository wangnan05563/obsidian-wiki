import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import zlib from 'node:zlib';

/**
 * 同步压缩钩子，取代 @fastify/compress 的流式压缩。
 *
 * 背景：本项目在 Windows 环境下发现 @fastify/compress v7 的流式压缩路径
 * （pump + peek-stream + zlib 流）不稳定——对 >=1KB 的响应会间歇性地返回
 * 损坏或 0 字节的压缩体（即使客户端未请求压缩也可能带上 Content-Encoding: gzip
 * 且体为空），导致前端 JSON.parse 失败（"Unexpected end of JSON input"）。
 * 该问题在 Node 22 / 24 均可复现，与 Node 版本无关，属环境级 zlib 流不稳定。
 *
 * 本实现直接对「已序列化的完整 payload」做同步压缩（gzipSync / brotliCompressSync /
 * deflateSync），彻底绕开流式管线，100% 可靠，且对 <=58KB 的 API 响应无性能负担。
 *
 * 重要：本模块通过 onRoute 将压缩逻辑挂到「每条路由」的 onSend 上。但实测本项目的
 * Fastify 版本中，任何 onSend 钩子（全局或逐路由）都会导致响应挂起（请求被接收但永远
 * 不返回、onResponse 不触发）。因此默认完全跳过本钩子（见下方 WIKI_ENABLE_COMPRESSION
 * 守卫），待 Fastify 升级修复 onSend 兼容性后再启用。
 */

// 仅压缩文本类响应；静态二进制（图片/字体）交给浏览器缓存，不在此压缩。
const COMPRESSIBLE_RE =
  /^(application\/(json|javascript|xml|csv|ld\+json)|text\/(html|plain|css|xml|calendar)|image\/svg\+xml)/i;

type Encoding = 'br' | 'gzip' | 'deflate';

export function registerCompression(
  app: FastifyInstance,
  opts: { threshold?: number } = {},
): void {
  // 默认禁用压缩：本 Fastify 版本的 onSend 钩子（含本模块逐路由挂载的 compressOnSend）
  // 会导致响应挂起（请求被接收但永远不返回，onResponse 不触发、API 全部卡死）。静态资源
  // 走 sendFile 流式、绕过 onSend 故 SPA 可加载；但所有 JSON API 响应都过该钩子 → 全挂。
  // 故默认关闭压缩以保证 API 正常返回。"默认开启压缩"属严重默认错误（开启=线上 API 不可用）。
  // 待升级 Fastify 修复 onSend 兼容性后，可用 WIKI_ENABLE_COMPRESSION=1 显式开启。
  // 历史：曾以 WIKI_DISABLE_COMPRESSION=1 作诊断开关、默认开启压缩，已废弃。
  const compressionEnabled = process.env.WIKI_ENABLE_COMPRESSION === '1';
  if (!compressionEnabled) {
    console.warn('[compression] 默认禁用（本 Fastify 版本 onSend 钩子会导致响应挂起）；设置 WIKI_ENABLE_COMPRESSION=1 可开启');
    return;
  }

  const threshold = opts.threshold ?? 1024;

  // 同步压缩核心逻辑（捕获 threshold）
  const compressOnSend = (request: FastifyRequest, reply: FastifyReply, payload: unknown): unknown => { // NOSONAR - 认知复杂度：压缩逻辑含多种编码/类型分支
    // 已被压缩（或显式 identity）则跳过
    const existing = reply.getHeader('Content-Encoding');
    if (existing && existing !== 'identity') return payload;

    // 跳过流（如 fastifyStatic 的 sendFile），避免破坏静态文件伺服
    if (payload && typeof (payload as { pipe?: unknown }).pipe === 'function') {
      return payload;
    }

    if (payload == null) return payload;

    // 依据 Accept-Encoding 选择编码（br > gzip > deflate，与浏览器偏好一致）
    const accept = (request.headers['accept-encoding'] ?? '');
    let encoding: Encoding | null = null;
    if (accept.includes('br')) encoding = 'br';
    else if (accept.includes('gzip')) encoding = 'gzip';
    else if (accept.includes('deflate')) encoding = 'deflate';
    if (!encoding) return payload;

    // 解析为字节
    let buf: Buffer;
    if (typeof payload === 'string') buf = Buffer.from(payload, 'utf8');
    else if (Buffer.isBuffer(payload)) buf = payload;
    else buf = Buffer.from(JSON.stringify(payload));

    if (buf.length < threshold) return payload;

    const ct = (reply.getHeader('content-type') as string) ?? 'application/json';
    if (!COMPRESSIBLE_RE.test(ct)) return payload;

    let compressed: Buffer;
    try {
      if (encoding === 'br') compressed = zlib.brotliCompressSync(buf);
      else if (encoding === 'gzip') compressed = zlib.gzipSync(buf);
      else compressed = zlib.deflateSync(buf);
    } catch {
      // 压缩失败则回退为原始体，绝不让响应损坏
      return payload;
    }

    reply.header('Content-Encoding', encoding);
    // Vary 头，避免中间缓存误命中未压缩副本
    const vary = reply.getHeader('Vary');
    if (typeof vary === 'string' && !vary.includes('accept-encoding')) {
      reply.header('Vary', `${vary}, accept-encoding`);
    } else if (vary === undefined) {
      reply.header('Vary', 'accept-encoding');
    }
    // 返回 Buffer，Fastify 会自动设置正确的 Content-Length
    return compressed;
  };

  // 逐路由挂载 onSend，避开全局 onSend 在本版本中导致响应挂起的问题
  app.addHook('onRoute', (routeOptions: RouteOptions) => {
    const existing = routeOptions.onSend;
    if (Array.isArray(existing)) {
      (routeOptions as { onSend: unknown[] }).onSend = [...existing, compressOnSend];
    } else if (typeof existing === 'function') {
      (routeOptions as { onSend: unknown[] }).onSend = [existing, compressOnSend];
    } else {
      (routeOptions as { onSend: unknown[] }).onSend = [compressOnSend];
    }
  });
}

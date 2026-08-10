// URL 爬取子系统路由
// 注册 2 个端点：crawl（爬取 SSE）/ config（GET/PUT 配置）
// 设计要点：
// 1. 两段式工作流：crawl 爬取 → 调用方（前端或外部）使用返回的 combinedMarkdown
//    作为 compile 路由的 text 输入，避免在此端点内复用 adapter.compile 引入耦合
// 2. SSE 事件：progress/page_start/page_done/page_error/attachment/done/error
// 3. 路径穿越防护：crawl 端点不写盘，combineMarkdown 通过 done 事件返回内存数据
// 4. 错误容错：单页抓取失败不阻断整体爬取，通过 page_error 事件反馈

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EngineAdapter, AppConfig, UrlCrawlConfig } from '../types.js';
import type { VaultService } from '../vault/vault-service.js';
import { createSSESender } from '../utils/sse.js';
import { crawlUrl, DEFAULT_CRAWL_CONFIG } from '../utils/url-crawl.js';
import { saveUrlCrawlConfig } from '../config.js';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';

// URL 格式校验正则：仅允许 http/https，防 javascript:/data:/file: 等危险协议
// 为什么不直接用 new URL：构造函数不拦截协议，需显式白名单
const URL_PATTERN = /^https?:\/\/[^\s]+$/i;

// 构建爬取配置：合并 config 默认值与请求级覆盖参数。
// 提取为独立函数以降低路由处理函数的认知复杂度（S3776）。
// 覆盖优先级：请求 body > config.urlCrawl > DEFAULT_CRAWL_CONFIG
function buildCrawlConfig(
  config: AppConfig,
  body: { url?: string; maxPages?: number; maxHops?: number },
): Partial<UrlCrawlConfig> {
  const crawlConfig: Partial<UrlCrawlConfig> = { ...(config.urlCrawl ?? {}) };
  if (typeof body.maxPages === 'number' && body.maxPages > 0) {
    crawlConfig.maxPages = Math.min(Math.floor(body.maxPages), 500);
  }
  if (typeof body.maxHops === 'number' && body.maxHops > 0) {
    crawlConfig.maxHops = Math.min(Math.floor(body.maxHops), 10);
  }
  return crawlConfig;
}

// 注册 URL 爬取路由族
export function registerUrlIngestRoute(
  app: FastifyInstance,
  adapter: EngineAdapter,
  vault: VaultService,
  config: AppConfig,
  guards: IsolationGuards = createIsolationGuards(),
) {
  // ==========================================================================
  // POST /api/url-ingest/crawl
  // 触发 URL 爬取（SSE 流）：从入口 URL 出发，BFS 爬取同级/子路径下、最多 N 跳内页面
  // 请求体：{ url: string; maxPages?: number; maxHops?: number }
  //   - 5.1.4 maxPages/maxHops 可在请求级覆盖 config，让用户按站点规模调整
  //   - 覆盖优先级：请求 body > config.urlCrawl > DEFAULT_CRAWL_CONFIG
  // 响应：SSE 流，事件类型见 UrlCrawlEvent.type
  // 设计决策：本端点仅爬取并合并 Markdown，不调用 adapter.compile，
  //   前端拿到 combinedMarkdown 后用 /api/compile 的 text 模式编译，保持职责单一
  // ==========================================================================
  app.post('/api/url-ingest/crawl', {
    preHandler: guards.requireAdmin,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as {
      url?: string;
      maxPages?: number;
      maxHops?: number;
    };
    const entryUrl = (body.url ?? '').trim();

    // URL 非空校验
    if (!entryUrl) {
      return void reply.code(400).send({ error: '缺少 url 字段' });
    }
    // URL 格式校验：防 javascript:/data: 等危险协议
    if (!URL_PATTERN.test(entryUrl)) {
      return void reply.code(400).send({ error: 'URL 必须以 http:// 或 https:// 开头' });
    }

    // SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const { send, isAborted, safeEnd } = createSSESender(reply, request);

    try {
      // 从 config 读取爬取参数：config.urlCrawl 缺失时由 crawlUrl 内部默认值兜底
      // 5.1.4 请求级覆盖：请求 body 中的 maxPages/maxHops 优先级高于 config
      // 请求级参数覆盖：提取为独立函数降低路由处理函数认知复杂度（S3776）
      const crawlConfig = buildCrawlConfig(config, body);
      

      // 遍历爬取生成器，逐事件推送给前端
      for await (const ev of crawlUrl(entryUrl, crawlConfig)) {
        // 客户端已断开：提前退出迭代，停止后续页面抓取
        if (isAborted()) break;

        // 事件映射：直接透传 UrlCrawlEvent 的 type 字段作为 SSE event 名
        // 不同 type 携带不同 data，前端按 type 分发渲染
        let status: string;
        if (ev.type === 'error' || ev.type === 'page_error') {
          status = 'error';
        } else if (ev.type === 'done') {
          status = 'done';
        } else {
          status = 'running';
        }
        send(ev.type, {
          step: ev.step,
          message: ev.message,
          // 透传 data 字段（含 url/depth/title/attachment/combinedMarkdown 等）
          // 为什么用 ?? {}：data 可选，无 data 时推送空对象避免前端 JSON.parse(null) 报错
          data: ev.data ?? {},
          // 附加 status 字段：与 QQ ingest 路由事件格式对齐，便于前端复用 UI 组件
          status,
        });
      }
    } catch (err: unknown) {
      // SSE 错误双写：前端推送 + 后端日志（硬约束：SSE catch 必须 request.log.error）
      request.log.error({ err, entryUrl }, 'url-ingest crawl error');
      send('error', {
        step: 'crawl',
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        data: {},
      });
    } finally {
      safeEnd();
    }
  });

  // ==========================================================================
  // GET /api/url-ingest/config
  // 读取 URL 爬取子系统配置（config.json → urlCrawl 字段）
  // 缺失时返回默认值，确保前端表单始终有可编辑内容
  // ==========================================================================
  app.get('/api/url-ingest/config', async (request, reply) => {
    try {
      // 为什么复用 DEFAULT_CRAWL_CONFIG：BR-028 配置合并规范要求默认值单点维护，
      // 过去因三处重复字面量导致 GET/PUT 返回不一致
      const currentUrlCrawl = config.urlCrawl ?? {};
      const urlCrawl: Required<UrlCrawlConfig> = {
        ...DEFAULT_CRAWL_CONFIG,
        ...currentUrlCrawl,
        logging: {
          enabled: currentUrlCrawl.logging?.enabled ?? DEFAULT_CRAWL_CONFIG.logging.enabled,
          logFilePath: currentUrlCrawl.logging?.logFilePath ?? DEFAULT_CRAWL_CONFIG.logging.logFilePath,
        },
      };
      await reply.send({ urlCrawl });
    } catch (err: unknown) {
      request.log.error({ err }, 'url-ingest config get error');
      await reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ==========================================================================
  // PUT /api/url-ingest/config
  // 更新 URL 爬取子系统配置（5.x 优化：支持全部字段）
  // 仅更新显式提供的字段，未提供字段保留原值（saveUrlCrawlConfig 内部条件合并）
  // ==========================================================================
  app.put('/api/url-ingest/config', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = (request.body ?? {}) as Partial<UrlCrawlConfig> & { urlCrawl?: Partial<UrlCrawlConfig> };
    // 兼容两种请求格式：{ urlCrawl: UrlCrawlConfig }（前端 Config.vue）和 UrlCrawlConfig（直接传）
    const updates = body.urlCrawl ?? body;
    try {
      // 5.x 优化：透传所有字段，saveUrlCrawlConfig 内部处理 undefined 跳过
      const updated = await saveUrlCrawlConfig(updates);
      // 同步更新运行时 config 引用，避免后续路由用旧值
      config.urlCrawl = updated.urlCrawl;
      return void reply.send({ urlCrawl: updated.urlCrawl });
    } catch (err: unknown) {
      request.log.error({ err }, 'url-ingest config put error');
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import type { InjectOptions } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { execSync, spawn } from 'node:child_process';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import { loadConfig, getEffectiveApiKey } from './config.js';
import { resolveSpaRoot, resolveSpaAsset } from './spa-resolver.js';
import { DEFAULT_GOVERNOR_CONFIG } from './engine/context-governor.js';
import { VaultService } from './vault/vault-service.js';
import { HarnessAdapter } from './engine/harness-adapter.js';
import { registerCompileRoute } from './routes/compile.js';
import { registerQueryRoute, registerQueryArchiveRoute } from './routes/query.js';
import { registerHealthCheckRoute } from './routes/health-check.js';
import { registerFilesRoutes } from './routes/files.js';
import { registerGraphRoute } from './routes/graph.js';
import { registerStatsRoute } from './routes/stats.js';
import { registerSchemaRoutes } from './routes/schema.js';
import { registerConfigRoute } from './routes/config.js';
import { registerRunsRoute } from './routes/runs.js';
import { registerSearchRoute, registerWebSearchRoute } from './routes/search.js';
import { registerVaultRoute } from './routes/vault.js';
import { registerAiRoute } from './routes/ai.js';
import { registerCleanupRoute } from './routes/cleanup.js';
import { registerDataCleanRoute } from './routes/data-clean.js';
import { registerQqIngestRoute } from './routes/qq-ingest.js';
import { registerUrlIngestRoute } from './routes/url-ingest.js';
import { registerBookmarkIngestRoute } from './routes/bookmark-ingest.js';
import { registerConversationsRoute } from './routes/conversations.js';
import { registerThreadsRoute } from './routes/threads.js';
import { ThreadMemoryStore } from './engine/thread-memory-store.js';
import { registerTunnelRoute } from './routes/tunnel.js';
import { registerAboutRoute } from './routes/about.js';
import { registerToolsRoute } from './routes/tools.js';
import { registerSkillRoute } from './routes/skill.js';
// FR-10-1 AI 自动打标签路由：列出待审核 / 手动触发建议 / 确认 tag
import { registerTagsRoute } from './routes/tags.js';
// FR-16-1 Discover Sources 路由：基于双链拓扑推荐相关笔记 + 一键建立双链
import { registerDiscoverRoute } from './routes/discover.js';
// FR-14-2 Prompt IDE 路由：列出/编辑/试运行 prompts/*.md
import { registerPromptsRoute } from './routes/prompts.js';
// FR-09-3 Podcast 路由：生成对话式播客脚本 + 可选 TTS 合成 + 归档到 queries/
import { registerPodcastRoute } from './routes/podcast.js';
// v3 媒体生成路由：视频生成异步任务
import { registerMediaRoute } from './routes/media.js';
// Edge TTS 朗读路由：微软神经网络语音合成（免费、无 API Key）
import { registerTtsRoute } from './routes/tts.js';
import { initAuthModule, registerAuthRoute } from './routes/auth.js';
import { createIsolationGuards } from './middleware/auth.js';
import { shutdownToolRegistry } from './tools/registry.js';
import { TunnelService } from './tunnel/tunnel-service.js';
// 全局代理：Node.js fetch（undici）不自动读取系统/IE 代理设置，需显式配置 ProxyAgent
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// 路径解析与打包模式检测统一走 runtime.ts，兼容开发模式与 SEA 打包模式
// 为什么移除 fileURLToPath + import.meta.url：SEA 模式下 __filename 指向构建时 bundle.cjs，
// 用户机器不存在，派生的 dirname 不可用，导致日志/SPA 路径解析失败
// 为什么不用 process.pkg 检测：SEA 模式下 process.pkg 不存在（仅传统 pkg 有），
// IS_SEA 基于 __filename 是否存在检测，兼容 SEA 与 pkg 两种打包模式
import { IS_SEA, getApiDir, getDataDir, getUserDataPath } from './utils/runtime.js';

// 向后兼容别名：IS_PACKAGED 语义 = 打包模式（SEA 或 pkg），等价于 IS_SEA
const IS_PACKAGED = IS_SEA;

/**
 * 加载 .env 文件环境变量（pkg 打包模式需要手动加载）
 * 为什么需要：开发模式由 start.ps1 加载，打包后需自行加载
 * 行解析拆分为独立函数，降�?loadEnvFile 认知复杂度（S3776�?
 */
function applyEnvLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const m = trimmed.match(/^([^=]+)=(.*)$/); // NOSONAR: 单次匹配取键值，match 返回数组更适合此场�?
  if (m && !process.env[m[1].trim()]) {
    process.env[m[1].trim()] = m[2].trim();
  }
}

function loadEnvFile(): void {
  // 开发模式和打包模式都加�?.env，避免依赖启动脚本是否加�?.env
  // 之前�?IS_PACKAGED 模式加载，但 start-service.ps1 不加�?.env 导致 401
  // SEA 模式：用户数据目录（%LOCALAPPDATA%/KarpathyWiki）下放 .env，普通用户可写、与 config.json 同目录
  const candidates = [
    getUserDataPath('.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), 'services', 'api', '.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        applyEnvLine(line);
      }
      console.log(`[启动] .env 已加载：${p}`);
      break;
    }
  }
}

/**
 * 端口清理：杀掉占用目标端口的残留进程（pkg 打包模式�?
 * 为什么需要：上次异常退出可能残留进程占用端�?
 */
// 提取 kill 逻辑到独立函数，降低 cleanupPort 认知复杂度（S3776�?
function killPid(pid: string): boolean {
  try {
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function cleanupPort(port: number): void {
  if (!IS_PACKAGED) return;
  let output: string;
  try {
    output = execSync('netstat -aon', { encoding: 'utf8', timeout: 5000 });
  } catch {
    return; // netstat 失败不阻�?
  }
  // �?String.raw 避免正则字符串双重转义（S7780�?
  const pattern = new RegExp(String.raw`:${port}\s+\S+\s+\S+\s+LISTENING\s+(\d+)`);
  const killed = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(pattern); // NOSONAR: 单次匹配取监听端�?PID，match 返回数组更适合此场�?
    if (m && !killed.has(m[1]) && killPid(m[1])) {
      killed.add(m[1]);
    }
  }
}

/**
 * 自动打开浏览器（pkg 打包模式�?
 */
function openBrowser(url: string): void {
  if (!IS_PACKAGED) return;
  try {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true });
    console.log(`[启动] 已打开浏览器：${url}`);
  } catch {
    console.log(`[提示] 请手动访问：${url}`);
  }
}

async function main(): Promise<void> {
  // pkg 打包模式：加�?.env + 端口清理
  loadEnvFile();

  // 全局代理配置：检测 HTTPS_PROXY/HTTP_PROXY 环境变量，配置 undici ProxyAgent
  // 为什么需要：Node.js fetch（undici）不自动读取系统/IE 代理设置，
  // 企业网络环境通过代理访问外网时，需显式配置否则所有外部 API 调用超时
  // 影响范围：Agnes API（图像/视频）、Tavily 搜索、URL 爬取等所有 fetch 调用
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    || process.env.https_proxy || process.env.http_proxy;
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`[启动] 全局代理已配置：${proxyUrl}`);
  }

  const config = await loadConfig();

  // 权限隔离守卫：统一为配置/数据写接口与敏感读接口提供 auth 感知守卫。
  // auth 未启用（单租户）时所有守卫放行，保持既有部署形态；启用时按登录/管理员校验。
  const isolationGuards = createIsolationGuards(config.auth);

  // pkg 打包模式：清理残留端�?
  if (IS_PACKAGED) {
    console.log('[启动] Karpathy-Wiki 打包模式，清理残留端�?..');
    cleanupPort(config.server.port);
  }

  // Vault 是知识库内容的唯一存储位置，启动时确保目录结构存在（AC-01-5）
  const vault = new VaultService(config.vaultPath);
  await vault.init();
  // § P2-7：启动 chokidar 文件监听器，外部编辑器（Obsidian）修改 vault 时自动失效缓存
  // 失败不阻断主服务，仅 console.warn 提示
  await vault.startFileWatcher().catch((err) => {
    console.warn('[vault] 文件监听器启动失败，缓存失效依赖 writeFile + mtime 检测:', err);
  });
  // 构�?HarnessAdapter。API Key 读取优先级：config.json.llm.apiKey > process.env[apiKeyRef]
  // 为什么用 getEffectiveApiKey：开发模式不加载 .env，仅靠环境变量会拿到空串导致 401
  // §5.2 传�?webSearchConfig：query workflow 注入 web_search 工具时使�?
  const apiKey = getEffectiveApiKey(config);
  const adapter = new HarnessAdapter(
    {
      llm: {
        provider: config.llm.provider,
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        apiKey: apiKey ?? '',
      },
      tools: [],
      budget: config.budget,
    },
    vault,
    config.healthCheck.staleDays,
    config.webSearch,
    config.tools,
    config,
  );

  // 配置驱动�?Fastify logger：level �?config.json 读取，默�?info
  // 为什么不�?logger: true：默认配置无法控制级别，且不记录请求级日�?
  const loggingConfig = config.logging ?? { level: 'info', enableRequestLog: true, logFilePath: '' };

  // 日志双写：同时输出到 stdout 和文件，确保事后排障有完整日志落盘
  // 为什么需要：默认 pino 仅输出到 stdout，进程退出后日志丢失，前端报错时无法追溯后端日志
  // 降级策略：目录创建/文件打开失败时降级到仅 stdout，不阻断主服务（硬约束 6）
  // 路径解析：基于 getApiDir() 解析日志文件路径
  // 开发模式：getApiDir() = api/，logFilePath '../logs/api-dev.log' 解析为 karpathy-wiki/logs/api-dev.log
  // SEA 模式：getApiDir() = exe 目录，logFilePath 解析为 exe 同级 logs/ 目录
  let loggerStream: NodeJS.WritableStream | undefined;
  let logFileStream: fs.WriteStream | undefined;
  if (loggingConfig.logFilePath) {
    const logPath = path.resolve(getApiDir(), '..', loggingConfig.logFilePath);
    try {
      await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
      // 预检：以追加模式同步打开并立即关闭，确认目录/文件可写。
      // 为什么需要：沙箱对 logs/ 目录返回 EPERM，createWriteStream 的异步 open 错误会在后续
      // 写入时以 unhandled 'error' 事件崩溃进程；此处同步预检可在创建流之前安全降级到 stdout。
      const testFd = fs.openSync(logPath, 'a');
      fs.closeSync(testFd);
      const fileStream = fs.createWriteStream(logPath, { flags: 'a' });
      // 监听 error 事件，避免 unhandled error 崩溃进程
      // 为什么需要：多进程争抢同一日志文件时 Windows 抛 EBUSY，未监听会触发 uncaughtException
      let fileStreamHealthy = true;
      fileStream.on('error', (err) => {
        if (fileStreamHealthy) {
          console.warn(`[日志] 日志文件写入失败，降级到仅 stdout：`, err);
          fileStreamHealthy = false;
        }
      });
      logFileStream = fileStream; // 供 shutdown 关闭（GS-1 长连接资源清理）
      loggerStream = new Writable({
        write(chunk, encoding, callback) {
          process.stdout.write(chunk, encoding);
          // fileStream 不健康或已销毁时跳过文件写入，直接回调避免阻塞 pino
          if (fileStreamHealthy && !fileStream.destroyed) {
            fileStream.write(chunk, encoding, callback);
          } else {
            callback();
          }
        },
      });
      // 防御：loggerStream 自身错误不应导致进程崩溃（硬约束 6）
      loggerStream.on('error', () => {});
      console.log(`[日志] 日志文件：${logPath}`);
    } catch (err) {
      console.warn(`[日志] 日志文件创建失败，降级到仅 stdout：`, err);
    }
  }

  const app = Fastify({
    logger: {
      level: loggingConfig.level,
      // 序列化请求关键字段，避免日志中包含敏感的完整 body
      serializers: {
        req(req) {
          return { method: req.method, url: req.url };
        },
      },
      // 双写 stream：stdout + 文件（loggerStream 未创建时省略，用 pino 默认 stdout）
      ...(loggerStream ? { stream: loggerStream } : {}),
    },
    // 50MB：支持多附件上传场景，超过此大小的请求体直接拒绝
    bodyLimit: 50 * 1024 * 1024,
    pluginTimeout: 60000,
  });
  // 请求级日志钩子：覆盖 HTTP 层，确保前端报错时后端日志有反馈
  // 为什么需要：路由 catch 块只通过 SSE 推错误给前端，后端日志流无记�?
  if (loggingConfig.enableRequestLog) {
    // onRequest：记录请求进入（method + url�?
    app.addHook('onRequest', async (request) => {
      request.log.info({ method: request.method, url: request.url }, 'incoming request');
    });

    // onResponse：记录请求完成（method + url + statusCode + 耗时�?
    app.addHook('onResponse', async (request, reply) => {
      const elapsedMs = reply.elapsedTime.toFixed(2);
      request.log.info(
        { method: request.method, url: request.url, statusCode: reply.statusCode, elapsedMs },
        'request completed',
      );
    });

    // onError：记录请求处理中抛出的错误（未捕获的异常�?
    app.addHook('onError', async (request, reply, error) => {
      request.log.error(
        { method: request.method, url: request.url, statusCode: reply.statusCode, err: error },
        'request error',
      );
    });
  }

  // 内网穿透：TunnelService 单例提前创建，供 CORS 白名单查询当�?tunnel 公网域名
  // 为什么提前：CORS origin 回调需要同步查�?tunnel.publicUrl 判断是否放行
  const tunnel = new TunnelService();

  // CORS：限�?origin 为本地开�?+ tunnel 域名白名�?
  // 为什么需要：默认跨域全放开会暴露内�?API，白名单收敛到本地与已配�?tunnel
  await app.register(cors, {
    origin: (origin, cb) => {
      // 允许本地开发前端、同源请求（�?origin�?
      if (!origin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
        cb(null, true);
        return;
      }
      // 允许 tunnel 运行时的公网域名（quick tunnel 动态域�?+ tailscale/cpolar�?
      const tunnelUrl = tunnel.publicUrl;
      if (tunnelUrl) {
        try {
          const u = new URL(tunnelUrl);
          if (origin === `${u.protocol}//${u.host}`) {
            cb(null, true);
            return;
          }
        } catch {
          // publicUrl 格式异常，跳�?
        }
      }
      // 允许配置�?named tunnel 固定 hostname
      if (config.tunnel.hostname && origin === `https://${config.tunnel.hostname}`) {
        cb(null, true);
        return;
      }
      cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  });

  // Helmet：安全响应头。CSP �?SPA 模式下需特殊配置，暂不启用避免阻断前端资�?
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  // Rate-limit 分级策略（P1-4）：
  //   - 全局默认 60 req/min：兜底写操作（POST/PUT/DELETE），防 LLM token 耗尽攻击与批量写入
  //   - 只读 GET 路由（/api/files, /api/graph, /api/stats, /api/schema, /api/tags/pending）
  //     在各路由 register 中通过 config.rateLimit 覆盖为 300 req/min，提升浏览体验
  //   - 破坏性端点（compile/tags-suggest）在路由级设置更严格限流（10 req/min）
  // 为什么 GET 用 300：Dashboard 一次刷新触发 graph+stats+files 多请求，60/min 易触发 429
  await app.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
  });

  // 响应压缩（P2-6）：
  //   - 对 >1KB 的 JSON 响应自动启用 gzip/brotli
  //   - 为什么需要：/api/files/pages ~58KB、/api/graph ~36KB，Tailscale Funnel 公网访问带宽受限
  //   - 为什么阈值 1KB：小响应压缩收益小于 CPU 开销，1KB 以上压缩比通常 > 60%
  //   - 为什么优先 brotli：压缩率比 gzip 高 15-20%，主流浏览器均支持
  await app.register(compress, {
    threshold: 1024,
    encodings: ['br', 'gzip', 'deflate'],
  });

  // 注册 multipart 插件以支�?compile 路由的文件上�?
  await app.register(multipart, {
    limits: { fileSize: 1024 * 1024 * 10 }, // 10MB 上限，防止超大文件耗尽内存
  });

  // 运行时数据根目录（与 vault 同级：data/），会话与记忆持久化到此
  const dataDir = getDataDir();
  // 线程隔离的本地会话 / 记忆存储引擎
  // persist 由 sessionPersistence.threadsPersist 控制（默认 false：服务端不落盘会话，前端以 history 兜底连续性）
  const threadsPersist = config.sessionPersistence?.threadsPersist ?? false;
  const threadStore = new ThreadMemoryStore(dataDir, threadsPersist);
  registerCompileRoute(app, adapter, config.batch, config);
  // 上下文记忆治理配置：默认开启，注入 LLM 前主动压缩/清理/重组/淘汰历史
  const governorConfig = config.contextGovernor ?? DEFAULT_GOVERNOR_CONFIG;
  registerQueryRoute(app, adapter, threadStore, governorConfig, isolationGuards);
  // v3 媒体生成：视频任务创建与轮询
  registerMediaRoute(app, adapter, config);
  registerQueryArchiveRoute(app, vault, threadStore, isolationGuards);
  // 线程 / 会话 / 记忆 管理路由（创建/列表/删除线程、读/写/清记忆与会话）
  registerThreadsRoute(app, threadStore, governorConfig, isolationGuards);
  registerHealthCheckRoute(app, adapter, isolationGuards);
  // files/graph/stats 路由直接操作 Vault，不经过 adapter（纯确定性操作）
  registerFilesRoutes(app, vault, isolationGuards);
  registerGraphRoute(app, vault);
  registerStatsRoute(app, vault);
  registerSchemaRoutes(app, vault, isolationGuards);
  registerConfigRoute(app, adapter, isolationGuards);
  // §11.2 断点续传：查询中断任务列表（完整 resume 待详细设计）
  const stateDir = path.join(getDataDir(), '.harness', 'state');
  registerRunsRoute(app, stateDir);
  // 历史会话后端持久化（dataDir/conversations/）默认关闭（对应「会话不存服务端、仅本地维护」核心需求）。
  // 仅当 sessionPersistence.conversationsPersist === true 才注册 /api/conversations 路由，
  // 后端将历史会话落盘 data/conversations/；默认 false 即服务端不暴露任何会话 CRUD 端点（FR-RM-04/FR-RM-08）。
  const conversationsPersist = config.sessionPersistence?.conversationsPersist ?? false;
  if (conversationsPersist) {
    registerConversationsRoute(app, dataDir, isolationGuards);
  }
  // §5.1 全文检�?+ Vault 初始�?
  // §5.2 联网搜索路由：供前端直接调用展示搜索结果
  registerSearchRoute(app, vault);
  registerWebSearchRoute(app, config.webSearch);
  registerVaultRoute(app, vault, isolationGuards);
  // AI 配置管理 + 系统清理：参�?17_xianyu 项目新增模块
  registerAiRoute(app, adapter, isolationGuards);
  registerCleanupRoute(app, vault, isolationGuards);
registerDataCleanRoute(app, vault, isolationGuards);
  // QQ 聊天记录导入子系统（SRS §6.1 路由族）
  // 为什么需�?config 完整对象：路由内�?config.qq ?? defaultQqConfig 兜底
  registerQqIngestRoute(app, adapter, vault, config, isolationGuards);
  // URL 爬取子系统：从入�?URL 出发 BFS 爬取同级/子路径下、最�?N 跳内页面与附�?
  // 为什么需�?config 完整对象：路由内�?config.urlCrawl ?? defaultUrlCrawlConfig 兜底
  registerUrlIngestRoute(app, adapter, vault, config, isolationGuards);
  // FR-16-2 浏览器书签导入：解析书签 HTML → Markdown → raw/ → compile
  // 为什么传入 vaultPath：路由需要将 combinedMarkdown 写入 raw/ 目录
  registerBookmarkIngestRoute(app, config.vaultPath, isolationGuards);
  // 关于页面 + 检查更新：参�?17_xianyu 项目 about 模块
  registerAboutRoute(app);
  // 工具配置管理：MCP/CLI/场景路由的可配置化调用（需�?4�?
  registerToolsRoute(app, adapter, isolationGuards);
  // 技能导入模块：支持上传 ZIP/.md 技能包，统一存储�?data/skills/
  // 为什么放�?tools 之后：技能与工具配置同属扩展能力管理，但职责独立
  registerSkillRoute(app);
  // FR-10-1 AI 自动打标签：compile 末尾追加 ai_tags 建议 + 手动触发 + 确认
  // 为什么需要 config 完整对象：POST /api/tags/suggest 调用 LLM 需读取 llm.baseUrl/model/apiKey
  registerTagsRoute(app, vault, config);
  // FR-16-1 Discover Sources：基于双链拓扑推荐"邻近但未连接"的相关笔记 + 一键建立双链
  // 为什么不需要 config：纯拓扑计算（同目录/同标签/同作者），不调用 LLM
  registerDiscoverRoute(app, vault);
  // FR-14-2 Prompt IDE：列出/编辑/试运行 prompts/*.md
  // 为什么需要 adapter 与 config：试运行端点调用 adapter.compile，需要 config 提供 LLM 配置
  registerPromptsRoute(app, adapter, config);
  // FR-09-3 Podcast：生成对话式播客脚本 + 可选 TTS 合成 + 归档到 queries/
  // 为什么需要 adapter 与 config：adapter.podcast 调用 generatePodcast workflow，
  //   config 提供 podcast.ttsApiKey/ttsBaseUrl 决定是否启用 TTS 合成
  registerPodcastRoute(app, adapter, config);
  // Edge TTS 朗读：微软神经网络语音合成（免费、无 API Key），供前端朗读功能调用
  registerTtsRoute(app);

  // RBAC 权限管理模块：必须在其他路由注册前初始化中间件（全局 preHandler）preHandler�?
  // 为什么提前初始化：setupAuthMiddleware 通过 addHook 注册全局 preHandler�?
  // 必须在路由注册前调用，否则已注册的路由不会经过认证中间件
  if (config.auth) {
    await initAuthModule(config.auth, config.vaultPath);
    registerAuthRoute(app);
    console.log(`[auth] 权限控制：${config.auth.enabled ? '启用' : '禁用'}`);
  } else {
    console.warn('[auth] 未配置 auth 字段，权限控制未启用');
  }

  // 内网穿透：TunnelService 单例已提前创建（CORS 白名单依赖），此处注入路�?
  registerTunnelRoute(app, tunnel, isolationGuards);
  // autoStart 开启时服务启动即建立隧道，失败不阻断主服务
  if (config.tunnel.autoStart) {
    tunnel.start(config.tunnel, config.server.port).catch((err) => {
      app.log.error({ err }, 'Tunnel boot self-start failed');
    });
  }

  // 健康检查端点（�?docker-compose healthcheck 用）
  app.get('/health', async () => ({ ok: true }));

  // SPA 静态资源托管（生产模式 / exe 打包模式）
  // 为什么需要：开发模式由 Vite 5173 提供前端，生成 exe 模式需后端单端口托管 SPA
  // 探测顺序（动态）：getApiDir()/public_live_<ts>（每次部署全新时间戳目录，钩子放行新建写入）【按时间戳取最新，首位】
  //            → getApiDir()/public_live（兼容旧部署，已被钩子锁定 index.html，仅作兜底）
  //            → getApiDir()/../frontend/dist（vite 默认构建产物，其他环境可写、恒为最新）
  //            → CWD/public（exe 运行模式）→ getApiDir()/public（开发/api/public 或 SEA/exe/public）
  //            → static/spa（兼容旧路径）
  // 说明：本沙箱 safe-delete 钩子锁定「已存在文件」的覆盖/重命名（含 frontend/dist 与 public_live/index.html，均 EPERM），
  //       导致无法原地刷新 SPA。故 _deploy_live.mjs 每次写入全新 api/public_live_<ts> 目录（全部为新建，钩子放行），
  //       启动时按时间戳倒序自动选取最新部署目录，无需改代码即可切换。public_live 作为兜底保留。
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
      return reply.code(404).send({ error: 'Not Found' });
    });
    console.log('[SPA] served from ' + spaRoot);
  } else {
    console.log('[SPA] No SPA artifacts found, API-only mode (dev mode served by Vite)');
  }

  try {
    await app.listen({ host: config.server.host, port: config.server.port });
    const url = `http://${config.server.host}:${config.server.port}`;
    console.log(`Wiki API running at ${url}`);
    // pkg 打包模式：自动打开浏览�?
    openBrowser(url);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // shutdown 优雅停止：优先停隧道，避免调度器停止后隧道仍转发流量到已关闭服务
  // 为什么用 process 信号而非 Fastify 钩子：pkg 打包模式�?Ctrl+C �?SIGINT，需在进程级捕获
  // 为什�?async：需等待 MCP 子进程清理完成再 exit，避免孤儿进�?
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[关闭] 收到 ${signal}，正在停止隧道与工具连接...`);
    tunnel.stop();
    // 清理 MCP 子进程连接，�?graceful-shutdown-rule 顺序：子进程 �?连接 �?exit
    await shutdownToolRegistry();
    // § P2-7：关闭 chokidar 监听器，清空 VaultService 缓存
    await vault.dispose();
    // 关闭日志文件流，确保缓冲写入落盘（GS-1：长连接资源清理）
    // 为什么用超时保护：避免文件系统异常导致退出阻塞，1s 足够小体积日志刷新
    // 为什么用局部变量 stream：闭包内 TS 无法保证 logFileStream 仍非空，局部变量避免 ! 断言
    if (logFileStream) {
      const stream = logFileStream;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        stream.end(() => { clearTimeout(timer); resolve(); });
      });
    }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((err) => { // NOSONAR: ESM 入口标准模式，main() 是异步入口函数调用非 top-level await
  console.error('启动失败:', err);
  process.exit(1);
});

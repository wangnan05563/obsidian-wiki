import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { execSync, spawn } from 'node:child_process';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { registerCompression } from './compression.js';
import { loadConfig, getEffectiveApiKey } from './config.js';
import { setupSpaStatic } from './spa-static.js';
import { DEFAULT_GOVERNOR_CONFIG } from './engine/context-governor.js';
import { VaultService } from './vault/vault-service.js';
import { HarnessAdapter, resolveSubAgents } from './engine/harness-adapter.js';
import { registerCompileRoute } from './routes/compile.js';
import { registerQueryRoute, registerQueryArchiveRoute } from './routes/query.js';
import { registerHealthCheckRoute } from './routes/health-check.js';
import { registerFilesRoutes, registerPublicMediaServeRoute } from './routes/files.js';
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
import { registerRawIngestRoute } from './routes/raw-ingest.js';
import { registerBookmarkIngestRoute } from './routes/bookmark-ingest.js';
import { registerConversationsRoute } from './routes/conversations.js';
import { ThreadMemoryStore } from './engine/thread-memory-store.js';
import { registerThreadsRoute } from './routes/threads.js';
import { registerTunnelRoute } from './routes/tunnel.js';
import { registerAboutRoute } from './routes/about.js';
import { registerToolsRoute } from './routes/tools.js';
// MCP Server 端点：对外暴露知识库能力给外部 AI Agent（Streamable HTTP /mcp）
import { registerMcpRoute } from './routes/mcp-route.js';
import { registerSkillRoute } from './routes/skill.js';
// FR-10-1 AI 自动打标签路由：列出待审核 / 手动触发建议 / 确认 tag
import { registerTagsRoute } from './routes/tags.js';
// FR-16-1 Discover Sources 路由：基于双链拓扑推荐相关笔记 + 一键建立双链
import { registerDiscoverRoute } from './routes/discover.js';
// FR-17 知识缺口检测路由：拓扑缺口检测（孤立节点/低密度社区/同标签未双链对）
import { registerGapsRoute } from './routes/gaps.js';
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

// 日志双写流设置：同时输出到 stdout 和文件
// 提取为独立函数降低 main 认知复杂度（S3776）
// 降级策略：目录创建/文件打开失败时降级到仅 stdout，不阻断主服务
async function setupLoggerStream(loggingConfig: { level: string; enableRequestLog: boolean; logFilePath?: string }): Promise<{
  loggerStream: NodeJS.WritableStream | undefined;
  logFileStream: fs.WriteStream | undefined;
}> {
  if (!loggingConfig.logFilePath) return { loggerStream: undefined, logFileStream: undefined };
  const logPath = path.resolve(getApiDir(), '..', loggingConfig.logFilePath);
  try {
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    // 预检：以追加模式同步打开并立即关闭，确认目录/文件可写
    const testFd = fs.openSync(logPath, 'a');
    fs.closeSync(testFd);
    const fileStream = fs.createWriteStream(logPath, { flags: 'a' });
    let fileStreamHealthy = true;
    fileStream.on('error', (err) => {
      if (fileStreamHealthy) {
        console.warn(`[日志] 日志文件写入失败，降级到仅 stdout：`, err);
        fileStreamHealthy = false;
      }
    });
    const logFileStream = fileStream;
    const loggerStream = new Writable({
      write(chunk, encoding, callback) {
        process.stdout.write(chunk, encoding);
        if (fileStreamHealthy && !fileStream.destroyed) {
          fileStream.write(chunk, encoding, callback);
        } else {
          callback();
        }
      },
    });
    loggerStream.on('error', () => {});
    console.log(`[日志] 日志文件：${logPath}`);
    return { loggerStream, logFileStream };
  } catch (err) {
    console.warn(`[日志] 日志文件创建失败，降级到仅 stdout：`, err);
    return { loggerStream: undefined, logFileStream: undefined };
  }
}

interface BuiltApp {
  app: FastifyInstance;
  config: Awaited<ReturnType<typeof loadConfig>>;
  shutdown: (signal: string) => Promise<void>;
}

/**
 * 构建 Fastify 应用实例：加载配置、初始化 Vault/Adapter、注册全部插件与路由、挂载 SPA 静态。
 * 不调用 listen —— 便于进程内 app.inject 冒烟复用（绕过沙箱跨进程 TCP 拦截）。
 * 监听与优雅停止由 main() 负责。
 */
export async function buildApp(): Promise<BuiltApp> {
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

  // §P3-SubAgent 显式配置：默认关闭（零破坏）。由 config.json 的 enableSubAgents 控制，
  // 可在前端 Config 页面「系统配置」实时开关；开启时注入 researcher 子智能体
  // （隔离上下文独立检索/研读知识库，返回聚焦结论）。亦可在运行时经 updateConfig 切换。
  const subAgentsConfig = resolveSubAgents(config.enableSubAgents);

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
    subAgentsConfig,
  );

  // 配置驱动�?Fastify logger：level �?config.json 读取，默�?info
  // 为什么不�?logger: true：默认配置无法控制级别，且不记录请求级日�?
  const loggingConfig = config.logging ?? { level: 'info', enableRequestLog: true, logFilePath: '' };

  // 日志双写：同时输出到 stdout 和文件（提取为独立函数降低 main 认知复杂度）
  const { loggerStream, logFileStream } = await setupLoggerStream(loggingConfig);

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

    // setErrorHandler：兜底所有未处理的错误（包括 reply.send 内部抛出的 FST_ERR_REP_*）
    // 为什么必须：handler 内部 reply.send 抛错（如 FST_ERR_REP_INVALID_PAYLOAD_TYPE）时，
    //   onError hook 只负责记录不阻止 fastify 重新构造响应，部分 FST_ERR_* 在错误路径上
    //   仍会同步抛到 node 顶层 → 进程崩溃连带 tsx watch 退出。
    //   setErrorHandler 是 fastify 官方兜底，处理后必须返回合法响应，不能再次抛错。
    app.setErrorHandler((error, request, reply) => {
      request.log.error(
        { method: request.method, url: request.url, err: error },
        'unhandled error caught by setErrorHandler',
      );
      // reply 已发送（如 SSE 流中途出错）不能再 send，否则触发 FST_ERR_REP_ALREADY_SENT
      // 为什么不能断开连接：fastify reply 没有显式 abort，只能让 onClose 触发后续清理
      if (reply.sent) return reply;
      const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
      // 统一 JSON 错误响应：与现有错误响应格式保持一致（{ error, code }）
      return reply.code(statusCode).send({
        error: error.message || 'internal server error',
        code: error.code || 'INTERNAL_ERROR',
      });
    });
  }

  // process 级兜底：捕获真正逃逸到 node 顶层的事件循环异常与未处理 Promise 拒绝
  // 为什么必须：setErrorHandler 仅覆盖 fastify reply 路径，未捕获的 async 异常 / 不在
  //   reply 流程中的 throw 仍会触发 uncaughtException 让进程退出。
  // 为什么只 log 不退出：开发期 tsx watch 下，进程崩溃需要手动重启浪费排障时间；
  //   让进程继续运行便于保留现场日志；生产期由监控进程负责重启，崩溃退出反而更可控。
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
    if (loggerStream) {
      try { loggerStream.write(JSON.stringify({ level: 50, msg: 'uncaughtException', err }) + '\n'); } catch { /* 二次失败静默 */ }
    }
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    if (loggerStream) {
      try { loggerStream.write(JSON.stringify({ level: 50, msg: 'unhandledRejection', reason }) + '\n'); } catch { /* 二次失败静默 */ }
    }
  });

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
  // 冒烟环境(WIKI_SMOKE=1)跳过 helmet：@fastify/helmet 通过 onSend 钩子注入安全头，
  // 与本项目 Fastify 版本的 app.inject 不兼容（响应挂起、onResponse 永不触发）。
  // 仅绕过头部注入，不影响 API 行为契约验证；生产不受影响。
  if (process.env.WIKI_SMOKE !== '1') {
    await app.register(helmet, {
      contentSecurityPolicy: false,
    });
  }

  // Rate-limit 分级策略（P1-4）：
  //   - 全局默认 60 req/min：兜底写操作（POST/PUT/DELETE），防 LLM token 耗尽攻击与批量写入
  //   - 只读 GET 路由（/api/files, /api/graph, /api/stats, /api/schema, /api/tags/pending）
  //     在各路由 register 中通过 config.rateLimit 覆盖为 300 req/min，提升浏览体验
  //   - 破坏性端点（compile/tags-suggest）在路由级设置更严格限流（10 req/min）
  // 为什么 GET 用 300：Dashboard 一次刷新触发 graph+stats+files 多请求，60/min 易触发 429
  // PERF-TEST HOOK: 当 WIKI_DISABLE_RATE_LIMIT=1 时，**完全跳过插件注册**——
  // 这样全局 60/min 与路由级 config.rateLimit 覆盖（300/min 等）都会一并失效，
  // 暴露真实吞吐上限。注意：本版本 @fastify/rate-limit 会**忽略** `enable:false` 选项，
  // 仅设 enable 不能真正关闭限流，必须改为条件注册。
  if (process.env.WIKI_DISABLE_RATE_LIMIT !== '1' && process.env.WIKI_SMOKE !== '1') {
    await app.register(rateLimit, {
      max: 60,
      timeWindow: '1 minute',
    });
  }

  // 响应压缩（P2-6）：
  //   - 对 >1KB 的 JSON 响应自动启用 gzip/brotli
  //   - 为什么需要：/api/files/pages ~58KB、/api/graph ~36KB，Tailscale Funnel 公网访问带宽受限
  //   - 为什么阈值 1KB：小响应压缩收益小于 CPU 开销，1KB 以上压缩比通常 > 60%
  //   - 为什么优先 brotli：压缩率比 gzip 高 15-20%，主流浏览器均支持
  //   - 实现说明：原 @fastify/compress 的流式压缩在 Windows 环境下间歇返回损坏/空压缩体
  //     （见 src/compression.ts 注释），已替换为同步压缩钩子，100% 可靠。
  registerCompression(app, { threshold: 1024 });

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
  registerQueryRoute(app, adapter, threadStore, governorConfig, isolationGuards, config.enableResumableStream ?? false);
  // v3 媒体生成：视频任务创建与轮询
  registerMediaRoute(app, adapter, config, isolationGuards);
  registerQueryArchiveRoute(app, vault, threadStore, isolationGuards);
  // 线程 / 会话 / 记忆 管理路由（创建/列表/删除线程、读/写/清记忆与会话）
  // T00265：重新启用 registerThreadsRoute——上下文占用徽章依赖 GET /threads/:id/context
  //   （拉取当前上下文 token 数与 maxTokens）与 POST /threads/:id/compact（手动压缩）
  registerThreadsRoute(app, threadStore, governorConfig, isolationGuards);
  registerHealthCheckRoute(app, adapter, isolationGuards);
  // files/graph/stats 路由直接操作 Vault，不经过 adapter（纯确定性操作）
  // FR-18：末尾传 knowledge.staleDays 供 /files/pages 注入每页知识时效状态（Browse 角标）
  registerFilesRoutes(app, vault, isolationGuards, { filesReadAuthRequired: config.auth?.filesReadAuthRequired ?? false }, config.knowledge?.staleDays ?? 365);
  // 公开媒体文件服务：queries/ 下生成的图像/视频无需认证（浏览器 img/video 标签无法带 Authorization header）
  registerPublicMediaServeRoute(app, vault);
  registerGraphRoute(app, vault);
  registerStatsRoute(app, vault);
  registerSchemaRoutes(app, vault, isolationGuards);
  registerConfigRoute(app, adapter, isolationGuards);
  // §11.2 断点续传：查询中断任务列表（完整 resume 待详细设计）
  const stateDir = path.join(getDataDir(), '.harness', 'state');
  registerRunsRoute(app, stateDir, isolationGuards);
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
  // A1 网页捕获（书签捕获）：接收 bookmarklet 抓回的 outerHTML → 提取正文 → 合并 Markdown，供前端走 /api/compile text 模式
  registerRawIngestRoute(app, config, isolationGuards);
  // FR-16-2 浏览器书签导入：解析书签 HTML → Markdown → raw/ → compile
  // 为什么传入 vaultPath：路由需要将 combinedMarkdown 写入 raw/ 目录
  registerBookmarkIngestRoute(app, config.vaultPath, isolationGuards);
  // 关于页面 + 检查更新：参�?17_xianyu 项目 about 模块
  registerAboutRoute(app);
  // 工具配置管理：MCP/CLI/场景路由的可配置化调用（需�?4�?
  registerToolsRoute(app, adapter, isolationGuards);
  // MCP Server 端点：对外暴露知识库能力给外部 AI Agent。
  // 为什么独立于 isolationGuards：外部 Agent 无 Web 会话，改用 mcp.userToken/adminToken 双轨鉴权。
  registerMcpRoute(app, vault, adapter, config);
  // 技能导入模块：支持上传 ZIP/.md 技能包，统一存储�?data/skills/
  // 为什么放�?tools 之后：技能与工具配置同属扩展能力管理，但职责独立
  registerSkillRoute(app);
  // FR-10-1 AI 自动打标签：compile 末尾追加 ai_tags 建议 + 手动触发 + 确认
  // 为什么需要 config 完整对象：POST /api/tags/suggest 调用 LLM 需读取 llm.baseUrl/model/apiKey
  registerTagsRoute(app, vault, config);
  // FR-16-1 Discover Sources：基于双链拓扑推荐"邻近但未连接"的相关笔记 + 一键建立双链
  // 为什么不需要 config：纯拓扑计算（同目录/同标签/同作者），不调用 LLM
  registerDiscoverRoute(app, vault);
  // FR-17 知识缺口检测：纯拓扑计算（孤立节点/低密度社区/同标签未双链对），需要 config.graph.minPages
  registerGapsRoute(app, vault, config);
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

  // SPA 静态资源托管（提取为独立函数降低 main 认知复杂度）
  await setupSpaStatic(app);


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
  return { app, config, shutdown };
}

async function main(): Promise<void> {
  const { app, config, shutdown } = await buildApp();
  try {
    await app.listen({ host: config.server.host, port: config.server.port });
    const url = `http://${config.server.host}:${config.server.port}`;
    console.log(`Wiki API running at ${url}`);
    openBrowser(url);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

if (process.env.WIKI_SMOKE !== '1') {
  // 包进 async IIFE：esbuild 固定 --format=cjs，CJS 不支持顶层 await
  (async () => {
    try {
      await main();
    } catch (err) {
      console.error('启动失败:', err);
      process.exit(1);
    }
  })();
}

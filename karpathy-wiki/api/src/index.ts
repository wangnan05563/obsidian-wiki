import Fastify from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { loadConfig, getEffectiveApiKey } from './config.js';
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
import { registerQqIngestRoute } from './routes/qq-ingest.js';
import { registerConversationsRoute } from './routes/conversations.js';
import { registerTunnelRoute } from './routes/tunnel.js';
import { registerAboutRoute } from './routes/about.js';
import { registerToolsRoute } from './routes/tools.js';
import { registerSkillRoute } from './routes/skill.js';
import { initAuthModule, registerAuthRoute } from './routes/auth.js';
import { shutdownToolRegistry } from './tools/registry.js';
import { TunnelService } from './tunnel/tunnel-service.js';

// ESM 原生方式获取目录。esbuild 打包时通过 --define 替换 import.meta.url 为 CJS 等价表达式
import { fileURLToPath } from 'node:url';
const dirname = path.dirname(fileURLToPath(import.meta.url));

// pkg 打包模式标志（process.pkg 仅在 pkg 打包后存在）
const IS_PACKAGED = !!(process as NodeJS.Process & { pkg?: unknown }).pkg;

/**
 * 加载 .env 文件环境变量（pkg 打包模式需要手动加载）
 * 为什么需要：开发模式由 start.ps1 加载，打包后需自行加载
 * 行解析拆分为独立函数，降低 loadEnvFile 认知复杂度（S3776）
 */
function applyEnvLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const m = trimmed.match(/^([^=]+)=(.*)$/); // NOSONAR: 单次匹配取键值，match 返回数组更适合此场景
  if (m && !process.env[m[1].trim()]) {
    process.env[m[1].trim()] = m[2].trim();
  }
}

function loadEnvFile(): void {
  // 开发模式和打包模式都加载 .env，避免依赖启动脚本是否加载 .env
  // 之前仅 IS_PACKAGED 模式加载，但 start-service.ps1 不加载 .env 导致 401
  const candidates = [
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
 * 端口清理：杀掉占用目标端口的残留进程（pkg 打包模式）
 * 为什么需要：上次异常退出可能残留进程占用端口
 */
// 提取 kill 逻辑到独立函数，降低 cleanupPort 认知复杂度（S3776）
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
    return; // netstat 失败不阻断
  }
  // 用 String.raw 避免正则字符串双重转义（S7780）
  const pattern = new RegExp(String.raw`:${port}\s+\S+\s+\S+\s+LISTENING\s+(\d+)`);
  const killed = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(pattern); // NOSONAR: 单次匹配取监听端口 PID，match 返回数组更适合此场景
    if (m && !killed.has(m[1]) && killPid(m[1])) {
      killed.add(m[1]);
    }
  }
}

/**
 * 自动打开浏览器（pkg 打包模式）
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
  // pkg 打包模式：加载 .env + 端口清理
  loadEnvFile();

  const config = await loadConfig();

  // pkg 打包模式：清理残留端口
  if (IS_PACKAGED) {
    console.log('[启动] Karpathy-Wiki 打包模式，清理残留端口...');
    cleanupPort(config.server.port);
  }

  // Vault 是知识库内容的唯一存储位置，启动时确保目录结构存在（AC-01-5）
  const vault = new VaultService(config.vaultPath);
  await vault.init();

  // 构造 HarnessAdapter。API Key 读取优先级：config.json.llm.apiKey > process.env[apiKeyRef]
  // 为什么用 getEffectiveApiKey：开发模式不加载 .env，仅靠环境变量会拿到空串导致 401
  // §5.2 传递 webSearchConfig：query workflow 注入 web_search 工具时使用
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
  );

  // 配置驱动的 Fastify logger：level 从 config.json 读取，默认 info
  // 为什么不用 logger: true：默认配置无法控制级别，且不记录请求级日志
  const loggingConfig = config.logging ?? { level: 'info', enableRequestLog: true };
  const app = Fastify({
    logger: {
      level: loggingConfig.level,
      // 序列化请求关键字段，避免日志中包含敏感的完整 body
      serializers: {
        req(req) {
          return { method: req.method, url: req.url };
        },
      },
    },
    // 50MB：支持多附件上传场景，超过此大小的请求体直接拒绝
    bodyLimit: 50 * 1024 * 1024,
  });

  // 请求级日志钩子：覆盖 HTTP 层，确保前端报错时后端日志有反馈
  // 为什么需要：路由 catch 块只通过 SSE 推错误给前端，后端日志流无记录
  if (loggingConfig.enableRequestLog) {
    // onRequest：记录请求进入（method + url）
    app.addHook('onRequest', async (request) => {
      request.log.info({ method: request.method, url: request.url }, 'incoming request');
    });

    // onResponse：记录请求完成（method + url + statusCode + 耗时）
    app.addHook('onResponse', async (request, reply) => {
      const elapsedMs = reply.elapsedTime.toFixed(2);
      request.log.info(
        { method: request.method, url: request.url, statusCode: reply.statusCode, elapsedMs },
        'request completed',
      );
    });

    // onError：记录请求处理中抛出的错误（未捕获的异常）
    app.addHook('onError', async (request, reply, error) => {
      request.log.error(
        { method: request.method, url: request.url, statusCode: reply.statusCode, err: error },
        'request error',
      );
    });
  }

  // 内网穿透：TunnelService 单例提前创建，供 CORS 白名单查询当前 tunnel 公网域名
  // 为什么提前：CORS origin 回调需要同步查询 tunnel.publicUrl 判断是否放行
  const tunnel = new TunnelService();

  // CORS：限制 origin 为本地开发 + tunnel 域名白名单
  // 为什么需要：默认跨域全放开会暴露内部 API，白名单收敛到本地与已配置 tunnel
  await app.register(cors, {
    origin: (origin, cb) => {
      // 允许本地开发前端、同源请求（无 origin）
      if (!origin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
        cb(null, true);
        return;
      }
      // 允许 tunnel 运行时的公网域名（quick tunnel 动态域名 + tailscale/cpolar）
      const tunnelUrl = tunnel.publicUrl;
      if (tunnelUrl) {
        try {
          const u = new URL(tunnelUrl);
          if (origin === `${u.protocol}//${u.host}`) {
            cb(null, true);
            return;
          }
        } catch {
          // publicUrl 格式异常，跳过
        }
      }
      // 允许配置的 named tunnel 固定 hostname
      if (config.tunnel.hostname && origin === `https://${config.tunnel.hostname}`) {
        cb(null, true);
        return;
      }
      cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  });

  // Helmet：安全响应头。CSP 在 SPA 模式下需特殊配置，暂不启用避免阻断前端资源
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  // Rate-limit：防 LLM token 耗尽攻击。全局 60/min 兜底，破坏性端点在各路由 config 中设置更严格限流
  await app.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
  });

  // 注册 multipart 插件以支持 compile 路由的文件上传
  await app.register(multipart, {
    limits: { fileSize: 1024 * 1024 * 10 }, // 10MB 上限，防止超大文件耗尽内存
  });

  registerCompileRoute(app, adapter, config.batch);
  registerQueryRoute(app, adapter);
  registerQueryArchiveRoute(app, vault);
  registerHealthCheckRoute(app, adapter);
  // files/graph/stats 路由直接操作 Vault，不经过 adapter（纯确定性操作）
  registerFilesRoutes(app, vault);
  registerGraphRoute(app, vault);
  registerStatsRoute(app, vault);
  registerSchemaRoutes(app, vault);
  registerConfigRoute(app, adapter);
  // §11.2 断点续传：查询中断任务列表（完整 resume 待详细设计）
  const stateDir = path.resolve(config.vaultPath, '..', '.harness', 'state');
  registerRunsRoute(app, stateDir);
  // 历史会话后端持久化：落盘到 dataDir/conversations/
  // dataDir 与 vaultPath 同级（data/），遵循"运行时数据与源码分离"约定
  const dataDir = path.resolve(config.vaultPath, '..');
  registerConversationsRoute(app, dataDir);
  // §5.1 全文检索 + Vault 初始化
  // §5.2 联网搜索路由：供前端直接调用展示搜索结果
  registerSearchRoute(app, vault);
  registerWebSearchRoute(app, config.webSearch);
  registerVaultRoute(app, vault);
  // AI 配置管理 + 系统清理：参考 17_xianyu 项目新增模块
  registerAiRoute(app, adapter);
  registerCleanupRoute(app, vault);
  // QQ 聊天记录导入子系统（SRS §6.1 路由族）
  // 为什么需要 config 完整对象：路由内用 config.qq ?? defaultQqConfig 兜底
  registerQqIngestRoute(app, adapter, vault, config);
  // 关于页面 + 检查更新：参考 17_xianyu 项目 about 模块
  registerAboutRoute(app);
  // 工具配置管理：MCP/CLI/场景路由的可配置化调用（需求 4）
  registerToolsRoute(app, adapter);
  // 技能导入模块：支持上传 ZIP/.md 技能包，统一存储到 data/skills/
  // 为什么放在 tools 之后：技能与工具配置同属扩展能力管理，但职责独立
  registerSkillRoute(app);

  // RBAC 权限管理模块：必须在其他路由注册前初始化中间件（全局 preHandler）
  // 为什么提前初始化：setupAuthMiddleware 通过 addHook 注册全局 preHandler，
  // 必须在路由注册前调用，否则已注册的路由不会经过认证中间件
  if (config.auth) {
    await initAuthModule(config.auth, config.vaultPath);
    registerAuthRoute(app);
    console.log(`[auth] 权限控制已${config.auth.enabled ? '启用' : '禁用'}`);
  } else {
    console.warn('[auth] 未配置 auth 字段，权限控制未启用');
  }

  // 内网穿透：TunnelService 单例已提前创建（CORS 白名单依赖），此处注入路由
  registerTunnelRoute(app, tunnel);
  // autoStart 开启时服务启动即建立隧道，失败不阻断主服务
  if (config.tunnel.autoStart) {
    tunnel.start(config.tunnel, config.server.port).catch((err) => {
      app.log.error({ err }, '隧道开机自启失败');
    });
  }

  // 健康检查端点（供 docker-compose healthcheck 用）
  app.get('/health', async () => ({ ok: true }));

  // SPA 静态资源托管（生产模式 / exe 打包模式）
  // 为什么需要：开发模式由 Vite 5173 提供前端，生产/exe 模式需后端单端口托管 SPA
  // 探测顺序：exe 同级 public → api/public → api/static/spa
  const spaCandidates = [
    path.resolve(process.cwd(), 'public'),                      // exe 运行模式：CWD/public
    path.resolve(dirname, '..', 'public'),                      // tsx 开发模式：src/../public
    path.resolve(dirname, '..', 'static', 'spa'),               // 兼容旧路径
  ];
  let spaRoot: string | null = null;
  for (const p of spaCandidates) {
    if (fs.existsSync(path.join(p, 'index.html'))) {
      spaRoot = p;
      break;
    }
  }
  if (spaRoot) {
    await app.register(fastifyStatic, {
      root: spaRoot,
      prefix: '/',
      wildcard: false,  // 关闭通配符，手动处理 SPA fallback
    });
    // SPA fallback：所有未匹配的 GET 请求返回 index.html（Vue Router history 模式）
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not Found' });
    });
    console.log(`[SPA] 静态资源托管：${spaRoot}`);
  } else {
    console.log('[SPA] 未找到 SPA 产物，仅 API 模式（开发模式由 Vite 提供前端）');
  }

  try {
    await app.listen({ host: config.server.host, port: config.server.port });
    const url = `http://${config.server.host}:${config.server.port}`;
    console.log(`Wiki API running at ${url}`);
    // pkg 打包模式：自动打开浏览器
    openBrowser(url);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // shutdown 优雅停止：优先停隧道，避免调度器停止后隧道仍转发流量到已关闭服务
  // 为什么用 process 信号而非 Fastify 钩子：pkg 打包模式下 Ctrl+C 走 SIGINT，需在进程级捕获
  // 为什么 async：需等待 MCP 子进程清理完成再 exit，避免孤儿进程
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[关闭] 收到 ${signal}，正在停止隧道与工具连接...`);
    tunnel.stop();
    // 清理 MCP 子进程连接，按 graceful-shutdown-rule 顺序：子进程 → 连接 → exit
    await shutdownToolRegistry();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((err) => { // NOSONAR: ESM 入口标准模式，main() 是异步入口函数调用非 top-level await
  console.error('启动失败:', err);
  process.exit(1);
});

import Fastify from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
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
import { registerSearchRoute } from './routes/search.js';
import { registerVaultRoute } from './routes/vault.js';

// CJS 模式下 __dirname 由 Node.js 原生提供；ESM 模式下需要从 import.meta.url 派生
// esbuild 打包时会自动保留 __dirname 引用，TypeScript 编译需声明此变量
declare const __dirname: string;
const dirname = typeof __dirname !== 'undefined' // NOSONAR: __dirname 为 declare const，ESM 下可能未声明，需 typeof 守卫
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

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
  if (!IS_PACKAGED) return;
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

  // 构造 HarnessAdapter。API Key 通过环境变量读取，不落盘（M-7）
  const apiKey = process.env[config.llm.apiKeyRef];
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
  );

  const app = Fastify({ logger: true });

  // 注册 multipart 插件以支持 compile 路由的文件上传
  await app.register(multipart, {
    limits: { fileSize: 1024 * 1024 * 10 }, // 10MB 上限，防止超大文件耗尽内存
  });

  registerCompileRoute(app, adapter);
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
  // §5.1 全文检索 + Vault 初始化
  registerSearchRoute(app, vault);
  registerVaultRoute(app, vault);

  // 健康检查端点（供 docker-compose healthcheck 用）
  app.get('/health', async () => ({ ok: true }));

  // SPA 静态资源托管（生产模式 / exe 打包模式）
  // 为什么需要：开发模式由 Vite 5173 提供前端，生产/exe 模式需后端单端口托管 SPA
  // 探测顺序：exe 同级 public → services/api/public → services/api/static/spa
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
}

main().catch((err) => { // NOSONAR: ESM 入口标准模式，main() 是异步入口函数调用非 top-level await
  console.error('启动失败:', err);
  process.exit(1);
});

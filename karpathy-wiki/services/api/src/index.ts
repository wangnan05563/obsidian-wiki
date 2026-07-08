import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { loadConfig } from './config.js';
import { VaultService } from './vault/vault-service.js';
import { HarnessAdapter } from './engine/harness-adapter.js';
import { registerCompileRoute } from './routes/compile.js';
import { registerQueryRoute } from './routes/query.js';
import { registerHealthCheckRoute } from './routes/health-check.js';
import { registerFilesRoutes } from './routes/files.js';
import { registerGraphRoute } from './routes/graph.js';
import { registerStatsRoute } from './routes/stats.js';
import { registerSchemaRoutes } from './routes/schema.js';
import { registerConfigRoute } from './routes/config.js';

async function main(): Promise<void> {
  const config = await loadConfig();

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
  registerHealthCheckRoute(app, adapter);
  // files/graph/stats 路由直接操作 Vault，不经过 adapter（纯确定性操作）
  registerFilesRoutes(app, vault);
  registerGraphRoute(app, vault);
  registerStatsRoute(app, vault);
  registerSchemaRoutes(app, vault);
  registerConfigRoute(app);

  // 健康检查端点（供 docker-compose healthcheck 用）
  app.get('/health', async () => ({ ok: true }));

  try {
    await app.listen({ host: config.server.host, port: config.server.port });
    console.log(`Wiki API running at http://${config.server.host}:${config.server.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});

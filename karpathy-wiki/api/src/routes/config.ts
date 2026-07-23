import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  loadConfig,
  reloadConfig,
  saveBudgetConfig,
  saveHealthCheckConfig,
  saveBatchConfig,
  saveLoggingConfig,
} from '../config.js';
import type { AppConfig } from '../types.js';
import type { HarnessAdapter } from '../engine/harness-adapter.js';

// 注册配置路由。
//   GET  /api/config                  读取当前配置（API Key 字段脱敏）
//   PUT  /api/config                  仅校验反馈，不落盘（向后兼容保留）
//   POST /api/config/reload           §12.3-7 热加载：重读 config.json 并将可热更新字段应用到 adapter
//   PUT  /api/config/budget           保存运行参数（maxSteps/tokenBudget）+ 同步 adapter
//   PUT  /api/config/health-check     保存健康检查阈值（staleDays）+ 同步 adapter
//   PUT  /api/config/batch            保存批量编译配置（需重启 multipart 限制才完全生效）
//   PUT  /api/config/logging          保存日志配置（level 需重启，enableRequestLog 可热更新）
// 配置中心前端展示与编辑入口，落盘 + 同步 adapter 运行时实例，避免双轨不一致。
export function registerConfigRoute(app: FastifyInstance, adapter: HarnessAdapter) {
  app.get('/api/config', async (_request, reply) => {
    const config = await loadConfig();
    // 脱敏：apiKeyRef 是环境变量名（非 Key 本身），可展示；实际 Key 不返回
    return reply.send({
      vaultPath: config.vaultPath,
      adapter: config.adapter,
      llm: {
        provider: config.llm.provider,
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        apiKeyRef: config.llm.apiKeyRef,
        apiKeySet: Boolean(process.env[config.llm.apiKeyRef]),
      },
      budget: config.budget,
      server: config.server,
      localOnly: config.localOnly,
      healthCheck: config.healthCheck,
      // 暴露 batch/logging 给前端 Config.vue 展示与编辑
      batch: config.batch ?? {
        allowedExtensions: ['md', 'txt', 'pdf', 'html', 'json'],
        maxBatchSize: 20,
        maxFileSizeMb: 10,
      },
      logging: config.logging ?? { level: 'info', enableRequestLog: true },
    });
  });

  // 向后兼容保留：原 PUT /api/config 不落盘，仅返回提示。
  // 新代码应使用 PUT /api/config/{budget,health-check,batch,logging} 子资源接口。
  app.put('/api/config', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Partial<AppConfig>;
    if (!body) {
      return reply.code(400).send({ error: '请求体为空' });
    }
    return reply.send({
      ok: true,
      message: '配置已收到。请使用 PUT /api/config/{budget,health-check,batch,logging} 子资源接口进行持久化。',
    });
  });

  // §12.3-7 热加载：重读 config.json，将可热更新字段（model/maxSteps/tokenBudget/staleDays）
  // 即时同步到运行中的 adapter。adapter/vaultPath/server 涉及实例重建或端口绑定，需重启进程。
  app.post('/api/config/reload', async (_request, reply) => {
    const fresh = await reloadConfig();
    adapter.updateConfig({
      model: fresh.llm.model,
      maxSteps: fresh.budget.maxSteps,
      tokenBudget: fresh.budget.tokenBudget,
      staleDays: fresh.healthCheck.staleDays,
    });
    return reply.send({
      ok: true,
      applied: {
        model: fresh.llm.model,
        maxSteps: fresh.budget.maxSteps,
        tokenBudget: fresh.budget.tokenBudget,
        staleDays: fresh.healthCheck.staleDays,
      },
      requireRestart: ['adapter', 'vaultPath', 'server', 'llm.provider', 'llm.baseUrl'],
    });
  });

  // 保存运行参数（maxSteps/tokenBudget）到 config.json + 同步 adapter 运行时。
  // 为什么需要：用户在前端 Config.vue 调整 token 预算与步数上限后，需即时生效无需重启。
  app.put('/api/config/budget', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      maxSteps?: number;
      tokenBudget?: number;
    };
    if (!body) {
      return reply.code(400).send({ error: '请求体为空' });
    }
    // 输入校验：maxSteps 必须为正整数，tokenBudget 必须为正整数
    if (body.maxSteps !== undefined && (!Number.isInteger(body.maxSteps) || body.maxSteps < 1)) {
      return reply.code(400).send({ error: 'maxSteps 必须为正整数' });
    }
    if (body.tokenBudget !== undefined && (!Number.isInteger(body.tokenBudget) || body.tokenBudget < 1)) {
      return reply.code(400).send({ error: 'tokenBudget 必须为正整数' });
    }
    try {
      const merged = await saveBudgetConfig({
        maxSteps: body.maxSteps,
        tokenBudget: body.tokenBudget,
      });
      // 落盘后同步 adapter 运行时实例，避免下次请求使用旧值
      adapter.updateConfig({
        maxSteps: merged.budget.maxSteps,
        tokenBudget: merged.budget.tokenBudget,
      });
      return reply.send({
        ok: true,
        config: merged.budget,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ error: msg });
    }
  });

  // 保存健康检查配置（staleDays）到 config.json + 同步 adapter 运行时。
  // 为什么需要：用户根据知识库更新频率调整"过期页面"判定阈值后，需即时生效。
  app.put('/api/config/health-check', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      staleDays?: number;
    };
    if (!body) {
      return reply.code(400).send({ error: '请求体为空' });
    }
    if (body.staleDays !== undefined && (!Number.isInteger(body.staleDays) || body.staleDays < 1)) {
      return reply.code(400).send({ error: 'staleDays 必须为正整数' });
    }
    try {
      const merged = await saveHealthCheckConfig({
        staleDays: body.staleDays,
      });
      adapter.updateConfig({
        staleDays: merged.healthCheck.staleDays,
      });
      return reply.send({
        ok: true,
        config: merged.healthCheck,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ error: msg });
    }
  });

  // 保存批量编译配置（allowedExtensions/maxBatchSize/maxFileSizeMb）到 config.json。
  // 为什么不能热更新：multipart fileSize 限制在 Fastify 启动时注册，运行时不可变更。
  //   allowedExtensions/maxBatchSize 可热更新但为避免与 multipart 限制脱节，统一提示重启。
  app.put('/api/config/batch', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      allowedExtensions?: string[];
      maxBatchSize?: number;
      maxFileSizeMb?: number;
    };
    if (!body) {
      return reply.code(400).send({ error: '请求体为空' });
    }
    // 输入校验：maxBatchSize/maxFileSizeMb 必须为正整数；allowedExtensions 必须为字符串数组
    if (body.maxBatchSize !== undefined && (!Number.isInteger(body.maxBatchSize) || body.maxBatchSize < 1)) {
      return reply.code(400).send({ error: 'maxBatchSize 必须为正整数' });
    }
    if (body.maxFileSizeMb !== undefined && (!Number.isInteger(body.maxFileSizeMb) || body.maxFileSizeMb < 1)) {
      return reply.code(400).send({ error: 'maxFileSizeMb 必须为正整数' });
    }
    if (body.allowedExtensions !== undefined) {
      if (!Array.isArray(body.allowedExtensions) || body.allowedExtensions.some(e => typeof e !== 'string' || !e.trim())) {
        return reply.code(400).send({ error: 'allowedExtensions 必须为非空字符串数组' });
      }
    }
    try {
      const merged = await saveBatchConfig({
        allowedExtensions: body.allowedExtensions?.map(e => e.trim().toLowerCase()),
        maxBatchSize: body.maxBatchSize,
        maxFileSizeMb: body.maxFileSizeMb,
      });
      return reply.send({
        ok: true,
        config: merged.batch,
        requireRestart: ['multipart.fileSize'], // maxFileSizeMb 变更需重启才完全生效
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ error: msg });
    }
  });

  // 保存日志配置（level/enableRequestLog）到 config.json。
  // 为什么 level 需重启：pino logger 在 Fastify 启动时创建，运行时不可变更级别。
  //   enableRequestLog 可热更新（路由钩子运行时读取 config）。
  app.put('/api/config/logging', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      level?: string;
      enableRequestLog?: boolean;
    };
    if (!body) {
      return reply.code(400).send({ error: '请求体为空' });
    }
    // 输入校验：level 必须为有效 pino 级别
    const validLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
    if (body.level !== undefined && !validLevels.includes(body.level)) {
      return reply.code(400).send({ error: `level 必须为: ${validLevels.join(', ')}` });
    }
    if (body.enableRequestLog !== undefined && typeof body.enableRequestLog !== 'boolean') {
      return reply.code(400).send({ error: 'enableRequestLog 必须为 boolean' });
    }
    try {
      const merged = await saveLoggingConfig({
        level: body.level,
        enableRequestLog: body.enableRequestLog,
      });
      return reply.send({
        ok: true,
        config: merged.logging,
        requireRestart: body.level === undefined ? [] : ['pino.level'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ error: msg });
    }
  });
}

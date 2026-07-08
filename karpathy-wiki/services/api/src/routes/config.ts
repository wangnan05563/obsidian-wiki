import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig, reloadConfig } from '../config.js';
import type { AppConfig } from '../types.js';
import type { HarnessAdapter } from '../engine/harness-adapter.js';

// 注册配置路由。
//   GET  /api/config         读取当前配置（API Key 字段脱敏）
//   PUT  /api/config         更新配置（运行时合并，不落盘——落盘需手动改 config.json）
//   POST /api/config/reload  §12.3-7 热加载：重读 config.json 并将可热更新字段应用到 adapter
// 配置中心前端展示与临时调整，持久化需用户手动编辑 config.json（安全考量 M-7）。
// reload 仅对运行时参数生效（model/budget/staleDays），adapter/vaultPath/server 需重启。
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
    });
  });

  app.put('/api/config', async (request: FastifyRequest, reply: FastifyReply) => {
    // PUT 仅做校验反馈，不落盘。配置持久化需用户手动编辑 config.json。
    // 这里返回提示，引导用户手动操作，避免运行时配置与文件不一致。
    const body = request.body as Partial<AppConfig>;
    if (!body) {
      return reply.code(400).send({ error: '请求体为空' });
    }
    return reply.send({
      ok: true,
      message: '配置已收到。运行时配置不落盘，请手动更新 config.json 以持久化。',
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
}

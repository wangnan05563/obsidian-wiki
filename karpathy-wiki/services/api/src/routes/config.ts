import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config.js';
import type { AppConfig } from '../types.js';

// 注册配置路由。
//   GET /api/config   读取当前配置（API Key 字段脱敏）
//   PUT /api/config   更新配置（运行时合并，不落盘——落盘需手动改 config.json）
// 配置中心前端展示与临时调整，持久化需用户手动编辑 config.json（安全考量 M-7）。
export function registerConfigRoute(app: FastifyInstance) {
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
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EngineAdapter, AppConfig } from '../types.js';

// v3 媒体生成路由：视频生成异步任务
// 设计要点：
// 1. POST /api/media/video 创建任务（5/min 限流，与 podcast 一致，触发 LLM + Agnes API）
// 2. GET /api/media/video/:taskId 轮询状态（60/min 限流，前端 5 秒间隔高频轮询）
// 3. 错误处理：区分"未配置"（400）与"API 失败"（500）
// 4. 为什么视频走独立 JSON 端点而非 SSE：视频生成需数分钟，超出 query SSE 60 秒超时

export function registerMediaRoute(
  app: FastifyInstance,
  adapter: EngineAdapter,
  appConfig?: AppConfig,
) {
  // 创建视频生成任务：前端提交 prompt，后端调 Agnes Video API 返回 taskId
  app.post('/api/media/video', {
    // 破坏性端点严格限流：视频生成成本高，5/min 防 token 耗尽
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { prompt?: string };

    // prompt 必填：视频生成围绕用户描述展开，空 prompt 无法生成
    if (!body?.prompt || typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
      return void reply.code(400).send({ error: '请求体须含非空 prompt 字段' });
    }

    try {
      const result = await adapter.generateVideo(body.prompt.trim(), appConfig);
      return void reply.send({ ok: true, ...result });
    } catch (err: unknown) {
      // 为什么同时 request.log.error：JSON 错误只回前端，后端日志流需独立记录以便排障
      request.log.error(
        { err, prompt: body.prompt },
        'video generation create task failed',
      );
      const message = err instanceof Error ? err.message : String(err);
      // 区分"未配置 API key"（400）与"Agnes API 失败"（500）
      const isConfigError = message.includes('not configured');
      reply.code(isConfigError ? 400 : 500).send({
        ok: false,
        error: message,
      });
    }
  });

  // 轮询视频任务状态：前端按 5 秒间隔轮询，完成时返回视频 URL
  app.get('/api/media/video/:taskId', {
    // 轮询高频端点：60/min 与前端 5 秒间隔匹配（10 次/分钟）
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    if (!taskId) {
      reply.code(400).send({ error: '须提供 taskId' });
    }

    try {
      const result = await adapter.pollVideoTask(taskId, appConfig);
      return void reply.send({ ok: true, ...result });
    } catch (err: unknown) {
      request.log.error({ err, taskId }, 'video poll failed');
      const message = err instanceof Error ? err.message : String(err);
      const isConfigError = message.includes('not configured');
      reply.code(isConfigError ? 400 : 500).send({
        ok: false,
        error: message,
      });
    }
  });
}

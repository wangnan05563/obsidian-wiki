import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EngineAdapter, AppConfig } from '../types.js';

// FR-09-3 Podcast (Audio Overview) 路由
// AC-09-6: 支持 tag/folder 范围限定，避免全库噪音
// AC-09-7: 归档到 queries/podcast-{timestamp}.md
// AC-09-8: frontmatter 含 type/output_mode/generated_at 等元数据
//
// 设计要点：
// 1. JSON POST 端点（非 SSE）：podcast-workflow 返回 Promise<PodcastResult>，
//    脚本生成 + TTS 合成是离散步骤，不适合流式推送（与 compile/query 的 SSE 模式不同）
// 2. 严格限流：单请求触发 LLM + 多段 TTS，token 与时间成本远高于 query，5/min 防滥用
// 3. TTS 失败降级：workflow 内部已处理，route 只需透传结果（ttsEnabled=false 表示仅脚本）

export function registerPodcastRoute(
  app: FastifyInstance,
  adapter: EngineAdapter,
  appConfig?: AppConfig,
) {
  app.post('/api/podcast', {
    // 破坏性端点最严格限流：podcast 触发 LLM + 多段 TTS，5/min 防 token 耗尽
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      topic?: string;
      tags?: string[];
      folder?: string;
    };

    // topic 必填：播客脚本围绕主题展开，空主题无法检索相关页面
    if (!body?.topic || typeof body.topic !== 'string' || body.topic.trim().length === 0) {
      return void reply.code(400).send({ error: '请求体须含非空 topic 字段' });
    }

    // AC-09-6 范围限定：tags/folder 均可选，至少一个时启用过滤
    const scopeFilter: { tags?: string[]; folder?: string } | undefined =
      (body.tags && body.tags.length > 0) || body.folder
        ? { tags: body.tags, folder: body.folder }
        : undefined;

    try {
      const result = await adapter.podcast(body.topic.trim(), appConfig, scopeFilter);

      // 归档成功：返回完整结果供前端渲染（脚本 + 音频列表 + 时长 + 归档路径）
      return void reply.send({
        ok: true,
        script: result.script,
        audioFiles: result.audioFiles,
        durationSec: result.durationSec,
        archivePath: result.archivePath,
        ttsEnabled: result.ttsEnabled,
      });
    } catch (err: unknown) {
      // 为什么同时 request.log.error：JSON 错误只回前端，后端日志流需独立记录以便排障
      request.log.error(
        { err, topic: body.topic, scopeFilter },
        'podcast generation failed',
      );
      const message = err instanceof Error ? err.message : String(err);
      // 区分"无相关页面"与"LLM 失败"：前者是用户输入问题（400），后者是服务端问题（500）
      const isNoPages = message.includes('no relevant pages');
      reply.code(isNoPages ? 400 : 500).send({
        ok: false,
        error: message,
      });
    }
  });
}

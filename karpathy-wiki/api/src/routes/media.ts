import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineAdapter, AppConfig, MediaVideoUserConfig, MediaPresetsFile } from '../types.js';
import { getResourcePath } from '../utils/runtime.js';
import type { IsolationGuards } from '../middleware/auth.js';
import { createIsolationGuards } from '../middleware/auth.js';

// v3 媒体生成路由：视频生成异步任务
// 设计要点：
// 1. POST /api/media/video 创建任务（5/min 限流，与 podcast 一致，触发 LLM + Agnes API）
// 2. GET /api/media/video/:taskId 轮询状态（60/min 限流，前端 5 秒间隔高频轮询）
// 3. GET /api/media/presets 返回生图/视频预设模板（media-presets.json）
// 4. 错误处理：区分"未配置"（400）与"API 失败"（500）
// 5. 为什么视频走独立 JSON 端点而非 SSE：视频生成需数分钟，超出 query SSE 60 秒超时
// 6. BYOK：POST 可携带 mediaConfig.video（用户自己的 baseUrl/key/model/秒数），优先级高于服务端 media.agnes；
//    为在轮询下载时复用同一用户 key，create 时把 video 配置按 taskId 存入内存 taskMap。

// 内存 task→用户视频配置映射：进程级，重启即失效（任务随之失效，可接受）。
// 为什么放路由层而非 adapter：video 创建/轮询都经过本路由，adapter 只委托 workflow 无业务态。
const taskVideoConfig = new Map<string, MediaVideoUserConfig>();

const PRESETS_PATH: string = findPresetsPath();

// media-presets.json 权威路径（开发模式：api/media-presets.json，SEA 模式：exe 同级）。cwd 兜底应对 pnpm 符号链接。
function findPresetsPath(): string {
  const candidates: string[] = [
    getResourcePath('media-presets.json'),
    path.resolve(process.cwd(), 'media-presets.json'),
    path.resolve(process.cwd(), 'api', 'media-presets.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // 找不到时返回第一候选路径（让 readFileSync 错误自然抛出便于诊断，与 ai.ts 的 resolvePresetsPath 一致）
  return candidates[0];
}

export function registerMediaRoute(
  app: FastifyInstance,
  adapter: EngineAdapter,
  appConfig?: AppConfig,
  guards: IsolationGuards = createIsolationGuards(),
) {
  // GET /api/media/presets：返回生图/视频预设模板，供前端配置页/生成弹窗下拉一键应用。
  // 预设为只读模板（仿 llm-presets.json），用户选择后自行微调并保存为个人 BYOK 配置。
  // 鉴权：requireAuth——读取预设需登录（与其它配置类读端点一致）。
  app.get('/api/media/presets', {
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    preHandler: guards.requireAuth,
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const presets = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8')) as MediaPresetsFile;
      return void reply.send({
        imagePresets: Array.isArray(presets?.imagePresets) ? presets.imagePresets : [],
        videoPresets: Array.isArray(presets?.videoPresets) ? presets.videoPresets : [],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      requestErrorLog(_request, 'load media presets failed', message);
      return void reply.code(500).send({ error: '读取媒体预设文件失败' });
    }
  });

  // 创建视频生成任务：前端提交 prompt（+ 可选 BYOK video 配置），后端调 Agnes Video API 返回 taskId
  // 鉴权：requireAuth——视频生成消耗真实 API 额度，仅限登录用户，避免未登录匿名滥用服务端共享 key。
  app.post('/api/media/video', {
    // 破坏性端点严格限流：视频生成成本高，5/min 防 token 耗尽
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    preHandler: guards.requireAuth,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { prompt?: string; mediaConfig?: { video?: MediaVideoUserConfig } };

    // prompt 必填：视频生成围绕用户描述展开，空 prompt 无法生成
    if (!body?.prompt || typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
      return void reply.code(400).send({ error: '请求体须含非空 prompt 字段' });
    }

    // 提取用户 BYOK 视频配置（若提供），用于 create 且关联 taskId 供轮询回用
    const videoOverride: MediaVideoUserConfig | undefined = body.mediaConfig?.video;

    try {
      const result = await adapter.generateVideo(body.prompt.trim(), appConfig, videoOverride);
      if (videoOverride) {
        taskVideoConfig.set(result.taskId, videoOverride);
      }
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
  // 鉴权：requireAuth——与创建端点一致，防止匿名查询在建任务状态。
  app.get('/api/media/video/:taskId', {
    // 轮询高频端点：60/min 与前端 5 秒间隔匹配（10 次/分钟）
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    preHandler: guards.requireAuth,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { taskId } = request.params as { taskId: string };
    if (!taskId) {
      reply.code(400).send({ error: '须提供 taskId' });
    }

    try {
      // 用 create 时关联的用户视频配置回调（下载需同一 key/baseUrl）；无则回退服务端 media.agnes
      const videoOverride = taskVideoConfig.get(taskId);
      const result = await adapter.pollVideoTask(taskId, appConfig, videoOverride);
      // 到达终态（completed/failed）后清理 taskVideoConfig 关联，避免内存无界增长
      if (result.status === 'completed' || result.status === 'failed') {
        taskVideoConfig.delete(taskId);
      }
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

// 独立小函数记录预设读取失败的请求日志，避免内联重复逻辑（与视频路由错误记录方式一致）。
function requestErrorLog(request: FastifyRequest, msg: string, detail: string): void {
  request.log.error({ msg, detail }, 'request error');
}
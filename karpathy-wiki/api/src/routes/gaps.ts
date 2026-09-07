// 知识缺口检测路由（FR-17）
//
// 注册端点：
//   GET /api/graph/gaps - 返回知识图谱的三种缺口（孤立节点/低密度社区/同标签未双链对）
//
// 为什么独立文件而非并入 graph.ts：T4-2 需追加 SSE（POST /api/graph/gaps/analyze），
// 与 graph.ts 的纯图数据职责区分；minPages 阈值从 config.graph 读取，避免硬编码。

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { HarnessConfig } from '@wiki/harness';
import type { VaultService } from '../vault/vault-service.js';
import type { AppConfig } from '../types.js';
import { getEffectiveApiKey } from '../config.js';
import { SSE_HEADERS, createSSESender } from '../utils/sse.js';
import {
  detectGaps,
  streamGapSuggestions,
  summarizeGapsText,
} from '../workflows/gaps-workflow.js';

export function registerGapsRoute(app: FastifyInstance, vault: VaultService, config: AppConfig): void {
  // GET /api/graph/gaps
  // 小样本知识库（< config.graph.minPages）返回 insufficient-data，避免误报
  app.get('/api/graph/gaps', {
    // 只读 GET，与 graph/stats/files 同档位 300 req/min
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const minPages = config.graph?.minPages ?? 20;
      const result = await detectGaps(vault, minPages);
      return void reply.send(result);
    } catch (err: unknown) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/graph/gaps/analyze
  // LLM 生成缺口补全建议，SSE 流式返回，仅展示不落盘。
  // 降级：LLM 失败时回退到 summarizeGapsText 的拓扑摘要，保证前端始终有输出。
  app.post('/api/graph/gaps/analyze', {
    // 调用 LLM 属于较重写操作，限制 60 req/min（与 tags/suggest 等写端点一致）
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const minPages = config.graph?.minPages ?? 20;
    const result = await detectGaps(vault, minPages);
    // 小样本无足够数据：直接返回（非 SSE），示意无需分析
    if (result.status === 'insufficient-data') {
      return void reply.send({ status: 'insufficient-data', pageCount: result.pageCount });
    }

    reply.raw.writeHead(200, SSE_HEADERS);
    const { send, isAborted, safeEnd } = createSSESender(reply, request);

    // 从 config 组装 Harness 的 LLM 配置（与 index.ts 构造 adapter 一致），实时取有效 key
    const apiKey = getEffectiveApiKey(config);
    const gapHarness: HarnessConfig = {
      llm: {
        provider: config.llm.provider,
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        apiKey: apiKey || '',
      },
      tools: [],
      budget: config.budget,
    };

    try {
      for await (const part of streamGapSuggestions(gapHarness, result)) {
        if (isAborted()) break;
        send('text', { text: part.text });
      }
      send('done', { status: 'ok' });
    } catch (err) {
      // LLM 降级：推送确定性拓扑摘要，避免流式中断时前端无任何结果
      send('text', { text: summarizeGapsText(result) });
      send('done', {
        status: 'ok',
        fallback: true,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    safeEnd();
  });
}
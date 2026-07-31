// AI 自动打标签路由（FR-10-1）
//
// 注册 3 个端点：
//   GET  /api/tags/pending          - 列出所有含 ai_tags 字段的页面（供前端展示待审核列表）
//   POST /api/tags/suggest          - 手动触发某页面重新生成 tag 建议
//   PUT  /api/tags/confirm          - 确认 tag（从 ai_tags 移到 tags）
//
// 设计原则：
// - 路径白名单校验：仅允许 PAGE_DIRS 下的 .md 文件，防路径穿越
// - 错误统一用 err instanceof Error 守卫，与 compile.ts 同模式
// - POST /api/tags/suggest 触发 LLM 调用，需 rateLimit 防滥用

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { VaultService } from '../vault/vault-service.js';
import type { AppConfig } from '../types.js';
import { suggestTagsForPage, confirmTagForPage, listPendingTagPages } from '../workflows/tag-suggest-workflow.js';

// 路径白名单正则：仅允许 entities/concepts/comparisons/queries/qa/solutions 目录下的 .md 文件
// 与 vault-service.ts WRITE_ALLOWED_DIRS 中的页面目录对齐（排除 drafts/raw）
// 为什么不用单一 [a-zA-Z0-9_-]+：页面名可能含中文，需 \u4e00-\u9fa5 字符范围
const VAULT_PAGE_PATTERN = /^(entities|concepts|comparisons|queries|qa|solutions)\/[\w\u4e00-\u9fa5-]+\.md$/i;

// tag 校验正则：小写英文/中文/连字符，长度 1~32
// 为什么限制长度：防止 LLM 返回超长字符串污染 frontmatter
const TAG_PATTERN = /^[\w\u4e00-\u9fa5-]{1,32}$/i;

export function registerTagsRoute(
  app: FastifyInstance,
  vault: VaultService,
  config: AppConfig,
): void {
  // GET /api/tags/pending
  // 列出所有含 ai_tags 字段的页面，供前端 Browse.vue 展示待审核列表
  // § 只读 GET 限流 300 req/min（P1-4）：与 files/graph/stats/schema 同档位，Browse 频繁刷新场景
  app.get('/api/tags/pending', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (_req, reply) => {
    try {
      const pages = await listPendingTagPages(vault);
      return reply.send({ pages });
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/tags/suggest
  // 手动触发某页面重新生成 tag 建议
  // 为什么用 POST 而非 PUT：每次调用都产生新的 ai_tags，非幂等
  app.post('/api/tags/suggest', {
    // 触发 LLM 调用，10/min 防滥用（与 compile 同级别）
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { path?: string } | null;
    const pagePath = body?.path ?? '';
    if (!VAULT_PAGE_PATTERN.test(pagePath)) {
      return reply.code(400).send({
        error: 'Invalid path: must match ^(entities|concepts|comparisons|queries|qa|solutions)/[name].md$',
      });
    }

    try {
      const aiTags = await suggestTagsForPage(vault, pagePath, config);
      return reply.send({ path: pagePath, aiTags });
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PUT /api/tags/confirm
  // 确认 tag：从 ai_tags 移到 tags（合并去重，幂等）
  app.put('/api/tags/confirm', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { path?: string; tag?: string } | null;
    const pagePath = body?.path ?? '';
    const tag = body?.tag ?? '';

    if (!VAULT_PAGE_PATTERN.test(pagePath)) {
      return reply.code(400).send({
        error: 'Invalid path: must match ^(entities|concepts|comparisons|queries|qa|solutions)/[name].md$',
      });
    }
    if (!TAG_PATTERN.test(tag)) {
      return reply.code(400).send({
        error: 'Invalid tag: must be 1~32 chars of [a-zA-Z0-9_\\u4e00-\\u9fa5-]',
      });
    }

    try {
      const result = await confirmTagForPage(vault, pagePath, tag);
      return reply.send({ path: pagePath, ...result });
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

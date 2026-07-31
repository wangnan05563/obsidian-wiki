// Discover Sources 推荐路由（FR-16-1）
//
// 注册 2 个端点：
//   GET  /api/discover/recommend  - 列出与指定页面拓扑相关但未双链的页面
//   POST /api/discover/link       - 一键在两篇笔记 frontmatter.related 建立双向链接
//
// 设计原则（与 tags.ts 一致）：
// - 路径白名单校验：仅允许 PAGE_DIRS 下的 .md 文件，防路径穿越
// - 错误统一用 err instanceof Error 守卫
// - POST 触发写盘操作，rateLimit 防滥用
// - 不依赖 config（无需 LLM），仅需要 vault 实例

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { VaultService } from '../vault/vault-service.js';
import { recommendPages, createBidirectionalLink } from '../workflows/discover-workflow.js';

// 路径白名单正则：与 tags.ts 对齐
// 为什么复用相同模式：discover 与 tags 操作同样的页面集合，路径校验需一致
const VAULT_PAGE_PATTERN = /^(entities|concepts|comparisons|queries|qa|solutions)\/[\w\u4e00-\u9fa5-]+\.md$/i;

export function registerDiscoverRoute(app: FastifyInstance, vault: VaultService): void {
  // GET /api/discover/recommend?pagePath=entities/foo.md
  // 返回与目标页面拓扑相关但未双链的候选页面（最少 3，最多 5）
  app.get('/api/discover/recommend', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as { pagePath?: string } | null;
    const pagePath = query?.pagePath ?? '';
    if (!VAULT_PAGE_PATTERN.test(pagePath)) {
      return reply.code(400).send({
        error: 'Invalid pagePath: must match ^(entities|concepts|comparisons|queries|qa|solutions)/[name].md$',
      });
    }

    try {
      const recommendations = await recommendPages(vault, pagePath);
      return reply.send({ pagePath, recommendations });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/discover/link
  // 在 source/target 两篇笔记 frontmatter.related 字段添加 [[页面名]] 双链
  // 幂等：已存在的链接不会重复添加
  app.post('/api/discover/link', {
    // 写盘操作，限制 20/min（比 tags.suggest 宽松，因不调用 LLM）
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { sourcePath?: string; targetPath?: string } | null;
    const sourcePath = body?.sourcePath ?? '';
    const targetPath = body?.targetPath ?? '';

    if (!VAULT_PAGE_PATTERN.test(sourcePath)) {
      return reply.code(400).send({
        error: 'Invalid sourcePath: must match ^(entities|concepts|comparisons|queries|qa|solutions)/[name].md$',
      });
    }
    if (!VAULT_PAGE_PATTERN.test(targetPath)) {
      return reply.code(400).send({
        error: 'Invalid targetPath: must match ^(entities|concepts|comparisons|queries|qa|solutions)/[name].md$',
      });
    }

    try {
      const result = await createBidirectionalLink(vault, sourcePath, targetPath);
      return reply.send({ sourcePath, targetPath, ...result });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

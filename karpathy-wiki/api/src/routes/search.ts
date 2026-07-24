import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { VaultService } from '../vault/vault-service.js';
import type { WebSearchConfig } from '../types.js';
import { searchPages } from '../search-util.js';
import { createWebSearchTool } from '../tools/web-search.js';

// 注册全文检索路由。
//   GET /api/search?q=关键词&source=&status=  全文检索 + frontmatter 过滤
//
// source/status 按页面 frontmatter 字段过滤（AC-10），可与 q 组合使用。
// 当仅提供 source/status 而无 q 时，返回所有匹配过滤条件的页面。
export function registerSearchRoute(app: FastifyInstance, vault: VaultService) {
  app.get('/api/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { q?: string; source?: string; status?: string };
    const hasFilter = query.source || query.status;
    if (!query.q?.trim() && !hasFilter) {
      return reply.code(400).send({ error: '缺少 q 参数或过滤条件（source/status）' });
    }

    try {
      const hits = await searchPages(vault, query.q || '', 20, {
        source: query.source,
        status: query.status,
      });
      return reply.send({ hits, total: hits.length });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

// §5.2 注册联网搜索路由。
//   POST /api/search/web  { query, limit? }
// 为什么独立路由：query workflow 内的 web_search 是工具调用（LLM 决策），
// 此路由供前端直接调用展示搜索结果（用户主动触发），两条链路共用 createWebSearchTool 工厂。
export function registerWebSearchRoute(app: FastifyInstance, config?: WebSearchConfig) {
  app.post('/api/search/web', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { query?: string; limit?: number };
    if (typeof body?.query !== 'string') {
      return reply.code(400).send({ error: '请求体须含 query 字段' });
    }
    if (!config) {
      return reply.code(400).send({ error: '搜索功能未配置' });
    }

    // 复用 workflow 工厂：保证路由直调与工具调用行为一致
    const tool = createWebSearchTool(config);
    if (!tool) {
      return reply.code(400).send({ error: '搜索 API Key 未配置' });
    }

    try {
      const results = await tool.handler({ query: body.query, limit: body.limit });
      return reply.send({ results, total: results.length });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

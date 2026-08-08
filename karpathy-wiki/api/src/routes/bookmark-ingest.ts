import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import { parseBookmarksHtml } from '../utils/bookmark-connector.js';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';

// FR-16-2 浏览器书签导入路由
// 遵循 V3.1 §6.2 约束：仅用于 ingest（内容先 archiveRaw → compile），禁止跨源 RAG
//
// POST /api/ingest/bookmarks: 上传书签 HTML 文件，解析为 Markdown 后存到 raw/ 目录
// 为什么不是 SSE：书签是静态文件解析，无需流式推送，JSON 一次性返回更简洁
// 为什么分离"解析"与"compile"：遵循项目"compile 是 compile"原则，前端拿到 combinedMarkdown
//   后复用 /api/compile 的 text 模式调用 compile，保持职责单一

export function registerBookmarkIngestRoute(app: FastifyInstance, vaultPath: string, guards: IsolationGuards = createIsolationGuards()) {
  app.post('/api/ingest/bookmarks', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    // 文件大小限制：书签导出文件通常 100KB-10MB，20MB 上限足够
    const data = await request.file({ limits: { fileSize: 20 * 1024 * 1024 } });
    if (!data) {
      return reply.code(400).send({ error: '请上传书签 HTML 文件' });
    }

    const buffer = await data.toBuffer();
    const filename = data.filename || 'bookmarks.html';

    // 编码检测：尝试 UTF-8，失败则回退 GBK（Windows 中文浏览器常用 GBK 编码）
    let html: string;
    try {
      html = buffer.toString('utf8');
      // 简单完整性检测：HTML 文件应包含 < 标签
      if (!html.includes('<')) {
        html = buffer.toString('latin1'); // 兜底编码
      }
    } catch {
      html = buffer.toString('latin1');
    }

    // 验证是否为书签文件：检查 Netscape Bookmark 文件头
    if (!html.includes('NETSCAPE-Bookmark-file') && !html.includes('<DT><A')) {
      return reply.code(400).send({
        error: '文件格式不符合书签 HTML 格式。请从浏览器导出书签为 HTML 文件。',
      });
    }

    try {
      const result = parseBookmarksHtml(html);

      if (result.entries.length === 0) {
        return reply.code(400).send({ error: '未找到有效书签链接' });
      }

      // 保存 Markdown 到 raw/ 目录（后续由用户触发 compile）
      const rawDir = vaultPath.replace(/[\\/]vault$/, '/raw');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const rawFilename = `bookmarks-${timestamp}.md`;
      const rawPath = `${rawDir}/${rawFilename}`;

      try {
        await fs.mkdir(rawDir, { recursive: true });
        await fs.writeFile(rawPath, result.combinedMarkdown, 'utf8');
      } catch (err) {
        return reply.code(500).send({
          error: `保存文件失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }

      return reply.send({
        ok: true,
        totalBookmarks: result.totalBookmarks,
        totalFolders: result.totalFolders,
        combinedMarkdown: result.combinedMarkdown,
        rawPath,
        // 前端可据此构造 compile 请求
        message: `已导入 ${result.totalBookmarks} 条书签（${result.totalFolders} 个文件夹），保存至 ${rawPath}，可立即编译。`,
      });
    } catch (err) {
      return reply.code(500).send({
        error: `解析失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

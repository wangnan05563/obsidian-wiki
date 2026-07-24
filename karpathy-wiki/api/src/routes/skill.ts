// 技能导入路由：提供 ZIP/.md 技能包的上传、列表、详情、删除能力。
//   POST   /api/skills/import  上传技能包（multipart/form-data，file 字段）
//   GET    /api/skills         列出所有已导入技能的元数据
//   GET    /api/skills/:id     获取技能详情（含 SKILL.md 全文与文件列表）
//   DELETE /api/skills/:id     删除指定技能
//
// 为什么独立路由：技能管理与 AI 模型配置、工具配置职责不同，
// 且涉及文件上传与解压，逻辑独立，便于权限隔离与维护。

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { importSkill, listSkills, getSkillDetail, deleteSkill } from '../skill/skill-service.js';
import type { SkillImportError } from '../types.js';

export function registerSkillRoute(app: FastifyInstance) {
  // POST /api/skills/import：上传技能包
  // 为什么用 multipart：技能包可能含多文件（ZIP 归档），需二进制上传
  // 限流：10/min，防止频繁上传耗尽磁盘
  app.post('/api/skills/import', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.startsWith('multipart/form-data')) {
      const err: SkillImportError = { error: 'Content-Type 必须为 multipart/form-data' };
      return reply.code(400).send(err);
    }

    const file = await request.file();
    if (!file) {
      const err: SkillImportError = { error: '缺少 file 字段' };
      return reply.code(400).send(err);
    }

    const buffer = await file.toBuffer();
    try {
      const result = await importSkill(buffer, file.filename);
      return reply.send(result);
    } catch (e) {
      const err: SkillImportError = {
        error: e instanceof Error ? e.message : '技能导入失败',
        details: e instanceof Error ? e.stack?.split('\n')[0] : undefined,
      };
      request.log.error({ err: e, filename: file.filename }, 'skill import failed');
      return reply.code(400).send(err);
    }
  });

  // GET /api/skills：列出所有已导入技能
  app.get('/api/skills', async (_request, reply) => {
    const skills = await listSkills();
    return reply.send({ skills });
  });

  // GET /api/skills/:id：获取技能详情
  // 路径穿越防护在 skill-service.getSkillDetail 内部通过白名单正则校验
  app.get('/api/skills/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const detail = await getSkillDetail(id);
    if (!detail) {
      return reply.code(404).send({ error: '技能不存在或 ID 非法' });
    }
    return reply.send(detail);
  });

  // DELETE /api/skills/:id：删除技能
  // 限流：10/min，防止误操作频繁删除
  app.delete('/api/skills/:id', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const ok = await deleteSkill(id);
    if (!ok) {
      return reply.code(404).send({ error: '技能不存在或 ID 非法' });
    }
    return reply.send({ ok: true });
  });
}

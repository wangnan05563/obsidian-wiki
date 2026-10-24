// 技能导入路由：提供 ZIP/.md 技能包的上传、列表、详情、启用/禁用、删除能力。
//   POST   /api/skills/import        上传技能包（multipart/form-data，file 字段）
//   GET    /api/skills               列出所有已导入技能的元数据
//   GET    /api/skills/:id           获取技能详情（含 SKILL.md 全文与文件列表）
//   PATCH  /api/skills/:id/enabled   切换技能启用状态（T02917）
//   DELETE /api/skills/:id           删除指定技能
//
// 为什么独立路由：技能管理与 AI 模型配置、工具配置职责不同，
// 且涉及文件上传与解压，逻辑独立，便于权限隔离与维护。

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { importSkill, listSkills, getSkillDetail, deleteSkill, setSkillEnabled } from '../skill/skill-service.js';
import type { SkillImportError } from '../types.js';
import type { IsolationGuards } from '../middleware/auth.js';
import { createIsolationGuards } from '../middleware/auth.js';

export function registerSkillRoute(
  app: FastifyInstance,
  guards: IsolationGuards = createIsolationGuards(),
) {
  // POST /api/skills/import：上传技能包
  // 为什么用 multipart：技能包可能含多文件（ZIP 归档），需二进制上传
  // 限流：10/min，防止频繁上传耗尽磁盘
  app.post('/api/skills/import', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.startsWith('multipart/form-data')) {
      const err: SkillImportError = { error: 'Content-Type 必须为 multipart/form-data' };
      return void reply.code(400).send(err);
    }

    const file = await request.file();
    if (!file) {
      return void reply.code(400).send({ error: '缺少 file 字段' });
    }

    const buffer = await file.toBuffer();
    try {
      const result = await importSkill(buffer, file.filename);
      return void reply.send(result);
    } catch (e) {
      const err: SkillImportError = {
        error: e instanceof Error ? e.message : '技能导入失败',
        details: e instanceof Error ? e.stack?.split('\n')[0] : undefined,
      };
      request.log.error({ err: e, filename: file.filename }, 'skill import failed');
      reply.code(400).send(err);
    }
  });

  // GET /api/skills：列出所有已导入技能
  // 为什么不按启用状态过滤（T02917）：被禁用的技能仍需在列表里可见，否则界面没有再次启用的入口；
  // 「可用技能数」由前端按 enabled 计算，服务端不隐藏。
  app.get('/api/skills', async (_request, reply) => {
    const skills = await listSkills();
    reply.send({ skills });
  });

  // GET /api/skills/:id：获取技能详情
  // 路径穿越防护在 skill-service.getSkillDetail 内部通过白名单正则校验
  app.get('/api/skills/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const detail = await getSkillDetail(id);
    if (!detail) {
      reply.code(404).send({ error: '技能不存在或 ID 非法' });
    }
    return void reply.send(detail);
  });

  // PATCH /api/skills/:id/enabled：切换启用状态（T02917）
  // 为什么要 requireAdmin：这条会写用户的 SKILL.md 落盘内容，
  //   而本路由其余端点今日无鉴权（已作为存量问题另行上报），新代码不再跟着漏。
  app.patch('/api/skills/:id/enabled', {
    preHandler: guards.requireAdmin,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { enabled?: unknown };
    if (!body || typeof body.enabled !== 'boolean') {
      return void reply.code(400).send({ error: '请求体需为 { enabled: boolean }' });
    }
    const meta = await setSkillEnabled(id, body.enabled);
    if (!meta) {
      return void reply.code(404).send({ error: '技能不存在或 ID 非法' });
    }
    return void reply.send(meta);
  });

  // DELETE /api/skills/:id：删除技能
  // 限流：10/min，防止误操作频繁删除
  app.delete('/api/skills/:id', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const ok = await deleteSkill(id);
    if (!ok) {
      return void reply.code(404).send({ error: '技能不存在或 ID 非法' });
    }
    reply.send({ ok: true });
  });
}

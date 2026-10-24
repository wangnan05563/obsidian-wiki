// T02917「技能启用状态」后端用例。
// ------------------------------------------------------------------
// 工单原话要求「先定口径再做」，本文件锁住最终口径：
//   · enabled 落在 SKILL.md frontmatter，缺失一律视为启用（存量技能升级后不得静默禁用）；
//   · 切换只改启用位，不碰 name/description 等其余 frontmatter 键与正文；
//   · 列表不隐藏被禁用的技能（否则界面没有再次启用的入口），可用数由前端按 enabled 现算。
// 为什么必须在 import 之前把 API_SKILLS_ROOT 指到临时目录：skill-service 在模块加载时
//   解析根目录，不指走就会把用例写进用户真实的 data/skills。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import matter from 'gray-matter';
import { fileURLToPath } from 'node:url';

import { createIsolationGuards } from '../src/middleware/auth.js';

let tmpRoot: string;
let svc: typeof import('../src/skill/skill-service.js');
let app: FastifyInstance;
let prevRoot: string | undefined;

const MD_BODY = '# 用法\n\n把三段材料合成一页。\n';

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-skills-enabled-'));
  prevRoot = process.env.API_SKILLS_ROOT;
  process.env.API_SKILLS_ROOT = tmpRoot;

  svc = await import('../src/skill/skill-service.js');
  const { registerSkillRoute } = await import('../src/routes/skill.js');

  app = Fastify({ logger: false });
  // 单租户形态（auth 未启用）：只验端点行为；鉴权接线由下面的源码守护盯住
  registerSkillRoute(app, createIsolationGuards({ enabled: false }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (prevRoot === undefined) delete process.env.API_SKILLS_ROOT;
  else process.env.API_SKILLS_ROOT = prevRoot;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('frontmatter 解析口径', () => {
  it('没有 enabled 字段 ⇒ 启用（存量技能不得被静默禁用）', async () => {
    const res = await svc.importSkill(Buffer.from(`---\nname: 无开关技能\n---\n\n${MD_BODY}`, 'utf8'), 'no-flag.md');
    expect(res.ok).toBe(true);
    expect(res.skill.enabled).toBe(true);
  });

  it('显式 enabled: false ⇒ 禁用；字符串 "false" 同样按禁用处理', async () => {
    const off = await svc.importSkill(
      Buffer.from(`---\nname: 显式关闭\ndescription: d\nenabled: false\n---\n\n${MD_BODY}`, 'utf8'),
      'explicit-off.md',
    );
    expect(off.skill.enabled).toBe(false);

    const quoted = await svc.importSkill(
      Buffer.from(`---\nname: 手写字符串\nenabled: "false"\n---\n\n${MD_BODY}`, 'utf8'),
      'quoted-off.md',
    );
    expect(quoted.skill.enabled).toBe(false);
  });

  it('列表返回全部技能（禁用项不隐藏），并逐条带 enabled', async () => {
    const list = await svc.listSkills();
    const byId = new Map(list.map((s) => [s.id, s]));
    expect(byId.get('no-flag')?.enabled).toBe(true);
    expect(byId.get('explicit-off')?.enabled).toBe(false);
    expect(byId.get('quoted-off')?.enabled).toBe(false);
  });
});

describe('setSkillEnabled 落盘', () => {
  it('关闭：写回 frontmatter，且保住 name/description 与正文', async () => {
    const before = (await svc.listSkills()).find((s) => s.id === 'no-flag');
    const meta = await svc.setSkillEnabled('no-flag', false);
    expect(meta?.enabled).toBe(false);
    // importedAt 派生自目录 mtime：切换开关不得把它改成「刚刚」
    expect(meta?.importedAt).toBe(before?.importedAt);

    const raw = await fs.readFile(path.resolve(tmpRoot, 'no-flag', 'SKILL.md'), 'utf8');
    const parsed = matter(raw);
    expect(parsed.data.enabled).toBe(false);
    // 只改启用位：其余元数据与正文逐字保留
    expect(parsed.data.name).toBe('无开关技能');
    expect(parsed.content).toContain('把三段材料合成一页。');

    // 重新读盘（不依赖返回值）：列表必须跟着变
    const listed = (await svc.listSkills()).find((s) => s.id === 'no-flag');
    expect(listed?.enabled).toBe(false);
  });

  it('重新开启：状态回 true，且不留下临时文件', async () => {
    const meta = await svc.setSkillEnabled('no-flag', true);
    expect(meta?.enabled).toBe(true);
    const files = await fs.readdir(path.resolve(tmpRoot, 'no-flag'));
    expect(files.filter((f) => f.includes('.tmp-'))).toHaveLength(0);
    expect(files).toContain('SKILL.md');
  });

  it('非法 ID / 不存在的技能 ⇒ null（与详情、删除同一口径）', async () => {
    expect(await svc.setSkillEnabled('../etc', false)).toBeNull();
    expect(await svc.setSkillEnabled('does-not-exist', false)).toBeNull();
    // 目录在但没有入口文件
    await fs.mkdir(path.resolve(tmpRoot, 'empty-dir'), { recursive: true });
    expect(await svc.setSkillEnabled('empty-dir', false)).toBeNull();
  });
});

describe('PATCH /api/skills/:id/enabled 接线', () => {
  it('切换成功返回最新元数据', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/skills/explicit-off/enabled', payload: { enabled: true } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; enabled: boolean };
    expect(body.id).toBe('explicit-off');
    expect(body.enabled).toBe(true);
  });

  it('body 不是布尔 ⇒ 400，且不落盘', async () => {
    const before = (await svc.listSkills()).find((s) => s.id === 'explicit-off')?.enabled;
    const res = await app.inject({ method: 'PATCH', url: '/api/skills/explicit-off/enabled', payload: { enabled: 'false' } });
    expect(res.statusCode).toBe(400);
    const after = (await svc.listSkills()).find((s) => s.id === 'explicit-off')?.enabled;
    expect(after).toBe(before);
  });

  it('未知 ID ⇒ 404', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/skills/unknown-skill/enabled', payload: { enabled: false } });
    expect(res.statusCode).toBe(404);
  });
});

describe('源码守护：新端点不得裸奔', () => {
  it('PATCH 启用端点带 requireAdmin；列表不按 enabled 过滤', () => {
    const src = fsSync.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/routes/skill.ts'),
      'utf8',
    );
    const patchBlock = /app\.patch\('\/api\/skills\/:id\/enabled'[\s\S]*?\n  \}\);/.exec(src)?.[0] ?? '';
    expect(patchBlock).toContain('preHandler: guards.requireAdmin');
    const listBlock = /app\.get\('\/api\/skills'[\s\S]*?\n  \}\);/.exec(src)?.[0] ?? '';
    expect(listBlock).not.toMatch(/filter/);
  });

  it('index.ts 把真实守卫传进技能路由（默认 guards 是空转的）', () => {
    const src = fsSync.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'),
      'utf8',
    );
    // 不传第二参时 createIsolationGuards() 的 enabled 默认为 false，守卫全部空转
    expect(src).toContain('registerSkillRoute(app, isolationGuards)');
    expect(src).not.toMatch(/registerSkillRoute\(app\);/);
  });
});

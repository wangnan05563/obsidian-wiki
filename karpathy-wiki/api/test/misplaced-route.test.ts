// T02797 路由层：GET /api/data-clean/misplaced 与 POST /api/data-clean/misplaced/promote。
// ------------------------------------------------------------------
// 模块级用例（misplaced-pages.test.ts）已经证明检测与归位本身正确；本文件只管「接线」：
//   ① 端点真的可达、返回形状与前端读的字段一致（T02773 那类「接口返回正常、显示被吃掉」
//      只在前端读不到键时才会暴露，故这里按 JSON 字面键名断言，不按 TS 类型）；
//   ② 破坏性端点默认 dry_run（不传就不许动盘）——与本页其余写操作同一套约定；
//   ③ requireAdmin 必须真截断：未登录调用回 401，且文件一个都不能少动。
//      守卫的 done 桥接本身由 isolation-guards.test.ts 逐路由验过，这里只补本端点这一处。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import { VaultService } from '../src/vault/vault-service.js';
import { registerDataCleanRoute } from '../src/routes/data-clean.js';
import { createIsolationGuards } from '../src/middleware/auth.js';
import { initAuditLog, resetAuditLog } from '../src/auth/audit-log.js';

let tempDir: string;
let vaultDir: string;
let vault: VaultService;
let app: FastifyInstance;

/** 落一条存量错位页（绕过写盘校验，与 misplaced-pages.test.ts 同一造法） */
async function writeStray(rel: string, title: string, type: string): Promise<string> {
  const abs = path.join(vaultDir, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, matter.stringify(`\n# ${title}\n\n正文\n`, { title, type, updated: '2026-10-21' }), 'utf8');
  return rel;
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-misplaced-route-'));
  await initAuditLog(path.join(tempDir, 'audit.log'));
  vaultDir = path.join(tempDir, 'vault');
  vault = new VaultService(vaultDir);
  await vault.init();
  // 单租户形态（auth 未启用）：守卫放行，用于验端点行为
  app = Fastify({ logger: false });
  registerDataCleanRoute(app, vault, createIsolationGuards({ enabled: false }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  resetAuditLog();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('GET /api/data-clean/misplaced', () => {
  it('返回错位页数组，键名与前端读的 path/title/suggestedPath/conflict 逐字一致', async () => {
    const rel = await writeStray('concepts/entity/route-proof.md', '路由取证页', 'entity');
    const res = await app.inject({ method: 'GET', url: '/api/data-clean/misplaced' });
    expect(res.statusCode).toBe(200);
    const items = res.json();
    expect(Array.isArray(items)).toBe(true);
    const hit = items.find((i: any) => i.path === rel);
    expect(hit, '刚写的错位页必须出现在响应里').toBeTruthy();
    expect(Object.keys(hit).sort()).toEqual(['conflict', 'path', 'suggestedPath', 'title', 'type']);
    expect(hit.suggestedPath).toBe('entities/route-proof.md');
    expect(hit.conflict).toBeNull();
  });
});

describe('GET /api/data-clean/precheck（T02843 同屏口径）', () => {
  it('预检响应里这一类的数量与 GET /misplaced 完全一致（两个端点不得各算各的）', async () => {
    await writeStray('concepts/legacy/precheck-route.md', '预检接线取证页', 'concept');
    const misplacedRes = await app.inject({ method: 'GET', url: '/api/data-clean/misplaced' });
    const precheckRes = await app.inject({ method: 'GET', url: '/api/data-clean/precheck' });
    expect(misplacedRes.statusCode).toBe(200);
    expect(precheckRes.statusCode).toBe(200);

    const items = misplacedRes.json();
    const body = precheckRes.json();
    const lines = (body.warnings as string[]).filter((w) => w.includes('知识库索引不到'));
    expect(lines, '预检结论必须带上这一类，否则同屏仍是两个口径').toHaveLength(1);
    expect(Number(lines[0].match(/^(\d+)\s/)?.[1]), '两处数量').toBe(items.length);
    expect(items.length, '前置：本 vault 里确实有错位页').toBeGreaterThan(0);
    // 这一类不是错误：编译门与「预检通过」的语义不因它翻转（只有解析错误才 blocked）
    expect(body.blocked).toBe(false);
  });
});

describe('POST /api/data-clean/misplaced/promote', () => {
  it('paths 缺失 → 400，不动盘', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/data-clean/misplaced/promote', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('paths');
  });

  it('不传 dry_run 时按预览处理（默认值必须是 true，否则一次误点就搬文件）', async () => {
    const rel = await writeStray('qa/legacy/default-dry.md', '默认预览页', 'qa');
    const res = await app.inject({
      method: 'POST',
      url: '/api/data-clean/misplaced/promote',
      payload: { paths: [rel] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(true);
    expect(body.promoted).toEqual([{ from: rel, to: 'qa/default-dry.md' }]);
    expect(await vault.readFile(rel), '预览不得移动文件').toContain('正文');
    await expect(fs.stat(path.join(vaultDir, 'qa', 'default-dry.md'))).rejects.toThrow(/ENOENT/);
  });

  it('dry_run=false → 真归位，返回 promoted/skipped/errors/dryRun 四个键', async () => {
    const rel = await writeStray('solutions/legacy/real-move.md', '真实归位页', 'solution');
    const res = await app.inject({
      method: 'POST',
      url: '/api/data-clean/misplaced/promote',
      payload: { paths: [rel], dry_run: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['dryRun', 'errors', 'promoted', 'skipped']);
    expect(body.promoted).toEqual([{ from: rel, to: 'solutions/real-move.md' }]);
    expect(body.errors).toEqual([]);
    expect(await vault.listAllPages()).toContainEqual(expect.objectContaining({ path: 'solutions/real-move.md' }));
  });

  it('auth 启用且未登录 → 401 截断，文件保持错位原样', async () => {
    const rel = await writeStray('comparisons/locked/guard.md', '门控取证页', 'comparison');
    const gated = Fastify({ logger: false });
    registerDataCleanRoute(gated, vault, createIsolationGuards({ enabled: true }));
    await gated.ready();
    try {
      const res = await gated.inject({
        method: 'POST',
        url: '/api/data-clean/misplaced/promote',
        payload: { paths: [rel], dry_run: false },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('UNAUTHORIZED');
      expect(await vault.readFile(rel), '被拦下的请求不得产生任何移动').toContain('正文');
      await expect(fs.stat(path.join(vaultDir, 'comparisons', 'guard.md'))).rejects.toThrow(/ENOENT/);
      // 只读检测不受管理员门控（发现问题不该需要提权才能看见）
      const probe = await gated.inject({ method: 'GET', url: '/api/data-clean/misplaced' });
      expect(probe.statusCode).toBe(200);
    } finally {
      await gated.close();
    }
  });
});

// T02478（PRD X6/L1 · REQ-038）：页面口径跨端一致性的**运行时**守护。
// ------------------------------------------------------------------
// 为什么还要再写一个 api 侧测试：前端 p0-regression.test.ts 只能证明
// 「前端常量 PAGE_SCOPE_DIRS 与后端 PAGE_DIRS 字面相同」，证明不了三条统计链路
// （/api/stats 的 totalPages、/api/stats 的 dirCounts、/api/data-clean/pages 的 scanVault）
// 真的都按这份口径取数。真机回归时踩到的正是这个缺口：3000 端口上跑的是 page-scope
// 落地前启动的旧进程，页面质量清洗显示 216、仪表盘显示 245，而 216 恰好等于
// 「concepts + entities + comparisons 三目录白名单」的旧口径 —— 只看源码看不出来，
// 只有把三条链路放在同一个 fixture vault 上跑一遍，才能锁死「三处必须同一个数」。
//
// fixture 刻意包含三类噪声文件，它们都不算页面：
//   entities/test-*.md、entities/proxy-test*.md  → 联调遗留（isPageFile 排除）
//   drafts/*.md、raw/*.md、根目录 index.md        → 不在 PAGE_DIRS 内
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { VaultService } from '../src/vault/vault-service.js';
import { PAGE_DIRS } from '../src/vault/page-scope.js';
import { scanVault } from '../src/data-clean/quality-scanner.js';
import { registerStatsRoute } from '../src/routes/stats.js';

/** 每个 PAGE_DIRS 目录放 1 个正式页，共 PAGE_DIRS.length 个页面 */
const EXPECTED_PAGES = PAGE_DIRS.length;

let vaultDir: string;
let vault: VaultService;

function page(title: string, links: string[] = []): string {
  return `---\ntype: concept\ntitle: ${title}\n---\n\n# ${title}\n\n正文内容，词数够长一些以免被判为占位页。${'内容 '.repeat(30)}\n\n关联：${links.map((l) => `[[${l}]]`).join(' ')}\n`;
}

beforeAll(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'page-scope-vault-'));
  for (const dir of PAGE_DIRS) {
    await fs.mkdir(path.join(vaultDir, dir), { recursive: true });
  }
  // 正式页面：每个口径内目录 1 个
  for (const dir of PAGE_DIRS) {
    await fs.writeFile(path.join(vaultDir, dir, `${dir}-page.md`), page(`${dir} 页`), 'utf-8');
  }
  // 联调遗留：在口径内目录，但必须被 isPageFile 排除
  await fs.writeFile(path.join(vaultDir, 'entities', 'test-leftover.md'), page('test 遗留'), 'utf-8');
  await fs.writeFile(path.join(vaultDir, 'entities', 'proxy-test-leftover.md'), page('proxy 遗留'), 'utf-8');
  // 口径外目录：draft 是中间状态，raw 是原始资料
  await fs.mkdir(path.join(vaultDir, 'drafts'), { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'raw'), { recursive: true });
  await fs.writeFile(path.join(vaultDir, 'drafts', 'draft-page.md'), page('草稿页'), 'utf-8');
  await fs.writeFile(path.join(vaultDir, 'raw', 'source.md'), '原始资料，不是页面', 'utf-8');
  // 根目录索引文件也不是页面
  await fs.writeFile(path.join(vaultDir, 'index.md'), page('索引'), 'utf-8');
  await fs.writeFile(path.join(vaultDir, 'log.md'), '## 2026-10-19\n- 操作类型：compile\n', 'utf-8');

  vault = new VaultService(vaultDir);
});

afterAll(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('页面口径三链路一致（REQ-038 运行时守护）', () => {
  let app: FastifyInstance;
  let stats: { totalPages: number; dirCounts: Record<string, number> };

  beforeAll(async () => {
    app = Fastify();
    registerStatsRoute(app, vault);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(200);
    stats = res.json();
    await app.close();
  });

  it('数据清洗扫描（/api/data-clean/pages 的底层）按 PAGE_DIRS 取数，排除测试遗留与口径外目录', async () => {
    const pages = await scanVault(vault);
    expect(pages).toHaveLength(EXPECTED_PAGES);
    const dirs = new Set(pages.map((p) => p.path.split('/')[0]));
    expect([...dirs].sort()).toEqual([...PAGE_DIRS].sort());
    expect(pages.map((p) => p.path)).not.toContain('entities/test-leftover.md');
    expect(pages.map((p) => p.path)).not.toContain('drafts/draft-page.md');
  });

  it('/api/stats 的 totalPages 与清洗扫描同一个数（仪表盘与清洗页不再各说各话）', async () => {
    const scanned = await scanVault(vault);
    expect(stats.totalPages).toBe(scanned.length);
    expect(stats.totalPages).toBe(EXPECTED_PAGES);
  });

  it('/api/stats 的目录分布合计等于 totalPages（同一页内不自相矛盾）', () => {
    expect(Object.keys(stats.dirCounts).sort()).toEqual([...PAGE_DIRS].sort());
    const sum = Object.values(stats.dirCounts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(stats.totalPages);
  });

  it('链接图节点集与清洗页面集同源（图谱「共 N 个节点」不再另算一套）', async () => {
    const graph = await vault.buildLinkGraph();
    const scanned = (await scanVault(vault)).map((p) => p.path).sort();
    expect([...graph.nodes].sort()).toEqual(scanned);
  });
});

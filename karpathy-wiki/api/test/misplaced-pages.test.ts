// T02797：存量错位页面（页面目录的子目录里的 .md）检测与一键归位。
// ------------------------------------------------------------------
// 本用例覆盖任务的四条判据：
//   A 递归检测覆盖全部页面目录，且刻意合法的嵌套（queries/media）不被误报
//   B 归位落点按页面自己声明的 type 反查（PAGE_DIR_TO_TYPE 的反向量），不是按所在目录猜
//   C 命中已有同名/同标题页面时只报冲突，绝不自动并页
//   D 归位是确定性读→写→删：内容逐字不变、旧路径消失、空子目录清掉、页面立刻回到索引里
//   E 调用方无法借归位接口摆布落点或路径（只认「当前确实错位」的条目）
// 造法与 T02731 同源（vault-page-depth.test.ts:136-138）：用 fs 直接落盘，
//   模拟「写盘深度校验上线前」就已存在的存量错位页——本模块的处置对象正是它们，
//   走 writeFile 造不出来（会被 pageDepthError 直接拒收）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import { PAGE_DIRS, TYPE_TO_PAGE_DIR, pageDepthError } from '../src/vault/page-scope.js';
import { VaultService } from '../src/vault/vault-service.js';
import { detectMisplacedPages, promoteMisplacedPages } from '../src/data-clean/misplaced-pages.js';

let tempDir: string;
let vaultDir: string;
let vault: VaultService;

/** 绕过写盘校验落盘（存量错位的成因），返回 vault 相对路径 */
async function writeStray(rel: string, title: string, type: string, body = '正文内容'): Promise<string> {
  const abs = path.join(vaultDir, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const fm: Record<string, string> = { title, updated: '2026-10-21' };
  if (type) fm.type = type;
  await fs.writeFile(abs, matter.stringify(`\n# ${title}\n\n${body}\n`, fm), 'utf8');
  return rel;
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-misplaced-'));
  vaultDir = path.join(tempDir, 'vault');
  vault = new VaultService(vaultDir);
  await vault.init();
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('A · 递归检测：覆盖全部页面目录，合法嵌套不误报', () => {
  it('每个页面目录下的子目录页面都被检出；queries/media 与平铺页面不算错位', async () => {
    const strayPaths: string[] = [];
    for (const dir of PAGE_DIRS) {
      strayPaths.push(await writeStray(`${dir}/legacy/${dir}-one.md`, `${dir} 错位一页`, ''));
    }
    // 更深一层也要能扫到（子目录里再套子目录同样隐身）
    await writeStray('concepts/legacy/deeper/two.md', '二层嵌套错位页', 'concept');
    // 合法平铺页与刻意嵌套的媒体归档不得进检测结果
    await vault.writeFile('entities/flat-ok.md', '---\ntitle: 平铺页面\ntype: entity\n---\n\n正文\n');
    await vault.writeFile('queries/media/media-archive.md', '---\ntitle: 媒体归档\ntype: query\n---\n\n归档说明\n');
    // 联调遗留的 test-*.md 按页面口径就不是页面（isPageFile），别把它报成「丢了的页面」
    await writeStray('concepts/legacy/test-proxy.md', '联调测试文件', 'concept');

    const found = (await detectMisplacedPages(vault)).map((m) => m.path);
    for (const rel of strayPaths) {
      expect(found, `${rel} 应被判为错位（flat readdir 扫不到它，用户无从发现）`).toContain(rel);
    }
    expect(found).toContain('concepts/legacy/deeper/two.md');
    expect(found, '平铺页面不是错位').not.toContain('entities/flat-ok.md');
    expect(found.filter((p) => p.startsWith('queries/media/')), '媒体归档是刻意设计，误报等于让用户搬错文件').toEqual([]);
    expect(found, 'test-*.md 按页面口径就不是页面').not.toContain('concepts/legacy/test-proxy.md');
    // 检测目录集与 PAGE_DIRS 同源：新增页面目录后检测面自动跟着扩
    expect(new Set(found.map((p) => p.split('/')[0]))).toEqual(new Set(PAGE_DIRS));
  });
});

describe('B · 落点按 frontmatter type 反查，不按所在目录猜', () => {
  it('type: entity 被写进 concepts/entity/ → 建议落点是 entities/（T02731 的实测错位形状）', async () => {
    const rel = await writeStray('concepts/entity/bill-recourse.md', '票据追索权', 'entity');
    const item = (await detectMisplacedPages(vault)).find((m) => m.path === rel);
    expect(item, '刚写的错位页应被检出').toBeTruthy();
    expect(item!.suggestedPath).toBe('entities/bill-recourse.md');
    expect(pageDepthError(item!.suggestedPath), '建议落点本身必须写得进去').toBeNull();
  });

  it('type 缺失/未知时留在原顶层目录，只补掉多余层级，不改页面归属', async () => {
    const noType = await writeStray('qa/legacy/no-type.md', '无类型页', '');
    const weird = await writeStray('qa/legacy/odd-type.md', '怪类型页', 'not-a-real-type');
    const items = await detectMisplacedPages(vault);
    expect(items.find((m) => m.path === noType)!.suggestedPath).toBe('qa/no-type.md');
    expect(items.find((m) => m.path === weird)!.suggestedPath).toBe('qa/odd-type.md');
    // 反查表由 PAGE_DIR_TO_TYPE 派生：qa 的 type 就是 qa，不该被兜底成 concept
    expect(TYPE_TO_PAGE_DIR.qa).toBe('qa');
  });
});

describe('C · 冲突只报不并页', () => {
  it('目标目录已有同名文件时报冲突，且真实归位会跳过、原文件保持不动', async () => {
    const keeper = 'comparisons/keep-me.md';
    await vault.writeFile(keeper, '---\ntitle: 已存在的对照页\ntype: comparison\n---\n\n已有内容，不能被覆盖\n');
    const stray = await writeStray('concepts/sub/keep-me.md', '子目录里的对照页', 'comparison');

    const item = (await detectMisplacedPages(vault)).find((m) => m.path === stray);
    expect(item!.suggestedPath).toBe(keeper);
    expect(item!.conflict, '同名目标已存在必须报冲突').toMatch(/目标位置已有同名页面/);

    const res = await promoteMisplacedPages(vault, [stray], false);
    expect(res.promoted).toEqual([]);
    expect(res.skipped).toEqual([{ path: stray, reason: item!.conflict! }]);
    expect(await vault.readFile(stray)).toContain('正文内容');
    expect(await vault.readFile(keeper)).toContain('已有内容，不能被覆盖');
  });

  it('目标目录已有同标题（不同文件名）页面时也报冲突，交给用户决定并页', async () => {
    await vault.writeFile('solutions/existing-title.md', '---\ntitle: 同一主题\ntype: solution\n---\n\n既有页面\n');
    const stray = await writeStray('concepts/sub/other-name.md', '同一主题', 'solution');
    const item = (await detectMisplacedPages(vault)).find((m) => m.path === stray);
    expect(item!.suggestedPath).toBe('solutions/other-name.md');
    expect(item!.conflict).toMatch(/同标题页面：solutions\/existing-title\.md/);
  });

  it('两条错位页归位到同一落点时互相报冲突（各自都不冲突、并到一起才撞车）', async () => {
    const a = await writeStray('entities/x-group/a.md', '同批甲', 'entity');
    const b = await writeStray('concepts/x-group/a.md', '同批乙', 'entity');
    const items = await detectMisplacedPages(vault);
    const ia = items.find((m) => m.path === a)!;
    const ib = items.find((m) => m.path === b)!;
    expect(ia.suggestedPath).toBe(ib.suggestedPath);
    expect(ia.conflict).toMatch(/与本批另一个页面同名/);
    expect(ib.conflict).toMatch(/与本批另一个页面同名/);
    // 真实归位两条都不动，避免「先搬的把后搬的挤掉」
    const res = await promoteMisplacedPages(vault, [a, b], false);
    expect(res.promoted).toEqual([]);
    expect(res.skipped.map((s) => s.path)).toEqual([a, b]);
  });
});

describe('D · 归位：读→写→删，页面重新进入索引', () => {
  it('dry_run 只给预览，不落任何盘', async () => {
    const rel = await writeStray('comparisons/legacy/dry.md', '预演页', 'comparison');
    const res = await promoteMisplacedPages(vault, [rel], true);
    expect(res.dryRun).toBe(true);
    expect(res.promoted).toEqual([{ from: rel, to: 'comparisons/dry.md' }]);
    await expect(fs.readFile(path.join(vaultDir, 'comparisons', 'dry.md'), 'utf8')).rejects.toThrow();
    expect(await vault.readFile(rel)).toContain('正文内容');
  });

  it('真实归位后内容逐字不变、旧路径与空子目录消失、列表与 [[引用]] 解析同时恢复', async () => {
    // 用只装这一页的子目录：归位后它才应当被连带清掉（A 里那些 legacy/ 还有同伴，不会空）
    const rel = await writeStray('queries/p-legacy/p-2026.md', '季度问答页', 'query', '待归位的原文，含 [[平铺页面]] 引用');
    const before = await vault.readFile(rel);
    const pathsBefore = (await vault.listAllPages()).map((p) => p.path);
    expect(pathsBefore, '归位前它确实不在页面列表里（这正是「隐身」的实测形状）').not.toContain(rel);

    const res = await promoteMisplacedPages(vault, [rel], false);
    expect(res.errors).toEqual([]);
    expect(res.promoted).toEqual([{ from: rel, to: 'queries/p-2026.md' }]);

    expect(await vault.readFile('queries/p-2026.md'), '正文必须逐字不变（归位不改内容，只改落点）').toBe(before);
    await expect(fs.stat(path.join(vaultDir, rel)), '旧路径应已删除').rejects.toThrow(/ENOENT/);
    await expect(fs.stat(path.join(vaultDir, 'queries', 'p-legacy')), '搬空的子目录应清掉').rejects.toThrow(/ENOENT/);

    const paths = (await vault.listAllPages()).map((p) => p.path);
    expect(paths).toContain('queries/p-2026.md');
    expect(await vault.resolvePageName('p-2026')).toBe('queries/p-2026.md');
    // 归位后不再被检测为错位
    expect((await detectMisplacedPages(vault)).map((m) => m.path)).not.toContain(rel);
  });

  it('深层嵌套归位后整条空目录链一起清空（顶层页面目录本身保留）', async () => {
    const rel = await writeStray('solutions/a-group/b-group/deep.md', '深层页', 'solution');
    await promoteMisplacedPages(vault, [rel], false);
    const vaultPathOf = (r: string) => path.join(vaultDir, ...r.split('/'));
    await expect(fs.stat(vaultPathOf('solutions/a-group/b-group')), '第二层空目录应清掉').rejects.toThrow(/ENOENT/);
    await expect(fs.stat(vaultPathOf('solutions/a-group')), '第一层空目录应清掉').rejects.toThrow(/ENOENT/);
    const deepStat = await fs.stat(vaultPathOf('solutions'));
    expect(deepStat.isDirectory(), '顶层页面目录必须保留').toBe(true);
    expect(await vault.readFile('solutions/deep.md')).toContain('正文内容');
  });

  it('多条一起归位：逐条独立，成功的落盘、失败的报错不阻断其余', async () => {
    const ok = await writeStray('entities/batch/batch-one.md', '批量甲', 'entity');
    const alsoOk = await writeStray('concepts/batch/batch-two.md', '批量乙', 'concept');
    const res = await promoteMisplacedPages(vault, [ok, alsoOk, 'entities/not-stray.md'], false);
    expect(res.promoted.map((p) => p.to).sort()).toEqual(['concepts/batch-two.md', 'entities/batch-one.md']);
    expect(res.skipped).toHaveLength(1);
    expect(res.errors).toEqual([]);
  });
});

describe('E · 落点与路径不可被调用方操纵', () => {
  it('只接受「当前确实错位」的路径；平铺页与越权路径一律跳过，不产生任何写入或删除', async () => {
    const flat = 'entities/flat-ok.md';
    await vault.writeFile(flat, '---\ntitle: 平铺页面\ntype: entity\n---\n\n正文\n');
    const res = await promoteMisplacedPages(vault, [flat, '../../outside.md', 'concepts/../../outside.md', ''], false);
    expect(res.promoted).toEqual([]);
    expect(res.errors).toEqual([]);
    await expect(fs.stat(path.join(tempDir, 'outside.md')), '不得在 vault 之外留文件').rejects.toThrow(/ENOENT/);
    expect(await vault.readFile(flat)).toContain('正文');
    expect(res.skipped).toHaveLength(3);
  });
});

describe('F · 目录索引补登（T02844：index.md 定位是「内容目录，每页一行摘要」）', () => {
  it('真实归位后 index.md 追加一行摘要；dry_run 一律不动 index', async () => {
    const idxBefore = await vault.readFile('index.md');
    const rel = await writeStray('comparisons/legacy/idx.md', '索引补登页', 'comparison');

    await promoteMisplacedPages(vault, [rel], true);
    expect(await vault.readFile('index.md'), 'dry_run 只预览，index 不得被写').toBe(idxBefore);

    const res = await promoteMisplacedPages(vault, [rel], false);
    expect(res.errors).toEqual([]);
    const idx = await vault.readFile('index.md');
    expect(idx).toContain('- [[索引补登页]] — 错位归位：原位于 comparisons/legacy/idx.md');
  });

  it('index 已有同名行时去重不重复登记；重复归位同一页也不产生重复行', async () => {
    const rel = await writeStray('entities/legacy/dup-idx.md', '重复登记页', 'entity');
    await vault.appendIndex('重复登记页', '归位前已存在的摘要行');
    expect((await vault.readFile('index.md')).match(/^- \[\[重复登记页\]\]/gm)).toHaveLength(1);

    const res = await promoteMisplacedPages(vault, [rel], false);
    expect(res.errors).toEqual([]);
    const idx = await vault.readFile('index.md');
    expect(idx.match(/^- \[\[重复登记页\]\]/gm), '同名行只保留一条').toHaveLength(1);
    expect(idx).toContain('归位前已存在的摘要行');

    // 页面已归位（不再错位），重复调用归位会 skip——这里验证的是 appendIndex 自身幂等口径：
    // 同名再登记一次也不产生第二行（promote 重试 / 多入口登记同页的兜底）
    await vault.appendIndex('重复登记页', '第二次登记');
    expect((await vault.readFile('index.md')).match(/^- \[\[重复登记页\]\]/gm)).toHaveLength(1);
  });
});

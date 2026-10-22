// T02843：预检结论与「页面在子目录里，知识库索引不到」那块必须同源。
// ------------------------------------------------------------------
// 用户报的表现：同一屏上「Vault 预检：通过（扫描 243 个文件 · 0 个错误）」和
//   「页面在子目录里，知识库索引不到（3 个）」并存——预检自己也是逐顶层目录 flat readdir，
//   这一类问题压根不在它的结论里，用户读不出到底哪个作数。
// 卡面判据与本用例的对应关系：
//   1 预检里出现该类条目，且数量与 detectMisplacedPages 完全一致（A 组，同一函数出数）
//   2 queries/media（NESTED_PAGE_DIRS）与 test-*.md（isPageFile）两处都不计入（B 组）
//   3 例外清单加成员时两处同时变（C 组——防「例外只在一处生效」）
//   4 文案与前端块标题逐字同源（D 组：同屏说两句话本身就是矛盾）
// 「预检不得自带第二份检测逻辑」这条守在 vault-page-depth.test.ts 的 D 组（T02731 的同源约定）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

import { NESTED_PAGE_DIRS, PAGE_DIRS } from '../src/vault/page-scope.js';
import { VaultService } from '../src/vault/vault-service.js';
import { precheckVault } from '../src/data-clean/quality-scanner.js';
import { detectMisplacedPages, misplacedPrecheckWarning, MISPLACED_ISSUE_PHRASE } from '../src/data-clean/misplaced-pages.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

let tempDir: string;
let vaultDir: string;
let vault: VaultService;

/** 绕过写盘校验落盘存量错位页（与 misplaced-pages.test.ts 同一造法：走 writeFile 造不出来） */
async function writeStray(rel: string, title: string, type: string): Promise<string> {
  const abs = path.join(vaultDir, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, matter.stringify(`\n# ${title}\n\n正文\n`, { title, type, updated: '2026-10-21' }), 'utf8');
  return rel;
}

/** 预检结论里指向「子目录页面」这一类的条目（按前端那句文案筛，不按索引位置——警告顺序不是契约） */
function misplacedWarnings(warnings: string[]): string[] {
  return warnings.filter((w) => w.includes('知识库索引不到'));
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-precheck-misplaced-'));
  vaultDir = path.join(tempDir, 'vault');
  vault = new VaultService(vaultDir);
  await vault.init();
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('A · 预检报出这一类，且数量与检测完全一致', () => {
  it('库里没有错位页时不得凭空报出这一类（空结果不制造假问题）', async () => {
    await vault.writeFile('entities/clean-one.md', '---\ntitle: 干净页面\ntype: entity\n---\n\n正文\n');
    const result = await precheckVault(vault);
    expect(await detectMisplacedPages(vault)).toEqual([]);
    expect(misplacedWarnings(result.warnings), '没有错位页就不该有这一类警告').toEqual([]);
  });

  it('每个页面目录都有错位页时，预检警告里的数字等于 detectMisplacedPages 的条数', async () => {
    for (const dir of PAGE_DIRS) {
      await writeStray(`${dir}/legacy/${dir}-stray.md`, `${dir} 错位页`, '');
    }
    const detected = await detectMisplacedPages(vault);
    const result = await precheckVault(vault);
    const lines = misplacedWarnings(result.warnings);

    expect(lines, '这一类必须进预检结论，否则同屏仍是两个口径').toHaveLength(1);
    // 逐字比对而不是「包含数字」：数字是格式化出来的，写错口径（比如扫目录数）也要红
    expect(lines[0]).toBe(misplacedPrecheckWarning(detected));
    expect(Number(lines[0].match(/^(\d+)\s/)?.[1]), '警告里的数字').toBe(detected.length);
    expect(detected).toHaveLength(PAGE_DIRS.length);
  });

  it('这一类只记警告：不改 scannedFiles 口径，也不翻转 passed/blocked', async () => {
    const result = await precheckVault(vault);
    expect(result.blocked, '错位页不是解析错误，不该阻断编译门').toBe(false);
    expect(result.passed, 'errors 仍为空 ⇒ 预检不算失败，但警告必须看得见').toBe(true);
    // 错位页按口径不算页面（否则本页「页面总数」与仪表盘又会错位，T02472 修过同源缺陷）
    expect(result.scannedFiles, 'scannedFiles 仍只数合法平铺页面').toBe(1);
    expect(result.errors).toEqual([]);
  });
});

describe('B · 例外口径两处一致', () => {
  it('queries/media 的归档页与 test-*.md 既不进检测，也不进预检警告', async () => {
    await vault.writeFile('queries/media/media-note.md', '---\ntitle: 媒体归档\ntype: query\n---\n\n归档说明\n');
    const stray = await writeStray('comparisons/legacy/test-proxy.md', '联调遗留文件', 'comparison');
    const before = await detectMisplacedPages(vault);

    const result = await precheckVault(vault);
    expect(misplacedWarnings(result.warnings)[0]).toBe(misplacedPrecheckWarning(before));
    expect(before.map((m) => m.path), '媒体归档是刻意嵌套').not.toContain('queries/media/media-note.md');
    expect(before.map((m) => m.path), 'test-*.md 按页面口径就不是页面').not.toContain(stray);
    expect(before.every((m) => !m.path.startsWith('queries/media/')), '整棵媒体子树都不该计入').toBe(true);
  });
});

describe('C · 例外清单加成员时两处同时变', () => {
  it('把某个错位目录登记为合法嵌套后，检测与预检同时少掉这些页面', async () => {
    const detected = await detectMisplacedPages(vault);
    const warningBefore = misplacedWarnings((await precheckVault(vault)).warnings)[0];
    expect(warningBefore).toBe(misplacedPrecheckWarning(detected));

    // 挑一个 A 组确实造出错位页的目录（entities/legacy）当临时例外
    const tempNested = 'entities/legacy';
    const inside = detected.filter((m) => m.path.startsWith(`${tempNested}/`));
    expect(inside.length, `前置：${tempNested} 下应有错位页，否则本用例测不出联动`).toBeGreaterThan(0);

    NESTED_PAGE_DIRS.push(tempNested);
    try {
      const after = await detectMisplacedPages(vault);
      const warningAfter = misplacedWarnings((await precheckVault(vault)).warnings)[0];
      // 两处同时减：数量一致这件事必须在「改例外」之后仍然成立
      expect(after).toHaveLength(detected.length - inside.length);
      expect(warningAfter).toBe(misplacedPrecheckWarning(after));
      expect(after.map((m) => m.path), '例外目录下的页面两处都不该再出现').not.toContain(inside[0].path);
    } finally {
      // 例外清单是模块级可变数组：本用例必须还原，否则「唯一成员是 queries/media」那条守护会被带歪
      const i = NESTED_PAGE_DIRS.indexOf(tempNested);
      if (i >= 0) NESTED_PAGE_DIRS.splice(i, 1);
    }
    expect(NESTED_PAGE_DIRS).toEqual(['queries/media']);
    // 还原后两处结论也立刻回到原样（不是「改完就再也对不上」）
    const restored = await detectMisplacedPages(vault);
    expect(misplacedWarnings((await precheckVault(vault)).warnings)[0]).toBe(misplacedPrecheckWarning(restored));
  });
});

describe('D · 同屏文案同源', () => {
  it('预检警告的短语与前端错位块标题逐字相同', async () => {
    const presentation = await fs.readFile(
      path.join(repoRoot, 'frontend', 'src', 'utils', 'dataCleanPresentation.ts'),
      'utf8',
    );
    const phrase = presentation.match(/MISPLACED_ISSUE_TEXT\s*=\s*'([^']+)'/);
    expect(phrase, '前端错位块标题常量应可被读到').toBeTruthy();

    const detected = await detectMisplacedPages(vault);
    expect(misplacedPrecheckWarning(detected)).toBe(`${detected.length} 个${phrase![1]}`);
  });

  it('错位页归位后预检的这类警告随之消失（不是永远挂着的一条）', async () => {
    const stray = await writeStray('solutions/legacy/precheck-drop.md', '待归位取证页', 'solution');
    expect(misplacedWarnings((await precheckVault(vault)).warnings)).toHaveLength(1);
    const res = await detectMisplacedPages(vault);
    expect(res.map((m) => m.path)).toContain(stray);

    // 只验「数量跟着归位走」，用 dry_run 之外的真实归位会动其它页面目录，这里逐条搬本页
    const content = await vault.readFile(stray);
    await vault.writeFile('solutions/precheck-drop.md', content);
    await fs.rm(path.join(vaultDir, ...stray.split('/')));

    const after = await detectMisplacedPages(vault);
    expect(after.map((m) => m.path)).not.toContain(stray);
    expect(misplacedWarnings((await precheckVault(vault)).warnings)[0]).toBe(misplacedPrecheckWarning(after));
  });
});

// T02907：预检卡只显条数不显内容——界面读 warningCategories 聚合，不再数 warnings 逐条。
// 分类计数必须与 warnings 同一次扫描出数（同源），零类不上榜（否则空库也挂一排 0）。
describe('E · T02907 分类计数（warningCategories）', () => {
  it('misplaced 类计数与 detectMisplacedPages 同数，label 与前端块标题逐字同源', async () => {
    const result = await precheckVault(vault);
    const detected = await detectMisplacedPages(vault);
    const misplacedCat = result.warningCategories.find((c) => c.key === 'misplaced');
    expect(misplacedCat, '错位页存在时 misplaced 分类必须在场').toBeTruthy();
    expect(misplacedCat!.count).toBe(detected.length);
    // 与前端错位块标题逐字同源（D 组锁的是 warnings 字符串，这里锁的是界面实际读的分类 label）
    const presentation = await fs.readFile(
      path.join(repoRoot, 'frontend', 'src', 'utils', 'dataCleanPresentation.ts'),
      'utf8',
    );
    const phrase = presentation.match(/MISPLACED_ISSUE_TEXT\s*=\s*'([^']+)'/)![1];
    expect(misplacedCat!.label).toBe(MISPLACED_ISSUE_PHRASE);
    expect(misplacedCat!.label).toBe(phrase);
  });

  it('BOM 与未解析双链按扫描计数器出数，且与 warnings 逐条数一致', async () => {
    // 绕过口径限制：vault.writeFile 只收顶层页面目录内的 .md，BOM/断链页是合法顶层页面
    await vault.writeFile(
      'entities/bom-link-page.md',
      '\uFEFF---\ntitle: BOM与断链页\ntype: entity\n---\n\n正文 [[不存在甲]] 和 [[不存在乙]]\n',
    );
    try {
      const result = await precheckVault(vault);
      const bomCat = result.warningCategories.find((c) => c.key === 'bom');
      const linkCat = result.warningCategories.find((c) => c.key === 'unresolvedLink');
      expect(bomCat, '带 BOM 的页面存在时 bom 分类必须在场').toBeTruthy();
      expect(bomCat!.count, 'bom 计数').toBe(1);
      expect(bomCat!.label).toBe('页面带 UTF-8 BOM');
      expect(linkCat, '两条断链存在时 unresolvedLink 分类必须在场').toBeTruthy();
      expect(linkCat!.count, 'unresolvedLink 计数按链接条数（不按文件数）').toBe(2);
      // 计数不是凭空造的：与 warnings 逐条数同源
      expect(result.warnings.filter((w) => w.includes('UTF-8 BOM'))).toHaveLength(1);
      expect(result.warnings.filter((w) => w.includes('Unresolved link'))).toHaveLength(2);
    } finally {
      await fs.rm(path.join(vaultDir, 'entities', 'bom-link-page.md'), { force: true });
    }
  });

  it('计数为 0 的分类不上榜（空库不挂一排 0）', async () => {
    // 本库此时尚有错位页（A 组造的存量），misplaced 在场是对的；这里只锁「零计数不上榜」
    const result = await precheckVault(vault);
    const keys = result.warningCategories.map((c) => c.key);
    expect(keys).not.toContain('bom');
    expect(keys).not.toContain('unresolvedLink');
    expect(result.warningCategories.every((c) => c.count > 0), '全部计数非零').toBe(true);
  });
});

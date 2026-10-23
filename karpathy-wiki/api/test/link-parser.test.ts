// T02921：wikilink 解析与目标名解析「单一来源」守护。
// ------------------------------------------------------------------
// 背景：同一套 [[...]] 正则此前在库内至少六处各自重写（harness-adapter 断链扫描 / vault-service
// 边生成 / discover-workflow 抽取 / compile-workflow entities 校验 / podcast-workflow 脚本清洗 /
// query-workflow refs 提取），前四处均只取整串且大小写精确匹配——隔离副本实测 397 条断链里
// 83 条（20.9%）是假断链（69 条别名/锚点未拆 + 14 条大小写），孤立页 21 条假阳性。
// 本文件锁两件事：
//   A link-parser 纯函数口径（别名/锚点拆解、页内去重、精确优先 + 大小写回落稳定取首）
//   B 调用点同口径（harness-adapter 断链与 vault-service 边对同一批形状结论一致）——
//     固定用例取自 T02605 实测的两类假断链：[[目标|别名]] 与 [[Cpp014002]]→cpp014002.md
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLinkResolver, extractWikilinkTargets, parseWikilink } from '../src/vault/link-parser.js';
import { VaultService } from '../src/vault/vault-service.js';
import { HarnessAdapter } from '../src/engine/harness-adapter.js';

describe('A · parseWikilink / extractWikilinkTargets / createLinkResolver 纯函数口径', () => {
  it('parseWikilink 拆别名与锚点（Obsidian 三种合法语法）', () => {
    expect(parseWikilink('plain-page')).toEqual({ target: 'plain-page', alias: null, anchor: null });
    expect(parseWikilink('huipiao-chengdui|汇票承兑')).toEqual({
      target: 'huipiao-chengdui',
      alias: '汇票承兑',
      anchor: null,
    });
    expect(parseWikilink('some-page#章节锚点')).toEqual({
      target: 'some-page',
      alias: null,
      anchor: '章节锚点',
    });
    expect(parseWikilink('some-page#^块引用id')).toEqual({
      target: 'some-page',
      alias: null,
      anchor: '^块引用id',
    });
    expect(parseWikilink(' some-page | 别名 ')).toEqual({
      target: 'some-page',
      alias: '别名',
      anchor: null,
    });
  });

  it('extractWikilinkTargets 只留真实目标且页内去重（同一目标多个别名只计一条）', () => {
    const content = [
      '见 [[a-page|别名甲]] 与 [[a-page|别名乙]]，',
      '锚点 [[a-page#标题]]，',
      '另有 [[b-page]] 与 [[totally-missing]]。',
    ].join('\n');
    expect(extractWikilinkTargets(content)).toEqual(['a-page', 'b-page', 'totally-missing']);
  });

  it('createLinkResolver：精确命中优先；大小写不敏感回落；同名多候选稳定取首个', () => {
    const nameToPath = new Map<string, string>([
      ['cpp014002', 'entities/cpp014002.md'],
      ['AB', 'concepts/AB.md'],
      ['ab', 'entities/ab.md'],
    ]);
    const resolver = createLinkResolver(nameToPath);
    expect(resolver.resolve('cpp014002')).toBe('entities/cpp014002.md');
    expect(resolver.resolve('Cpp014002')).toBe('entities/cpp014002.md');
    expect(resolver.resolve('CPP014002')).toBe('entities/cpp014002.md');
    // 精确命中优先：'ab' 命中精确键，不被合并/覆盖
    expect(resolver.resolve('ab')).toBe('entities/ab.md');
    // 大小写回落：候选按路径稳定排序取首（concepts/AB.md < entities/ab.md）
    expect(resolver.resolve('Ab')).toBe('concepts/AB.md');
    expect(resolver.resolve('no-such-page')).toBeNull();
  });

  it('空索引解析任何目标都返回 null（不抛错）', () => {
    const resolver = createLinkResolver(new Map());
    expect(resolver.resolve('anything')).toBeNull();
  });
});

describe('B · 调用点同口径（真实 vault 集成：断链扫描与链接图结论一致）', () => {
  let vaultDir = '';
  let vault: VaultService;

  beforeAll(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 't02921-vault-'));
    vault = new VaultService(vaultDir);
    await vault.init();
    // T02605 实测的两类假断链形状：
    // 1) 修复工作流写入的合法别名语法 [[目标|别名]]
    await vault.writeFile(
      'entities/bill-system.md',
      '---\ntitle: 汇票系统\ntype: entity\n---\n\n见 [[huipiao-chengdui|汇票承兑]]。\n',
    );
    await vault.writeFile('entities/huipiao-chengdui.md', '---\ntitle: 汇票承兑\ntype: entity\n---\n\n内容。\n');
    // 2) 大小写不一致：链接写 Cpp014002，实际文件是 cpp014002.md
    await vault.writeFile(
      'entities/cpp001002.md',
      '---\ntitle: 编号页\ntype: entity\n---\n\n关联 [[Cpp014002]] 与 [[CPP014002]]，断链 [[totally-missing-page]]。\n',
    );
    await vault.writeFile('entities/cpp014002.md', '---\ntitle: 目标页\ntype: entity\n---\n\n内容。\n');
  });

  afterAll(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('体检断链：别名/大小写形状不再是断链，真断链仍报出且 to 为真实目标名', async () => {
    const adapter = new HarnessAdapter({} as never, vault);
    adapter.invalidateHealthCheckCache();
    const report = await adapter.healthCheck();
    const keys = report.brokenLinks.map((b) => `${b.from}->${b.to}`);
    expect(keys).toContain('entities/cpp001002.md->totally-missing-page');
    expect(keys, '别名语法不得判断链').not.toContain('entities/bill-system.md->huipiao-chengdui|汇票承兑');
    expect(keys, '大小写回落不得判断链').not.toContain('entities/cpp001002.md->Cpp014002');
    expect(keys, '大小写回落不得判断链').not.toContain('entities/cpp001002.md->CPP014002');
    // to 字段是拆掉别名/锚点后的真实目标名（healthList issueKey 依赖该口径）
    for (const b of report.brokenLinks) {
      expect(b.to).not.toMatch(/[|#]/);
    }
  });

  it('链接图：别名/大小写形状生成真实边，孤立页同步消解（体检两口径一致）', async () => {
    const graph = await vault.buildLinkGraph();
    const edgeKeys = graph.edges.map((e) => `${e.from}->${e.to}`);
    expect(edgeKeys).toContain('entities/bill-system.md->entities/huipiao-chengdui.md');
    expect(edgeKeys).toContain('entities/cpp001002.md->entities/cpp014002.md');

    const adapter = new HarnessAdapter({} as never, vault);
    adapter.invalidateHealthCheckCache();
    const report = await adapter.healthCheck();
    // 入链已真实生成：两个此前「孤立」的页面必须被消解（T02605 复验里 112 条孤立页一条消解不了的根因）
    expect(report.orphans).not.toContain('entities/huipiao-chengdui.md');
    expect(report.orphans).not.toContain('entities/cpp014002.md');
  });

  it('守护：全库只剩一处 [[...]] 正则定义（link-parser.ts），防止各处再写副本', async () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    // 单一来源里定义正则的写法形态，其他 src 文件出现即视为副本
    const WIKILINK_DEF = String.raw`/\[\[([^\]]+)\]\]/g`;
    async function collectFiles(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...(await collectFiles(p)));
        else if (ent.name.endsWith('.ts')) out.push(p);
      }
      return out;
    }
    const files = await collectFiles(srcRoot);
    const offenders: string[] = [];
    for (const f of files) {
      if (f.replace(/\\/g, '/').endsWith('vault/link-parser.ts')) continue;
      const text = (await fs.readFile(f, 'utf8')).replace(/\s+/g, '');
      if (text.includes(WIKILINK_DEF)) offenders.push(f);
    }
    expect(offenders, 'wikilink 正则只允许在 vault/link-parser.ts 定义').toEqual([]);
  });
});

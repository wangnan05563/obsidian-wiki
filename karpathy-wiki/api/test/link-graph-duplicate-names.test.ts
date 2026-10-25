// T02951：跨目录同名页（basename 冲突）不再丢边。
// 此前 nameToPath 用 Map<string, string>，后者覆盖前者：
// - 被覆盖页永远不进 nameToPath.values() → buildLinkGraph 不取其 rawLinks → 该页零出边；
// - 指向该名字的链接全部落到覆盖页路径 → 入边错页 + 体检孤立页失真。
// 本文件锁两件事：
//   A resolver 多候选口径（稳定排序取首、路径限定键精确命中、旧单值 Map 兼容）
//   B 隔离 vault 上链接图/体检/gaps 三处消费方对同名页的结论一致
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  addPageName,
  addPageToNameIndex,
  createLinkResolver,
  type PageNameIndex,
} from '../src/vault/link-parser.js';
import { VaultService } from '../src/vault/vault-service.js';
import { HarnessAdapter } from '../src/engine/harness-adapter.js';
import { computeGaps } from '../src/workflows/gaps-workflow.js';

describe('A · 同名页多候选解析口径', () => {
  it('同一名字保留全部候选，精确命中按路径稳定排序取首（不吞并）', () => {
    const index: PageNameIndex = new Map();
    addPageName(index, 'hundsun', 'entities/hundsun.md');
    addPageName(index, 'hundsun', 'concepts/hundsun.md');
    addPageName(index, 'hundsun', 'entities/hundsun.md'); // 重复登记去重

    const resolver = createLinkResolver(index);
    expect(index.get('hundsun')).toEqual(['entities/hundsun.md', 'concepts/hundsun.md']);
    // concepts < entities：短名链接稳定落到字典序首候选
    expect(resolver.resolve('hundsun')).toBe('concepts/hundsun.md');
    expect(resolver.resolve('Hundsun')).toBe('concepts/hundsun.md');
  });

  it('路径限定键可精确指向任一同名页（大小写不敏感回落）', () => {
    const index: PageNameIndex = new Map();
    addPageToNameIndex(index, 'entities/hundsun.md');
    addPageToNameIndex(index, 'concepts/hundsun.md');

    const resolver = createLinkResolver(index);
    expect(resolver.resolve('entities/hundsun')).toBe('entities/hundsun.md');
    expect(resolver.resolve('concepts/hundsun')).toBe('concepts/hundsun.md');
    expect(resolver.resolve('ENTITIES/Hundsun')).toBe('entities/hundsun.md');
  });

  it('旧单值 Map 调用口径保持不变', () => {
    const resolver = createLinkResolver(new Map([['page', 'concepts/page.md']]));
    expect(resolver.resolve('page')).toBe('concepts/page.md');
    expect(resolver.resolve('PAGE')).toBe('concepts/page.md');
    expect(resolver.resolve('nope')).toBeNull();
  });
});

describe('B · 隔离 vault 集成：链接图 / 体检 / gaps 对同名页结论一致', () => {
  let vaultDir = '';
  let vault: VaultService;

  beforeAll(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 't02951-vault-'));
    vault = new VaultService(vaultDir);
    await vault.init();
    // 同名页：entities/hundsun.md 与 concepts/hundsun.md
    await vault.writeFile(
      'entities/hundsun.md',
      '---\ntitle: 实体侧恒生\ntype: entity\n---\n\n关联 [[alpha-page]]。\n',
    );
    await vault.writeFile(
      'concepts/hundsun.md',
      '---\ntitle: 概念侧恒生\ntype: concept\n---\n\n关联 [[beta-page]]。\n',
    );
    await vault.writeFile('concepts/alpha-page.md', '---\ntitle: 甲页\ntype: concept\n---\n\n内容。\n');
    await vault.writeFile('concepts/beta-page.md', '---\ntitle: 乙页\ntype: concept\n---\n\n内容。\n');
    // 短名 + 路径限定：短名落稳定首候选（concepts），路径限定精确指向实体侧
    await vault.writeFile(
      'concepts/hub.md',
      '---\ntitle: 枢纽页\ntype: concept\n---\n\n短名 [[hundsun]]；精确 [[entities/hundsun]]。\n',
    );
  });

  afterAll(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('两个同名页各自保留出边，入边按短名/路径限定分别落位', async () => {
    const graph = await vault.buildLinkGraph();
    const edgeKeys = graph.edges.map((e) => `${e.from}->${e.to}`);

    expect(graph.nodes).toContain('entities/hundsun.md');
    expect(graph.nodes).toContain('concepts/hundsun.md');
    // 被覆盖页恢复出边（修复前 entities/hundsun.md 完全不在扫描范围）
    expect(edgeKeys).toContain('entities/hundsun.md->concepts/alpha-page.md');
    expect(edgeKeys).toContain('concepts/hundsun.md->concepts/beta-page.md');
    // 短名按稳定排序落到 concepts；路径限定精确落到 entities
    expect(edgeKeys).toContain('concepts/hub.md->concepts/hundsun.md');
    expect(edgeKeys).toContain('concepts/hub.md->entities/hundsun.md');
  });

  it('体检：同名页均有入链不判孤立，路径限定链接不判断链', async () => {
    const adapter = new HarnessAdapter({} as never, vault);
    adapter.invalidateHealthCheckCache();
    const report = await adapter.healthCheck();

    expect(report.orphans).not.toContain('entities/hundsun.md');
    expect(report.orphans).not.toContain('concepts/hundsun.md');
    const brokenKeys = report.brokenLinks.map((b) => `${b.from}->${b.to}`);
    expect(brokenKeys).not.toContain('concepts/hub.md->entities/hundsun');
  });

  it('gaps：路径限定链接指向同名页指定路径，该页不判孤立', () => {
    const pages = [
      { path: 'entities/hundsun.md', pageName: 'hundsun', tags: ['hs'], wikilinks: new Set<string>() },
      { path: 'concepts/hundsun.md', pageName: 'hundsun', tags: ['hs'], wikilinks: new Set<string>() },
      {
        path: 'concepts/hub.md',
        pageName: 'hub',
        tags: ['hs'],
        wikilinks: new Set(['entities/hundsun']),
      },
    ];
    const result = computeGaps(pages, 1);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.isolated).not.toContain('entities/hundsun.md');
  });
});

// T02964：编译写盘不得再生产「双 frontmatter 块 + 非法内联 YAML」页面。
// 固定样本取自真实故障形态：块 1 是 tag-suggest 写过的 type/ai_tags/updated，
// 块 2 才是完整元信息，且 entities 写成 `- name: "x", relation: "y"`（缺花括号 → js-yaml 非法）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

import { VaultService } from '../src/vault/vault-service.js';
import { createCompileTools } from '../src/workflows/compile-workflow.js';
import { confirmTagForPage } from '../src/workflows/tag-suggest-workflow.js';
import { HarnessAdapter } from '../src/engine/harness-adapter.js';
import { fixFrontmatter, scanVault } from '../src/data-clean/quality-scanner.js';

const DOUBLE_BLOCK = [
  '---',
  'type: concept',
  'ai_tags:',
  '  - 票据',
  "updated: '2026-10-24'",
  '---',
  '---',
  'title: 电子商业汇票',
  "created: '2026-01-01'",
  'source: raw/demo.md',
  'tags:',
  '  - 票据',
  'knowledge_class: timeless',
  'entities:',
  '  - name: "上海票据交易所", relation: "created_by"',
  '---',
  '',
  '正文见 [[上海票据交易所]]。',
].join('\n');

describe('T02964 写侧单块 frontmatter 兜底', () => {
  let vaultDir = '';
  let vault: VaultService;

  beforeAll(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 't02964-vault-'));
    vault = new VaultService(vaultDir);
    await vault.init();
  });

  afterAll(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it('write_file：双块合并为单块，块 2 元信息与 entities 保留且可解析', async () => {
    const tools = createCompileTools(vault);
    const writeFile = tools.find((t) => t.name === 'write_file');
    expect(writeFile).toBeTruthy();

    const result = (await writeFile!.handler({
      path: 'concepts/e-bill.md',
      content: DOUBLE_BLOCK,
    }, {} as never)) as { ok: boolean; path: string };
    expect(result.ok).toBe(true);

    const raw = await vault.readFile('concepts/e-bill.md');
    // 单块：只有一对 --- 分隔符
    expect(raw.match(/^---$/gm)?.length).toBe(2);

    const parsed = matter(raw); // js-yaml 解析成功（非法内联写法已被合并与规整）
    expect(parsed.data.title).toBe('电子商业汇票');
    expect(parsed.data.type).toBe('concept');
    expect(parsed.data.knowledge_class).toBe('timeless');
    expect(parsed.data.ai_tags).toEqual(['票据']);
    expect(parsed.data.entities).toEqual([{ name: '上海票据交易所', relation: 'created_by' }]);
    expect(parsed.content).toContain('正文见 [[上海票据交易所]]。');
    expect(parsed.content).not.toContain('title: 电子商业汇票');

    // 体检口径：页面有可用 frontmatter
    const scanned = await scanVault(vault);
    expect(scanned.find((p) => p.path === 'concepts/e-bill.md')?.metadata.hasFrontmatter).toBe(true);

    // 「批量补元信息」对刚写入的页面应为 0 条待修
    const repair = await fixFrontmatter(vault, ['concepts/e-bill.md'], true);
    expect(repair.errors).toEqual([]);
    expect(repair.fixed).toEqual([]);
  });

  it('write_file：正文以 --- 开头的普通分隔线不被误判为第二块', async () => {
    const single = [
      '---',
      'title: 普通页',
      'type: concept',
      '---',
      '---',
      '这不是 YAML 映射',
      '---',
      '',
      '正文。',
    ].join('\n');
    const tools = createCompileTools(vault);
    const writeFile = tools.find((t) => t.name === 'write_file')!;
    await writeFile.handler({ path: 'concepts/plain.md', content: single }, {} as never);

    expect(await vault.readFile('concepts/plain.md')).toBe(single);
  });

  it('confirmTagForPage：历史脏正文不再因重解析正文抛 YAMLException', async () => {
    await vault.writeFile(
      'concepts/legacy.md',
      [
        '---',
        'title: 历史页',
        'type: concept',
        'ai_tags:',
        '  - 候选',
        '---',
        '---',
        'broken: [unclosed',
        '---',
        '正文。',
      ].join('\n'),
    );

    const result = await confirmTagForPage(vault, 'concepts/legacy.md', '票据');
    expect(result.tags).toContain('票据');

    const raw = await vault.readFile('concepts/legacy.md');
    const parsed = matter(raw);
    expect(parsed.data.tags).toContain('票据');
    // 脏正文原样保留（未被二次解析吞掉），只是本条写路径不再炸
    expect(raw).toContain('broken: [unclosed');
  });

  it('markKnowledgeReviewed：dated 页面脏正文下仍能追加 reviewed_at', async () => {
    await vault.writeFile(
      'concepts/dated-legacy.md',
      [
        '---',
        'title: 时效页',
        'type: concept',
        'knowledge_class: dated',
        '---',
        '---',
        'broken: [unclosed',
        '---',
        '正文。',
      ].join('\n'),
    );
    const adapter = new HarnessAdapter({} as never, vault);
    const result = await adapter.markKnowledgeReviewed(['concepts/dated-legacy.md']);
    expect(result.ok).toBe(true);

    const parsed = matter(await vault.readFile('concepts/dated-legacy.md'));
    expect(typeof parsed.data.reviewed_at).toBe('string');
  });
});

describe('T02964 守护：列出的写盘点不得再传字符串正文', () => {
  it('matter.stringify 的首参必须是对象形式 { content }', async () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const targets = [
      'workflows/compile-workflow.ts',
      'workflows/tag-suggest-workflow.ts',
      'workflows/discover-workflow.ts',
      'engine/harness-adapter.ts',
      'data-clean/quality-scanner.ts',
    ];
    const offenders: string[] = [];
    // 只匹配「变量/成员表达式作首参」的形态，注释里的示意写法不计
    const STRINGY = /matter\.stringify\(\s*[A-Za-z_$][\w$.]*\s*,/;
    for (const rel of targets) {
      const text = await fs.readFile(path.join(srcRoot, rel), 'utf8');
      if (STRINGY.test(text)) offenders.push(rel);
    }
    expect(offenders, '写盘点应使用 matter.stringify({ content }, data)').toEqual([]);
  });
});

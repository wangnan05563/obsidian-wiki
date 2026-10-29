// T03647（由 T03610 补测过程派生）：gray-matter 内容缓存被就地改写导致的跨页串字段。
//
// 成因（node_modules/gray-matter/index.js:35-47）：解析结果以「整段内容字符串」为键缓存在
// matter.cache，命中时只做 Object.assign({}, cached) 浅拷贝——data 以及 data 内部的数组仍是
// 缓存对象本体。于是「改 parsed.data 再写回」会把字段写进缓存，任何字节完全相同的第二次读取
// 都会凭空带上第一次写入的值，随后被 matter.stringify 落进自己的 frontmatter。
//
// 本文件两层：
//   1) 行为层——parsePage 拿到的是脱钩副本，同字节的第二次读取看不到第一次的写入；真实写入口
//      （tag 建议 / tag 确认）在两个字节完全相同的页面上互不污染。
//   2) 守护层——src 里不允许再出现就地改写 `X.data.<字段>` 的写法，防止复发。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

import { VaultService } from '../src/vault/vault-service.js';
import { parsePage, stringifyPage } from '../src/utils/frontmatter.js';
import { confirmTagForPage, suggestTagsForPage } from '../src/workflows/tag-suggest-workflow.js';
import type { AppConfig } from '../src/types.js';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// 两个页面字节完全相同才会命中同一条缓存 —— 这正是现场「重复投递/模板页」会造出来的形状
function sameBytesPage(): string {
  return ['---', 'title: 同字节课', 'type: concept', '---', '', '正文：[[同字节课]]'].join('\n');
}

describe('parsePage 与 gray-matter 内容缓存脱钩', () => {
  it('改副本后，同字节的第二次解析看不到写入', () => {
    const raw = sameBytesPage();
    const first = parsePage(raw);
    first.data.ai_tags = ['来自第一次写入'];
    first.data.draft = true;

    const second = parsePage(raw);
    expect(second.data.ai_tags).toBeUndefined();
    expect(second.data.draft).toBeUndefined();
    expect(second.data.title).toBe('同字节课');
  });

  it('嵌套数组同样脱钩：改 entities 不会渗进缓存', () => {
    const raw = ['---', 'title: 实体页', 'entities:', '  - name: 甲', '---', '', '正文'].join('\n');
    const first = parsePage(raw);
    (first.data.entities as { name: string }[]).push({ name: '乙' });

    const second = parsePage(raw);
    expect(second.data.entities).toEqual([{ name: '甲' }]);
  });

  it('写回的副本不回灌缓存：stringifyPage 之后再解析仍是原样', () => {
    const raw = sameBytesPage();
    const doc = parsePage(raw);
    doc.data.updated = '2026-10-29';
    const out = stringifyPage(doc.content, doc.data);
    expect(out).not.toBe(raw);
    expect(parsePage(raw).data.updated).toBeUndefined();
    // 落盘结果本身带上字段
    expect(matter(out).data.updated).toBe('2026-10-29');
  });

  it('无引号 YAML 日期保持 Date：structuredClone 不会把它压成字符串', () => {
    const raw = ['---', 'title: 日期页', 'updated: 2026-08-01', '---', '', '正文'].join('\n');
    const doc = parsePage(raw);
    expect(doc.data.updated).toBeInstanceOf(Date);
    // 缓存本身的行为不变（同一份 Date 引用被浅拷贝透传，正是就地改写会串的原因）
    const viaMatter = matter(raw);
    expect(viaMatter.data.updated).toBeInstanceOf(Date);
  });

  it('对照实验：直接改 matter(raw).data 会串到同字节的第二次读取（缺陷成因）', () => {
    // 用本用例独有的字节，避免把污染条目留给同文件其它用例
    const raw = ['---', 'title: 泄漏演示串', 'type: concept', '---', '', '正文'].join('\n');
    const leaky = matter(raw);
    leaky.data.ai_tags = ['leaked'];
    const again = matter(raw);
    expect(again.data).toBe(leaky.data);
    expect(again.data.ai_tags).toEqual(['leaked']);
    // 内容差一个字节即另起缓存项 —— 说明这是「同字节才串」的隐蔽缺陷
    expect(matter(raw + ' ').data.ai_tags).toBeUndefined();
  });
});

describe('真实写入口：两个字节完全相同的页面互不污染', () => {
  let tmpDir = '';
  let vault: VaultService;
  let appConfig: AppConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 't03647-'));
    vault = new VaultService(path.join(tmpDir, 'vault'));
    await vault.init();
    appConfig = {
      llm: { provider: 'glm', baseUrl: 'http://localhost:9/v1', apiKey: 'test-key', model: 'test-model' },
    } as unknown as AppConfig;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function stubTagResponse(tags: string[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ai_tags: tags }) } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      ),
    );
  }

  it('给 A 写 ai_tags 后，字节相同的 B 不带上 A 的建议', async () => {
    const raw = sameBytesPage();
    await vault.writeFile('concepts/A.md', raw);
    await vault.writeFile('concepts/B.md', raw);

    stubTagResponse(['票据']);
    await suggestTagsForPage(vault, 'concepts/A.md', appConfig);

    const bData = matter(await vault.readFile('concepts/B.md')).data as Record<string, unknown>;
    expect(bData.ai_tags).toBeUndefined();
    expect(bData.updated).toBeUndefined();
    // A 自己确实写上了
    const aData = matter(await vault.readFile('concepts/A.md')).data as { ai_tags?: string[] };
    expect(aData.ai_tags).toEqual(['票据']);
  });

  it('对 B 跑 tag 建议不会把 A 的历史建议合并进来，也不覆盖 A', async () => {
    const raw = sameBytesPage();
    await vault.writeFile('concepts/A2.md', raw);
    await vault.writeFile('concepts/B2.md', raw);

    stubTagResponse(['清算']);
    await suggestTagsForPage(vault, 'concepts/A2.md', appConfig);
    stubTagResponse(['票据']);
    const bTags = await suggestTagsForPage(vault, 'concepts/B2.md', appConfig);
    // B 只拿到本轮建议：A 的「清算」没有串过来
    expect(bTags).toEqual(['票据']);

    const aData = matter(await vault.readFile('concepts/A2.md')).data as { ai_tags?: string[] };
    const bData = matter(await vault.readFile('concepts/B2.md')).data as { ai_tags?: string[] };
    expect(aData.ai_tags).toEqual(['清算']);
    expect(bData.ai_tags).toEqual(['票据']);
  });

  it('tag 确认只动目标页：同字节页的 tags/ai_tags 不被牵连', async () => {
    const raw = ['---', 'title: 待确认', 'type: concept', 'ai_tags:', '  - 票据', '  - 清算', '---', '', '正文'].join('\n');
    await vault.writeFile('concepts/C.md', raw);
    await vault.writeFile('concepts/D.md', raw);

    const result = await confirmTagForPage(vault, 'concepts/C.md', '票据');
    expect(result.tags).toEqual(['票据']);
    expect(result.aiTags).toEqual(['清算']);

    const dData = matter(await vault.readFile('concepts/D.md')).data as Record<string, unknown>;
    expect(dData.tags).toBeUndefined();
    expect(dData.ai_tags).toEqual(['票据', '清算']);
  });

  it('双链回写各写各的 related：同字节的两个页面不会共用同一个数组', async () => {
    const { createBidirectionalLink } = await import('../src/workflows/discover-workflow.js');
    const page = (title: string) =>
      ['---', `title: ${title}`, 'type: concept', '---', '', `正文 [[${title}]]`].join('\n');
    // 两页 frontmatter 字节完全相同 → 命中同一条 gray-matter 缓存。
    // 修复前：source/target 的 related 是同一个缓存数组，双向各 push 一次后两页都会带上
    // [[M]] 与 [[L]] 两条；修复后各页只写自己那一条出链。
    await vault.writeFile('concepts/L.md', page('甲'));
    await vault.writeFile('concepts/M.md', page('甲'));

    const { sourceRelated, targetRelated } = await createBidirectionalLink(
      vault,
      'concepts/L.md',
      'concepts/M.md',
    );

    expect(sourceRelated).not.toBe(targetRelated);
    const lData = matter(await vault.readFile('concepts/L.md')).data as { related?: string[] };
    const mData = matter(await vault.readFile('concepts/M.md')).data as { related?: string[] };
    expect(lData.related).toEqual(['[[M]]']);
    expect(mData.related).toEqual(['[[L]]']);
  });
});

describe('源码守护：不允许再就地改写 gray-matter 解析结果', () => {
  const banned = [
    // 覆盖裸赋值与复合赋值；(?!=) 排除 === / !== 比较，>= <= 天然不匹配
    { name: '就地赋值 X.data.<字段> =', re: /\.data\.[\w$]+\s*(?:[-+*/%]|\|\||\?\?)?=(?!=)/ },
    { name: '就地删除 delete X.data.<字段>', re: /\bdelete\s+[A-Za-z_$][\w$]*\.data\./ },
    { name: '就地改 X.data.<数组>.push/splice/sort', re: /\.data\.[\w$]+\.(push|splice|unshift|sort|reverse)\s*\(/ },
  ];

  it('守护规则本身不是空转：能识别赋值、不误识别比较', () => {
    const assign = banned[0].re;
    expect(assign.test('  parsed.data.ai_tags = merged;')).toBe(true);
    expect(assign.test('  parsed.data.count += 1;')).toBe(true);
    expect(assign.test("  parsed.data.updated = '2026-01-01';")).toBe(true);
    expect(assign.test("  const t = typeof parsed.data.title === 'string';")).toBe(false);
    expect(assign.test('  if (parsed.data.ai_tags !== undefined) {')).toBe(false);
    expect(assign.test('  if (parsed.data.count >= 2) {')).toBe(false);
    expect(banned[1].re.test('  delete parsed.data.ai_tags;')).toBe(true);
    expect(banned[2].re.test('  parsed.data.entities.push(item);')).toBe(true);
  });

  it('src 下无就地改写 .data. 的写法', async () => {
    const entries = await fs.readdir(srcDir, { recursive: true, encoding: 'utf-8' });
    const tsFiles = (entries as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => path.join(srcDir, f))
      // 唯一的例外：本模块自己就是「脱钩」实现处
      .filter((f) => path.basename(f) !== 'frontmatter.ts');

    const offenders: string[] = [];
    for (const file of tsFiles) {
      const text = await fs.readFile(file, 'utf-8');
      for (const rule of banned) {
        text.split(/\r?\n/).forEach((line, idx) => {
          if (line.includes('// c03647-allow')) return;
          if (rule.re.test(line)) {
            offenders.push(`${path.relative(srcDir, file)}:${idx + 1} ${rule.name} → ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('四个 frontmatter 写入口都走 utils/frontmatter 的脱钩解析', async () => {
    const writers = [
      'workflows/tag-suggest-workflow.ts',
      'workflows/compile-workflow.ts',
      'workflows/discover-workflow.ts',
      'engine/harness-adapter.ts',
    ];
    for (const rel of writers) {
      const text = await fs.readFile(path.join(srcDir, rel), 'utf-8');
      expect(text, rel).toContain('../utils/frontmatter.js');
    }
  });
});

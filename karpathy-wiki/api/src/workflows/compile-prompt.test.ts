import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';

// T6-4 prompt 回归：compile.md 声明了页面编译必须携带的核心 frontmatter 字段。
// 为什么测 prompt 文本而非清洗函数：核心回归风险在于——改 compile.md 时把字段要求改丢，
// LLM 就会少写字段，自动清洗（ensurePageTypeField 等）只能修复 type/knowledge_class，
// 无法凭空补足 title/created/updated/source/tags。锁定声明行为回归即可早期拦截。
const COMPILE_MD_URL = new URL('../prompts/compile.md', import.meta.url);

// V3.x 既有核心字段：改 compile.md 时必须保留，作为回归基准。
// knowledge_class 是 V4.0 新增字段，一并纳入锁定。
const REQUIRED_FIELDS = [
  'title',
  'type',
  'created',
  'updated',
  'source',
  'tags',
  'knowledge_class',
] as const;

describe('compile prompt frontmatter 字段回归（T6-4）', () => {
  it('compile.md 可正常读取', async () => {
    const text = await fs.readFile(COMPILE_MD_URL, 'utf8');
    expect(text.length).toBeGreaterThan(0);
  });

  it('frontmatter 声明行存在且包含全部核心字段', async () => {
    const text = await fs.readFile(COMPILE_MD_URL, 'utf8');
    // 声明行：'frontmatter（title, type, created, updated, source, tags, knowledge_class）'
    const declLine = text
      .split('\n')
      .find((l) => l.includes('frontmatter') && l.includes('title'));
    expect(declLine, '应存在包含 frontmatter 与 title 的行').toBeDefined();
    for (const field of REQUIRED_FIELDS) {
      expect(
        declLine!.includes(field),
        `frontmatter 声明行应包含核心字段 "${field}"`,
      ).toBe(true);
    }
  });

  it('页面必须包含 frontmatter 的硬约束仍保留', async () => {
    const text = await fs.readFile(COMPILE_MD_URL, 'utf8');
    // 约束章节必须保留"必须包含 frontmatter"的强约束，否则 LLM 可能整页省略 frontmatter
    expect(text).toContain('必须包含 frontmatter');
  });

  it('type 字段与合法枚举文档对齐（entity/concept/comparison/query/qa/solution）', async () => {
    const text = await fs.readFile(COMPILE_MD_URL, 'utf8');
    for (const t of ['entity', 'concept', 'comparison', 'query', 'qa', 'solution']) {
      expect(text, `compile.md 应声明页面类型 "${t}"`).toContain(t);
    }
  });
});
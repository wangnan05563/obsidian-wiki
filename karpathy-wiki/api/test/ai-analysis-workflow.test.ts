// AI 智能清洗分析工作流单元测试
// 覆盖：
//   ① 纯函数：isRedundantCandidate / needsRename / toKebabName / parseAiAnalysisOutput
//   ② analyzeVaultForCleanup：确定性候选 + LLM 合并（注入 llmCall，隔离真实 fetch）
//   ③ LLM 失败优雅降级（回退确定性候选）
//   ④ 畸形 JSON 容错解析
//   ⑤ quality-scanner 新增：renameFile / batchRename（同目录、目标存在保护、跨目录拒绝）/ batchDedupPages
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { VaultService } from '../src/vault/vault-service.js';
import type { AppConfig } from '../src/types.js';
import {
  analyzeVaultForCleanup,
  callLlmForAnalysis,
  isRedundantCandidate,
  needsRename,
  toKebabName,
  normalizeSuggestedName,
  parseAiAnalysisOutput,
} from '../src/data-clean/ai-analysis-workflow.js';
import {
  renameFile,
  batchRename,
  batchDedupPages,
} from '../src/data-clean/quality-scanner.js';

let vaultDir: string;
// 文件系统支撑的轻量 VaultService fake：提供 mergeDuplicatePages 需要的 readFile / writeFile，
// 其余方法（rename/archive/delete）走 quality-scanner 内部的 resolveVaultPath + fs，只需 getVaultPath。
function makeVault(): VaultService {
  return {
    getVaultPath: () => vaultDir,
    readFile: (rel: string) => fs.readFile(path.join(vaultDir, rel), 'utf-8'),
    writeFile: (rel: string, content: string) => fs.writeFile(path.join(vaultDir, rel), content, 'utf-8'),
  } as unknown as VaultService;
}
const config = {
  llm: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKeyRef: '', apiKey: 'sk-test' },
  vaultPath: '',
} as unknown as AppConfig;

const CANNED_LLM = JSON.stringify({
  redundant: [{ path: 'concepts/empty.md', reason: '空文件，可安全删除' }],
  duplicates: [{ representativePath: 'entities/bar.md', paths: ['entities/bar.md', 'entities/bar-copy.md'], reason: '两文件内容完全相同' }],
  renames: [{ path: 'concepts/Transformer Model.md', suggestedName: 'transformer-model.md', reason: '空格转连字符' }],
});

beforeAll(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-analysis-'));
  for (const d of ['entities', 'concepts', 'comparisons']) {
    await fs.mkdir(path.join(vaultDir, d), { recursive: true });
  }
  // 正常文件（含 frontmatter，质量分 > 0）
  await fs.writeFile(
    path.join(vaultDir, 'concepts', 'foo.md'),
    '---\ntype: concept\ntitle: Foo\n---\n# Foo\n这是一段正常的内容，用于质量评估与去重基线。\n',
    'utf-8',
  );
  // 空/占位文件 → 冗余候选
  await fs.writeFile(path.join(vaultDir, 'concepts', 'empty.md'), '---\ntitle: Empty\n---\n', 'utf-8');
  // 重复对（内容完全相同）
  const dup = '# Bar\nhello world test content here for deduplication check.\n';
  await fs.writeFile(path.join(vaultDir, 'entities', 'bar.md'), dup, 'utf-8');
  await fs.writeFile(path.join(vaultDir, 'entities', 'bar-copy.md'), dup, 'utf-8');
  // 文件名含空格+大写 → 重命名候选
  await fs.writeFile(path.join(vaultDir, 'concepts', 'Transformer Model.md'), '# Transformer Model\n内容\n', 'utf-8');
});

afterAll(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('纯函数：候选判定与命名规范化', () => {
  it('isRedundantCandidate 识别空文件/草稿', () => {
    expect(isRedundantCandidate({ metadata: { wordCount: 0, fileSizeBytes: 10 } } as any)).toMatch(/空/);
    expect(isRedundantCandidate({ path: 'concepts/draft-tmp.md', qualityScore: 80, metadata: { wordCount: 300, fileSizeBytes: 2000 } } as any)).toMatch(/冗余/);
    expect(isRedundantCandidate({ path: 'concepts/foo.md', qualityScore: 80, metadata: { wordCount: 300, fileSizeBytes: 2000 } } as any)).toBeNull();
  });

  it('needsRename 识别空格/大写/下划线/连续连字符', () => {
    expect(needsRename('Transformer Model.md')).toBe(true);
    expect(needsRename('my_file.md')).toBe(true);
    expect(needsRename('foo--bar.md')).toBe(true);
    expect(needsRename('-leading.md')).toBe(true);
    expect(needsRename('good-name.md')).toBe(false);
    expect(needsRename('中文标题.md')).toBe(false);
  });

  it('toKebabName 规范化（小写/去空格/去冗余词）', () => {
    expect(toKebabName('Transformer Model.md')).toBe('transformer-model.md');
    expect(toKebabName('Copy of note.md')).toBe('note.md');
    expect(toKebabName('My_File Name.md')).toBe('my-file-name.md');
    expect(toKebabName('  spaced  .md')).toBe('spaced.md');
  });

  it('normalizeSuggestedName 取 basename 并强制 kebab .md', () => {
    expect(normalizeSuggestedName('concepts/My Name.md')).toBe('my-name.md');
    expect(normalizeSuggestedName('Already-Good.md')).toBe('already-good.md');
  });
});

describe('parseAiAnalysisOutput 容错', () => {
  it('解析标准 JSON', () => {
    const r = parseAiAnalysisOutput('{"redundant":[{"path":"a.md","reason":"x"}]}');
    expect(r.redundant).toHaveLength(1);
    expect(r.redundant[0].path).toBe('a.md');
  });
  it('剥离 ```json 围栏与前后多余文本', () => {
    const r = parseAiAnalysisOutput('好的：\n```json\n{"renames":[{"path":"a.md","suggestedName":"a.md","reason":"r"}]}\n```\n完成');
    expect(r.renames).toHaveLength(1);
    expect(r.renames[0].suggestedName).toBe('a.md');
  });
  it('畸形 JSON 不抛错，返回空数组', () => {
    const r = parseAiAnalysisOutput('这不是 json {{');
    expect(r.redundant).toEqual([]);
    expect(r.duplicates).toEqual([]);
    expect(r.renames).toEqual([]);
  });
});

describe('analyzeVaultForCleanup', () => {
  it('LLM 成功：合并确定性候选与 LLM 结论', async () => {
    const result = await analyzeVaultForCleanup(makeVault(), config, {
      llmCall: async () => CANNED_LLM,
    });
    expect(result.summary.totalPages).toBe(5);
    // 冗余：empty.md
    expect(result.redundant.map((r) => r.path)).toContain('concepts/empty.md');
    // 重复：bar 组
    const grp = result.duplicates.find((g) => g.representativePath === 'entities/bar.md');
    expect(grp).toBeTruthy();
    expect(grp!.paths.sort()).toEqual(['entities/bar-copy.md', 'entities/bar.md'].sort());
    // 重命名：Transformer Model → transformer-model.md，同目录
    const rn = result.renames.find((r) => r.path === 'concepts/Transformer Model.md');
    expect(rn).toBeTruthy();
    expect(rn!.suggestedName).toBe('transformer-model.md');
    expect(rn!.suggestedPath).toBe('concepts/transformer-model.md');
    expect(result.rawLlm).toBeTruthy();
  });

  it('LLM 失败：优雅降级到确定性候选，仍产出结论', async () => {
    const result = await analyzeVaultForCleanup(makeVault(), config, {
      llmCall: async () => {
        throw new Error('network down');
      },
    });
    // 确定性冗余候选仍存在
    expect(result.redundant.map((r) => r.path)).toContain('concepts/empty.md');
    // 确定性重命名候选仍存在（kebab 兜底）
    const rn = result.renames.find((r) => r.path === 'concepts/Transformer Model.md');
    expect(rn?.suggestedName).toBe('transformer-model.md');
    // dedup 组由确定性 deduplicatePages 提供（LLM 未返回时回退）
    expect(result.duplicates.length).toBeGreaterThanOrEqual(1);
    expect(result.rawLlm).toBeUndefined();
  });

  it('缺少 apiKey 时 callLlmForAnalysis 抛错（驱动端点 400）', async () => {
    const noKey = { llm: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKeyRef: '', apiKey: '' }, vaultPath: '' } as unknown as AppConfig;
    await expect(callLlmForAnalysis('sys', 'payload', noKey)).rejects.toThrow(/API Key/);
  });
});

describe('quality-scanner 重命名/去重能力', () => {
  it('renameFile 同目录重命名（dry_run=false 真实移动）', async () => {
    await fs.writeFile(path.join(vaultDir, 'concepts', 'old Name.md'), '# old', 'utf-8');
    const res = await renameFile(makeVault(), 'concepts/old Name.md', 'concepts/old-name.md', false);
    expect(res.errors).toHaveLength(0);
    expect(res.renamed).toContain('concepts/old-name.md');
    await expect(fs.access(path.join(vaultDir, 'concepts', 'old-name.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(vaultDir, 'concepts', 'old Name.md'))).rejects.toBeDefined();
  });

  it('renameFile 拒绝跨目录与目标已存在', async () => {
    await fs.writeFile(path.join(vaultDir, 'concepts', 'a.md'), '# a', 'utf-8');
    await fs.writeFile(path.join(vaultDir, 'concepts', 'a-target.md'), '# a target', 'utf-8');
    const crossDir = await renameFile(makeVault(), 'concepts/a.md', 'entities/a-renamed.md', false);
    expect(crossDir.errors[0]).toMatch(/跨目录/);
    const exists = await renameFile(makeVault(), 'concepts/a.md', 'concepts/a-target.md', false);
    expect(exists.errors[0]).toMatch(/已存在/);
  });

  it('batchRename 逐条执行，单条失败不影响其余', async () => {
    await fs.writeFile(path.join(vaultDir, 'concepts', 'b one.md'), '# b', 'utf-8');
    await fs.writeFile(path.join(vaultDir, 'concepts', 'b two.md'), '# b', 'utf-8');
    const res = await batchRename(
      makeVault(),
      [
        { from: 'concepts/b one.md', to: 'concepts/b-one.md' },
        { from: 'concepts/b two.md', to: 'entities/b-two.md' }, // 跨目录 → 失败
      ],
      false,
    );
    expect(res.renamed).toContain('concepts/b-one.md');
    expect(res.errors.length).toBe(1);
  });

  it('batchDedupPages 合并非代表文档（dry_run=true 不落盘）', async () => {
    const dup = { pageA: { path: 'entities/x.md', title: 'x', qualityScore: 0, category: { length: 0, links: 0, frontmatter: 0, citations: 0, duplicate: 0, freshness: 0 }, metadata: { wordCount: 0, lineCount: 0, internalLinks: 0, inboundLinks: 0, lastModified: '', hasFrontmatter: false, isDraft: false, fileSizeBytes: 0, hasBom: false, encoding: 'utf-8', directory: 'entities' }, issues: [], suggestions: [] } as any, pageB: { path: 'entities/y.md', title: 'y', qualityScore: 0, category: { length: 0, links: 0, frontmatter: 0, citations: 0, duplicate: 0, freshness: 0 }, metadata: { wordCount: 0, lineCount: 0, internalLinks: 0, inboundLinks: 0, lastModified: '', hasFrontmatter: false, isDraft: false, fileSizeBytes: 0, hasBom: false, encoding: 'utf-8', directory: 'entities' }, issues: [], suggestions: [] } as any, similarity: 1, matchType: 'exact', reason: 't' };
    // 准备两个文件
    await fs.writeFile(path.join(vaultDir, 'entities', 'x.md'), '# X\n内容\n', 'utf-8');
    await fs.writeFile(path.join(vaultDir, 'entities', 'y.md'), '# Y\n内容\n', 'utf-8');
    const res = await batchDedupPages(makeVault(), [{ keep: 'entities/x.md', merge: ['entities/y.md'] }], true);
    expect(res.merged).toBe(1);
    expect(res.errors).toHaveLength(0);
    // dry_run 不删除 y.md
    await expect(fs.access(path.join(vaultDir, 'entities', 'y.md'))).resolves.toBeUndefined();
  });

  it('mergeDuplicatePages 经 batchDedupPages 复用（archiveKept=true）', async () => {
    await fs.writeFile(path.join(vaultDir, 'entities', 'keep.md'), '# Keep\n原始内容\n', 'utf-8');
    await fs.writeFile(path.join(vaultDir, 'entities', 'drop.md'), '# Drop\n重复内容\n', 'utf-8');
    const res = await batchDedupPages(makeVault(), [{ keep: 'entities/keep.md', merge: ['entities/drop.md'] }], false);
    expect(res.merged).toBe(1);
    // drop.md 被归档（archiveKept=true → 移出 vault）
    await expect(fs.access(path.join(vaultDir, 'entities', 'drop.md'))).rejects.toBeDefined();
  });
});

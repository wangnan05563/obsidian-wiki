// FR-20 语义搜索核心单测（T01751 测试计划第 2 项：索引写入-重建-查询闭环）
// 隔离纪律（NFR-3 / CODING-TEST-ISOLATION）：SQLite 库落在 os.tmpdir() 随机目录，
// 用后即焚，不触碰真实 data/。embedding 为外置 BYOK，单测只验证本地存储/切分/融合逻辑。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getIndexDb,
  replacePageChunks,
  savePageVectors,
  markIndexFailed,
  keywordRecall,
  vectorRecall,
  getIndexStatus,
  removePageIndex,
  closeIndexDb,
} from '../src/search/sqlite-index.js';
import { chunkPage } from '../src/search/hybrid-search.js';

let dataDir: string;
const createdDirs: string[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'wiki-index-test-'));
  createdDirs.push(dataDir);
});

// 每个测试后关闭并重置单例：索引层 db 是模块级单例，须与 tmpdir 生命周期严格同步，
// 否则下一个测试的 mkdtemp 新目录会被旧句柄污染（计数叠加、数据泄漏）
afterEach(() => {
  closeIndexDb();
});

afterAll(() => {
  // 只删除本测试创建的目录，绝不波及系统临时目录的其他内容
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
});

describe('sqlite-index（FR-20 索引层）', () => {
  it('chunk 写入 → FTS5 关键词召回（BM25 排序）', () => {
    replacePageChunks(dataDir, 'concepts/rag.md', [
      { content: 'RAG 是检索增强生成的缩写，先检索后生成。', heading: null },
      { content: '向量检索依赖 embedding 模型将文本编码为向量。', heading: null },
    ]);
    replacePageChunks(dataDir, 'concepts/vault.md', [
      { content: 'vault 是知识库的文件根目录，存放全部页面。', heading: null },
    ]);
    const hits = keywordRecall(dataDir, '检索', 5);
    // 两个 chunk 都含「检索」，rag 页的两个 chunk 应命中
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every((h) => h.content.includes('检索'))).toBe(true);
    // 无关词零召回
    expect(keywordRecall(dataDir, '量子力学', 5)).toEqual([]);
  });

  it('向量写入 → 余弦召回，同向优先', () => {
    replacePageChunks(dataDir, 'concepts/a.md', [{ content: '向量甲', heading: null }]);
    replacePageChunks(dataDir, 'concepts/b.md', [{ content: '向量乙', heading: null }]);
    const dim = 4;
    // 查询向量 (1,0,0,0)：甲完全同向（相似度 1），乙正交（相似度 0）
    const qv = new Float32Array([1, 0, 0, 0]);
    savePageVectors(dataDir, 'concepts/a.md', [new Float32Array([2, 0, 0, 0])], 'test-model');
    savePageVectors(dataDir, 'concepts/b.md', [new Float32Array([0, 1, 0, 0])], 'test-model');
    const hits = vectorRecall(dataDir, qv, 5);
    expect(hits.length).toBe(2);
    expect(hits[0].pagePath).toBe('concepts/a.md');
    expect(hits[0].similarity).toBeCloseTo(1, 5);
  });

  it('embedding 失败重试 ≤3 次后标记 pending（索引待补）', () => {
    replacePageChunks(dataDir, 'concepts/x.md', [{ content: '内容', heading: null }]);
    expect(getIndexStatus(dataDir).pendingPages).toBe(1); // 写入时默认 pending（无向量）
    markIndexFailed(dataDir, 'concepts/x.md');
    markIndexFailed(dataDir, 'concepts/x.md');
    // 前两次 attempts<3，status 保持写入时初始值
    markIndexFailed(dataDir, 'concepts/x.md');
    expect(getIndexStatus(dataDir).pendingPages).toBe(1);
    // 向量写入后待补清零
    savePageVectors(dataDir, 'concepts/x.md', [new Float32Array([1, 0])], 'm');
    expect(getIndexStatus(dataDir).pendingPages).toBe(0);
  });

  it('页面删除：索引同步移除（NFR-4 不索引已删除页面）', () => {
    replacePageChunks(dataDir, 'concepts/del.md', [{ content: '将被删除', heading: null }]);
    expect(getIndexStatus(dataDir).totalChunks).toBe(1);
    removePageIndex(dataDir, 'concepts/del.md');
    expect(getIndexStatus(dataDir).totalChunks).toBe(0);
    expect(keywordRecall(dataDir, '删除', 5)).toEqual([]);
  });

  it('同页重写幂等：chunk 重复索引不翻倍', () => {
    const chunks = [{ content: '内容A', heading: null }];
    replacePageChunks(dataDir, 'concepts/idem.md', chunks);
    replacePageChunks(dataDir, 'concepts/idem.md', chunks);
    expect(getIndexStatus(dataDir).totalChunks).toBe(1);
  });
});

describe('chunkPage（300–500 字切分，重叠 50）', () => {
  it('长文按目标长度切分且保留标题归属', () => {
    const md = [
      '# 第一章',
      'a'.repeat(350),
      '## 第二章',
      'b'.repeat(350),
    ].join('\n');
    const chunks = chunkPage(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].heading).toBe('第一章');
    // 第二块从新标题开始，归属第二章
    const second = chunks.find((c) => c.content.includes('## 第二章'));
    expect(second?.heading).toBe('第二章');
  });

  it('短文单块输出，不产生空块', () => {
    const chunks = chunkPage('只有一段短文本。');
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe('只有一段短文本。');
  });
});

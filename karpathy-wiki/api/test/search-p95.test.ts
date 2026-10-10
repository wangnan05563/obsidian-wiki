// NFR-1 性能基准（T01771 复核）：1000 chunk 量级单次查询 P95 < 800ms（本地机）。
// 作为常驻回归门禁：检索层性能退化（如 FTS5 查询劣化、索引表膨胀）即红。
// 隔离纪律（NFR-3）：SQLite 库落 os.tmpdir() 随机目录，用后即焚，与单例句柄生命周期严格同步。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  replacePageChunks,
  keywordRecall,
  removePageIndex,
  getIndexStatus,
  getIndexDb,
  closeIndexDb,
} from '../src/search/sqlite-index.js';

const createdDirs: string[] = [];
let dataDir = '';
const TARGET_PAGES = 250; // 每页 4 chunk → 1000 chunk 量级

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'wiki-bench-p95-'));
  createdDirs.push(dataDir);
  for (let i = 0; i < TARGET_PAGES; i++) {
    replacePageChunks(dataDir, `bench/page-${i}.md`, [
      { content: `页面 ${i} 的第一节内容，涉及检索与向量。`, heading: '第 0 节' },
      { content: `页面 ${i} 的第二节内容，涉及索引与图谱。`, heading: '第 1 节' },
      { content: `页面 ${i} 的第三节内容，涉及编译与缓存。`, heading: '第 2 节' },
      { content: `页面 ${i} 的第四节内容，涉及主题与路由。`, heading: '第 3 节' },
    ]);
  }
});

afterEach(() => {
  closeIndexDb();
});

afterAll(() => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
});

describe('NFR-1 检索性能（1000 chunk 本地机）', () => {
  it(`写入 ${TARGET_PAGES} 页产生约 1000 chunk`, () => {
    const status = getIndexStatus(dataDir);
    expect(status.totalChunks).toBe(TARGET_PAGES * 4);
  });

  it('单次查询 P95 < 800ms（混合长短词 × 60 次采样）', () => {
    // 混合单/双/多词与零命中查询：覆盖 FTS5 最常见路径，避免单一词型偏差
    const queries = ['检索', '向量 索引', '知识库 图谱 编译', '缓存 主题 路由 术语', '不存在的查询词xyz'];
    const latencies: number[] = [];
    for (let round = 0; round < 60; round++) {
      const q = queries[round % queries.length];
      const t0 = performance.now();
      keywordRecall(dataDir, q, 10);
      latencies.push(performance.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    // 报告实际数值供基线追踪（vitest 输出可见）
    console.log(`[NFR-1] P50=${p50.toFixed(1)}ms P95=${p95.toFixed(1)}ms max=${latencies[latencies.length - 1].toFixed(1)}ms`);
    expect(p95).toBeLessThan(800);
  });

  it('首次查询与热查询差异可见（首查含 FTS5 查询计划冷启动）', () => {
    // 冷查询单独跑一次：本地机冷启动通常仍远低于 800ms 门槛，记录用于基线
    const t0 = performance.now();
    const hits = keywordRecall(dataDir, '检索', 10);
    const cold = performance.now() - t0;
    console.log(`[NFR-1] 冷查询=${cold.toFixed(1)}ms hits=${hits.length}`);
    expect(hits.length).toBeGreaterThan(0);
    expect(cold).toBeLessThan(800);
  });

  it('NFR-4 引用不泄露（单机语义）：删除页面后 chunk 全量清空', () => {
    const before = getIndexStatus(dataDir);
    removePageIndex(dataDir, 'bench/page-0.md');
    const after = getIndexStatus(dataDir);
    expect(after.totalChunks).toBe(before.totalChunks - 4);
    // 直接断言 chunks 表中该页零残留（/api/search/chunks 读同一表）
    const rows = getIndexDb(dataDir)
      .prepare('SELECT COUNT(*) AS n FROM chunks WHERE page_path = ?')
      .get('bench/page-0.md') as { n: number };
    expect(rows.n).toBe(0);
  });
});

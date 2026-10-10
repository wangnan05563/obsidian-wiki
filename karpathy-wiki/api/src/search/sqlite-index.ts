// FR-20 语义搜索：SQLite 索引层（node:sqlite 内置模块，零依赖）。
// 约束 6 合规：向量以 BLOB 存于同一 SQLite 库（无独立向量库进程），embedding 计算外置到
// 用户 BYOK 的 embedding API——本模块不做任何网络调用，只负责存储与 FTS5 关键词查询。
// 为什么 node:sqlite 而非 better-sqlite3：Node ≥22.5 内置（运行时 v24 实测可用）、
// 编译期自带 FTS5，无需原生编译依赖，符合「单机零安装」路线。
// 为什么用 createRequire 动态加载而非静态 import：vite 5 / vitest 1.x 的模块解析器
// 内置清单不含 node:sqlite（Node 22.5 新增），静态 import 会被误解析为 npm 包 'sqlite'
// 导致构建/测试加载失败；CJS require 由 Node 运行时自行处理，绕开前端工具链解析。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
// DatabaseSync 是类（值），类型位置用 InstanceType 提取实例类型
type SyncDb = InstanceType<typeof DatabaseSync>;

export interface ChunkRow {
  pagePath: string;
  chunkIndex: number;
  content: string;
  heading: string | null;
}

export interface IndexStatus {
  indexedPages: number;
  pendingPages: number;
  totalChunks: number;
}

let db: SyncDb | null = null;
// 记录当前库目录：目录变更（测试隔离/多实例）时重建连接，避免旧句柄指向已删除的临时目录
let currentDir = '';

// 单例惰性初始化：库文件位于 data/（运行时数据目录，与 threads/ 同级）
export function getIndexDb(dataDir: string): SyncDb {
  if (db && currentDir === dataDir) return db;
  db?.close();
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'wiki-index.db'));
  currentDir = dataDir;
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      heading TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(page_path, chunk_index)
    );
    CREATE TABLE IF NOT EXISTS chunk_vecs (
      page_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      -- 向量按调用方序列化为 BLOB（Float32Array little-endian），此处只管存取
      vec BLOB NOT NULL,
      dim INTEGER NOT NULL,
      model TEXT NOT NULL,
      UNIQUE(page_path, chunk_index)
    );
    CREATE TABLE IF NOT EXISTS index_status (
      page_path TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'indexed',
      -- 重试计数：embedding 失败重试 ≤3 次后标记 pending（索引待补）
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content, page_path UNINDEXED, content=chunks, content_rowid=id, tokenize='trigram'
    );
    -- FTS5 外部内容表同步触发器（chunks 增删改自动维护全文索引）
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, page_path) VALUES (new.id, new.content, new.page_path);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, page_path) VALUES ('delete', old.id, old.content, old.page_path);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, page_path) VALUES ('delete', old.id, old.content, old.page_path);
      INSERT INTO chunks_fts(rowid, content, page_path) VALUES (new.id, new.content, new.page_path);
    END;
  `);
  return db;
}

/** 测试与重建用：关闭并释放单例（进程内不影响其他模块） */
export function closeIndexDb(): void {
  db?.close();
  db = null;
}

/** 写入一页的 chunk（先清旧再写新，保证幂等） */
export function replacePageChunks(dataDir: string, pagePath: string, chunks: Array<{ content: string; heading: string | null }>): void {
  const d = getIndexDb(dataDir);
  const now = new Date().toISOString();
  const tx = d;
  tx.exec('BEGIN');
  try {
    tx.prepare('DELETE FROM chunk_vecs WHERE page_path = ?').run(pagePath);
    tx.prepare('DELETE FROM chunks WHERE page_path = ?').run(pagePath);
    const ins = tx.prepare('INSERT INTO chunks (page_path, chunk_index, content, heading, updated_at) VALUES (?, ?, ?, ?, ?)');
    chunks.forEach((c, i) => ins.run(pagePath, i, c.content, c.heading, now));
    tx.prepare(`INSERT INTO index_status (page_path, status, attempts, updated_at) VALUES (?, 'pending', 0, ?)
                ON CONFLICT(page_path) DO UPDATE SET attempts = 0, updated_at = excluded.updated_at`).run(pagePath, now);
    tx.exec('COMMIT');
  } catch (err) {
    tx.exec('ROLLBACK');
    throw err;
  }
}

/** 写入某页全部 chunk 的向量，并把该页标记为 indexed（待补清零） */
export function savePageVectors(
  dataDir: string,
  pagePath: string,
  vectors: Float32Array[],
  model: string,
): void {
  const d = getIndexDb(dataDir);
  const now = new Date().toISOString();
  d.exec('BEGIN');
  try {
    const del = d.prepare('DELETE FROM chunk_vecs WHERE page_path = ?');
    del.run(pagePath);
    const ins = d.prepare('INSERT INTO chunk_vecs (page_path, chunk_index, vec, dim, model) VALUES (?, ?, ?, ?, ?)');
    vectors.forEach((v, i) => {
      // Float32Array → BLOB：固定 4 字节小端，查询端同构反序列化
      ins.run(pagePath, i, Buffer.from(v.buffer, v.byteOffset, v.byteLength), v.length, model);
    });
    d.prepare(`INSERT INTO index_status (page_path, status, attempts, updated_at) VALUES (?, 'indexed', 0, ?)
               ON CONFLICT(page_path) DO UPDATE SET status = 'indexed', attempts = 0, updated_at = excluded.updated_at`)
      .run(pagePath, now);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** embedding 失败：累计重试计数，≤3 次 status=pending（索引待补），不阻塞摄取主流程 */
export function markIndexFailed(dataDir: string, pagePath: string): void {
  const d = getIndexDb(dataDir);
  const now = new Date().toISOString();
  d.prepare(`UPDATE index_status SET attempts = attempts + 1,
             status = CASE WHEN attempts + 1 >= 3 THEN 'pending' ELSE status END,
             updated_at = ? WHERE page_path = ?`).run(now, pagePath);
}

/** 删除页面索引（页面被删除/清空时调用，防引用跳转泄露已删除内容——NFR-4） */
export function removePageIndex(dataDir: string, pagePath: string): void {
  const d = getIndexDb(dataDir);
  d.prepare('DELETE FROM chunks WHERE page_path = ?').run(pagePath);
  d.prepare('DELETE FROM chunk_vecs WHERE page_path = ?').run(pagePath);
  d.prepare('DELETE FROM index_status WHERE page_path = ?').run(pagePath);
}

/** FTS5 关键词路召回：BM25 排序 top-N。
 * 分词说明：trigram tokenizer 支持 CJK 子串匹配（默认 unicode61 会把整段中文当一个 token）。
 * trigram 的限制是查询串须 ≥3 字符——短查询与 FTS 语法错误一律降级 LIKE 扫描，保证功能可用。 */
export function keywordRecall(dataDir: string, query: string, limit: number): Array<ChunkRow & { score: number }> {
  const d = getIndexDb(dataDir);
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  // 短查询（trigram 需 ≥3 字符）降级 LIKE；中文两字词（最常见的搜索粒度）走此分支
  const useLike = terms.some((t) => t.length < 3) || /["*()]/.test(query);
  if (useLike) {
    const likeTerms = terms.slice(0, 3);
    const where = likeTerms.map(() => 'content LIKE ?').join(' AND ');
    const rows = d.prepare(`
      SELECT page_path, chunk_index, content, heading FROM chunks WHERE ${where} LIMIT ?
    `).all(...likeTerms.map((t) => `%${t.replace(/[%_]/g, (c) => '\\' + c)}%`), limit) as Array<{ page_path: string; chunk_index: number; content: string; heading: string | null }>;
    return rows.map((r) => ({ pagePath: r.page_path, chunkIndex: r.chunk_index, content: r.content, heading: r.heading, score: -1 }));
  }
  const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  try {
    const rows = d.prepare(`
      SELECT c.page_path, c.chunk_index, c.content, c.heading, bm25(chunks_fts) AS score
      FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY score LIMIT ?
    `).all(match, limit) as Array<{ page_path: string; chunk_index: number; content: string; heading: string | null; score: number }>;
    return rows.map((r) => ({ pagePath: r.page_path, chunkIndex: r.chunk_index, content: r.content, heading: r.heading, score: r.score }));
  } catch {
    // FTS5 语法错误等：LIKE 兜底，不让关键词路崩溃
    const rows = d.prepare('SELECT page_path, chunk_index, content, heading FROM chunks WHERE content LIKE ? LIMIT ?')
      .all(`%${terms[0]}%`, limit) as Array<{ page_path: string; chunk_index: number; content: string; heading: string | null }>;
    return rows.map((r) => ({ pagePath: r.page_path, chunkIndex: r.chunk_index, content: r.content, heading: r.heading, score: -1 }));
  }
}

/** 向量路召回：与查询向量做余弦相似度，top-N。无向量数据时返回空（语义路自动关闭） */
export function vectorRecall(
  dataDir: string,
  queryVec: Float32Array,
  limit: number,
): Array<ChunkRow & { similarity: number }> {
  const d = getIndexDb(dataDir);
  const rows = d.prepare(`
    SELECT c.page_path, c.chunk_index, c.content, c.heading, v.vec, v.dim
    FROM chunk_vecs v JOIN chunks c ON c.page_path = v.page_path AND c.chunk_index = v.chunk_index
  `).all() as Array<{ page_path: string; chunk_index: number; content: string; heading: string | null; vec: Buffer; dim: number }>;
  if (rows.length === 0) return [];
  const dim = queryVec.length;
  const scored = rows
    .filter((r) => r.dim === dim)
    .map((r) => {
      const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.dim);
      let dot = 0;
      let nq = 0;
      let nv = 0;
      for (let i = 0; i < dim; i++) {
        dot += queryVec[i] * v[i];
        nq += queryVec[i] * queryVec[i];
        nv += v[i] * v[i];
      }
      const similarity = nq > 0 && nv > 0 ? dot / (Math.sqrt(nq) * Math.sqrt(nv)) : 0;
      return { pagePath: r.page_path, chunkIndex: r.chunk_index, content: r.content, heading: r.heading, similarity };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
  return scored;
}

/** 索引状态统计（设置页展示：已索引/待补页面数） */
export function getIndexStatus(dataDir: string): IndexStatus {
  const d = getIndexDb(dataDir);
  const indexed = (d.prepare(`SELECT COUNT(*) AS n FROM index_status WHERE status = 'indexed'`).get() as { n: number }).n;
  const pending = (d.prepare(`SELECT COUNT(*) AS n FROM index_status WHERE status = 'pending'`).get() as { n: number }).n;
  const chunks = (d.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  return { indexedPages: indexed, pendingPages: pending, totalChunks: chunks };
}

/** 全部待补/未索引页面清单（懒索引与重建的工作清单） */
export function listPendingPages(dataDir: string): string[] {
  const d = getIndexDb(dataDir);
  const rows = d.prepare(`SELECT page_path FROM index_status WHERE status = 'pending' OR attempts > 0`).all() as Array<{ page_path: string }>;
  return rows.map((r) => r.page_path);
}

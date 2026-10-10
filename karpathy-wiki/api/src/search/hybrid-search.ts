// FR-20 语义搜索：混合检索编排层。
// 职责链：chunk 切分 → BYOK embedding 生成向量（外置计算，约束 6 合规）→ 双路召回（FTS5 BM25
// + 向量余弦）→ RRF（k=60）融合 → top-10。
// BYOK 语义（约束适配）：embedding 配置由**每次搜索请求**携带（与 llmConfig 同模式，密钥不落
// 服务端磁盘）——未配置时语义路自动关闭，仅关键词路生效（无报错、无回落）。
// 懒索引策略：索引写入无独立后台进程，搜索请求顺带为「待补」页面补算向量（用请求自带 key），
// 设置页重建入口走同一函数；索引失败重试 ≤3 次后标记 pending，不阻塞搜索主流程。
import path from 'node:path';
import { VaultService } from '../vault/vault-service.js';
import {
  getIndexDb,
  replacePageChunks,
  savePageVectors,
  markIndexFailed,
  keywordRecall,
  vectorRecall,
  getIndexStatus,
  listPendingPages,
  removePageIndex,
  type IndexStatus,
} from './sqlite-index.js';

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface HybridSearchOptions {
  query: string;
  limit?: number;
  embedding?: EmbeddingConfig;
  /** 懒索引：搜索前把待补页面补算向量（默认开，重建场景关闭增量语义） */
  lazyIndex?: boolean;
}

export interface HybridHit {
  path: string;
  title: string;
  snippet: string;
  /** 命中来源：keyword（关键词）/ semantic（语义）/ both（双命中）——前端据此加可区分标识 */
  source: 'keyword' | 'semantic' | 'both';
  score: number;
}

// ── chunk 切分：目标 300–500 字，重叠 50 字（FR-20 规格 1）──
// 优先按 Markdown 标题/段落边界切，超长段落再按字数硬切，避免句子拦腰截断导致检索噪声。
export function chunkPage(content: string): Array<{ content: string; heading: string | null }> {
  const TARGET = 400; // 300–500 中值
  const OVERLAP = 50;
  const lines = content.split(/\r?\n/);
  const chunks: Array<{ content: string; heading: string | null }> = [];
  let currentHeading: string | null = null;
  let buf: string[] = [];
  let bufLen = 0;

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) chunks.push({ content: text, heading: currentHeading });
    buf = [];
    bufLen = 0;
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      // 新章节开始：正文归前一块，标题记录为下一块的归属（供引用溯源定位）
      if (bufLen >= TARGET / 2) flush();
      currentHeading = headingMatch[2].trim();
    }
    buf.push(line);
    bufLen += line.length + 1;
    if (bufLen >= TARGET) {
      flush();
      // 重叠：把上一块尾部 50 字并回当前缓冲，保证跨块语义连续
      const prev = chunks[chunks.length - 1]?.content ?? '';
      const tail = prev.slice(-OVERLAP);
      if (tail) {
        buf.push(tail);
        bufLen = tail.length;
      }
    }
  }
  flush();
  return chunks;
}

// ── BYOK embedding 调用（OpenAI 兼容 /embeddings）──
export async function embedTexts(cfg: EmbeddingConfig, texts: string[]): Promise<Float32Array[]> {
  const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, input: texts }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Embedding API error ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { data: Array<{ embedding: number[]; index: number }> };
  const ordered = [...data.data].sort((a, b) => a.index - b.index);
  return ordered.map((d) => new Float32Array(d.embedding));
}

/** 索引单页：切分 → 写 chunk（关键词路立即可用）→ 尝试 embedding（失败计数待补） */
export async function indexPage(dataDir: string, vault: VaultService, relPath: string, embedding?: EmbeddingConfig): Promise<void> {
  let content: string;
  try {
    content = await vault.readFile(relPath);
  } catch {
    // 页面已删除：同步移除索引（NFR-4 不索引已删除页面）
    removePageIndex(dataDir, relPath);
    return;
  }
  replacePageChunks(dataDir, relPath, chunkPage(content));
  if (!embedding?.apiKey) return; // 无 key：关键词路已就绪，向量留待补
  await indexPageVectors(dataDir, vault, relPath, embedding);
}

/** 为已切分页面补算向量（懒索引/重建共用）；失败重试计数，≤3 次标记待补后放弃 */
async function indexPageVectors(dataDir: string, vault: VaultService, relPath: string, embedding: EmbeddingConfig): Promise<void> {
  const d = getIndexDb(dataDir);
  const rows = d.prepare('SELECT chunk_index, content FROM chunks WHERE page_path = ? ORDER BY chunk_index').all(relPath) as Array<{ chunk_index: number; content: string }>;
  if (rows.length === 0) return;
  try {
    const vectors = await embedTexts(embedding, rows.map((r) => r.content));
    savePageVectors(dataDir, relPath, vectors, embedding.model);
  } catch {
    markIndexFailed(dataDir, relPath); // 失败不阻塞：该页标记待补，下次搜索/重建再试
  }
}

/** 列出 vault 内全部可检索页面（6 类页面目录，与 search-util 同源） */
export async function listVaultPages(vault: VaultService): Promise<string[]> {
  const pageDirs = ['entities', 'concepts', 'comparisons', 'queries', 'qa', 'solutions'];
  const fs = await import('node:fs/promises');
  const pages: string[] = [];
  for (const dir of pageDirs) {
    try {
      const entries = await fs.readdir(path.join(vault.getVaultPath(), dir));
      for (const f of entries) {
        if (f.endsWith('.md')) pages.push(`${dir}/${f}`);
      }
    } catch {
      continue; // 目录缺失（新库无该类页面）跳过
    }
  }
  return pages;
}

/** 全量重建索引：清空后逐页切分 + embedding（按请求自带 key），返回状态 */
export async function rebuildIndex(dataDir: string, vault: VaultService, embedding?: EmbeddingConfig): Promise<IndexStatus> {
  const d = getIndexDb(dataDir);
  d.exec('DELETE FROM chunk_vecs; DELETE FROM chunks; DELETE FROM index_status;');
  const pages = await listVaultPages(vault);
  for (const p of pages) {
    await indexPage(dataDir, vault, p, embedding);
  }
  return getIndexStatus(dataDir);
}

/** 懒索引：为待补页面补算向量（每次搜索限量，避免一次搜索触发海量 embedding 调用） */
async function lazyIndexPending(dataDir: string, vault: VaultService, embedding: EmbeddingConfig, maxPages = 5): Promise<void> {
  const pending = listPendingPages(dataDir).slice(0, maxPages);
  for (const p of pending) {
    await indexPageVectors(dataDir, vault, p, embedding);
  }
}

// ── RRF 融合（k=60）：score = Σ 1/(k + rank_i)，无需调权重的双路融合公式 ──
const RRF_K = 60;

function rrfFuse(
  keywordHits: Array<{ pagePath: string; content: string; heading: string | null }>,
  vectorHits: Array<{ pagePath: string; content: string; heading: string | null }>,
): Array<{ pagePath: string; snippet: string; heading: string | null; source: HybridHit['source']; score: number }> {
  const fused = new Map<string, { score: number; sources: Set<string>; content: string; heading: string | null }>();
  const add = (pagePath: string, rank: number, source: string, content: string, heading: string | null) => {
    const cur = fused.get(pagePath) ?? { score: 0, sources: new Set<string>(), content, heading };
    cur.score += 1 / (RRF_K + rank);
    cur.sources.add(source);
    fused.set(pagePath, cur);
  };
  keywordHits.forEach((h, i) => add(h.pagePath, i + 1, 'keyword', h.content, h.heading));
  vectorHits.forEach((h, i) => add(h.pagePath, i + 1, 'semantic', h.content, h.heading));
  return [...fused.entries()]
    .map(([pagePath, v]) => ({
      pagePath,
      snippet: v.content.slice(0, 120).replaceAll('\n', ' '),
      heading: v.heading,
      source: (v.sources.has('keyword') && v.sources.has('semantic') ? 'both' : v.sources.has('semantic') ? 'semantic' : 'keyword') as HybridHit['source'],
      score: v.score,
    }))
    .sort((a, b) => b.score - a.score);
}

/** 混合搜索主入口：双路召回 → RRF → top-10 */
export async function hybridSearch(dataDir: string, vault: VaultService, opts: HybridSearchOptions): Promise<{ hits: HybridHit[]; semanticEnabled: boolean }> {
  const limit = opts.limit ?? 10;
  const embedding = opts.embedding?.apiKey ? opts.embedding : undefined;
  const semanticEnabled = Boolean(embedding);

  // 懒索引：带上有效 embedding 配置时，先少量补算待补页面（有新 key 才有算力语义）
  if (embedding && opts.lazyIndex !== false) {
    await lazyIndexPending(dataDir, vault, embedding).catch(() => { /* 懒索引失败不影响本次搜索 */ });
  }

  // 关键词路：FTS5 BM25 top-20
  const keywordHits = keywordRecall(dataDir, opts.query, 20);

  // 语义路：查询向量余弦 top-20（无 key 或无向量数据时为空 → 仅关键词路）
  let vectorHits: Array<{ pagePath: string; content: string; heading: string | null }> = [];
  if (embedding) {
    try {
      const [qv] = await embedTexts(embedding, [opts.query]);
      vectorHits = await vectorRecall(dataDir, qv, 20);
    } catch {
      vectorHits = []; // 查询向量失败（如 key 无效/限流）：语义路静默关闭，关键词路兜底
    }
  }

  const fused = rrfFuse(keywordHits, vectorHits).slice(0, limit);
  const hits: HybridHit[] = [];
  for (const f of fused) {
    const title = f.pagePath.split('/').pop()?.replace(/\.md$/, '') ?? f.pagePath;
    hits.push({ path: f.pagePath, title, snippet: f.snippet, source: f.source, score: f.score });
  }
  return { hits, semanticEnabled };
}

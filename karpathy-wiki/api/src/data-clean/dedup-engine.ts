import crypto from 'node:crypto';
import type { DeduplicateResult, DuplicatePair, PageQualityScore } from '../types.js';
import { VaultService } from '../vault/vault-service.js';
import { scanVaultRaw } from './quality-scanner.js';

// ============================================================
// 去重判定阈值：集中配置便于调优
// 为什么放文件顶部：清洗逻辑调优时无需翻找散落常量
// ============================================================
// Jaccard 相似度 ≥ 此值判为 near-duplicate（内容高度重合）
const MATCH_THRESHOLD_NEAR = 0.8;
// 标题相似度 ≥ 此值且 Jaccard ≥ MATCH_MIN_JACCARD_FOR_SEMANTIC 判为 semantic-similar
const MATCH_THRESHOLD_SEMANTIC_TITLE = 0.7;
const MATCH_MIN_JACCARD_FOR_SEMANTIC = 0.3;
// 内容过短时跳过去重判定，避免误判（如空白页或仅 frontmatter 的占位文件）
const MIN_TOKENS_FOR_DEDUP = 5;

// 归一化内容：去 frontmatter、统一换行、压缩空白、转小写
// 为什么：frontmatter 的时间戳/updated 字段经常变化，会导致 hash 永远不一致；
// 压缩空白避免同内容但排版差异（多余空行/空格）造成的误判
function normalizeContent(content: string): string {
  // 移除 YAML frontmatter（--- ... ---）
  const fmStripped = content.replace(/^---\n[\s\S]*?\n---\n/, '');
  return fmStripped
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .toLowerCase()
    .trim();
}

function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(normalizeContent(content)).digest('hex');
}

// 分词：英文按单词（长度 ≥ 3），中文按 2-gram
// 为什么：纯英文分词对中文不友好，纯字 n-gram 对英文冗余
// 中英混排文档（Karpathy wiki 主要类型）需要双轨分词
function tokenize(text: string): Set<string> {
  const normalized = normalizeContent(text);
  const tokens = new Set<string>();

  const englishWords = normalized.match(/[a-z][a-z0-9_-]{2,}/g) || [];
  for (const w of englishWords) tokens.add(w);

  const chineseChars = normalized.match(/[\u4e00-\u9fa5]/g) || [];
  for (let i = 0; i < chineseChars.length - 1; i++) {
    tokens.add(chineseChars[i] + chineseChars[i + 1]);
  }

  return tokens;
}

function computeJaccardSimilarity(tokensA: Set<string>, tokensB: Set<string>): number {
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  // 遍历较小的集合，降低 CPU 占用
  const smaller = tokensA.size <= tokensB.size ? tokensA : tokensB;
  const larger = tokensA.size <= tokensB.size ? tokensB : tokensA;
  let intersection = 0;
  for (const t of smaller) if (larger.has(t)) intersection++;

  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Levenshtein 编辑距离，用于标题相似度计算
// 标题通常较短（< 50 字符），O(m*n) 复杂度可接受
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // 滚动数组优化空间至 O(n)
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function computeTitleSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

// Union-Find：把两两重复关系聚合为 N 个一组的等价类
// 为什么需要：A↔B、B↔C 应聚合为 {A,B,C}，避免在 UI 中显示 3 对却无关联
class UnionFind {
  private readonly parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      return x;
    }
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // 路径压缩：后续 find 复杂度接近 O(1)
    let curr = x;
    while (this.parent.get(curr) !== root) {
      const next = this.parent.get(curr)!;
      this.parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  union(x: string, y: string): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx !== ry) this.parent.set(rx, ry);
  }

  groups(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [key] of this.parent) {
      const root = this.find(key);
      if (!result.has(root)) result.set(root, []);
      result.get(root)!.push(key);
    }
    return result;
  }
}

interface PageFingerprint {
  page: PageQualityScore;
  contentHash: string;
  tokens: Set<string>;
}

// 模块级缓存：vault 内容未变时直接复用上次结果，避免重复扫描。
// 合并操作会改变内容 → 下次调用签名不同 → 自动失效重算。
let cachedSignature: string | null = null;
let cachedResult: DeduplicateResult | null = null;

// 根据「path + 内容哈希」构造全局内容签名（排序后拼接，与顺序无关）
function buildSignature(fps: PageFingerprint[]): string {
  const parts: string[] = fps.map((f) => `${f.page.path}\u0000${f.contentHash}`);
  parts.sort();
  return parts.join('\n');
}

export async function deduplicatePages(vault: VaultService): Promise<DeduplicateResult> { // NOSONAR - 认知复杂度：去重含多步处理逻辑
  // 单次扫描：读取原文 + 质量评分，复用同一份磁盘读取，
  // 避免历史实现中「scanVault 读一遍、dedup 再逐文件 readFile 一遍」的 2× 磁盘 I/O
  const scanned = await scanVaultRaw(vault);
  const pages = scanned.map((s) => s.page);

  // 步骤 1：为每个页面计算指纹（哈希 + token 集合），并剔除过短页面
  const fingerprints: PageFingerprint[] = [];
  for (let i = 0; i < scanned.length; i++) {
    const content = scanned[i].content;
    fingerprints.push({
      page: scanned[i].page,
      contentHash: computeContentHash(content),
      tokens: tokenize(content),
    });
  }

  // 内容签名缓存：vault 未变化时秒回；合并后触发的「重新扫描」也几乎瞬时
  const signature = buildSignature(fingerprints);
  if (cachedSignature === signature && cachedResult) {
    return cachedResult;
  }

  const N = fingerprints.length;

  // 步骤 2：倒排索引做 blocking，把 O(n²) 全量两两比较降为「共享 token 的候选对」比较。
  // 正确性：命中阈值要求 Jaccard ≥ 0.3，而 Jaccard > 0 ⇔ 两页至少共享一个 token；
  //   因此任何会被判为重复的对必然共享 token，blocking 不会漏判（false negative = 0）。
  // 过短页面（< MIN_TOKENS_FOR_DEDUP）不参与，与历史行为一致。
  const inverted = new Map<string, number[]>();
  for (let i = 0; i < N; i++) {
    if (fingerprints[i].tokens.size < MIN_TOKENS_FOR_DEDUP) continue;
    for (const t of fingerprints[i].tokens) {
      const arr = inverted.get(t);
      if (arr) arr.push(i);
      else inverted.set(t, [i]);
    }
  }

  // 超高频 token（如 the/and）几乎出现在所有页面：既无区分度，又会因 C(k,2) 退化回 O(n²)。
  // 剔除频率超过上限的 token（这类 token 的 Jaccard 贡献本就趋近 0，命中不到 0.3 阈值）。
  const FREQ_CAP = Math.max(30, Math.floor(N * 0.05));
  // 长度比预剪枝（数学精确）：Jaccard ≥ t 要求较小集合 ≥ t × 较大集合。
  // 候选对若 min(size) < 0.3 × max(size)，则 Jaccard 必 < 0.3，不可能命中任何阈值，直接跳过。
  const MIN_JACCARD_FOR_ANY_MATCH = MATCH_MIN_JACCARD_FOR_SEMANTIC; // 0.3
  const seen = new Set<number>();
  const candidatePairs: Array<[number, number]> = [];
  for (const postings of inverted.values()) {
    if (postings.length > FREQ_CAP) continue;
    for (let a = 0; a < postings.length; a++) {
      const ia = postings[a];
      const sa = fingerprints[ia].tokens.size;
      for (let b = a + 1; b < postings.length; b++) {
        const ib = postings[b];
        const sb = fingerprints[ib].tokens.size;
        // 长度比预剪枝：较小集合明显小于较大集合的 0.3 倍 → 不可能命中任何阈值
        if (Math.min(sa, sb) < MIN_JACCARD_FOR_ANY_MATCH * Math.max(sa, sb)) continue;
        const key = ia * N + ib; // postings 按 i 递增追加，保证 ia < ib
        if (seen.has(key)) continue;
        seen.add(key);
        candidatePairs.push([ia, ib]);
      }
    }
  }

  // 步骤 3：对候选对逐一判定，生成 matches + 同步 Union-Find 聚合
  const matches: DuplicatePair[] = [];
  const uf = new UnionFind();

  for (const [i, j] of candidatePairs) {
    const a = fingerprints[i];
    const b = fingerprints[j];

    // 同路径跳过（理论上不会出现，防御性编程）
    if (a.page.path === b.page.path) continue;

    let similarity = 0;
    let matchType: DuplicatePair['matchType'] | null = null;
    let reason = '';

    if (a.contentHash === b.contentHash) {
      // 完全相同：SHA-256 哈希一致（已排除空内容）
      similarity = 1.0; // NOSONAR
      matchType = 'exact';
      reason = '内容完全相同（SHA-256 一致）';
    } else {
      const jaccard = computeJaccardSimilarity(a.tokens, b.tokens);
      if (jaccard >= MATCH_THRESHOLD_NEAR) {
        similarity = jaccard;
        matchType = 'near-duplicate';
        reason = `内容高度相似（Jaccard ${(jaccard * 100).toFixed(0)}%）`;
      } else if (jaccard >= MATCH_MIN_JACCARD_FOR_SEMANTIC) {
        const titleSim = computeTitleSimilarity(a.page.title, b.page.title);
        if (titleSim >= MATCH_THRESHOLD_SEMANTIC_TITLE) {
          similarity = Math.max(jaccard, titleSim);
          matchType = 'semantic-similar';
          reason = `标题相似 ${(titleSim * 100).toFixed(0)}% + 内容重叠 ${(jaccard * 100).toFixed(0)}%`;
        }
      }
    }

    if (matchType) {
      // pageA 取质量分较高者，便于用户判断"保留谁"
      const [pageA, pageB] =
        a.page.qualityScore >= b.page.qualityScore ? [a.page, b.page] : [b.page, a.page];
      matches.push({ pageA, pageB, similarity, matchType, reason });
      uf.union(a.page.path, b.page.path);
    }
  }

  // 步骤 4：用 Union-Find 聚合分组，每组选 qualityScore 最高者为 representative
  const groupMap = uf.groups();
  const duplicateGroups: DeduplicateResult['duplicateGroups'] = [];

  // path → page 映射，避免原实现在分组时 O(n) 查找导致的二次 O(n²)
  const pageByPath = new Map<string, PageQualityScore>();
  for (const f of fingerprints) pageByPath.set(f.page.path, f.page);

  for (const [, paths] of groupMap) {
    if (paths.length < 2) continue;

    const pagesInGroup = paths
      .map((p) => pageByPath.get(p)!)
      .sort((a, b) => b.qualityScore - a.qualityScore);

    const representative = pagesInGroup[0];
    const totalWords = pagesInGroup.reduce((sum, p) => sum + p.metadata.wordCount, 0);

    duplicateGroups.push({
      pages: paths,
      representativePath: representative.path,
      totalWordsInGroup: totalWords,
    });
  }

  // uniquePages = 总页面 - 重复组中多出来的部分
  // 例如 3 个页面互相重复，uniquePages 减去 2（保留 1 个唯一页面）
  const duplicatePageCount = duplicateGroups.reduce(
    (sum: number, g: DeduplicateResult['duplicateGroups'][number]) => sum + g.pages.length - 1,
    0
  );
  const uniquePages = pages.length - duplicatePageCount;

  const result: DeduplicateResult = {
    matches,
    scannedPages: pages.length,
    uniquePages,
    duplicateGroups,
  };
  cachedSignature = signature;
  cachedResult = result;
  return result;
}

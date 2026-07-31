import type { VaultService } from '../vault/vault-service.js';
import type { DiffLine, DiffResult } from '../types.js';

// 路径白名单：禁止 .. 与绝对路径，防止路径穿越
// 为什么允许中文字符：vault 中大量页面文件名含中文（如 "恒生电子.md"、"DFB001 银行账户查询申请报文.md"），
// 仅允许 ASCII 会导致差异对比接口对中文文件名完全不可用
// 路径穿越防护不依赖此正则——下方 isValidVaultPath 中已显式拒绝 ".."、绝对路径与反斜杠
const PATH_WHITELIST = /^[a-zA-Z0-9_\-\u4e00-\u9fa5/]+\.md$/;

export function isValidVaultPath(relPath: string): boolean {
  if (!relPath || typeof relPath !== 'string') return false;
  if (relPath.includes('..')) return false;
  if (relPath.startsWith('/')) return false;
  if (relPath.includes('\\')) return false;
  return PATH_WHITELIST.test(relPath);
}

// LCS（最长公共子序列）动态规划
// dp[i][j] = linesA[0..i-1] 与 linesB[0..j-1] 的 LCS 长度
// 为什么用 LCS：行级 diff 经典算法，O(m*n) 时间与空间，对几百行文档足够快
function lcsMatrix(linesA: string[], linesB: string[]): number[][] {
  const m = linesA.length;
  const n = linesB.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (linesA[i - 1] === linesB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

// 根据 LCS 矩阵回溯生成 diff 行
// 回溯方向：
// - linesA[i-1] === linesB[j-1] → context，左上走
// - 否则 dp[i-1][j] >= dp[i][j-1] → del（A 多出来的行），向上走
// - 否则 add（B 多出来的行），向左走
function backtrackDiff(
  linesA: string[],
  linesB: string[],
  dp: number[][]
): DiffLine[] {
  const result: DiffLine[] = [];
  let i = linesA.length;
  let j = linesB.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      result.unshift({
        type: 'context',
        content: linesA[i - 1],
        oldLine: i,
        newLine: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({
        type: 'add',
        content: linesB[j - 1],
        newLine: j,
      });
      j--;
    } else {
      result.unshift({
        type: 'del',
        content: linesA[i - 1],
        oldLine: i,
      });
      i--;
    }
  }

  return result;
}

function computeSimilarity(linesA: number, linesB: number, unchanged: number): number {
  // 相似度 = 2 * 共同行数 / (A 行数 + B 行数)
  // 为什么用这个公式：与 Jaccard 相似度一致，避免 A=B=0 时的除零
  const denom = linesA + linesB;
  if (denom === 0) return 1;
  return (2 * unchanged) / denom;
}

export async function compareFiles(
  vault: VaultService,
  pathA: string,
  pathB: string
): Promise<DiffResult> {
  // 路径白名单校验，不通过直接抛错（路由层会捕获并返回 400）
  if (!isValidVaultPath(pathA) || !isValidVaultPath(pathB)) {
    throw new Error(`Invalid path: pathA=${pathA}, pathB=${pathB}`);
  }

  const [contentA, contentB] = await Promise.all([
    vault.readFile(pathA),
    vault.readFile(pathB),
  ]);

  // 按行切分（保留空行，避免行号错位）
  // 为什么 \n 而非 \r?\n：vault.writeFile 统一写 \n，且 normalize 已在去 frontmatter 时处理
  const linesA = contentA.split('\n');
  const linesB = contentB.split('\n');

  const dp = lcsMatrix(linesA, linesB);
  const lines = backtrackDiff(linesA, linesB, dp);

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const line of lines) {
    if (line.type === 'add') added++;
    else if (line.type === 'del') removed++;
    else unchanged++;
  }

  return {
    pathA,
    pathB,
    lines,
    summary: {
      added,
      removed,
      unchanged,
      similarity: computeSimilarity(linesA.length, linesB.length, unchanged),
    },
  };
}

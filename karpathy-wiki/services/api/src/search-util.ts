import fs from 'node:fs/promises';
import path from 'node:path';
import type { VaultService } from './vault/vault-service.js';

// 全文检索命中结果
export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  // 命中关键词数（相关性排序用）
  hits: number;
}

// 简单全文搜索：扫描所有页面目录，按关键词匹配标题与正文。
// 垂直切片阶段用最朴素的 includes 匹配，后续可替换为倒排索引或向量化检索。
// query-workflow.ts 的 searchPages 工具与 /api/search 路由共用此实现（DRY）。
export async function searchPages(
  vault: VaultService,
  keywords: string,
  limit = 20,
): Promise<SearchHit[]> {
  const pageDirs = ['entities', 'concepts', 'comparisons', 'queries'];
  const terms = keywords.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const results: SearchHit[] = [];

  for (const d of pageDirs) {
    const dirFull = path.join(vault.getVaultPath(), d);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dirFull);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue;
      const rel = `${d}/${f}`;
      let content = '';
      try {
        content = await vault.readFile(rel);
      } catch {
        continue;
      }
      const lower = content.toLowerCase();
      // 任一关键词命中即收录，命中数越多排序越靠前
      const hitCount = terms.filter((t) => lower.includes(t)).length;
      if (hitCount === 0) continue;

      const title = f.slice(0, -3);
      // 摘要取首个关键词出现位置前后 60 字符
      const firstIdx = lower.indexOf(terms[0]);
      const start = Math.max(0, firstIdx - 30);
      // 用 replaceAll 替代 replace+全局正则（S7781）
      const snippet = content.slice(start, start + 120).replaceAll('\n', ' ');

      results.push({ path: rel, title, snippet, hits: hitCount });
    }
  }

  // 命中数多的优先，同命中数按标题字典序
  results.sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    return a.title.localeCompare(b.title);
  });
  return results.slice(0, limit);
}

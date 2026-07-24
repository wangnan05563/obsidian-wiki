import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { VaultService } from './vault/vault-service.js';

// 全文检索命中结果
export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  // 命中关键词数（相关性排序用）
  hits: number;
}

export interface SearchFilter {
  // 按 frontmatter.source 过滤（如 "qq-chat", "web", "manual"）
  source?: string;
  // 按 frontmatter.status 过滤（如 "draft", "published"）
  status?: string;
}

// 简单全文搜索：扫描所有页面目录，按关键词匹配标题与正文。
// 垂直切片阶段用最朴素的 includes 匹配，后续可替换为倒排索引或向量化检索。
// query-workflow.ts 的 searchPages 工具与 /api/search 路由共用此实现（DRY）。
// filter 参数支持按 frontmatter source/status 字段过滤（AC-10）。
export async function searchPages(
  vault: VaultService,
  keywords: string,
  limit = 20,
  filter?: SearchFilter,
): Promise<SearchHit[]> {
  const pageDirs = ['entities', 'concepts', 'comparisons', 'queries'];
  const terms = keywords.toLowerCase().split(/\s+/).filter(Boolean);
  // 是否有前端过滤器活跃（source/status），允许空关键词场景
  const hasFilter = filter?.source || filter?.status;
  if (terms.length === 0 && !hasFilter) return [];

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

      // 当 source/status 过滤活跃时，解析 frontmatter 进行匹配
      if (hasFilter) {
        const parsed = matter(content);
        const fm = parsed.data;
        if (filter?.source && fm.source !== filter.source) continue;
        if (filter?.status && fm.status !== filter.status) continue;
        // 纯过滤模式（无关键词）：frontmatter 匹配即收录
        if (terms.length === 0) {
          const title = f.slice(0, -3);
          const snippet = (parsed.content || content).slice(0, 120).replaceAll('\n', ' ');
          results.push({ path: rel, title, snippet, hits: 1 });
          continue;
        }
        // 有关键词 + 过滤器：继续用过滤后的内容做全文匹配
        content = parsed.content;
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

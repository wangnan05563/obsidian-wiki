// Discover Sources 推荐工作流（FR-16-1）
//
// 设计原则（V3.1 AC-16-1~3）：
// - 仅基于双链拓扑（同目录/同标签/同作者），不引入语义相似度
//   为什么：V3.1 明确禁止向量库，避免与 V2.2 §2.3 "不建向量库"约束冲突
// - 推荐"邻近但未连接"的相关笔记，排除已建立双链的页面
// - 一键建立双链仅在 frontmatter 新增 related: [[页面名]] 字段，不修改正文
//   为什么：用户笔记正文是手工撰写的成品，自动改写会污染内容
//
// 数据流：
//   收集所有页面元数据（一次性）
//     → 计算候选页面与目标页面的匹配维度
//     → 排除自身 + 已建立双链的页面
//     → 按匹配维度数量降序排序
//     → 返回 top N（最少 3，默认 5）

import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { VaultService } from '../vault/vault-service.js';

// 页面目录列表：与 vault-service.ts PAGE_DIRS 对齐
// 为什么本地复制而不导入：避免跨模块内部常量耦合，目录变更时显式同步
const PAGE_DIRS = ['entities', 'concepts', 'comparisons', 'queries', 'qa', 'solutions'];

// 推荐结果项：前端侧边栏渲染用
export interface RecommendedPage {
  path: string;
  title: string;
  reasons: string[]; // 推荐理由（"同目录"/"同标签: xxx"/"同作者: xxx"）
  score: number; // 匹配维度数量，用于排序
}

// 页面元数据：推荐算法内部数据结构
interface PageMetadata {
  path: string;
  title: string;
  tags: string[];
  author: string | null;
  dir: string;
  pageName: string; // 不含 .md 后缀的页面名（[[页面名]] 引用形式）
  wikilinks: Set<string>; // 该页面正文中已存在的 [[页面名]] 双链目标
}

// 一次性收集所有页面元数据，供推荐算法使用
// 为什么一次性收集：避免对每个候选页面都重复扫描整个 vault（O(n²) → O(n)）
async function collectAllPageMetadata(vault: VaultService): Promise<PageMetadata[]> {
  const vaultPath = vault.getVaultPath();
  const pages: PageMetadata[] = [];

  for (const dir of PAGE_DIRS) {
    const dirFull = path.join(vaultPath, dir);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dirFull);
    } catch {
      // 目录不存在或无权访问时跳过，不阻塞整体推荐流程
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue;
      const rel = `${dir}/${f}`;
      const pageName = f.slice(0, -3);
      try {
        const raw = await vault.readFile(rel);
        const parsed = matter(raw);
        const tags = ensureStringArray(parsed.data.tags);
        const author = typeof parsed.data.author === 'string' ? parsed.data.author : null;
        const title = typeof parsed.data.title === 'string' ? parsed.data.title : pageName;
        // 抽取正文中所有 [[页面名]] 双链，用于排除已建立连接的页面
        const wikilinks = new Set<string>();
        const wikilinkRe = /\[\[([^\]]+)\]\]/g;
        let m: RegExpExecArray | null;
        while ((m = wikilinkRe.exec(raw)) !== null) {
          wikilinks.add(m[1].trim());
        }
        pages.push({ path: rel, title, tags, author, dir, pageName, wikilinks });
      } catch {
        // 跳过读取失败的页面，不阻塞整体流程
      }
    }
  }
  return pages;
}

// 为指定页面推荐相关笔记
// 算法：
//   1. 收集所有页面元数据
//   2. 计算候选页面与目标页面的匹配维度（同目录/同标签/同作者）
//   3. 排除：自身、已建立双链的页面（任一方向）
//   4. 按匹配维度数量降序排序，返回 top N
// 返回值：至少返回 3 个候选（若 vault 足够大），上限由 limit 控制（默认 5）
export async function recommendPages(
  vault: VaultService,
  pagePath: string,
  limit = 5,
): Promise<RecommendedPage[]> {
  const allPages = await collectAllPageMetadata(vault);

  // 找到目标页面
  const target = allPages.find((p) => p.path === pagePath);
  if (!target) {
    return [];
  }

  const candidates: RecommendedPage[] = [];

  for (const candidate of allPages) {
    // 排除自身
    if (candidate.path === target.path) continue;

    // 排除已建立双链的页面（任一方向已存在 [[pageName]]）
    // 为什么双向检查：双链是相互的，任一方向已建立则不再推荐
    if (target.wikilinks.has(candidate.pageName)) continue;
    if (candidate.wikilinks.has(target.pageName)) continue;

    // 计算匹配维度
    const reasons: string[] = [];
    if (candidate.dir === target.dir) reasons.push('同目录');

    // 同标签：取交集，仅展示共享的标签
    const sharedTags = candidate.tags.filter((t) => target.tags.includes(t));
    if (sharedTags.length > 0) {
      reasons.push(`同标签: ${sharedTags.join(', ')}`);
    }

    // 同作者（仅当双方都有 author 字段时才匹配）
    if (target.author && candidate.author && candidate.author === target.author) {
      reasons.push(`同作者: ${target.author}`);
    }

    // 仅保留至少一个匹配维度的候选
    if (reasons.length === 0) continue;

    candidates.push({
      path: candidate.path,
      title: candidate.title,
      reasons,
      score: reasons.length,
    });
  }

  // 按匹配维度数量降序排序
  candidates.sort((a, b) => b.score - a.score);

  // AC-16-1 要求 ≥ 3 个相关笔记，limit 为上限
  return candidates.slice(0, Math.max(limit, 3));
}

// 一键建立双链
// 仅在两篇笔记的 frontmatter 新增 related: [[页面名]] 字段，不修改正文
// 幂等：已存在则不重复添加，返回当前 related 数组
// 为什么双向添加：V3.1 AC-16-3 明确"一键建立双链"，双向才是真正的"双向链接"
export async function createBidirectionalLink(
  vault: VaultService,
  sourcePath: string,
  targetPath: string,
): Promise<{ sourceRelated: string[]; targetRelated: string[] }> {
  if (sourcePath === targetPath) {
    throw new Error('不能与自己建立双链');
  }

  // 读取两个页面
  const sourceRaw = await vault.readFile(sourcePath);
  const targetRaw = await vault.readFile(targetPath);

  const sourceParsed = matter(sourceRaw);
  const targetParsed = matter(targetRaw);

  // 提取页面名（不含 .md），用于构造 [[页面名]] 引用
  const sourcePageName = path.basename(sourcePath, '.md');
  const targetPageName = path.basename(targetPath, '.md');

  // 获取或初始化 related 数组
  const sourceRelated: string[] = Array.isArray(sourceParsed.data.related)
    ? (sourceParsed.data.related as string[])
    : [];
  const targetRelated: string[] = Array.isArray(targetParsed.data.related)
    ? (targetParsed.data.related as string[])
    : [];

  // 添加双链（幂等：已存在则跳过写入）
  const sourceLink = `[[${targetPageName}]]`;
  const targetLink = `[[${sourcePageName}]]`;

  let sourceChanged = false;
  let targetChanged = false;

  if (!sourceRelated.includes(sourceLink)) {
    sourceRelated.push(sourceLink);
    sourceParsed.data.related = sourceRelated;
    sourceParsed.data.updated = new Date().toISOString().slice(0, 10);
    sourceChanged = true;
  }

  if (!targetRelated.includes(targetLink)) {
    targetRelated.push(targetLink);
    targetParsed.data.related = targetRelated;
    targetParsed.data.updated = new Date().toISOString().slice(0, 10);
    targetChanged = true;
  }

  // 分别写入（仅当有变更时才写盘，避免无谓 IO）
  if (sourceChanged) {
    await vault.writeFile(sourcePath, matter.stringify(sourceParsed.content, sourceParsed.data));
  }
  if (targetChanged) {
    await vault.writeFile(targetPath, matter.stringify(targetParsed.content, targetParsed.data));
  }

  return { sourceRelated, targetRelated };
}

/** 安全地将 unknown 值转为 string[]，过滤非字符串元素 */
function ensureStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

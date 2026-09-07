// 知识缺口检测工作流（FR-17）
//
// 三种检测维度（均基于双向链接拓扑，不引入语义相似度，与 FR-16/FR-19 一致）：
//   1. 孤立节点：无任何入链/出链的页面（degree 0）
//   2. 低密度社区：连通分量内节点 >=3 且 2*边数/节点数 < 2（即边数 < 节点数）
//   3. 同标签未双链对：共享至少一个 frontmatter 标签、却无任何单向引用的页面两两组合
//
// 为什么复用 collectAllPageMetadata（discover-workflow）而非 buildLinkGraph：
//   buildLinkGraph 只提供 nodes/edges（路径 + [[页面名]]），不含 frontmatter 标签，而
//   同标签检测必须读取标签字段。collectAllPageMetadata 一次性提供 路径/标签/wikilinks/pageName，
//   原子数据足够覆盖全部三种维度。
//
// 计算内核 computeGaps 为纯函数（读 pages 数组返回结果），便于单测不依赖真实 vault；
// detectGaps 仅负责收集页面元数据后委托内核实。
//
// minPages 阈值：页面总数低于该值返回 insufficient-data（与 config.graph.minPages 默认 20 对齐）。

import type { VaultService } from '../vault/vault-service.js';
import { collectAllPageMetadata } from './discover-workflow.js';
import { Harness } from '@wiki/harness';
import type { HarnessConfig } from '@wiki/harness';

export type GapResult =
  | { status: 'insufficient-data'; pageCount: number }
  | {
      status: 'ok';
      pageCount: number;
      isolated: string[];
      lowDensity: LowDensityCommunity[];
      unlinkedPairs: UnlinkedTagPair[];
    };

export interface LowDensityCommunity {
  paths: string[];
  edgeCount: number;
}

export interface UnlinkedTagPair {
  a: string;
  b: string;
  pathA: string;
  pathB: string;
  sharedTags: string[];
}

// 页面拓扑所需的原子字段（PageMetadata 子集，computeGaps 只依赖这些）
export interface PageMeta {
  path: string;
  pageName: string;
  tags: string[];
  wikilinks: Set<string>;
}

export function computeGaps(pages: PageMeta[], minPages = 20): GapResult {
  if (pages.length < minPages) {
    return { status: 'insufficient-data', pageCount: pages.length };
  }

  // 按页面名建立索引，解析 [[页面名]] wikilink 为真实路径
  const byName = new Map<string, string>();
  for (const p of pages) byName.set(p.pageName, p.path);

  // 拓扑：adjacency[p] 无向邻居；outByName 出链目标（页面名）
  const adjacency = new Map<string, Set<string>>();
  const outByName = new Map<string, Set<string>>();
  for (const p of pages) {
    adjacency.set(p.path, new Set<string>());
    outByName.set(p.pageName, new Set<string>());
  }
  for (const p of pages) {
    for (const linkName of p.wikilinks) {
      const targetPath = byName.get(linkName);
      if (!targetPath || targetPath === p.path) continue; // 悬空/自环跳过
      adjacency.get(p.path)!.add(targetPath);
      adjacency.get(targetPath)!.add(p.path);
      outByName.get(p.pageName)!.add(linkName);
    }
  }

  // 孤立节点：无向邻居数为 0
  const isolated: string[] = [];
  for (const p of pages) {
    if ((adjacency.get(p.path)?.size ?? 0) === 0) isolated.push(p.path);
  }

  // 连通分量（迭代 BFS）：用于低密度社区检测
  const visited = new Set<string>();
  const components: Array<{ paths: string[]; edgeCount: number }> = [];
  for (const p of pages) {
    if (visited.has(p.path)) continue;
    const comp: string[] = [];
    const stack = [p.path];
    visited.add(p.path);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const nb of adjacency.get(cur) ?? []) {
        if (!visited.has(nb)) {
          visited.add(nb);
          stack.push(nb);
        }
      }
    }
    const compSet = new Set(comp);
    let edges = 0;
    for (const a of comp) {
      for (const b of adjacency.get(a) ?? []) {
        if (a < b && compSet.has(b)) edges++; // 字典序去重，每条无向边计一次
      }
    }
    components.push({ paths: comp, edgeCount: edges });
  }

  // 低密度社区：size>=3 且 边数 < 节点数（等价平均度数 < 2）
  const lowDensity: LowDensityCommunity[] = components
    .filter((c) => c.paths.length >= 3 && c.edgeCount < c.paths.length)
    .map((c) => ({ paths: c.paths, edgeCount: c.edgeCount }));

  // 同标签未双链对：按标签索引页面，组内两两组合判断「任一方向无引用」
  const tagToPages = new Map<string, PageMeta[]>();
  for (const p of pages) {
    for (const t of p.tags) {
      const arr = tagToPages.get(t);
      if (arr) arr.push(p);
      else tagToPages.set(t, [p]);
    }
  }
  const unlinkedPairs: UnlinkedTagPair[] = [];
  const seen = new Set<string>();
  for (const [tag, group] of tagToPages) {
    const sorted = [...group].sort((x, y) => x.pageName.localeCompare(y.pageName));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const pa = sorted[i];
        const pb = sorted[j];
        if (outByName.get(pa.pageName)?.has(pb.pageName) || outByName.get(pb.pageName)?.has(pa.pageName)) continue;
        const key = `${pa.pageName}|${pb.pageName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unlinkedPairs.push({ a: pa.pageName, b: pb.pageName, pathA: pa.path, pathB: pb.path, sharedTags: [tag] });
      }
    }
  }

  return { status: 'ok', pageCount: pages.length, isolated, lowDensity, unlinkedPairs };
}

export async function detectGaps(vault: VaultService, minPages = 20): Promise<GapResult> {
  const pages = (await collectAllPageMetadata(vault)) as PageMeta[];
  return computeGaps(pages, minPages);
}

// ── T4-2：LLM 缺口建议（SSE 流式，仅展示不落盘）──

// 拓扑「ok」分支类型别名：供 streamGapSuggestions / summarizeGapsText 使用
type OkGaps = Extract<GapResult, { status: 'ok' }>;

// 流式事件的最小形状：runStream 事件中只关心 type/text/message（delta/error）
export interface GapStreamEvent {
  type: string;
  text?: string;
  message?: string;
}

// 构造建议 prompt：把三类缺口序列化为人类可读清单，让 LLM 给出「新建页/补双链」建议
// 为什么不做成加载 prompts/*.md：建议生成是轻量单轮，无需维护独立 prompt 文件（YAGNI）
function buildGapAdvicePrompt(g: OkGaps): string {
  const lines: string[] = [
    '你是知识库图谱优化顾问。请基于以下检测出的"知识缺口"给出可执行的补全建议。',
    '请按「新建页面 / 添加 [[双向链接]]」两类动作分条给出，每条一句话，简洁具体。',
  ];
  if (g.isolated.length > 0) {
    lines.push(`孤立节点（无任何链接，建议为它们建立入链或吸收进相关主题）: ${g.isolated.join(', ')}`);
  }
  for (const c of g.lowDensity) {
    lines.push(`低密度社区（${c.paths.length} 页仅 ${c.edgeCount} 条边，内部缺乏交叉互引）: ${c.paths.join(', ')}`);
  }
  for (const p of g.unlinkedPairs) {
    lines.push(`同标签未双链对: [[${p.a}]] 与 [[${p.b}]]（共同标签: ${p.sharedTags.join('、')}）`);
  }
  return lines.join('\n');
}

// 流式生成缺口建议。runStream 参数可注入以便单测（默认用真实 Harness+LLM）。
// 事件契约：'delta' → yield {text}；'error' → throw（由 route 降级到拓扑摘要）。
export async function* streamGapSuggestions(
  harnessConfig: HarnessConfig,
  gapsResult: OkGaps,
  runStream?: (task: string) => AsyncIterable<GapStreamEvent>,
): AsyncGenerator<{ text: string }> {
  const prompt = buildGapAdvicePrompt(gapsResult);
  const streamFn =
    runStream ??
    (async function* (task: string) {
      // 纯 prompt 单轮，不注入工具，避免 LLM 在建议场景触发 ReAct 循环
      const harness = new Harness({
        ...harnessConfig,
        tools: [],
        budget: { maxSteps: 1, tokenBudget: 8000 },
        hooks: {},
      });
      for await (const evt of harness.runStream({ task, context: {} })) {
        yield evt as unknown as GapStreamEvent;
      }
    });
  for await (const evt of streamFn(prompt)) {
    if (evt.type === 'delta' && evt.text) yield { text: evt.text };
    if (evt.type === 'error') throw new Error(evt.message || 'gap analysis LLM failed');
  }
}

// 降级产物：LLM 不可用时直接返回拓扑摘要（人类可读），保证前端始终有输出
export function summarizeGapsText(g: OkGaps): string {
  const blocks: string[] = [];
  if (g.isolated.length > 0) {
    blocks.push(`孤立节点（${g.isolated.length} 个）：\n- ${g.isolated.join('\n- ')}`);
  }
  for (const c of g.lowDensity) {
    blocks.push(`低密度社区（${c.paths.length} 页、${c.edgeCount} 条边）：\n- ${c.paths.join('\n- ')}`);
  }
  for (const p of g.unlinkedPairs) {
    blocks.push(`同标签建议互引：[[${p.a}]] ↔ [[${p.b}]]（共同标签：${p.sharedTags.join('、')}）`);
  }
  return blocks.length > 0 ? blocks.join('\n\n') : '未发现明显结构缺口。';
}
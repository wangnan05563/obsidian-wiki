import type { HarnessConfig } from '@wiki/harness';
import fs from 'fs/promises';
import path from 'path';
import type { EngineAdapter, CompileInput, ProgressEvent, QueryInput, AnswerChunk, HealthReport } from '../types.js';
import type { VaultService } from '../vault/vault-service.js';
import { compileWorkflow } from '../workflows/compile-workflow.js';
import { queryWorkflow } from '../workflows/query-workflow.js';

// HarnessAdapter：阶段2 默认实现。
// healthCheck 绕过 harness 直接走确定性逻辑（M-2），compile/query 通过工作流调用 harness。
export class HarnessAdapter implements EngineAdapter {
  private harnessConfig: HarnessConfig;
  private vault: VaultService;
  private staleDays: number;

  constructor(config: HarnessConfig, vault: VaultService, staleDays = 30) {
    this.harnessConfig = config;
    this.vault = vault;
    this.staleDays = staleDays;
  }

  async *compile(input: CompileInput): AsyncIterable<ProgressEvent> {
    // 工具集与 hooks 由 compileWorkflow 内部注入，确保每次编译持有最新 vault 引用
    yield* compileWorkflow(this.harnessConfig, this.vault, input);
  }

  async *query(input: QueryInput): AsyncIterable<AnswerChunk> {
    yield* queryWorkflow(this.harnessConfig, this.vault, input);
  }

  // 纯确定性逻辑，不调 LLM。检测孤立页/断链/过期页（4.6 health-check 工作流）。
  async healthCheck(): Promise<HealthReport> {
    const graph = await this.vault.buildLinkGraph();

    // 入链集合：被任何页面 [[页面名]] 引用过的页面路径
    const linked = new Set<string>(graph.edges.map((e) => e.to));
    const orphans = graph.nodes.filter((n) => !linked.has(n));

    // 断链检测：扫描每个页面的 [[link]]，对照已存在的页面名集合。
    // buildLinkGraph 只记录"目标存在"的边，这里补出"目标不存在"的断链。
    const pageDirs = ['entities', 'concepts', 'comparisons', 'queries'];
    const nameToPath = new Map<string, string>();
    for (const rel of graph.nodes) {
      const base = path.basename(rel, '.md');
      nameToPath.set(base, rel);
    }
    const brokenLinks: Array<{ from: string; to: string }> = [];
    const wikilinkRe = /\[\[([^\]]+)\]\]/g;
    for (const d of pageDirs) {
      const dirFull = path.join(this.vault.getVaultPath(), d);
      let entries: string[] = [];
      try {
        entries = await fs.readdir(dirFull);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith('.md')) continue;
        const fromRel = `${d}/${f}`;
        let content = '';
        try {
          content = await this.vault.readFile(fromRel);
        } catch {
          continue;
        }
        let m: RegExpExecArray | null;
        while ((m = wikilinkRe.exec(content)) !== null) {
          const target = m[1].trim();
          if (!nameToPath.has(target)) {
            brokenLinks.push({ from: fromRel, to: target });
          }
        }
      }
    }

    // 过期页面：frontmatter.updated 距今超过 staleDays
    const stale: string[] = [];
    const now = Date.now();
    const thresholdMs = this.staleDays * 24 * 60 * 60 * 1000;
    for (const node of graph.nodes) {
      const updated = await this.vault.getPageUpdated(node);
      if (!updated) continue;
      const ts = Date.parse(updated);
      if (Number.isNaN(ts)) continue;
      if (now - ts > thresholdMs) {
        stale.push(node);
      }
    }

    return { orphans, brokenLinks, stale };
  }
}

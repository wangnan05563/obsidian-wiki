import type { HarnessConfig } from '@wiki/harness';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineAdapter, CompileInput, ProgressEvent, QueryInput, AnswerChunk, HealthReport, FixInput, FixProgressEvent, WebSearchConfig } from '../types.js';
import type { VaultService } from '../vault/vault-service.js';
import { compileWorkflow, resumeCompileWorkflow } from '../workflows/compile-workflow.js';
import { queryWorkflow } from '../workflows/query-workflow.js';
import { healthCheckFixWorkflow } from '../workflows/health-check-fix-workflow.js';

// HarnessAdapter：阶段2 默认实现。
// healthCheck 绕过 harness 直接走确定性逻辑（M-2），compile/query 通过工作流调用 harness。
export class HarnessAdapter implements EngineAdapter {
  private readonly harnessConfig: HarnessConfig;
  private readonly vault: VaultService;
  private staleDays: number;
  // §5.2 联网搜索配置：query workflow 注入 web_search 工具时需要
  private webSearchConfig?: WebSearchConfig;

  constructor(config: HarnessConfig, vault: VaultService, staleDays = 30, webSearchConfig?: WebSearchConfig) {
    this.harnessConfig = config;
    this.vault = vault;
    this.staleDays = staleDays;
    this.webSearchConfig = webSearchConfig;
  }

  // §12.3-7 配置热加载：更新运行时可变参数。
  // model/budget/staleDays 即时生效；provider/baseUrl/apiKey 变更同步到 harnessConfig.llm，
  // 下次 harness.run 时 OpenAICompatibleAdapter 会读取新值构造请求。
  // 为什么不需要重建 LLM 实例：OpenAICompatibleAdapter 持有 config 引用，构造请求时即时读取。
  // §5.2 webSearchConfig 变更同步内存实例，支持 Config 页面保存后即时生效
  updateConfig(updates: { provider?: string; baseUrl?: string; model?: string; apiKey?: string; maxSteps?: number; tokenBudget?: number; staleDays?: number; webSearchConfig?: WebSearchConfig }): void {
    if (updates.provider) {
      this.harnessConfig.llm.provider = updates.provider;
    }
    if (updates.baseUrl) {
      this.harnessConfig.llm.baseUrl = updates.baseUrl;
    }
    if (updates.model) {
      this.harnessConfig.llm.model = updates.model;
    }
    if (updates.apiKey !== undefined) {
      this.harnessConfig.llm.apiKey = updates.apiKey;
    }
    if (updates.maxSteps || updates.tokenBudget) {
      // harnessConfig.budget 在类型上是可选的，热加载前需保证字段存在
      const prev = this.harnessConfig.budget ?? { maxSteps: 20, tokenBudget: 50000 };
      this.harnessConfig.budget = {
        maxSteps: updates.maxSteps ?? prev.maxSteps,
        tokenBudget: updates.tokenBudget ?? prev.tokenBudget,
      };
    }
    if (updates.staleDays) {
      this.staleDays = updates.staleDays;
    }
    if (updates.webSearchConfig) {
      this.webSearchConfig = updates.webSearchConfig;
    }
  }

  async *compile(input: CompileInput): AsyncIterable<ProgressEvent> {
    // 工具集与 hooks 由 compileWorkflow 内部注入，确保每次编译持有最新 vault 引用
    yield* compileWorkflow(this.harnessConfig, this.vault, input);
  }

  // §11.2 断点续传：从中断点恢复编译，复用相同的 harness 事件桥接逻辑
  async *resumeCompile(runId: string): AsyncIterable<ProgressEvent> {
    yield* resumeCompileWorkflow(this.harnessConfig, this.vault, runId);
  }

  // §5.2 query 改造：传递 webSearchConfig 给 workflow，支持联网搜索工具注入
  async *query(input: QueryInput): AsyncIterable<AnswerChunk> {
    yield* queryWorkflow(this.harnessConfig, this.vault, input, {
      webSearchConfig: this.webSearchConfig,
    });
  }

  // §4.6 一键修复：通过 LLM 修复断链/孤立页面，SSE 流式返回修复进度
  async *healthCheckFix(input: FixInput): AsyncIterable<FixProgressEvent> {
    yield* healthCheckFixWorkflow(this.harnessConfig, this.vault, input);
  }

  // 纯确定性逻辑，不调 LLM。检测孤立页/断链/过期页（4.6 health-check 工作流）。
  // §11.2 并发体检：断链扫描与过期检测并行化，提升大规模知识库体检速度。
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

    // §11.2：4 个目录并行扫描断链，Promise.all 等待全部完成
    const wikilinkRe = /\[\[([^\]]+)\]\]/g;
    const scanDir = async (d: string): Promise<Array<{ from: string; to: string }>> => {
      const results: Array<{ from: string; to: string }> = [];
      const dirFull = path.join(this.vault.getVaultPath(), d);
      let entries: string[] = [];
      try {
        entries = await fs.readdir(dirFull);
      } catch {
        return results;
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
        wikilinkRe.lastIndex = 0; // 复用正则需重置 lastIndex
        while ((m = wikilinkRe.exec(content)) !== null) {
          const target = m[1].trim();
          if (!nameToPath.has(target)) {
            results.push({ from: fromRel, to: target });
          }
        }
      }
      return results;
    };

    // 过期检测也并行：每个节点独立 getPageUpdated
    const now = Date.now();
    const thresholdMs = this.staleDays * 24 * 60 * 60 * 1000;
    const checkStale = async (node: string): Promise<string | null> => {
      const updated = await this.vault.getPageUpdated(node);
      if (!updated) return null;
      const ts = Date.parse(updated);
      if (Number.isNaN(ts)) return null;
      if (now - ts > thresholdMs) return node;
      return null;
    };

    // 两类检测并行执行
    const [brokenByDir, staleResults] = await Promise.all([
      Promise.all(pageDirs.map(scanDir)),
      Promise.all(graph.nodes.map(checkStale)),
    ]);

    const brokenLinks = brokenByDir.flat();
    const stale = staleResults.filter((n): n is string => n !== null);

    return { orphans, brokenLinks, stale };
  }
}

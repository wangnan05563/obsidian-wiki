import type { HarnessConfig } from '@wiki/harness';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineAdapter, CompileInput, ProgressEvent, QueryInput, AnswerChunk, HealthReport, FixInput, FixProgressEvent, WebSearchConfig, ToolsConfig, AppConfig, PodcastResult, SkillPreset, VideoTaskResult } from '../types.js';
import type { VaultService } from '../vault/vault-service.js';
import { compileWorkflow, resumeCompileWorkflow } from '../workflows/compile-workflow.js';
import { queryWorkflow } from '../workflows/query-workflow.js';
import { healthCheckFixWorkflow } from '../workflows/health-check-fix-workflow.js';
import { generatePodcast } from '../workflows/podcast-workflow.js';
// v3 媒体生成：视频生成异步任务委托给 media-generation-workflow
import { generateVideo, pollVideoTask } from '../workflows/media-generation-workflow.js';

// BYOK per-user 配置覆盖纯函数（轻量模块，运行时零依赖，便于单测）。
import { applyPerRequestOverride } from './byok-override.js';

// HarnessAdapter：阶段 3 默认实现。
// healthCheck 绕过 harness 直接走确定性逻辑（M-2），compile/query 通过工作流调用 harness。
export class HarnessAdapter implements EngineAdapter {
  private readonly harnessConfig: HarnessConfig;
  private readonly vault: VaultService;
  private staleDays: number;
  // §5.2 联网搜索配置：Query workflow 注入 web_search 工具时需要
  private webSearchConfig?: WebSearchConfig;
  // 需求 4 扩展工具配置：Query workflow 注入 MCP/CLI 工具时需要
  private toolsConfig?: ToolsConfig;
  // FR-12 AI 伙伴预设：激活的伙伴 id 及其 scope/systemPrompt
  private activeSkill?: string;
  private activeSystemPrompt?: string;
  private activeScope?: SkillPreset['scope'];
  private activeOutputFormat?: string;
  // v3 媒体生成：持有 appConfig 引用，query/generateVideo/pollVideoTask 从中提取 mediaConfig
  // 为什么持有引用而非每次传参：query 方法签名由 EngineAdapter 接口固定，不能加 appConfig 参数
  private appConfig?: AppConfig;

  // 健康检查缓存
  private healthReportCache: HealthReport | null = null;
  private healthReportCachedAt = 0;
  private readonly HEALTH_CHECK_CACHE_TTL_MS = 60 * 1000; // 60秒缓存

  constructor(config: HarnessConfig, vault: VaultService, staleDays = 30, webSearchConfig?: WebSearchConfig, toolsConfig?: ToolsConfig, appConfig?: AppConfig) {
    this.harnessConfig = config;
    this.vault = vault;
    this.staleDays = staleDays;
    this.webSearchConfig = webSearchConfig;
    this.toolsConfig = toolsConfig;
    this.appConfig = appConfig;
  }

  // v3 配置热加载：config.json 更新后同步 adapter 持有的 appConfig 引用
  // 为什么需要：mediaConfig 可能被前端 Config 页面修改，需即时生效
  setAppConfig(config: AppConfig): void {
    this.appConfig = config;
  }

  // §12.3-7 配置热加载：更新运行时可变参数。
  // model/budget/staleDays 即时生效；provider/baseUrl/apiKey 变更同步到 harnessConfig.llm；
  // 下次 harness.run 时 OpenAICompatibleAdapter 会读新值构造请求。
  // 为什么不需要重建 LLM 实例：OpenAICompatibleAdapter 持有 config 引用，构造请求时即时读取。
  // §5.2 webSearchConfig 变更同步内存实例，支持 Config 页面保存后即时生效
  updateConfig(updates: { provider?: string; baseUrl?: string; model?: string; apiKey?: string; maxSteps?: number; tokenBudget?: number; staleDays?: number; webSearchConfig?: WebSearchConfig; toolsConfig?: ToolsConfig; activeSkill?: string; systemPrompt?: string; scope?: SkillPreset['scope']; outputFormat?: string }): void {
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
    if (updates.toolsConfig) {
      this.toolsConfig = updates.toolsConfig;
    }
    // FR-12 AI 伙伴预设热加载：Query 页面切换伙伴后即时生效
    if (updates.activeSkill !== undefined) {
      this.activeSkill = updates.activeSkill;
    }
    if (updates.systemPrompt !== undefined) {
      this.activeSystemPrompt = updates.systemPrompt;
    }
    if (updates.scope !== undefined) {
      this.activeScope = updates.scope;
    }
    if (updates.outputFormat !== undefined) {
      this.activeOutputFormat = updates.outputFormat;
    }
  }

  async *compile(input: CompileInput, appConfig?: AppConfig): AsyncIterable<ProgressEvent> {
    // 工具集与 hooks 由 compileWorkflow 内部注入，确保每次编译持有最新 vault 引用
    // FR-10-1: 传入 appConfig 后，compile 末尾自动为新页面生成 ai_tags 建议
    yield* compileWorkflow(this.harnessConfig, this.vault, input, appConfig);
  }

  // §11.2 断点续传：从中断点恢复编译，复用相同的 harness 事件桥接逻辑
  async *resumeCompile(runId: string): AsyncIterable<ProgressEvent> {
    yield* resumeCompileWorkflow(this.harnessConfig, this.vault, runId);
  }

  // §5.2 query 改造：传入 webSearchConfig 给 workflow，支持联网搜索工具注入
  // 需求 4：传入 toolsConfig 给 workflow，支持 MCP/CLI 扩展工具动态注入
  async *query(input: QueryInput): AsyncIterable<AnswerChunk> {
    // §真流式默认值补齐：input.stream 未传时用 appConfig.llm.stream 兜底，再兜底 false
    // 为什么在 adapter 层补齐而非 queryWorkflow 内部：wiki-harness 的 LLMConfig 不含 stream 字段，
    // stream 是业务层概念，由 adapter（持有 appConfig）负责注入默认值更合适
    const effectiveInput: QueryInput = input.stream === undefined
      ? { ...input, stream: this.appConfig?.llm.stream ?? false }
      : input;
    // ── BYOK per-user 覆盖：以请求携带的用户配置覆盖服务端共享配置 ──
    // 实现"各用户独立额度、互不抢占限流"，密钥不落服务端磁盘（见 applyPerRequestOverride）。
    const merged = applyPerRequestOverride(this.harnessConfig, this.webSearchConfig, this.toolsConfig, {
      llmConfig: input.llmConfig,
      searchConfig: input.searchConfig,
      toolsConfig: input.toolsConfig,
    });
    yield* queryWorkflow(merged.harnessConfig, this.vault, effectiveInput, {
      webSearchConfig: merged.webSearchConfig,
      toolsConfig: merged.toolsConfig,
      // FR-12 AI 伙伴预设：传递 scope 限定与额外 system prompt
      scopeFilter: this.activeScope === 'all' || !this.activeScope ? undefined : this.activeScope,
      systemPrompt: this.activeSystemPrompt,
      // v3 媒体生成：image 模式需要 mediaConfig 调用 Agnes API
      mediaConfig: this.appConfig?.media,
      appConfig: this.appConfig,
    });
  }

  // §4.6 一键修复：通过 LLM 修复断链/孤立页面，SSE 流式返回修复进度
  // C-1 写后即刷：修复可能已写入 vault，结束后必须失效体检缓存，
  //   否则前端 runCheck() 命中旧缓存导致已修复项仍显示在列表中
  // 为什么用 finally：generator 可能被调用方 break 中断（客户端断开），
  //   只要有 vault 写入的可能，都应失效缓存让下次体检反映真实状态
  async *healthCheckFix(input: FixInput): AsyncIterable<FixProgressEvent> {
    try {
      yield* healthCheckFixWorkflow(this.harnessConfig, this.vault, input);
    } finally {
      this.invalidateHealthCheckCache();
    }
  }

  // 纯确定性逻辑，不调 LLM。检测孤立页/断链/过期页（4.6 health-check 工作流）。
  // §11.2 并发体检：断链扫描与过期检测并行化，提升大规模知识库体检速度。
  async healthCheck(): Promise<HealthReport> {
    const now = Date.now();
    // 检查缓存是否有效
    if (this.healthReportCache && (now - this.healthReportCachedAt) < this.HEALTH_CHECK_CACHE_TTL_MS) {
      return this.healthReportCache;
    }

    const report = await this.doHealthCheck();

    // 写入缓存
    this.healthReportCache = report;
    this.healthReportCachedAt = now;
    return report;
  }

  // 实际执行健康检查的逻辑（私有方法）
  private async doHealthCheck(): Promise<HealthReport> {
    const graph = await this.vault.buildLinkGraph();

    // 入链集合：被任何页面 [[页面名]] 引用过的页面路径
    const linked = new Set<string>(graph.edges.map((e) => e.to));
    const orphans = graph.nodes.filter((n) => !linked.has(n));

    // 断链检测：扫描每个页面的 [[link]]，对照已存在的页面名集合。
    // buildLinkGraph 只记录 "目标存在" 的边，这里补 "目标不存在" 的断链。
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

  // 清除健康检查缓存（用于手动触发重新体检）
  invalidateHealthCheckCache(): void {
    this.healthReportCache = null;
    this.healthReportCachedAt = 0;
  }

  // FR-09-3 Podcast 生成：委托给 podcast-workflow，复用 this.harnessConfig 的 LLM 配置
  // 为什么不在此处加 withCompileLock：podcast 只写 queries/podcast-*.md，不触碰 index.md/log.md，
  //   与 compile 路由不存在 index.md 追加竞态；归档写入由 vault.writeFile 原子化保证
  async podcast(
    topic: string,
    appConfig: AppConfig | undefined,
    scopeFilter?: { tags?: string[]; folder?: string },
  ): Promise<PodcastResult> {
    return generatePodcast(this.harnessConfig, this.vault, topic, appConfig, scopeFilter);
  }

  // v3 视频生成：委托给 media-generation-workflow，创建 Agnes Video 异步任务
  // appConfig 参数优先于构造函数注入的 this.appConfig（与 podcast 一致的优先级模式）
  async generateVideo(prompt: string, appConfig?: AppConfig): Promise<VideoTaskResult> {
    const cfg = appConfig ?? this.appConfig;
    return generateVideo(prompt, cfg?.media, cfg);
  }

  // v3 视频任务轮询：委托给 media-generation-workflow，完成时下载视频并归档到 vault
  async pollVideoTask(taskId: string, appConfig?: AppConfig): Promise<VideoTaskResult> {
    const cfg = appConfig ?? this.appConfig;
    return pollVideoTask(taskId, this.vault, cfg?.media, cfg);
  }
}

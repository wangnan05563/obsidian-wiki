// 工具注册中心：统一管理扩展工具（MCP + CLI）的加载与注入。
// 为什么需要 registry：
// 1. query-workflow.ts 需要在运行时动态注入扩展工具，不能硬编码
// 2. MCP 工具需懒发现（连接服务器后才能列出工具），需集中管理连接生命周期
// 3. 场景路由器筛选工具后，需将工具名映射为 ToolDefinition
//
// 职责边界：
// - registry 只管扩展工具（MCP + CLI），内置工具（search_pages/read_page/web_search）由 query-workflow.ts 创建
// - registry 不依赖 VaultService，保持纯工具管理职责

import type { ToolDefinition, RunContext } from '@wiki/harness';
import type { ToolsConfig, McpServerEntry, CliToolEntry } from '../types.js';
import { routeTools, isToolEnabled, isMcpServerTriggered } from './scene-router.js';
import { listMcpTools, callMcpTool, buildMcpToolDefinition, disconnectAllMcpServers } from './mcp-client.js';
import { buildCliToolDefinition } from './cli-executor.js';

// 扩展工具加载结果。
// 为什么需要 errors 字段：单个 MCP 服务器连接失败不应阻断整体问答，错误信息收集后由 workflow 推送给前端。
export interface LoadedTools {
  tools: ToolDefinition[];
  errors: Array<{ source: string; message: string }>;
}

// 加载启用的 CLI 工具为 ToolDefinition 列表。
// 提取为独立函数降低 loadExtendedTools 认知复杂度（S3776）。
// 单条工具构建失败仅记录错误不阻断其他工具加载。
async function loadCliTools(config: ToolsConfig, enabledToolNames: string[]): Promise<LoadedTools> {
  const result: LoadedTools = { tools: [], errors: [] };
  for (const cliEntry of config.cliTools) {
    if (!cliEntry.enabled) continue;
    if (!isToolEnabled(cliEntry.name, enabledToolNames)) continue;
    try {
      const toolDef = buildCliToolDefinition(cliEntry);
      // 适配 harness ToolDefinition：保留 ctx 参数传递（即使 CLI handler 当前未用，便于未来扩展）
      result.tools.push({
        name: toolDef.name,
        description: toolDef.description,
        parameters: toolDef.parameters,
        handler: async (args: unknown, ctx: RunContext) => toolDef.handler(args, ctx),
      });
    } catch (err) {
      result.errors.push({
        source: `cli:${cliEntry.name}`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

// 根据 placeholderTool 的 name，在真正 connect MCP 后查找对应真实工具，返回该工具的调用结果。
// 为什么需要：placeholder 工具与真实工具名不一定完全一致（MCP 可能添加前后缀），
// 做一次 case-insensitive 前缀包含匹配即可覆盖大多数场景。
// 找不到匹配时返回友好错误，告知用户该 MCP 服务器未暴露同名工具。
async function resolveAndCallLazyTool(
  serverEntry: McpServerEntry,
  placeholderToolName: string,
  mcpTimeoutMs: number | undefined,
  args: unknown,
): Promise<{ output?: string; error?: string }> {
  // 首次调用触发真实 connect + tools/list
  const mcpTools = await listMcpTools(serverEntry, mcpTimeoutMs);
  const lowerName = placeholderToolName.toLowerCase();
  const matched = mcpTools.find((t) => t.name.toLowerCase() === lowerName)
    || mcpTools.find((t) => t.name.toLowerCase().includes(lowerName));
  if (!matched) {
    const available = mcpTools.map((t) => t.name).join(', ') || '(none)';
    return {
      error: `[MCP:${serverEntry.name}] 工具 "${placeholderToolName}" 在该服务器上不存在。可用工具：${available}`,
    };
  }
  const result = await callMcpTool(serverEntry, matched.name, args, mcpTimeoutMs);
  if (result.isError) {
    const text = result.content.map((c) => c.text || '').join('\n');
    return { error: text || 'MCP tool returned an error' };
  }
  const text = result.content.map((c) => c.text || '').join('\n');
  return { output: text };
}

// 构建懒加载占位 ToolDefinition（不立即连接 MCP，首次 handler 调用时才连接）。
// 为什么需要：auto 模式下并非每次问答都用到所有 MCP，提前 connect + initialize 会消耗大量时间
// （npx 拉包、握手超时），用户体验差。占位工具让 LLM 能感知可用能力，真正用到时才连接。
function buildLazyMcpToolDefinition(
  serverEntry: McpServerEntry,
  placeholder: { name: string; description: string; parameters?: object },
  mcpTimeoutMs?: number,
): ToolDefinition {
  const fullName = `mcp__${serverEntry.name}__${placeholder.name}`;
  let connectedCache: Promise<void> | null = null;
  return {
    name: fullName,
    description: `[MCP:${serverEntry.name}] ${placeholder.description}（首次调用时自动连接，如网络不可用可能超时）`,
    parameters: placeholder.parameters ?? { type: 'object' as const, properties: {}, required: [] },
    handler: async (args: unknown, _ctx: unknown) => {
      try {
        // 保证并发调用不会重复连接 MCP 服务器
        connectedCache ??= resolveAndCallLazyTool(serverEntry, placeholder.name, mcpTimeoutMs, args)
            .then(() => {})
            .catch(() => { connectedCache = null; });
        const res = await resolveAndCallLazyTool(serverEntry, placeholder.name, mcpTimeoutMs, args);
        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `MCP tool call failed (lazy connect): ${msg}` };
      }
    },
  };
}

// 收集 auto 模式下占位工具（未命中 triggerKeywords 的服务器）。
// 为什么需要：即使某个 MCP 服务器未被关键词命中，也应注册占位工具，让 LLM 知道有这些能力，
// 同时避免预先 connect MCP 带来的握手开销。命中 triggerKeywords 的服务器则直接真实加载。
function collectLazyPlaceholderTools(
  question: string,
  config: ToolsConfig,
  enabledToolNames: string[],
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const server of config.mcpServers) {
    if (!server.enabled) continue;
    if (!server.placeholderTools || server.placeholderTools.length === 0) continue;
    // 已经 trigger 命中的服务器不会走到这（在 loadMcpTools 里真实加载了），避免重复注册
    if (isMcpServerTriggered(question, server)) continue;
    // 占位工具名（mcp__{server}）同样需要通过 isToolEnabled 过滤
    if (!isToolEnabled(`mcp__${server.name}`, enabledToolNames)) continue;
    for (const ph of server.placeholderTools) {
      tools.push(buildLazyMcpToolDefinition(server, ph, config.mcpTimeoutMs));
    }
  }
  return tools;
}

// 加载启用的 MCP 服务器工具为 ToolDefinition 列表。
// 提取为独立函数降低 loadExtendedTools 认知复杂度（S3776）。
// 传递 config.mcpTimeoutMs 作为 RPC 超时默认值（per-server timeoutMs 优先）。
// 单个服务器连接失败仅记录错误不阻断其他服务器加载。
//
// §并行加载优化：原串行 for-await 在多个 MCP 服务器同时不可达时，会累计超时
// （2 个服务器 × 30s = 60s），刚好触发前端 60s 超时阈值，导致 AI 回复被前端中断。
// 改用 Promise.allSettled 并行加载，总耗时收敛到单服务器超时上限（30s），
// 给 LLM 留出足够首字节时间，避免误判"AI 未回复"。
async function loadMcpTools(config: ToolsConfig, enabledToolNames: string[]): Promise<LoadedTools> {
  const result: LoadedTools = { tools: [], errors: [] };
  // 先过滤出启用的服务器，避免对禁用服务器发起连接
  const activeServers = config.mcpServers.filter(
    (s) => s.enabled && isToolEnabled(`mcp__${s.name}`, enabledToolNames),
  );
  if (activeServers.length === 0) return result;

  // 并行加载：每个服务器的连接 + tools/list 独立 Promise，互不阻塞
  // 为什么用 allSettled 而非 all：单服务器失败不应阻断其他服务器的工具加载，
  //   allSettled 总是 resolve，失败结果在 settled 数组中以 rejected 状态呈现
  const settledResults = await Promise.allSettled(
    activeServers.map(async (serverEntry) => {
      const mcpTools = await listMcpTools(serverEntry, config.mcpTimeoutMs);
      // 同一服务器的多个工具构建可同步进行，无需再并行
      return mcpTools.map((tool) => {
        const toolDef = buildMcpToolDefinition(serverEntry, tool, config.mcpTimeoutMs);
        return {
          name: toolDef.name,
          description: toolDef.description,
          parameters: toolDef.parameters,
          handler: async (args: unknown, ctx: RunContext) => toolDef.handler(args, ctx),
        };
      });
    }),
  );

  // 收集结果：fulfilled 合并 tools，rejected 转 errors
  // 为什么用 entries + index 而非直接 map：需要在 rejected 分支拿到对应 serverEntry 名字
  for (let i = 0; i < settledResults.length; i++) {
    const settled = settledResults[i];
    const serverEntry = activeServers[i];
    if (settled.status === 'fulfilled') {
      result.tools.push(...settled.value);
    } else {
      // MCP 连接失败：记录错误但继续收集其他服务器的结果
      result.errors.push({
        source: `mcp:${serverEntry.name}`,
        message: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
      });
    }
  }
  return result;
}

// 合并多个 LoadedTools 为单个结果。
// 提取为辅助函数避免 loadExtendedTools 内多次展开数组增加复杂度。
function mergeLoaded(...parts: LoadedTools[]): LoadedTools {
  const tools = parts.flatMap((p) => p.tools);
  const errors = parts.flatMap((p) => p.errors);
  return { tools, errors };
}

// 根据用户问题加载扩展工具。
// question: 用户原始问题
// config: 工具配置（可为 undefined，表示无扩展工具）
export async function loadExtendedTools(
  question: string,
  config: ToolsConfig | undefined,
): Promise<LoadedTools> {
  if (!config) return { tools: [], errors: [] };

  // 1. 场景路由：获取应启用的工具名列表
  const enabledToolNames = routeTools(question, config);
  if (enabledToolNames.length === 0) return { tools: [], errors: [] };

  // 2. 顺序加载 CLI 工具与 MCP 工具，保持原有加载顺序便于日志可读
  const cliResult = await loadCliTools(config, enabledToolNames);
  const mcpResult = await loadMcpTools(config, enabledToolNames);
  // 2.5 auto 模式懒加载：triggerKeywords 未命中但配置了 placeholderTools 的服务器注册占位工具
  const lazyPlaceholders = config.routerMode === 'auto'
    ? collectLazyPlaceholderTools(question, config, enabledToolNames)
    : [];
  return mergeLoaded(cliResult, mcpResult, { tools: lazyPlaceholders, errors: [] });
}

// 列出所有配置的扩展工具（供 /api/tools/list 路由调用，前端展示用）。
// 为什么不在此处连接 MCP 服务器发现工具：前端展示只需配置概览，实际工具发现在问答时懒加载。
// 如需展示 MCP 工具详情，前端可单独调用 /api/tools/discover?server=xxx 触发连接。
export function listConfiguredTools(config: ToolsConfig | undefined): {
  cliTools: Array<{ name: string; command: string; enabled: boolean }>;
  mcpServers: Array<{ name: string; transport: string; enabled: boolean }>;
  scenes: Array<{ name: string; keywords: string[]; tools: string[]; enabled: boolean }>;
} {
  if (!config) {
    return { cliTools: [], mcpServers: [], scenes: [] };
  }
  return {
    cliTools: config.cliTools.map((c: CliToolEntry) => ({
      name: c.name,
      command: c.command,
      enabled: c.enabled,
    })),
    mcpServers: config.mcpServers.map((s: McpServerEntry) => ({
      name: s.name,
      transport: s.transport,
      enabled: s.enabled,
    })),
    scenes: config.scenes.map((r) => ({
      name: r.name,
      keywords: r.keywords,
      tools: r.tools,
      enabled: r.enabled,
    })),
  };
}

// 关闭工具注册中心：断开所有 MCP 连接。
// 为什么需要：服务退出时需清理子进程，避免孤儿进程占用资源。
export async function shutdownToolRegistry(): Promise<void> {
  await disconnectAllMcpServers();
}

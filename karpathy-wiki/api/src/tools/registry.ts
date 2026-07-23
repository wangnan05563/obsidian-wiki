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
import { routeTools, isToolEnabled } from './scene-router.js';
import { listMcpTools, buildMcpToolDefinition, disconnectAllMcpServers } from './mcp-client.js';
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

// 加载启用的 MCP 服务器工具为 ToolDefinition 列表。
// 提取为独立函数降低 loadExtendedTools 认知复杂度（S3776）。
// 传递 config.mcpTimeoutMs 作为 RPC 超时默认值（per-server timeoutMs 优先）。
// 单个服务器连接失败仅记录错误不阻断其他服务器加载。
async function loadMcpTools(config: ToolsConfig, enabledToolNames: string[]): Promise<LoadedTools> {
  const result: LoadedTools = { tools: [], errors: [] };
  for (const serverEntry of config.mcpServers) {
    if (!serverEntry.enabled) continue;
    if (!isToolEnabled(`mcp__${serverEntry.name}`, enabledToolNames)) continue;
    try {
      const mcpTools = await listMcpTools(serverEntry, config.mcpTimeoutMs);
      for (const tool of mcpTools) {
        const toolDef = buildMcpToolDefinition(serverEntry, tool, config.mcpTimeoutMs);
        result.tools.push({
          name: toolDef.name,
          description: toolDef.description,
          parameters: toolDef.parameters,
          handler: async (args: unknown, ctx: RunContext) => toolDef.handler(args, ctx),
        });
      }
    } catch (err) {
      // MCP 连接失败：记录错误但继续加载其他服务器
      result.errors.push({
        source: `mcp:${serverEntry.name}`,
        message: err instanceof Error ? err.message : String(err),
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
  return mergeLoaded(cliResult, mcpResult);
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

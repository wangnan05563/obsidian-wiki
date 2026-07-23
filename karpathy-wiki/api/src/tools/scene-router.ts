// 场景路由器：根据用户问题文本决定启用哪些扩展工具。
// 两种模式：
// - keyword：关键词匹配。命中规则的场景，其 tools 列表被启用。未命中任何规则时不启用扩展工具。
// - auto：注入所有 enabled 的工具，让 LLM 自主决策使用哪个（依赖 LLM 的 function calling 能力）。
//
// 为什么需要场景路由：
// 1. 工具数量过多时 LLM 容易误选，关键词路由收窄候选集提升准确率
// 2. auto 模式适合工具数量少（<10）或 LLM 能力强的场景，keyword 适合工具多或需精确控制的场景

import type { ToolsConfig } from '../types.js';

// auto 模式：收集所有启用工具名。
// 提取为独立函数降低 routeTools 认知复杂度（S3776）。
// MCP 工具：服务器级别启用即注入其所有工具（具体工具列表由 mcp-client 发现），
// 此处只返回服务器名前缀，registry 在加载时展开为具体工具名。
// CLI 工具：enabled 即注入。
function collectAutoModeTools(config: ToolsConfig): string[] {
  const toolNames: string[] = [];
  for (const server of config.mcpServers) {
    if (server.enabled) {
      toolNames.push(`mcp__${server.name}`);
    }
  }
  for (const cli of config.cliTools) {
    if (cli.enabled) {
      toolNames.push(cli.name);
    }
  }
  return toolNames;
}

// 判断场景规则是否命中用户问题（任一关键词命中即视为命中，OR 语义）。
// 提取为独立函数降低 routeTools 认知复杂度（S3776）。
// 为什么用 includes 而非正则：关键词含特殊字符时正则需转义，includes 更安全且语义清晰。
function isSceneHit(question: string, rule: { enabled: boolean; keywords: string[] }): boolean {
  if (!rule.enabled) return false;
  const lowerQuestion = question.toLowerCase();
  return rule.keywords.some((kw) => lowerQuestion.includes(kw.toLowerCase()));
}

// keyword 模式：遍历启用的场景规则，关键词命中则收集其工具列表。
// 提取为独立函数降低 routeTools 认知复杂度（S3776）。
function collectKeywordModeTools(question: string, config: ToolsConfig): string[] {
  const matchedTools = new Set<string>();
  for (const rule of config.scenes) {
    if (isSceneHit(question, rule)) {
      for (const toolName of rule.tools) {
        matchedTools.add(toolName);
      }
    }
  }
  return Array.from(matchedTools);
}

// 返回应启用的工具名列表。
// 工具名格式：MCP 工具为 mcp__{server}__{tool}，CLI 工具为 entry.name。
// question: 用户原始问题文本
// config: 工具配置
export function routeTools(question: string, config: ToolsConfig | undefined): string[] {
  if (!config) return [];
  if (config.routerMode === 'auto') return collectAutoModeTools(config);
  return collectKeywordModeTools(question, config);
}

// 判断指定工具名是否被路由结果启用。
// 为什么需要此函数：registry 拿到 routeTools 的列表后需逐个判断是否加载。
export function isToolEnabled(toolName: string, enabledList: string[]): boolean {
  // MCP 工具名格式 mcp__{server}__{tool}，路由返回的是 mcp__{server} 前缀
  // 需要前缀匹配：mcp__server__foo 被 mcp__server 启用
  if (toolName.startsWith('mcp__')) {
    const prefix = toolName.split('__').slice(0, 2).join('__');
    return enabledList.some((name) => name === prefix || name === toolName);
  }
  return enabledList.includes(toolName);
}

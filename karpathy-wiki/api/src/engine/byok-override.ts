// BYOK per-user 配置覆盖（纯函数，运行时零依赖，便于单测）。
//
// 将请求携带的"按用户隔离配置"覆盖到服务端共享配置之上：
//   - LLM：provider/baseUrl/model/apiKey 整体覆盖 harnessConfig.llm（保留服务端无关的 apiKeyRef/apiKeys）。
//   - 联网搜索：用户带 apiKey 时以其覆盖服务端 webSearchConfig（合并 apiKeyRef），
//     否则回退服务端配置（搜索为附加能力，不强制用户配置）。
//   - 工具集：用户维度整体替换服务端共享 MCP/CLI，落实"各用户调用自己配置"的隔离要求。
//
// 密钥（apiKey）仅存在于此次请求计算出的返回值，本函数不读写任何存储、不持久化。
// 仅含 type-only import，编译后无运行时依赖，可被单元测试直接引入而无需加载 harness/工作流。

import type { HarnessConfig } from '@wiki/harness';
import type { QueryInput, WebSearchConfig, ToolsConfig } from '../types.js';

export interface PerRequestOverride {
  llmConfig?: QueryInput['llmConfig'];
  searchConfig?: QueryInput['searchConfig'];
  toolsConfig?: ToolsConfig;
}

export function applyPerRequestOverride(
  harnessConfig: HarnessConfig,
  webSearchConfig: WebSearchConfig | undefined,
  toolsConfig: ToolsConfig | undefined,
  override: PerRequestOverride,
): { harnessConfig: HarnessConfig; webSearchConfig: WebSearchConfig | undefined; toolsConfig: ToolsConfig | undefined } {
  // 1) LLM：provider/baseUrl/model/apiKey 整体覆盖（保留服务端 apiKeyRef/apiKeys 等无关字段）
  const effectiveHarness: HarnessConfig = override.llmConfig
    ? { ...harnessConfig, llm: { ...harnessConfig.llm, ...override.llmConfig } }
    : harnessConfig;

  // 2) 联网搜索：用户带 apiKey 时以其覆盖（合并服务端 apiKeyRef 等），否则回退服务端配置
  let effectiveWebSearch: WebSearchConfig | undefined = webSearchConfig;
  if (override.searchConfig?.apiKey) {
    effectiveWebSearch = {
      provider: override.searchConfig.provider,
      apiKeyRef: webSearchConfig?.apiKeyRef ?? '',
      apiKey: override.searchConfig.apiKey,
      maxResults: override.searchConfig.maxResults ?? webSearchConfig?.maxResults,
    };
  }

  // 3) 工具集：用户维度整体替换（始终按用户隔离，不沿用服务端共享 MCP/CLI）
  // 但空工具配置（未配置任何 MCP/CLI/场景）视为"未提供覆盖"，回退服务端共享配置，
  // 避免未配置工具的用户被空对象清空既有工具能力（与前端"仅下发非空工具配置"双保险）。
  const userTools = override.toolsConfig;
  const hasOwnTools = !!userTools &&
    ((userTools.mcpServers?.length ?? 0) > 0 ||
      (userTools.cliTools?.length ?? 0) > 0 ||
      (userTools.scenes?.length ?? 0) > 0);
  const effectiveTools: ToolsConfig | undefined = hasOwnTools ? userTools : toolsConfig;

  return { harnessConfig: effectiveHarness, webSearchConfig: effectiveWebSearch, toolsConfig: effectiveTools };
}

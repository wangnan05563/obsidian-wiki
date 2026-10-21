// T02802：MCP 配置「表单 ↔ Claude Desktop JSON」双模式的合并口径。
// ------------------------------------------------------------------
// 为什么抽出来：JSON 模式把 stdio 条目按 name 重建，而 Claude Desktop 格式的 JSON 里
// 没有 timeoutMs / triggerKeywords / placeholderTools 这几个键；不显式带回来，一次 JSON 往返
// 就把后端的懒加载配置静默清空，而配置保存是整份回传（丢的是数据，不只是显示）。
// 这段逻辑原先埋在 Config.vue 的 setup 里，无法单独验证，故抽出成纯函数。
import type { McpServerEntry } from '../types';

/** Claude Desktop 兼容格式里单个 server 的形状（只承认这三个键） */
export interface McpJsonServer {
  command?: string;
  /** args 保持 unknown：JSON 里可能是字符串等脏形状，合并时按数组校验后归一 */
  args?: unknown;
  env?: Record<string, string>;
}

export interface McpJsonFile {
  mcpServers?: Record<string, McpJsonServer>;
}

export interface McpMergeResult {
  servers: McpServerEntry[];
  /** 空串表示成功；非空是给 UI 的错误文案 */
  error: string;
}

/**
 * 合并策略（与 Config.vue 的 JSON 编辑模式口径一致）：
 *  1. 非 stdio（sse/http）条目原样保留——JSON 模式不编辑这些类型；
 *  2. stdio 条目以 JSON 为权威源重建：JSON 里没有的同名 stdio 视为已删除；
 *  3. 重建时按 name 从旧条目带回 JSON 格式里不存在的那三个键；
 *  4. JSON 里的名字若撞上现存非 stdio 条目，报错并原样返回（不静默删远程服务器）。
 */
export function mergeMcpJsonIntoServers(existing: McpServerEntry[], parsed: McpJsonFile): McpMergeResult {
  const servers = existing.filter((s) => s.transport !== 'stdio');
  const remoteNames = new Set(servers.map((s) => s.name));
  const previousByName = new Map(existing.map((s) => [s.name, s]));
  for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
    if (!cfg?.command) {
      return { servers: existing, error: `服务器 "${name}" 缺少 command 字段` };
    }
    // JSON 格式表达不了 sse/http，同名只会是误写：报错并保持原配置，比悄悄删掉远程服务器安全
    if (remoteNames.has(name)) {
      return { servers: existing, error: `服务器 "${name}" 已存在（非 stdio 类型），JSON 模式无法编辑` };
    }
    const previous = previousByName.get(name);
    servers.push({
      ...(previous?.timeoutMs !== undefined ? { timeoutMs: previous.timeoutMs } : {}),
      ...(previous?.triggerKeywords ? { triggerKeywords: previous.triggerKeywords } : {}),
      ...(previous?.placeholderTools ? { placeholderTools: previous.placeholderTools } : {}),
      name,
      transport: 'stdio',
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
      enabled: true,
    });
  }
  return { servers, error: '' };
}

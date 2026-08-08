// 按用户维度隔离的配置存储层（AI 服务 / 搜索引擎 / 工具配置）。
//
// 设计动机（需求：AI 服务配置、搜索引擎配置、工具配置应按用户隔离，每个用户拥有单独配置，
// 改为合适的持久化存储，软件升级或重装不会影响持久化信息）：
//   - 不同用户在同一浏览器登录时，各自的 AI/搜索/工具配置（含 API Key）必须互不干扰、互不可见。
//   - 复用 chatDb 的 preferences 仓库（keyPath='key'，不加密——属个人配置，不回传服务端），
//     键名内嵌 userId 形成 per-user 命名空间：'usercfg::<kind>::<userId>'。
//   - 应用层只读取"当前登录用户"的命名空间，天然实现隔离：用户 A 永远读不到
//     'usercfg::ai::<用户B>' 的记录。
//   - 该仓库位于客户端浏览器（IndexedDB），后端重部署 / 升级 / 重装均不影响用户本地配置。
//
// 为什么存客户端而不是服务端共享 config.json：
//   - 用户各自持有自己的 API Key（BYOK 模式），密钥仅存自己浏览器，不落服务端磁盘，
//     规避服务端共享密钥导致的"全员共用同一额度 / 互相限流"问题；
//   - 每个用户调用自己配置好的 API，真正按用户隔离额度与限流。
//
// 注意：本层是纯客户端存储，不回传服务端（与项目"个人配置仅存本地"约定一致）。

import { dbGet, dbPut, CHAT_STORES } from './chatDb';
import type { ToolsConfig } from '../types';

export type UserConfigKind = 'ai' | 'search' | 'tools' | 'inputbox';

// ── 各配置域的字段形状（与后端 AppConfig.llm / WebSearchConfig / ToolsConfig 对齐）──

// AI 服务（LLM）配置：直接对应后端 harnessConfig.llm 的运行时字段。
// apiKey 为明文用户密钥（BYOK），仅存客户端、随每次请求作为覆盖项发给后端，后端不持久化。
export interface AiUserConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

// 搜索引擎配置：对应后端 WebSearchConfig（provider/apiKey/maxResults）。
export interface SearchUserConfig {
  provider: 'tavily' | 'bing';
  apiKey: string;
  maxResults?: number;
}

// 工具配置：复用前端 ToolsConfig 类型（MCP 服务器 / CLI 工具 / 场景路由 / 路由器模式）。

// ── 默认值（首次进入配置页或未配置时的占位）──
export const DEFAULT_AI_USER_CONFIG: AiUserConfig = {
  provider: 'glm',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: '',
  apiKey: '',
};

export const DEFAULT_SEARCH_USER_CONFIG: SearchUserConfig = {
  provider: 'tavily',
  apiKey: '',
  maxResults: 5,
};

export const DEFAULT_TOOLS_USER_CONFIG: ToolsConfig = {
  mcpServers: [],
  cliTools: [],
  scenes: [],
  routerMode: 'keyword',
};

// ── 消息输入框个人偏好（按用户隔离）──
// 每个用户拥有独立、私有的输入框相关设置，按 userId 命名空间隔离存储与读取：
//   - fontSize：输入框字体大小（px，建议 12–22）
//   - inputTheme：输入框主题（default / sepia 暖色 / midnight 暗色）
//   - quickReplies：快捷回复预设（点击直接填入输入框）
//   - historyPreference：历史记录偏好（send=新会话首问携带本地历史；rely=依赖服务端线程记忆）
//   - enterSends：回车发送（true=Enter 发送 / Shift+Enter 换行；false=Ctrl+Enter 发送）
//   - compact：紧凑模式（缩小内边距与行高）
// 这些偏好与 AI/搜索/工具配置同层，均存本地 IndexedDB、不回传服务端、按用户互不干扰。
export interface InputBoxSettings {
  fontSize: number;
  inputTheme: 'default' | 'sepia' | 'midnight';
  quickReplies: string[];
  historyPreference: 'send' | 'rely';
  enterSends: boolean;
  compact: boolean;
}

export const DEFAULT_INPUT_BOX_SETTINGS: InputBoxSettings = {
  fontSize: 14,
  inputTheme: 'default',
  quickReplies: [],
  historyPreference: 'send',
  enterSends: false,
  compact: false,
};

export function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

// per-user 键名：不同 userId / 不同 kind 映射到不同的 preferences 记录，实现双重隔离。
function userConfigKey(kind: UserConfigKind, userId: string): string {
  return `usercfg::${kind}::${userId}`;
}

// 读取指定用户的某类配置；用户无记录或读取失败时回退默认值（深拷贝，避免共享可变默认对象）。
export async function loadUserConfig<T>(
  userId: string,
  kind: UserConfigKind,
  defaults: T,
): Promise<T> {
  if (!userId) return clone(defaults);
  try {
    const rec = await dbGet<Record<string, unknown>>(
      CHAT_STORES.preferences,
      userConfigKey(kind, userId),
    );
    if (!rec) return clone(defaults);
    // 剥离索引主键 key，其余字段覆盖默认值（嵌套对象/数组整体替换）。
    const { key: _key, ...rest } = rec;
    void _key;
    return { ...clone(defaults), ...(rest as Partial<T>) };
  } catch {
    // IndexedDB 不可用时静默降级为默认配置，不阻断功能
    return clone(defaults);
  }
}

// 写入指定用户的某类配置（覆盖式：key 唯一，dbPut 即更新）。
// 关键：写入前对 cfg 做深拷贝剥离响应式代理——配置可能来自 Pinia 等响应式来源（如输入框偏好 store），
// 其嵌套数组/对象（如 quickReplies、mcpServers）仍是 Vue reactive 代理，直接交给 IndexedDB 的
// 结构化克隆会抛 "[object Array] could not be cloned"。深拷贝为纯对象后再落盘，确保任意来源都能持久化。
export async function saveUserConfig<T>(
  userId: string,
  kind: UserConfigKind,
  cfg: T,
): Promise<void> {
  if (!userId) return;
  try {
    const plain = clone(cfg);
    await dbPut(CHAT_STORES.preferences, { key: userConfigKey(kind, userId), ...plain });
  } catch (e) {
    // 写入失败（如隐私模式禁用 IndexedDB）时降级为不持久化，但记录告警以便排查，
    // 不抛出以免阻断输入（与 ai/search/tools 配置一致的静默降级策略）。
    console.warn('[userConfig] 保存用户配置失败（输入框偏好可能未持久化）:', (e as Error)?.message ?? e);
  }
}

// ── 类型化门面（业务层按需引用，避免散落字符串 kind）──
export const loadAiUserConfig = (userId: string) =>
  loadUserConfig<AiUserConfig>(userId, 'ai', DEFAULT_AI_USER_CONFIG);
export const saveAiUserConfig = (userId: string, cfg: AiUserConfig) =>
  saveUserConfig(userId, 'ai', cfg);

export const loadSearchUserConfig = (userId: string) =>
  loadUserConfig<SearchUserConfig>(userId, 'search', DEFAULT_SEARCH_USER_CONFIG);
export const saveSearchUserConfig = (userId: string, cfg: SearchUserConfig) =>
  saveUserConfig(userId, 'search', cfg);

export const loadToolsUserConfig = (userId: string) =>
  loadUserConfig<ToolsConfig>(userId, 'tools', DEFAULT_TOOLS_USER_CONFIG);
export const saveToolsUserConfig = (userId: string, cfg: ToolsConfig) =>
  saveUserConfig(userId, 'tools', cfg);

// 输入框个人偏好（按用户隔离）：与 AI/搜索/工具配置同层，复用 per-user 命名空间
export const loadInputBoxSettings = (userId: string) =>
  loadUserConfig<InputBoxSettings>(userId, 'inputbox', DEFAULT_INPUT_BOX_SETTINGS);
export const saveInputBoxSettings = (userId: string, cfg: InputBoxSettings) =>
  saveUserConfig(userId, 'inputbox', cfg);

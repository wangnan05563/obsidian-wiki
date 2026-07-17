import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './types.js';

// 配置文件名。路径解析见 getConfigPath()
const CONFIG_FILENAME = 'config.json';

// 通过 import.meta.url 获取 api 源码目录，与 CWD 解耦
// 为什么需要：开发模式 CWD 可能是项目根（pnpm --filter），打包模式 CWD 可能是 exe 同级目录，
// 两者读取的 config.json 不同，导致配置"丢失"假象。统一以源码定位 api/config.json 作为权威路径
const API_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_CONFIG_PATH = path.resolve(API_SRC_DIR, '..', CONFIG_FILENAME);

// 默认配置（NPR-05-7 默认值清单）。
// vaultPath 默认 '../data/vault'（相对 api，指向 karpathy-wiki/data/vault），
// 将运行时数据与源码分离；host 'localhost'，port 3000。
function defaultConfig(): AppConfig {
  return {
    vaultPath: '../data/vault',
    adapter: 'harness',
    llm: {
      provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-plus',
      apiKeyRef: 'GLM_KEY',
    },
    budget: { maxSteps: 20, tokenBudget: 50000 },
    server: { host: 'localhost', port: 3000 },
    localOnly: false,
    healthCheck: { staleDays: 30 },
    tunnel: {
      provider: 'cloudflare',
      localPort: 0,
      cpolarAuthtoken: '',
      binaryPath: '',
      autoStart: false,
      // Named Tunnel 默认 quick 模式（开箱即用），named 需三步向导配置后自动切换
      tunnelMode: 'quick',
      tunnelName: '',
      tunnelId: '',
      credentialsFile: '',
      hostname: '',
      certFile: '',
    },
    // 默认启用 info 级日志 + 请求级日志钩子
    logging: {
      level: 'info',
      enableRequestLog: true,
    },
    // §5.2 联网搜索默认配置：tavily 作为默认 provider，apiKey 留空待用户填写
    // 为什么需要默认值：避免 config.json 缺失 webSearch 字段时 query workflow 走"未配置"分支
    webSearch: {
      provider: 'tavily',
      apiKeyRef: 'TAVILY_API_KEY',
      apiKey: '',
      maxResults: 5,
    },
  };
}

// 解析 config.json 实际路径，供 tunnel 路由等落盘复用。
// 查找顺序（与 CWD 解耦）：
//   1. exe 同级 config.json（pkg 打包模式：与 exe 同目录，便于用户编辑）
//   2. api/config.json（开发模式 + tsx 模式：源码目录下，所有启动方式读同一文件）
//   3. 找不到时返回 api/config.json 作为写入目标（保持向后兼容）
// 为什么这样设计：避免 CWD 切换导致读写不同文件，造成配置"丢失"假象
export function getConfigPath(): string | null {
  const candidates: string[] = [];

  // pkg 打包模式：process.pkg 存在时，配置文件与 exe 同级
  const isPackaged = !!(process as NodeJS.Process & { pkg?: unknown }).pkg;
  if (isPackaged) {
    candidates.push(path.resolve(process.cwd(), CONFIG_FILENAME));
  }

  // 开发模式权威路径：api/config.json（基于 import.meta.url 定位）
  candidates.push(API_CONFIG_PATH);

  for (const p of candidates) {
    try {
      fsSync.accessSync(p);
      return p;
    } catch {
      // 尝试下一个候选路径
    }
  }
  // 候选路径都不存在时，返回 api/config.json 作为写入目标（创建新配置文件）
  return API_CONFIG_PATH;
}

// 简单的内存缓存
interface ConfigCache {
  data: AppConfig | null;
  path: string | null;
  loadedAt: number;
}

const configCache: ConfigCache = { data: null, path: null, loadedAt: 0 };
const CONFIG_CACHE_TTL_MS = 30 * 1000; // 30秒缓存

// 从 config.json 加载配置，合并默认值。
// apiKeyRef 仅存环境变量名，API Key 在使用方通过 process.env[apiKeyRef] 读取（M-7）。
export async function loadConfig(): Promise<AppConfig> {
  const now = Date.now();
  // 先获取当前路径，用于缓存有效性校验
  const currentPath = getConfigPath();
  // 检查缓存是否有效：路径必须一致 + TTL 未过期
  if (configCache.data && configCache.path === currentPath && (now - configCache.loadedAt) < CONFIG_CACHE_TTL_MS) {
    return configCache.data;
  }

  const defaults = defaultConfig();
  if (!currentPath) {
    configCache.data = defaults;
    configCache.path = currentPath;
    configCache.loadedAt = now;
    return defaults;
  }

  let raw: string;
  try {
    raw = await fs.readFile(currentPath, 'utf8');
  } catch {
    configCache.data = defaults;
    configCache.path = currentPath;
    configCache.loadedAt = now;
    return defaults;
  }

  let parsed: Partial<AppConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<AppConfig>;
  } catch {
    configCache.data = defaults;
    configCache.path = currentPath;
    configCache.loadedAt = now;
    return defaults;
  }

  // 浅合并嵌套对象，避免下层数据丢失
  const merged = {
    ...defaults,
    ...parsed,
    llm: { ...defaults.llm, ...parsed.llm },
    budget: { ...defaults.budget, ...parsed.budget },
    server: { ...defaults.server, ...parsed.server },
    healthCheck: { ...defaults.healthCheck, ...parsed.healthCheck },
    tunnel: { ...defaults.tunnel, ...parsed.tunnel },
    // 为什么用条件合并而非展开：parsed.logging 是可选的，展开后 level 会变成 string | undefined
    logging: parsed.logging
      ? { ...defaults.logging, ...parsed.logging }
      : defaults.logging,
    // §5.2 webSearch 合并：parsed.webSearch 可选，未配置时用默认值（含空 apiKey）
    webSearch: parsed.webSearch
      ? { ...defaults.webSearch!, ...parsed.webSearch }
      : defaults.webSearch,
  };

  // 写入缓存
  configCache.data = merged;
  configCache.path = currentPath;
  configCache.loadedAt = now;
  return merged;
}

// §12.3-7 配置热加载：重新读取 config.json 并返回新配置。
// 热加载作用域：llm.model/budget/healthCheck.staleDays 可即时生效（运行时参数）。
// 需重启生效项：adapter/vaultPath/server（涉及实例重建或端口绑定）。
// 调用方需自行判断哪些字段可热更新。
export async function reloadConfig(): Promise<AppConfig> {
  return loadConfig();
}

// 写盘后刷新内存缓存，避免 30s TTL 内读到旧值。
// 为什么需要：saveAiConfig/resetAiConfig/saveWebSearchConfig 写盘后若不刷新缓存，
// 紧接着的 GET /api/ai/config 会命中缓存返回旧值，用户看到"保存未生效"假象。
function refreshConfigCache(data: AppConfig): void {
  configCache.data = data;
  configCache.path = getConfigPath();
  configCache.loadedAt = Date.now();
}

// 保存 AI 配置到 config.json（部分更新，仅合并 llm 字段）。
// 为什么需要：前端 AI 服务配置页面需要持久化用户输入的 provider/baseUrl/model/apiKey。
// 安全考量：apiKey 以明文写入 config.json，需确保 .gitignore 排除了 config.json（M-7）。
export async function saveAiConfig(updates: {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): Promise<AppConfig> {
  const current = await loadConfig();
  const merged: AppConfig = {
    ...current,
    llm: {
      ...current.llm,
      ...updates.provider ? { provider: updates.provider } : {},
      ...updates.baseUrl ? { baseUrl: updates.baseUrl } : {},
      ...updates.model ? { model: updates.model } : {},
      // apiKey 空串表示清除，undefined 表示不修改
      ...(updates.apiKey !== undefined) ? { apiKey: updates.apiKey } : {},
    },
  };

  const configPath = getConfigPath();
  if (configPath) {
    const json = JSON.stringify(merged, null, 2);
    await fs.writeFile(configPath, json, 'utf8');
  }

  // 写盘后立即刷新缓存，避免后续 GET 命中旧缓存
  refreshConfigCache(merged);
  return merged;
}

// 读取生效的 API Key：优先 config.json 中的 apiKey，其次环境变量 apiKeyRef。
// 为什么需要：支持前端配置 API Key 的同时保持环境变量向后兼容。
export function getEffectiveApiKey(config: AppConfig): string {
  if (config.llm.apiKey) {
    return config.llm.apiKey;
  }
  return process.env[config.llm.apiKeyRef] ?? '';
}

// API Key 脱敏：仅保留末 4 位，前缀 ****。
// 为什么需要：GET 接口返回配置时不能暴露完整 Key，但需让用户确认 Key 已设置。
export function maskApiKey(key: string): string {
  if (!key || key.length < 4) {
    return key ? '****' : '';
  }
  return '****' + key.slice(-4);
}

// 恢复 LLM 配置到出厂默认值（defaultConfig 中的 llm 字段）。
// 为什么需要：用户误改配置后可一键恢复，避免手动编辑 config.json。
// 仅重置 llm 字段，其他配置（vaultPath/budget/tunnel/webSearch/logging）保持不变。
export async function resetAiConfig(): Promise<AppConfig> {
  const current = await loadConfig();
  const defaults = defaultConfig();
  const merged: AppConfig = {
    ...current,
    llm: { ...defaults.llm },
  };

  const configPath = getConfigPath();
  if (configPath) {
    const json = JSON.stringify(merged, null, 2);
    await fs.writeFile(configPath, json, 'utf8');
  }

  refreshConfigCache(merged);
  return merged;
}

// §5.2 保存联网搜索配置到 config.json（部分更新）。
// 为什么独立函数：webSearch 与 LLM 配置生命周期不同，用户可能单独启用/禁用联网搜索。
// apiKey 处理与 saveAiConfig 一致：**** 开头视为未修改，空串表示清除。
export async function saveWebSearchConfig(updates: {
  provider?: 'tavily' | 'bing';
  apiKey?: string;
  maxResults?: number;
}): Promise<AppConfig> {
  const current = await loadConfig();
  const baseWebSearch = current.webSearch ?? {
    provider: 'tavily' as const,
    apiKeyRef: 'TAVILY_API_KEY',
    apiKey: '',
    maxResults: 5,
  };

  const merged: AppConfig = {
    ...current,
    webSearch: {
      ...baseWebSearch,
      ...updates.provider ? { provider: updates.provider } : {},
      ...updates.maxResults ? { maxResults: updates.maxResults } : {},
      // apiKey 以 **** 开头视为脱敏回传，不修改
      ...(updates.apiKey !== undefined && !updates.apiKey.startsWith('****'))
        ? { apiKey: updates.apiKey }
        : {},
    },
  };

  const configPath = getConfigPath();
  if (configPath) {
    const json = JSON.stringify(merged, null, 2);
    await fs.writeFile(configPath, json, 'utf8');
  }

  refreshConfigCache(merged);
  return merged;
}

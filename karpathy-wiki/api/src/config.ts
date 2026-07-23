import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, ToolsConfig, QqConfig } from './types.js';

// 配置文件名。路径解析见 getConfigPath()
const CONFIG_FILENAME = 'config.json';

// batch 字段合并兜底：与 defaultConfig().batch 保持一致
// 为什么需要：AppConfig.batch 是可选字段，TS 推断 defaults.batch 为 T | undefined，
// 用 ?? 提供兜底避免 ! 断言（BR-028-1）
const DEFAULT_BATCH_FALLBACK = {
  allowedExtensions: ['md', 'txt', 'pdf', 'html', 'json'],
  maxBatchSize: 50,
  maxFileSizeMb: 10,
};

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
    // 批量编译默认配置：文件夹上传场景使用
    // allowedExtensions 与前端 Ingest.vue accept 保持一致，避免前后端白名单漂移
    batch: {
      allowedExtensions: ['md', 'txt', 'pdf', 'html', 'json'],
      maxBatchSize: 50,
      maxFileSizeMb: 10,
    },
    // RBAC 权限管理默认配置
    // 为什么 enabled 默认 true：生产环境必须启用权限控制
    // sessionTtlHours 默认 24：与常见 Web 应用一致
    // permissionCacheTtlSec 默认 300：5 分钟缓存，角色变更后最长 5 分钟生效
    // sessionSecretRef 默认 WIKI_SESSION_SECRET：与 llm.apiKeyRef 一致的引用模式
    auth: {
      enabled: true,
      sessionTtlHours: 24,
      permissionCacheTtlSec: 300,
      auditLogPath: '../data/audit.log',
      usersFilePath: '../data/users.json',
      pbkdf2Iterations: 100000,
      sessionSecretRef: 'WIKI_SESSION_SECRET',
    },
    // QQ 聊天记录导入子系统默认配置（SRS §6.2）
    // 为什么需要默认值：避免 config.json 缺失 qq 字段时 qq-ingest 路由走"未配置"分支
    // noise_rules 默认全开：NR-1~NR-6 覆盖常见噪声（表情包/单字/纯图/系统消息/红包/打卡）
    // privacy_patterns 默认覆盖 5 类 PII：phone/id_card/email/card/qq，遵循 Presidio 双向脱敏范式
    // max_batch_size 默认 20：与 batch.maxBatchSize 50 解耦，抽取任务更重，单批更小
    // chunk_threshold 默认 200：单块消息数上限，超过则按时间窗口切分（SRS §5.2.1a）
    // extract_model 默认 glm-4-plus：与主 llm.model 一致，可按需切换为更强模型
    // extract_token_budget 默认 50000：与 budget.tokenBudget 解耦，独立成本核算
    qq: {
      noise_rules: {
        'NR-1': true,
        'NR-2': true,
        'NR-3': true,
        'NR-4': true,
        'NR-5': true,
        'NR-6': true,
      },
      privacy_patterns: {
        phone: String.raw`1[3-9]\d{9}`,
        id_card: String.raw`\d{17}[\dXx]`,
        email: String.raw`[\w.-]+@[\w.-]+\.\w+`,
        card: String.raw`\d{16,19}`,
        qq: String.raw`(?<=QQ|扣扣|qq号|企鹅)\s*[0-9]{5,11}`,
      },
      max_batch_size: 20,
      chunk_threshold: 200,
      extract_model: 'glm-4-plus',
      // extract_base_url 默认空串：未配置时由 extract 路由回退至 llm.baseUrl（SRS §6.2）
      // 为什么不直接复制 llm.baseUrl：defaultConfig 在模块加载时执行，此时 llm.baseUrl 可能被用户覆盖，
      // 用空串作为"未配置"哨兵，运行时显式回退逻辑更清晰
      extract_base_url: '',
      extract_token_budget: 50000,
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
    // 为什么用 ?? 而非 !：避免可选字段被 undefined 覆盖（BR-028-1）
    webSearch: parsed.webSearch
      ? { ...defaults.webSearch, ...parsed.webSearch }
      : defaults.webSearch,
    // 批量编译配置合并：parsed.batch 可选，未配置时用默认值
    // 为什么用 ?? 而非 !：避免可选字段被 undefined 覆盖（BR-028-1）
    batch: parsed.batch
      ? { ...(defaults.batch ?? DEFAULT_BATCH_FALLBACK), ...parsed.batch }
      : defaults.batch,
    // RBAC auth 配置合并：parsed.auth 可选，未配置时用默认值
    // 为什么独立合并：auth 是嵌套对象，浅合并会丢失下层字段
    auth: parsed.auth
      ? { ...defaults.auth, ...parsed.auth }
      : defaults.auth,
    // QQ 导入子系统配置合并：parsed.qq 可选，未配置时用默认值
    // 为什么独立合并：qq 是嵌套对象（noise_rules/privacy_patterns），浅合并会丢失下层字段
    // 为什么用条件合并而非展开：parsed.qq.noise_rules 可能部分启用，需保留默认全开基础上覆盖
    qq: parsed.qq
      ? {
          ...defaults.qq,
          ...parsed.qq,
          noise_rules: { ...defaults.qq?.noise_rules, ...parsed.qq.noise_rules },
          privacy_patterns: { ...defaults.qq?.privacy_patterns, ...parsed.qq.privacy_patterns },
        }
      : defaults.qq,
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
      ...(updates.apiKey === undefined) ? {} : { apiKey: updates.apiKey },
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

// ===== 运行参数/健康检查/批量编译/日志 配置保存函数 =====
// 这些函数为前端 Config.vue 提供编辑入口，落盘后由调用方（路由层）同步 adapter 运行时实例。
// 为什么独立函数：与 LLM/webSearch 生命周期不同，且字段结构差异大，统一函数会增加类型复杂度。

// 保存运行参数（maxSteps/tokenBudget）到 config.json。
// 为什么需要：用户需要根据知识库规模调整 token 预算与步数上限，无需手动编辑 config.json。
export async function saveBudgetConfig(updates: {
  maxSteps?: number;
  tokenBudget?: number;
}): Promise<AppConfig> {
  const current = await loadConfig();
  const merged: AppConfig = {
    ...current,
    budget: {
      ...current.budget,
      ...updates.maxSteps === undefined ? {} : { maxSteps: updates.maxSteps },
      ...updates.tokenBudget === undefined ? {} : { tokenBudget: updates.tokenBudget },
    },
  };

  const configPath = getConfigPath();
  if (configPath) {
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf8');
  }
  refreshConfigCache(merged);
  return merged;
}

// 保存健康检查配置（staleDays）到 config.json。
// 为什么需要：用户需要根据知识库更新频率调整"过期页面"判定阈值。
export async function saveHealthCheckConfig(updates: {
  staleDays?: number;
}): Promise<AppConfig> {
  const current = await loadConfig();
  const merged: AppConfig = {
    ...current,
    healthCheck: {
      ...current.healthCheck,
      ...updates.staleDays === undefined ? {} : { staleDays: updates.staleDays },
    },
  };

  const configPath = getConfigPath();
  if (configPath) {
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf8');
  }
  refreshConfigCache(merged);
  return merged;
}

// 保存批量编译配置（allowedExtensions/maxBatchSize/maxFileSizeMb）到 config.json。
// 为什么需要：不同业务场景下文件类型与大小限制不同，用户需在前端调整。
export async function saveBatchConfig(updates: {
  allowedExtensions?: string[];
  maxBatchSize?: number;
  maxFileSizeMb?: number;
}): Promise<AppConfig> {
  const current = await loadConfig();
  const baseBatch = current.batch ?? {
    allowedExtensions: ['md', 'txt', 'pdf', 'html', 'json'],
    maxBatchSize: 50,
    maxFileSizeMb: 10,
  };
  const merged: AppConfig = {
    ...current,
    batch: {
      ...baseBatch,
      ...updates.allowedExtensions ? { allowedExtensions: updates.allowedExtensions } : {},
      ...updates.maxBatchSize === undefined ? {} : { maxBatchSize: updates.maxBatchSize },
      ...updates.maxFileSizeMb === undefined ? {} : { maxFileSizeMb: updates.maxFileSizeMb },
    },
  };

  const configPath = getConfigPath();
  if (configPath) {
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf8');
  }
  refreshConfigCache(merged);
  return merged;
}

// 保存日志配置（level/enableRequestLog）到 config.json。
// 为什么需要：调试时需要切换 debug 级别或开关请求级日志，重启服务才生效太繁琐。
// 注意：level 变更需重启 Fastify 实例才能完全生效（pino logger 在启动时创建），
//   但 enableRequestLog 可热更新（路由钩子运行时读取）。
export async function saveLoggingConfig(updates: {
  level?: string;
  enableRequestLog?: boolean;
}): Promise<AppConfig> {
  const current = await loadConfig();
  const baseLogging = current.logging ?? {
    level: 'info',
    enableRequestLog: true,
  };
  const merged: AppConfig = {
    ...current,
    logging: {
      ...baseLogging,
      ...updates.level === undefined ? {} : { level: updates.level },
      ...updates.enableRequestLog === undefined ? {} : { enableRequestLog: updates.enableRequestLog },
    },
  };

  const configPath = getConfigPath();
  if (configPath) {
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf8');
  }
  refreshConfigCache(merged);
  return merged;
}

// 保存工具配置（MCP/CLI/场景路由）到 config.json。
// 为什么需要：前端工具配置页面需持久化用户配置的 MCP 服务器、CLI 工具、场景规则。
// 安全考量：CLI 工具的 command 在执行时由 cli-executor 白名单校验，此处仅持久化原始配置。
export async function saveToolsConfig(updates: {
  mcpServers?: ToolsConfig['mcpServers'];
  cliTools?: ToolsConfig['cliTools'];
  scenes?: ToolsConfig['scenes'];
  routerMode?: ToolsConfig['routerMode'];
  mcpTimeoutMs?: ToolsConfig['mcpTimeoutMs'];
}): Promise<AppConfig> {
  const current = await loadConfig();
  const baseTools = current.tools ?? {
    mcpServers: [],
    cliTools: [],
    scenes: [],
    routerMode: 'auto' as const,
    mcpTimeoutMs: 30000,
  };
  const merged: AppConfig = {
    ...current,
    tools: {
      ...baseTools,
      ...updates.mcpServers === undefined ? {} : { mcpServers: updates.mcpServers },
      ...updates.cliTools === undefined ? {} : { cliTools: updates.cliTools },
      ...updates.scenes === undefined ? {} : { scenes: updates.scenes },
      ...updates.routerMode === undefined ? {} : { routerMode: updates.routerMode },
      ...updates.mcpTimeoutMs === undefined ? {} : { mcpTimeoutMs: updates.mcpTimeoutMs },
    },
  };

  const configPath = getConfigPath();
  if (configPath) {
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf8');
  }
  refreshConfigCache(merged);
  return merged;
}

// 保存 QQ 导入子系统配置（noise_rules/privacy_patterns/max_batch_size/chunk_threshold/extract_model/extract_base_url/extract_token_budget）到 config.json。
// 为什么需要：前端配置页面需持久化用户调整的噪声规则开关、脱敏正则、批量上限等参数。
// 安全考量：privacy_patterns 是用户自定义正则，运行时由 qq-preprocess 编译，需在编译前做 try/catch 防止正则错误阻塞流水线。
// 注意：extract_token_budget 为 0 时视为"未设置"，由抽取路由回退至 budget.tokenBudget（SRS §6.2）。
// 注意：extract_base_url 为空串时视为"未配置"，由抽取路由回退至 llm.baseUrl（SRS §6.2 extract_model 独立调用决策）。
export async function saveQqConfig(updates: {
  noise_rules?: Record<string, boolean>;
  privacy_patterns?: Record<string, string>;
  max_batch_size?: number;
  chunk_threshold?: number;
  extract_model?: string;
  extract_base_url?: string;
  extract_token_budget?: number;
}): Promise<AppConfig> {
  const current = await loadConfig();
  const baseQq: QqConfig = current.qq ?? {
    noise_rules: {
      'NR-1': true,
      'NR-2': true,
      'NR-3': true,
      'NR-4': true,
      'NR-5': true,
      'NR-6': true,
    },
    privacy_patterns: {
      phone: String.raw`1[3-9]\d{9}`,
      id_card: String.raw`\d{17}[\dXx]`,
      email: String.raw`[\w.-]+@[\w.-]+\.\w+`,
      card: String.raw`\d{16,19}`,
      qq: String.raw`(?<=QQ|扣扣|qq号|企鹅)\s*[0-9]{5,11}`,
    },
    max_batch_size: 20,
    chunk_threshold: 200,
    extract_model: 'glm-4-plus',
    extract_base_url: '',
    extract_token_budget: 50000,
  };
  // 条件合并：仅更新显式提供的字段，未提供的字段保留原值
  // 为什么不用展开合并：noise_rules/privacy_patterns 是 Map 结构，展开会整体覆盖而非按键合并
  const merged: AppConfig = {
    ...current,
    qq: {
      ...baseQq,
      ...updates.noise_rules === undefined ? {} : { noise_rules: updates.noise_rules },
      ...updates.privacy_patterns === undefined ? {} : { privacy_patterns: updates.privacy_patterns },
      ...updates.max_batch_size === undefined ? {} : { max_batch_size: updates.max_batch_size },
      ...updates.chunk_threshold === undefined ? {} : { chunk_threshold: updates.chunk_threshold },
      ...updates.extract_model === undefined ? {} : { extract_model: updates.extract_model },
      ...updates.extract_base_url === undefined ? {} : { extract_base_url: updates.extract_base_url },
      ...updates.extract_token_budget === undefined ? {} : { extract_token_budget: updates.extract_token_budget },
    },
  };

  const configPath = getConfigPath();
  if (configPath) {
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf8');
  }
  refreshConfigCache(merged);
  return merged;
}

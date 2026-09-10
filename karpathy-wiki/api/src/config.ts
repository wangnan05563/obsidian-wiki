import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { AppConfig, ToolsConfig, QqConfig, UrlCrawlConfig, SkillPreset } from './types.js';
import { DEFAULT_CRAWL_CONFIG } from './utils/url-crawl.js';
import { DEFAULT_GOVERNOR_CONFIG } from './engine/context-governor.js';
import { DEFAULT_CLARIFY_CONFIG } from './workflows/clarify/clarify-types.js';
// 路径解析统一走 runtime.ts，兼容开发模式（api/config.json）与 SEA 模式（exe/config.json）
// 为什么移除 fileURLToPath + import.meta.url：SEA 模式下 __filename 指向构建时 bundle.cjs，
// 用户机器不存在，派生的 API_SRC_DIR 不可用，导致 config.json 加载失败
import { getUserDataPath, getUserDataDir, IS_SEA } from './utils/runtime.js';

// 配置文件名。路径解析见 getConfigPath()
const CONFIG_FILENAME = 'config.json';

// batch 字段合并兜底：与 defaultConfig().batch 保持一致
// 为什么需要：AppConfig.batch 是可选字段，TS 推断 defaults.batch 为 T | undefined，
// 用 ?? 提供兜底避免 ! 断言（BR-028-1）
const DEFAULT_BATCH_FALLBACK = {
  allowedExtensions: ['md', 'txt', 'pdf', 'html', 'json', 'docx', 'xlsx', 'pptx', 'doc', 'xls'],
  maxBatchSize: 50,
  maxFileSizeMb: 10,
};

// config.json 权威路径（开发模式：api/config.json，SEA 模式：%LOCALAPPDATA%/KarpathyWiki/config.json）
// 为什么用 getUserDataPath：SEA 模式把可写配置放到用户数据目录，避免写在 Program Files 无权限/被卸载清除
const API_CONFIG_PATH = getUserDataPath(CONFIG_FILENAME);

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
      // §真流式默认值：false 保持向后兼容，前端可在 Query 页面切换并发送 body.stream=true
      // 为什么不默认 true：避免老用户升级后行为突变（流式可能触发某些 LLM 的限流）
      stream: false,
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
      // Tailscale path prefix: /wiki/ for multi-app coexistence on same ts.net host.
      // Empty string = root path mode (legacy behavior).
      pathPrefix: '/wiki/',
      // Named Tunnel 默认 quick 模式（开箱即用），named 需三步向导配置后自动切换
      tunnelMode: 'quick',
      tunnelName: '',
      tunnelId: '',
      credentialsFile: '',
      hostname: '',
      certFile: '',
    },
    // 默认启用 info 级日志 + 请求级日志钩子
    // logFilePath 默认空串：未配置时不落盘，仅 stdout 输出；配置后双写 stdout + 文件
    logging: {
      level: 'info',
      enableRequestLog: true,
      logFilePath: '',
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
      allowedExtensions: ['md', 'txt', 'pdf', 'html', 'json', 'docx', 'xlsx', 'pptx', 'doc', 'xls'],
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
      // #5 默认 false：保持既有的读端点公开可读；置 true 即要求登录后才可浏览/下载知识库
      filesReadAuthRequired: false,
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
    // URL 爬取子系统默认配置（5.x 优化完整字段）
    // 为什么需要默认值：避免 config.json 缺失 urlCrawl 字段时 url-ingest 路由走"未配置"分支
    // maxHops 默认 3：需求约束"最多三次跳转"，0=入口页本身，3=第三跳可达
    // timeoutMs 默认 10000：与 qq-extract-workflow fetch 超时一致，防止网络挂起阻塞 SSE
    // maxPages 默认 50：单次爬取页面数上限，防止网站地图巨大时失控
    // userAgent 默认 KarpathyWikiBot/1.0：标识机器人身份，遵循爬虫规范
    // allowedAttachmentTypes 默认覆盖文档/图片/音视频常见格式，可按需扩展
    // 5.1.1 followRobotsTxt 默认 true：合规性要求
    // 5.1.2 concurrency 默认 1：串行模式，避免对目标站点压力过大
    // 5.2.1 excludeTemplateElements 默认 true：移除 header/footer/nav/aside 模板噪声
    // 5.2.2 renderJs 默认 false：Playwright 依赖较重，默认关闭
    // 5.2.3 contentAttachmentTypes：仅文档/音视频视为内容附件，装饰图片排除
    // 5.3.1 retryAttempts 默认 1：单次重试足以应对瞬时网络抖动
    // 5.2.5 enableAttachmentDedup 默认 true：跨页面同 URL 附件仅记录一次
    // 5.3.3 logging.enabled 默认 false：日志持久化默认关闭，按需开启
    // 5.3.4 connectTimeoutMs/readTimeoutMs 默认 0：回退到 timeoutMs
    // 5.5.3 copyrightNotice：版权声明默认文本
    // 5.4.3 preserveOnCancel 默认 true：取消后保留已爬取结果
    urlCrawl: {
      maxHops: 3,
      timeoutMs: 10000,
      maxPages: 50,
      userAgent: 'KarpathyWikiBot/1.0',
      allowedAttachmentTypes: [
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
        'mp4', 'webm', 'mp3', 'wav', 'ogg',
      ],
      followRobotsTxt: true,
      crawlDelayMs: 0,
      concurrency: 1,
      excludeTemplateElements: true,
      renderJs: false,
      contentAttachmentTypes: [
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'mp4', 'webm', 'mp3', 'wav', 'ogg',
      ],
      retryAttempts: 1,
      retryBackoffMs: 500,
      enableAttachmentDedup: true,
      logging: { enabled: false, logFilePath: '../data/url-crawl.log' },
      connectTimeoutMs: 0,
      readTimeoutMs: 0,
      copyrightNotice: '本文内容来源于互联网公开资源，仅用于个人知识管理，如有侵权请联系删除',
      preserveOnCancel: true,
      // 5.1.3 增量爬取：默认 false，仅高频复访站点开启
      incrementalCrawl: false,
      incrementalStatePath: '../data/url-crawl-state.json',
      // 5.3.2 断点续爬：默认 false，与 incrementalCrawl 共享状态文件
      resumeCrawl: false,
    },
    // FR-13-2 OCR 默认配置：undefined 表示未配置，resolveOcrConfig 会回退到 llm 配置
    // 为什么不设默认值：OCR 模型需用户显式配置支持视觉的模型（如 agnes-2.1-flash），
    // 不应自动使用主 LLM（如 deepseek-chat 不支持视觉）
    ocr: undefined,
    // FR-09-3 Podcast 默认配置：undefined 表示未配置，podcast workflow 仅生成脚本不合成音频
    // 为什么不设默认值：TTS 需用户显式配置 provider/apiKey/voice，不应自动启用
    podcast: undefined,
    // v3 媒体生成默认配置：Agnes API 公开参数（baseUrl/model/size）给默认值
    // API key 复用 llm.apiKeys.agnes 或 process.env[AGNES_API_KEY]
    // 为什么不像 ocr/podcast 用 undefined：media 的 baseUrl/model 是非敏感公开参数，
    // 提供默认值让用户只需配置 API key 即可使用图像/视频生成
    media: {
      agnes: {
        baseUrl: 'https://apihub.agnes-ai.com/v1',
        apiKeyRef: 'AGNES_API_KEY',
        imageModel: 'agnes-image-2.5-flash',
        videoModel: 'agnes-video-2.5-flash',
        defaultImageSize: '1024x768',
        defaultImageRatio: '16:9',
        defaultVideoSize: '1280x720',
        defaultVideoSeconds: 5,
      },
      // T00320 管理员全局「共享媒体」默认不配置：与既有行为一致，个人 BYOK / media.agnes 兜底不受影响
      shared: undefined,
    },
    // 会话持久化（对应「问答会话本地存储 + 线程隔离 + 本地记忆」需求）。
    // 默认关闭服务端落盘（D-1 决策 / SRS 核心需求：会话内容不存储于服务器端，仅在本地维护）：
    //   - 本应用已引入多用户注册，服务端落盘会话会违反「注册用户间数据隔离 + 会话不上服务端」要求；
    //   - 会话历史唯一权威源为前端 IndexedDB（含 ownerId 隔离），Query 始终携带完整 history，
    //     因此服务端无需持久化会话/记忆即可保证问答连续性。
    // threadsPersist=false：ThreadMemoryStore 不写 data/threads/，getHistoryContext 恒返回 []（前端用 history 兜底）。
    // conversationsPersist=false：/api/conversations 路由族不注册，服务端不暴露任何会话 CRUD 端点（FR-RM-04/FR-RM-08）。
    // 如需开启（如单用户本地优先调试）可在 config.json 的 sessionPersistence 中显式设 true。
    sessionPersistence: {
      threadsPersist: false,
      conversationsPersist: false,
    },
    // 上下文记忆治理（对应「上下文窗口受限场景下的对话历史主动管理」需求）
    // 默认开启：注入 LLM 前自动语义压缩/清理/重组/容量淘汰，保护关键信息、保持连贯。
    // 阈值可调：maxTokens 控制注入历史 token 硬上限；warnRatio 控制主动触发时机；
    //   recencyWindow 保证最近 N 条原文不被压缩（连贯性底线）。
    contextGovernor: { ...DEFAULT_GOVERNOR_CONFIG },
    // 子智能体（多步 Agent）开关：默认关闭，零破坏；Config 页面可实时开启。
    enableSubAgents: false,
    // X-2 可恢复流式开关：默认关闭，零破坏；开启后问答运行与请求解耦支持断线重连。
    enableResumableStream: false,
    // 意图澄清默认配置：开启 + 默认参数（阈值 0.6 / 最多 2 轮 / 最多 3 选项 / 10 分钟 TTL /
    // 多模态输出模式跳过）。config.json 可整体覆盖，前端请求 middlewares 不含 'clarify' 时跳过。
    clarify: { ...DEFAULT_CLARIFY_CONFIG },
    // MCP 服务端默认关闭（零破坏）。启用后对外暴露知识库能力给外部 AI Agent。
    // authenticated 默认 true：未配置 token 时端点不可用（安全默认）。
    mcp: { enabled: false, endpointPath: '/mcp', name: 'karpathy-wiki', version: '1.0.0' },
    // V4.0 知识校验默认配置（FR-17/18/19）
    // knowledge.staleDays 默认 365：单用户本地库更新频率低，一年未更新的 dated 知识才判过期
    // graph.minPages 默认 20：低于该页数的知识库样本不足，缺口检测返回 insufficient-data 而非误报
    // refs.authorityMap 默认按现有 source 类别枚举映射：web 官方网页高 / manual 手工录入中 / qq-chat 聊天记录低
    knowledge: { staleDays: 365 },
    graph: { minPages: 20 },
    refs: { authorityMap: { web: 'high', manual: 'medium', 'qq-chat': 'low' } },
  };
}

// 解析 config.json 实际路径，供 tunnel 路由等落盘复用。
// 查找顺序（与 CWD 解耦）：
//   1. 权威路径（SEA: exe/config.json，开发: api/config.json，由 getResourcePath 统一解析）
//   2. CWD/config.json（兼容用户从任意目录启动的场景）
//   3. 找不到时返回权威路径作为写入目标（保持向后兼容）
// 为什么不用 process.pkg 检测：SEA 模式下 process.pkg 不存在（仅传统 pkg 有），
// 改用 runtime.ts 的 IS_SEA 标志统一识别打包模式
export function getConfigPath(): string | null {
  const candidates: string[] = [
    API_CONFIG_PATH,
    path.resolve(process.cwd(), CONFIG_FILENAME),
  ];

  for (const p of candidates) {
    try {
      fsSync.accessSync(p);
      return p;
    } catch {
      // 尝试下一个候选路径
    }
  }
  // 候选路径都不存在时，返回权威路径作为写入目标（创建新配置文件）
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

// 合并嵌套配置对象，避免下层数据丢失。
// 提取为独立函数以降低 loadConfig 的认知复杂度（S3776）。
function mergeConfigObjects(defaults: AppConfig, parsed: Partial<AppConfig>): AppConfig {
  return {
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
      ? { ...defaults.webSearch, ...parsed.webSearch }
      : defaults.webSearch,
    // 批量编译配置合并：parsed.batch 可选，未配置时用默认值
    batch: parsed.batch
      ? { ...(defaults.batch ?? DEFAULT_BATCH_FALLBACK), ...parsed.batch }
      : defaults.batch,
    // RBAC auth 配置合并：parsed.auth 可选，未配置时用默认值
    auth: parsed.auth
      ? { ...defaults.auth, ...parsed.auth }
      : defaults.auth,
    // QQ 导入子系统配置合并：parsed.qq 可选，未配置时用默认值
    qq: parsed.qq && defaults.qq
      ? {
          ...defaults.qq,
          ...parsed.qq,
          noise_rules: { ...defaults.qq.noise_rules, ...parsed.qq.noise_rules },
          privacy_patterns: { ...defaults.qq.privacy_patterns, ...parsed.qq.privacy_patterns },
        }
      : defaults.qq,
    // URL 爬取子系统配置合并：parsed.urlCrawl 可选，未配置时用默认值
    urlCrawl: parsed.urlCrawl
      ? { ...defaults.urlCrawl, ...parsed.urlCrawl }
      : defaults.urlCrawl,
    // FR-13-2 OCR 配置合并：parsed.ocr 可选，未配置时为 undefined（resolveOcrConfig 会回退到 llm）
    ocr: parsed.ocr
      ? { ...defaults.ocr, ...parsed.ocr }
      : defaults.ocr,
    // FR-09-3 Podcast 配置合并：parsed.podcast 可选，未配置时为 undefined
    podcast: parsed.podcast
      ? { ...defaults.podcast, ...parsed.podcast }
      : defaults.podcast,
    // v3 媒体生成配置合并：parsed.media 可选，未配置时用默认值
    // 为什么保留 parsed.media.shared：管理员「共享媒体」（生图/视频）由 /api/media/shared 写入，
    //   浅合并 agnes（敏感默认覆盖）时若丢弃 shared 会导致共享配置保存后丢失；条件带出即可。
    media: parsed.media && defaults.media
      ? {
          agnes: { ...defaults.media.agnes, ...parsed.media.agnes },
          ...(parsed.media.shared ? { shared: parsed.media.shared } : {}),
        }
      : defaults.media,
    // 会话持久化配置合并：parsed.sessionPersistence 可选，未配置时用默认值
    sessionPersistence: parsed.sessionPersistence && defaults.sessionPersistence
      ? {
          threadsPersist:
            parsed.sessionPersistence.threadsPersist ?? defaults.sessionPersistence.threadsPersist,
          conversationsPersist:
            parsed.sessionPersistence.conversationsPersist ?? defaults.sessionPersistence.conversationsPersist,
        }
      : defaults.sessionPersistence,
    // 上下文记忆治理配置合并：parsed.contextGovernor 可选，未配置时用默认值（开启）
    contextGovernor: parsed.contextGovernor && defaults.contextGovernor
      ? { ...defaults.contextGovernor, ...parsed.contextGovernor }
      : defaults.contextGovernor,
    // 意图澄清配置合并：parsed.clarify 可选，未配置时用默认值（开启）；浅合并支持单字段覆盖
    clarify: parsed.clarify && defaults.clarify
      ? { ...defaults.clarify, ...parsed.clarify }
      : defaults.clarify,
    // MCP 服务端配置合并：parsed.mcp 可选，未配置时用默认值（关闭）；浅合并支持单字段覆盖
    mcp: parsed.mcp && defaults.mcp
      ? { ...defaults.mcp, ...parsed.mcp }
      : defaults.mcp,
    // V4.0 配置合并：三个区间均可选，浅合并支持单字段覆盖，未配置时用默认值
    knowledge: parsed.knowledge && defaults.knowledge
      ? { ...defaults.knowledge, ...parsed.knowledge }
      : defaults.knowledge,
    graph: parsed.graph && defaults.graph
      ? { ...defaults.graph, ...parsed.graph }
      : defaults.graph,
    refs: parsed.refs && defaults.refs
      ? { ...defaults.refs, authorityMap: { ...defaults.refs.authorityMap, ...parsed.refs.authorityMap } }
      : defaults.refs,
  };
}

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
  const merged = mergeConfigObjects(defaults, parsed);

  // SEA 模式路径重写与首次落盘（提取为独立函数降低 loadConfig 认知复杂度）
  if (IS_SEA) {
    applySeaRebase(merged);
    await writeSeaDefaultsIfNeeded(merged);
  }

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

// SEA 模式路径重写：把可写数据路径收敛到用户数据目录，避免落到 exe 同级（Program Files 不可写/卸载清除）
// 为什么整体归一化：defaultConfig 中 vaultPath/auth/urlCrawl 等默认是相对路径（开发模式相对 api/），
//   SEA 模式下这些相对基准（CWD）不可靠，必须改写为用户数据根目录下的绝对路径。
// 绝对路径保留：尊重用户在配置中显式指定的绝对路径（如自定义 vault 位置）。
function applySeaRebase(merged: AppConfig): void {
  const dataDir = path.join(getUserDataDir(), 'data');
  const rebase = (p: string | undefined, fallback: string): string =>
    !p || path.isAbsolute(p) ? (p ?? fallback) : path.join(dataDir, fallback);

  merged.vaultPath = rebase(merged.vaultPath, 'vault');
  if (merged.auth) {
    merged.auth.usersFilePath = rebase(merged.auth.usersFilePath, 'users.json');
    merged.auth.auditLogPath = rebase(merged.auth.auditLogPath, 'audit.log');
  }
  if (merged.urlCrawl) {
    if (merged.urlCrawl.logging) {
      merged.urlCrawl.logging.logFilePath = rebase(merged.urlCrawl.logging.logFilePath, 'url-crawl.log');
    }
    merged.urlCrawl.incrementalStatePath = rebase(merged.urlCrawl.incrementalStatePath, 'url-crawl-state.json');
  }
  if (merged.logging) {
    merged.logging.logFilePath = rebase(merged.logging.logFilePath, 'api.log');
  }
}

// SEA 首次运行：若用户数据目录尚无 config.json，落盘默认配置，便于用户编辑且保持行为一致
// 为什么只在 SEA：开发模式保持不自动生成文件的最小惊讶原则
// 为什么写"干净默认"而非 merged：merged 已被 SEA rebase 成机器相关的绝对路径，固化进 config.json 会降低可移植性
async function writeSeaDefaultsIfNeeded(merged: AppConfig): Promise<void> {
  if (fsSync.existsSync(API_CONFIG_PATH)) return;
  try {
    const defaults = defaultConfig();
    const portable: AppConfig = {
      ...merged,
      vaultPath: defaults.vaultPath,
      auth: merged.auth
        ? {
            ...merged.auth,
            usersFilePath: defaults.auth?.usersFilePath ?? merged.auth.usersFilePath,
            auditLogPath: defaults.auth?.auditLogPath ?? merged.auth.auditLogPath,
          }
        : merged.auth,
      urlCrawl: merged.urlCrawl
        ? {
            ...merged.urlCrawl,
            logging: {
              ...merged.urlCrawl.logging,
              logFilePath: defaults.urlCrawl?.logging?.logFilePath ?? merged.urlCrawl.logging?.logFilePath,
            },
            incrementalStatePath: defaults.urlCrawl?.incrementalStatePath ?? merged.urlCrawl.incrementalStatePath,
          }
        : merged.urlCrawl,
      logging: merged.logging
        ? { ...merged.logging, logFilePath: defaults.logging?.logFilePath ?? merged.logging.logFilePath }
        : merged.logging,
    };
    await fs.writeFile(API_CONFIG_PATH, JSON.stringify(portable, null, 2), 'utf8');
  } catch {
    // 落盘失败不阻断启动，应用退化为内存默认值
  }
}

// 保存 AI 配置到 config.json（部分更新，仅合并 llm 字段）。
// 为什么需要：前端 AI 服务配置页面需要持久化用户输入的 provider/baseUrl/model/apiKey。
// 安全考量：apiKey 以明文写入 config.json，需确保 .gitignore 排除了 config.json（M-7）。
// 多 key 持久化：provider 变更时自动迁移当前 apiKey 到 apiKeys[旧provider]，并从 apiKeys[新provider] 恢复 key。
//   为什么需要：单 apiKey 字段在预设切换时无法区分 provider 来源，导致 APIKEY 未跟随模型切换错误显示。
//   迁移策略：
//     1. 检测 provider 是否变化，未变化走原路径
//     2. provider 变化时：把 current.llm.apiKey 回写到 apiKeys[currentProvider]
//     3. 从 apiKeys[newProvider] 读取并赋给 llm.apiKey（无记录则空串）
//     4. 若请求体显式提供 apiKey（非 undefined），覆盖回写的值
//   apiKeyRef 同步：若请求体提供新 apiKeyRef，更新为新 provider 的环境变量名
export async function saveAiConfig(updates: {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  apiKeyRef?: string;
}): Promise<AppConfig> {
  const current = await loadConfig();
  const oldProvider = current.llm.provider;
  const newProvider = updates.provider ?? oldProvider;
  const providerChanged = newProvider !== oldProvider;

  // 多 key 持久化表：保留已有记录，按需追加/覆盖
  // 为什么用 ?? {}：老配置文件可能无 apiKeys 字段，首次切换时初始化空表
  const apiKeys: Record<string, string> = { ...(current.llm.apiKeys ?? {}) };

  // provider 变更时执行 key 迁移：保存当前 apiKey 到 apiKeys[旧provider]
  // 为什么条件判断：provider 未变时迁移会污染表（同 provider 覆盖自身无意义）
  // 为什么加 !apiKeys[oldProvider] 守卫：保留用户之前手动设置的旧 key，避免切换时丢失
  if (providerChanged && current.llm.apiKey && !apiKeys[oldProvider]) {
    apiKeys[oldProvider] = current.llm.apiKey;
  }

  // 计算生效的 apiKey：
  // - 优先用请求体显式提供的新值（含空串清除）
  // - provider 变更时从 apiKeys[newProvider] 恢复
  // - 否则保留 current.llm.apiKey
  let effectiveApiKey: string | undefined;
  if (updates.apiKey !== undefined) {
    // 请求体显式提供 apiKey：**** 开头视为脱敏回传（不修改），空串表示清除，其他为新值
    // 为什么需要脱敏检测：前端 GET 拿到 ****xxxx 回传时不能当新值写入
    effectiveApiKey = updates.apiKey.startsWith('****') ? current.llm.apiKey : updates.apiKey;
  } else if (providerChanged) {
    // provider 变更但未显式提供 apiKey：从 apiKeys 表恢复目标 provider 的 key
    // 为什么用空串兜底：apiKeys[newProvider] 可能不存在（用户首次切换到该 provider），空串表示未设置
    effectiveApiKey = apiKeys[newProvider] ?? '';
  } else {
    effectiveApiKey = current.llm.apiKey;
  }

  // 若 effectiveApiKey 非空，同步写入 apiKeys[newProvider] 保持表一致
  // 为什么需要：下次切回该 provider 时能从 apiKeys 表恢复
  if (effectiveApiKey) {
    apiKeys[newProvider] = effectiveApiKey;
  }

  const merged: AppConfig = {
    ...current,
    llm: {
      ...current.llm,
      provider: newProvider,
      ...updates.baseUrl ? { baseUrl: updates.baseUrl } : {},
      ...updates.model ? { model: updates.model } : {},
      // apiKeyRef 同步更新为新 provider 的环境变量名（预设切换场景）
      ...updates.apiKeyRef ? { apiKeyRef: updates.apiKeyRef } : {},
      apiKey: effectiveApiKey,
      apiKeys,
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

// 读取所有 provider 的 key 配置状态（脱敏后仅返回是否已配置，不暴露 key 本身）。
// 为什么需要：前端切换预设时需展示各 provider 的 key 状态，让用户感知哪些 provider 已配置。
export function getProviderKeyStatus(config: AppConfig): Record<string, boolean> {
  const status: Record<string, boolean> = {};
  const apiKeys = config.llm.apiKeys ?? {};
  // 当前 provider 的 apiKey 也算已配置
  if (config.llm.apiKey) {
    status[config.llm.provider] = true;
  }
  for (const [provider, key] of Object.entries(apiKeys)) {
    status[provider] = Boolean(key);
  }
  return status;
}

// 读取生效的 API Key：优先 config.json 中的 apiKey，其次按 provider 的多 key 持久化表
// apiKeys[provider]，最后环境变量 apiKeyRef。
// 为什么需要：
//   1. 支持前端配置 API Key 的同时保持环境变量向后兼容（既有能力）。
//   2. apiKeys 表是 provider 切换时多 key 迁移的落点（见 saveAiConfig：旧 key 迁入表、
//      新 provider 的 key 从表恢复）。当 llm.apiKey 字段缺失（如手动编辑 config.json、
//      resetAiConfig 恢复出厂、或切换流程中断）但 apiKeys[provider] 有值时，必须能取回，
//      否则 GET /api/ai/config 返回空 apiKeyMasked，前端表现为「后台有值但 API Key 未返显」，
//      而测试连接仍可能用其它路径（粘贴 key / 内存态）通过，造成体验断层。
//      语义对齐：media 链路（media-generation-workflow）已按 llm.apiKeys.agnes 取 key，本处补平。
export function getEffectiveApiKey(config: AppConfig): string {
  if (config.llm.apiKey) {
    return config.llm.apiKey;
  }
  const fromTable = config.llm.apiKeys?.[config.llm.provider];
  if (fromTable) {
    return fromTable;
  }
  return process.env[config.llm.apiKeyRef] ?? '';
}

// API Key 脱敏：仅保留末 4 位，前缀 ****。
// 为什么需要：GET 接口返回配置时不能暴露完整 Key，但需让用户确认 Key 已设置。
export function maskApiKey(key: string): string {
  if (!key || key.length < 4) {
    return key ? '****' : '';
  }
  return `****${key.slice(-4)}`;
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

// 保存 MCP 服务端配置（对外 /mcp 端点）到 config.json（部分更新，仅合并 mcp 字段）。
// 为什么独立函数：MCP 默认关闭；管理员开启并配置 userToken/adminToken 后外部 Agent 才能接入。
// 为什么 token 走脱敏判定：与 saveWebSearchConfig 同一约定——**** 开头视为未修改回传；
//   空串表示清除；其他为新值。undefined 表示字段未被改动、保留原值。
export async function saveMcpConfig(updates: {
  enabled?: boolean;
  endpointPath?: string;
  name?: string;
  version?: string;
  userToken?: string;
  adminToken?: string;
  authenticated?: boolean;
}): Promise<AppConfig> {
  const current = await loadConfig();
  const base = current.mcp ?? {
    enabled: false,
    endpointPath: '/mcp',
    name: 'karpathy-wiki',
    version: '1.0.0',
  };

  const merged: AppConfig = {
    ...current,
    mcp: {
      ...base,
      ...(updates.enabled === undefined ? {} : { enabled: updates.enabled }),
      ...(updates.endpointPath === undefined ? {} : { endpointPath: updates.endpointPath }),
      ...(updates.name === undefined ? {} : { name: updates.name }),
      ...(updates.version === undefined ? {} : { version: updates.version }),
      ...(updates.authenticated === undefined ? {} : { authenticated: updates.authenticated }),
      // token：脱敏串视为未修改；undefined 视为未提供；其余（含空串）覆盖写入
      ...(updates.userToken !== undefined && !updates.userToken.startsWith('****'))
        ? { userToken: updates.userToken }
        : {},
      ...(updates.adminToken !== undefined && !updates.adminToken.startsWith('****'))
        ? { adminToken: updates.adminToken }
        : {},
    },
  };

  const configPath = getConfigPath();
  if (configPath) {
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf8');
  }

  refreshConfigCache(merged);
  return merged;
}

// T00320 保存管理员「共享媒体」配置（media.shared.image / media.shared.video）到 config.json。
// 为什么独立函数：共享生图/视频为管理员级全局配置，与 user BYOK（客户端 IndexedDB）生命周期不同，
//   读写均走 requireAdmin 接口；仅更新显式提供的 image/video 组，未提供的组保留原值。
// apiKey 处理与 saveAiConfig 一致：**** 开头视为脱敏回传不修改，空串表示清除，其他为新值。
export async function saveSharedMediaConfig(updates: {
  image?: import('./types.js').MediaImageUserConfig;
  video?: import('./types.js').MediaVideoUserConfig;
}): Promise<AppConfig> {
  const current = await loadConfig();
  const baseMedia: import('./types.js').MediaConfig = current.media ?? {
    agnes: {
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      apiKeyRef: 'AGNES_API_KEY',
      imageModel: 'agnes-image-2.5-flash',
      videoModel: 'agnes-video-2.5-flash',
      defaultImageSize: '1024x768',
      defaultImageRatio: '16:9',
      defaultVideoSize: '1280x720',
      defaultVideoSeconds: 5,
    },
  };

  // 浅合并某组共享配置：仅覆盖显式提供的字段（undefined 字段保留旧值）；
  // apiKey 以 **** 开头视为脱敏回传，不覆盖。返回新对象，不修改入参。
  const mergeGroup = <T extends { apiKey?: string }>(
    prev: T | undefined,
    next: T | undefined,
  ): T | undefined => {
    if (next === undefined) return prev;
    const merged = { ...(prev ?? {}), ...next } as T;
    // apiKey 脱敏回传时恢复旧值
    if (typeof next.apiKey === 'string' && next.apiKey.startsWith('****')) {
      merged.apiKey = prev?.apiKey ?? '';
    }
    return merged;
  };

  const merged: AppConfig = {
    ...current,
    media: {
      agnes: baseMedia.agnes,
      ...(baseMedia.shared || updates.image !== undefined || updates.video !== undefined
        ? {
            shared: {
              ...(updates.image !== undefined
                ? { image: mergeGroup(baseMedia.shared?.image, updates.image) }
                : baseMedia.shared?.image !== undefined
                  ? { image: baseMedia.shared.image }
                  : {}),
              ...(updates.video !== undefined
                ? { video: mergeGroup(baseMedia.shared?.video, updates.video) }
                : baseMedia.shared?.video !== undefined
                  ? { video: baseMedia.shared.video }
                  : {}),
            },
          }
        : {}),
    },
  };

  const configPath = getConfigPath();
  if (configPath) {
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf8');
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

// FR-12 保存 AI 伙伴预设（skills + activeSkill）到 config.json
// 为什么独立函数：skills 与 llm 配置逻辑解耦，避免 saveAiConfig 膨胀
export async function saveSkillsConfig(
  skills?: SkillPreset[],
  activeSkill?: string,
): Promise<AppConfig> {
  const current = await loadConfig();
  const merged: AppConfig = {
    ...current,
  };
  if (skills !== undefined) {
    merged.skills = skills;
  }
  if (activeSkill !== undefined) {
    merged.activeSkill = activeSkill;
  }

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

// 保存子智能体（多步 Agent）开关到 config.json。
// 为什么需要：用户在前端 Config 页面实时开启/关闭 researcher 子智能体后需持久化，重启后仍生效。
export async function saveSubAgentConfig(enabled?: boolean): Promise<AppConfig> {
  const current = await loadConfig();
  const merged: AppConfig = { ...current };
  if (enabled !== undefined) {
    merged.enableSubAgents = enabled;
  }

  const configPath = getConfigPath();
  if (configPath) {
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf8');
  }
  refreshConfigCache(merged);
  return merged;
}

// 保存 X-2 可恢复流式开关到 config.json。
// 为什么需要：用户在前端 Config 页面实时开启/关闭可恢复流式后需持久化，重启后仍生效。
export async function saveResumableStreamConfig(enabled?: boolean): Promise<AppConfig> {
  const current = await loadConfig();
  const merged: AppConfig = { ...current };
  if (enabled !== undefined) {
    merged.enableResumableStream = enabled;
  }

  const configPath = getConfigPath();
  if (configPath) {
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf8');
  }
  refreshConfigCache(merged);
  return merged;
}
// 为什么需要：不同业务场景下文件类型与大小限制不同，用户需在前端调整。
export async function saveBatchConfig(updates: {
  allowedExtensions?: string[];
  maxBatchSize?: number;
  maxFileSizeMb?: number;
}): Promise<AppConfig> {
  const current = await loadConfig();
  const baseBatch = current.batch ?? {
    allowedExtensions: ['md', 'txt', 'pdf', 'html', 'json', 'docx', 'xlsx', 'pptx', 'doc', 'xls'],
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

// 保存日志配置（level/enableRequestLog/logFilePath）到 config.json。
// 为什么需要：调试时需要切换 debug 级别或开关请求级日志，重启服务才生效太繁琐。
// 注意：level 变更需重启 Fastify 实例才能完全生效（pino logger 在启动时创建），
//   但 enableRequestLog 可热更新（路由钩子运行时读取）。
// logFilePath 语义（与 apiKey 一致）：undefined=不修改，空串=清除（禁用落盘），非空=新路径
export async function saveLoggingConfig(updates: {
  level?: string;
  enableRequestLog?: boolean;
  logFilePath?: string;
}): Promise<AppConfig> {
  const current = await loadConfig();
  const baseLogging = current.logging ?? {
    level: 'info',
    enableRequestLog: true,
    logFilePath: '',
  };
  const merged: AppConfig = {
    ...current,
    logging: {
      ...baseLogging,
      ...updates.level === undefined ? {} : { level: updates.level },
      ...updates.enableRequestLog === undefined ? {} : { enableRequestLog: updates.enableRequestLog },
      ...updates.logFilePath === undefined ? {} : { logFilePath: updates.logFilePath },
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

// 保存 URL 爬取子系统配置（maxHops/timeoutMs/maxPages/userAgent/allowedAttachmentTypes）到 config.json。
// 为什么需要：用户需根据业务场景调整爬取深度、超时、附件白名单等参数，无需手动编辑 config.json。
// 注意：maxHops=0 表示仅爬入口页（不跳转），数值合法但需前端提示用户含义。
export async function saveUrlCrawlConfig(updates: Partial<UrlCrawlConfig>): Promise<AppConfig> {
  const current = await loadConfig();
  // 为什么复用 DEFAULT_CRAWL_CONFIG：BR-028 配置合并规范要求默认值单点维护
  const currentUrlCrawl = current.urlCrawl ?? {};
  const baseUrlCrawl: Required<UrlCrawlConfig> = {
    ...DEFAULT_CRAWL_CONFIG,
    ...currentUrlCrawl,
    // B 方案：egress 代理默认值（空字符串表示不启用），显式给 string 以满足 Required 约束
    egressProxyUrl: currentUrlCrawl.egressProxyUrl ?? DEFAULT_CRAWL_CONFIG.egressProxyUrl,
    logging: {
      enabled: currentUrlCrawl.logging?.enabled ?? DEFAULT_CRAWL_CONFIG.logging.enabled,
      logFilePath: currentUrlCrawl.logging?.logFilePath ?? DEFAULT_CRAWL_CONFIG.logging.logFilePath,
    },
  };
  // 合并用户更新（仅覆盖显式提供的字段）
  const merged: AppConfig = {
    ...current,
    urlCrawl: {
      ...baseUrlCrawl,
      ...updates,
      // logging 嵌套对象特殊处理：类型守卫防止 null/非对象导致 TypeError（BR-028-2）
      logging: updates.logging && typeof updates.logging === 'object'
        ? {
            enabled: updates.logging.enabled ?? baseUrlCrawl.logging.enabled,
            logFilePath: updates.logging.logFilePath ?? baseUrlCrawl.logging.logFilePath,
          }
        : baseUrlCrawl.logging,
    },
  };

  const configPath = getConfigPath();
  if (configPath) {
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf8');
  }
  refreshConfigCache(merged);
  return merged;
}

// ===== 数据迁移（T00332）：配置整体导出 / 导入 =====
// 目标：便于更换服务器 / 环境迁移时，把 config.json 的完整配置项打包传输。
// 安全与校验策略（与 saveAiConfig/saveMcpConfig 的 **** 脱敏约定保持对称）：
//   导出：对含密钥的字段递归脱敏（保留结构，值替换为 **** 掩码），避免明文 key 随文件泄露；
//   导入：白名单（顶层 key）+ 轻量类型校验，忽略未知字段防异常注入；密钥字段若回传掩码/空串，
//         视为"未修改"，沿用当前配置的真实值，避免导入后密钥被清空或误覆盖。
// 为什么集中声明密钥键名而非引入 YAML/JSONSchema 依赖：满足"不引入冲突第三方依赖 + 不上强依赖"，
//   集中枚举清晰可维护，键名覆盖本项目全部存明文 key 的字段。
const MIGRATION_SECRET_KEYS: ReadonlySet<string> = new Set([
  'apiKey',          // llm / webSearch / media(agnes|shared.image|shared.video) / ocr / audio 明文 key
  'apiKeys',         // llm 多 key 持久化表（provider -> key，值逐个脱敏）
  'userToken',       // mcp 读 token
  'adminToken',      // mcp 写 token
  'ttsApiKey',       // podcast TTS key
  'cpolarAuthtoken', // tunnel cpolar 口令
]);

// 顶层允许持久化的配置键（AppConfig 顶层字段白名单）。
// 为什么独立集合：导入只接受已知键，避免攻击者注入任意未知顶层字段污染结构。
const CONFIG_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'vaultPath', 'adapter', 'llm', 'budget', 'server', 'localOnly', 'healthCheck', 'tunnel',
  'webSearch', 'logging', 'batch', 'tools', 'auth', 'qq', 'urlCrawl', 'audio', 'ocr',
  'podcast', 'media', 'skills', 'activeSkill', 'sessionPersistence', 'contextGovernor',
  'enableSubAgents', 'enableResumableStream', 'clarify', 'mcp', 'knowledge', 'graph', 'refs',
]);

// 导入校验专属错误：路由据此返回 400（格式/完整性不符），区别于写盘 500。
export class ConfigMigrationError extends Error {}

// 判断是否为纯对象（用于递归脱敏/合并/校验）
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// 掩码单个字符串：保留末 4 位便于识别已配置，前缀 ****（与 maskApiKey 一致）。
// 空串保持空串：表示"未配置"，导入时同样沿用现状，确保导出→导入对称。
function maskSecretString(s: string): string {
  if (!s) return s;
  return s.length < 4 ? '****' : `****${s.slice(-4)}`;
}

// 递归脱敏：返回新对象，不修改入参。
// 为什么递归处理整个树：密钥散落在多层嵌套（llm/media/tunnel 等），逐层遍历才无遗漏。
function maskSecretsInConfig(node: unknown): unknown {
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (MIGRATION_SECRET_KEYS.has(k)) {
      if (k === 'apiKeys') {
        // 多 key 表：provider -> key 映射，逐个掩码（保留空串语义）
        out[k] = isPlainObject(v)
          ? Object.fromEntries(
              Object.entries(v).map(([p, key]): [string, unknown] => [p, typeof key === 'string' ? maskSecretString(key) : key]),
            )
          : v;
      } else {
        out[k] = typeof v === 'string' ? maskSecretString(v) : v;
      }
      continue;
    }
    out[k] = maskSecretsInConfig(v);
  }
  return out;
}

// 递归还原密钥：import 中密钥字段为掩码(****)或空串时，沿用 current 现值；否则用 import 真实值。
// current 为当前生效配置（含真实密钥），保证"导出→换机→导入"不丢 key 也不读明文。
function restoreSecretsInConfig(importNode: unknown, current: unknown): unknown {
  if (!isPlainObject(importNode)) return importNode;
  const cur = isPlainObject(current) ? current : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(importNode)) {
    if (MIGRATION_SECRET_KEYS.has(k)) {
      if (k === 'apiKeys') {
        const curTable = isPlainObject(cur[k]) ? (cur[k] as Record<string, unknown>) : {};
        out[k] = isPlainObject(v)
          ? Object.fromEntries(
              Object.entries(v).map(([p, key]): [string, unknown] => {
                if (typeof key !== 'string') return [p, key];
                // 掩码/空串：沿用当前表对应 provider 的真实值（未配置则保留原值）
                if (key === '' || key.startsWith('****')) {
                  return [p, typeof curTable[p] === 'string' ? curTable[p] : key];
                }
                return [p, key];
              }),
            )
          : v;
        continue;
      }
      if (typeof v === 'string' && (v === '' || v.startsWith('****'))) {
        out[k] = typeof cur[k] === 'string' ? cur[k] : '';
        continue;
      }
    }
    out[k] = restoreSecretsInConfig(v, cur[k]);
  }
  return out;
}

// 清洗 + 白名单/类型校验导入数据：返回受支持字段子集，未知字段记录到 failed。
// 为什么返回子集而非抛错：实现"忽略未知字段"，避免旧版本导出文件含新字段时导入被整体拒绝。
function sanitizeImportConfig(raw: unknown): { data: Record<string, unknown>; failed: string[] } {
  const failed: string[] = [];
  if (!isPlainObject(raw)) {
    throw new ConfigMigrationError('导入数据必须为一个 JSON 对象');
  }
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!CONFIG_TOP_LEVEL_KEYS.has(k)) {
      failed.push(`忽略未知字段 "${k}"`);
      continue;
    }
    data[k] = v;
  }
  // 顶层字段类型轻校验（明显异常类型直接拒绝，避免坏结构写盘）
  const objectKeys: ReadonlyArray<string> = [
    'llm', 'budget', 'server', 'healthCheck', 'tunnel', 'webSearch', 'logging', 'batch', 'tools',
    'auth', 'qq', 'urlCrawl', 'audio', 'ocr', 'podcast', 'media', 'contextGovernor', 'clarify',
    'mcp', 'knowledge', 'graph', 'refs', 'sessionPersistence',
  ];
  for (const k of objectKeys) {
    if (k in data && data[k] !== undefined && !isPlainObject(data[k])) {
      throw new ConfigMigrationError(`字段 "${k}" 应为对象`);
    }
  }
  if ('skills' in data && data.skills !== undefined && !Array.isArray(data.skills)) {
    throw new ConfigMigrationError('字段 "skills" 应为数组');
  }
  const boolKeys: ReadonlyArray<string> = ['localOnly', 'enableSubAgents', 'enableResumableStream'];
  for (const k of boolKeys) {
    if (k in data && data[k] !== undefined && typeof data[k] !== 'boolean') {
      throw new ConfigMigrationError(`字段 "${k}" 应为 boolean`);
    }
  }
  if ('vaultPath' in data && data.vaultPath !== undefined && typeof data.vaultPath !== 'string') {
    throw new ConfigMigrationError('字段 "vaultPath" 应为 string');
  }
  if ('activeSkill' in data && data.activeSkill !== undefined && typeof data.activeSkill !== 'string') {
    throw new ConfigMigrationError('字段 "activeSkill" 应为 string');
  }
  return { data, failed };
}

// 深度合并：base 已有字段保持不变，用 incoming 补齐 base 缺失的字段（仅对象间递归）。
// 为什么只补缺失：merge 模式语义为"仅导入目标中不存在的配置项，已有的保持不变"。
function deepMergeConfig(base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(incoming)) {
    const cur = base[k];
    if (isPlainObject(v) && isPlainObject(cur)) {
      out[k] = deepMergeConfig(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else if (cur === undefined) {
      out[k] = v;
    }
    // 其余情况：base 已有值保持不变
  }
  return out;
}

// 生成导出版本元数据外壳。
// 为什么带 meta：让导入端可识别文件来源/时间/格式，且不污染 config.json 结构。
export async function buildConfigExport(): Promise<{ fileName: string; data: unknown }> {
  const config = await loadConfig();
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return {
    fileName: `karpathy-wiki-config-${stamp}.json`,
    data: {
      format: 'karpathy-wiki-config',
      version: 1,
      exportedAt: now.toISOString(),
      config: maskSecretsInConfig(config),
    },
  };
}

// 导入配置数据并持久化，返回结果摘要 { applied, skipped, failed, details }。
// mode：
//   merge    仅补齐当前配置缺失的项，已有配置项保持不变（含嵌套对象递归）；
//   overwrite整体替换（先备份旧配置到 config.json.bak，写失败可从备份回滚）。
// 密钥处理：导入文件默认来自 buildConfigExport（掩码/空串），restoreSecretsInConfig 沿用当前真实值。
export async function importConfigData(
  raw: unknown,
  mode: 'merge' | 'overwrite',
): Promise<{ applied: number; skipped: number; failed: number; details: string[] }> {
  if (mode !== 'merge' && mode !== 'overwrite') {
    throw new ConfigMigrationError('mode 必须为 merge 或 overwrite');
  }
  const { data, failed } = sanitizeImportConfig(raw);
  if (Object.keys(data).length === 0) {
    throw new ConfigMigrationError(`未发现任何受支持的配置字段${failed.length ? `：${failed.join('；')}` : ''}`);
  }

  const prev = (await loadConfig()) as unknown as Record<string, unknown>;
  const base: Record<string, unknown> = mode === 'merge' ? deepMergeConfig(prev, data) : { ...prev, ...data };
  // 密钥还原：以 prev（真实值）为基准，掩码/空串回传沿用现值
  const restored = restoreSecretsInConfig(base, prev);

  const configPath = getConfigPath();
  if (!configPath) {
    throw new ConfigMigrationError('无法定位 config.json 写入路径');
  }

  if (mode === 'overwrite') {
    // 备份当前配置，写入失败时回滚
    await fs.writeFile(`${configPath}.bak`, JSON.stringify(prev, null, 2), 'utf8');
  }

  try {
    await fs.writeFile(configPath, JSON.stringify(restored, null, 2), 'utf8');
  } catch (err) {
    // 写入失败：尽力回滚备份（忽略回滚自身的二次错误，交由路由上报原始错误）
    try {
      await fs.writeFile(configPath, JSON.stringify(prev, null, 2), 'utf8');
    } catch { /* 回滚失败不掩盖原始错误 */ }
    throw err;
  }

  refreshConfigCache(restored as unknown as AppConfig);

  return {
    applied: Object.keys(data).length,
    skipped: 0,
    failed: failed.length,
    details: failed,
  };
}

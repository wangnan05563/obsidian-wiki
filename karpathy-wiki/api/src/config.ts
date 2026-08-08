import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { AppConfig, ToolsConfig, QqConfig, UrlCrawlConfig, SkillPreset } from './types.js';
import { DEFAULT_CRAWL_CONFIG } from './utils/url-crawl.js';
import { DEFAULT_GOVERNOR_CONFIG } from './engine/context-governor.js';
// 路径解析统一走 runtime.ts，兼容开发模式（api/config.json）与 SEA 模式（exe/config.json）
// 为什么移除 fileURLToPath + import.meta.url：SEA 模式下 __filename 指向构建时 bundle.cjs，
// 用户机器不存在，派生的 API_SRC_DIR 不可用，导致 config.json 加载失败
import { getResourcePath, getUserDataPath, getUserDataDir, IS_SEA } from './utils/runtime.js';

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
        imageModel: 'agnes-image-2.1-flash',
        videoModel: 'agnes-video-v2.0',
        defaultImageSize: '1024x768',
        defaultImageRatio: '16:9',
        defaultVideoSize: '1280x720',
        defaultVideoSeconds: 5,
      },
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
    // 为什么加 defaults.qq 守卫：defaultConfig() 实际总返回 qq 非空，
    // 但 TS 推断 AppConfig.qq 为可选（QqConfig | undefined），守卫后可省略 ?. 且无需 ! 断言（BR-028-1/2）
    qq: parsed.qq && defaults.qq
      ? {
          ...defaults.qq,
          ...parsed.qq,
          noise_rules: { ...defaults.qq.noise_rules, ...parsed.qq.noise_rules },
          privacy_patterns: { ...defaults.qq.privacy_patterns, ...parsed.qq.privacy_patterns },
        }
      : defaults.qq,
    // URL 爬取子系统配置合并：parsed.urlCrawl 可选，未配置时用默认值
    // 为什么独立合并：urlCrawl 含数组字段（allowedAttachmentTypes），浅合并会丢失默认值
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
    // 为什么独立合并：media.agnes 是嵌套对象，浅合并会让用户部分配置覆盖整个默认段
    media: parsed.media && defaults.media
      ? {
          agnes: { ...defaults.media.agnes, ...parsed.media.agnes },
        }
      : defaults.media,
    // 会话持久化配置合并：parsed.sessionPersistence 可选，未配置时用默认值（均为 false，服务端不落盘会话）
    // 为什么独立合并：嵌套对象，浅合并会丢失 threadsPersist/conversationsPersist 下层字段
    sessionPersistence: parsed.sessionPersistence && defaults.sessionPersistence
      ? {
          threadsPersist:
            parsed.sessionPersistence.threadsPersist ?? defaults.sessionPersistence.threadsPersist,
          conversationsPersist:
            parsed.sessionPersistence.conversationsPersist ?? defaults.sessionPersistence.conversationsPersist,
        }
      : defaults.sessionPersistence,
    // 上下文记忆治理配置合并：parsed.contextGovernor 可选，未配置时用默认值（开启）
    // 为什么用条件合并：contextGovernor 是嵌套对象（含 maxTokens/warnRatio 等），浅合并会丢失下层字段
    contextGovernor: parsed.contextGovernor && defaults.contextGovernor
      ? { ...defaults.contextGovernor, ...parsed.contextGovernor }
      : defaults.contextGovernor,
  };

  // SEA 模式：把可写数据路径收敛到用户数据目录，避免落到 exe 同级（Program Files 不可写/卸载清除）
  // 为什么整体归一化：defaultConfig 中 vaultPath/auth/urlCrawl 等默认是相对路径（开发模式相对 api/），
  //   SEA 模式下这些相对基准（CWD）不可靠，必须改写为用户数据根目录下的绝对路径。
  // 绝对路径保留：尊重用户在配置中显式指定的绝对路径（如自定义 vault 位置）。
  if (IS_SEA) {
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
    // 日志文件默认空串（不落盘）；若用户自定义相对路径，同样收敛到用户数据目录避免 Program Files 无权限
    if (merged.logging) {
      merged.logging.logFilePath = rebase(merged.logging.logFilePath, 'api.log');
    }
  }

  // SEA 首次运行：若用户数据目录尚无 config.json，落盘默认配置，便于用户编辑且保持行为一致
  // 为什么只在 SEA：开发模式保持不自动生成文件的最小惊讶原则
  // 为什么写"干净默认"而非 merged：merged 已被 SEA rebase 成机器相关的绝对路径
  //   （如 C:\Users\xxx\AppData\Local\KarpathyWiki\data\vault），固化进 config.json 会降低可移植性
  //   （换机/漫游配置会失效）。这些路径每次启动都会由 loadConfig 的 SEA rebase 块重新派生，
  //   因此落盘时把派生字段回退为相对默认值，配置保持可移植且单一真相源。
  if (IS_SEA && !fsSync.existsSync(API_CONFIG_PATH)) {
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

// 保存批量编译配置（allowedExtensions/maxBatchSize/maxFileSizeMb）到 config.json。
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

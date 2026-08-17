// 业务层类型定义。
// EngineAdapter 是阶段切换抽象点（V1.3 仅 HarnessAdapter，但接口保留为后续替换预留）。

// 上下文记忆治理模块配置类型（语义压缩/清理/重组/容量淘汰）
// 具体接口定义在引擎内，这里统一 re-export 供 AppConfig 引用
import type { ContextGovernorConfig } from './engine/context-governor.js';
export type { ContextGovernorConfig } from './engine/context-governor.js';

// RBAC 权限模块类型 re-export 便于外部统一从 types.ts 导入
// AuthConfig 本文件内 AppConfig 引用需 import type，其余类型仅 re-export 不在文件内使用
import type { AuthConfig } from './auth/types.js';
// UrlCrawlConfig 在文件内被 AppConfig.urlCrawl 字段引用，需 import type（re-export 不等于文件内可用）
import type { UrlCrawlConfig } from './utils/url-crawl.js';

export type {
  AuthRole,
  AuthPermission,
  UserRecord,
  SessionRecord,
  AuditLogEntry,
  AuditAction,
  AuthConfig,
  LoginRequest,
  LoginResponse,
  UserInfo,
  CreateUserRequest,
  UpdateUserRequest,
} from './auth/types.js';

// URL 爬取子系统类型 re-export：config.ts 从 types.ts 统一导入，避免消费端直接引用 utils 子模块
export type { UrlCrawlConfig } from './utils/url-crawl.js';

export interface EngineAdapter {
  // appConfig 可选：传入后 compile 末尾可触发 FR-10-1 ai_tags 建议生成等需要 AppConfig 的扩展逻辑
  compile(input: CompileInput, appConfig?: AppConfig): AsyncIterable<ProgressEvent>;
  // §11.2 断点续传：从中断点恢复编译
  resumeCompile(runId: string): AsyncIterable<ProgressEvent>;
  query(input: QueryInput): AsyncIterable<AnswerChunk>;
  healthCheck(): Promise<HealthReport>;
  // §4.6 一键修复：走 LLM 引擎，SSE 流式返回修复进度
  healthCheckFix(input: FixInput): AsyncIterable<FixProgressEvent>;
  // §5.2 模型即时切换：前端 ModelSelector 切换时调用，无需重启
  // provider/baseUrl/apiKey 变更需同步 LLM 实例，支持预设切换时完整更新
  // §5.2 webSearchConfig 变更需同步内存实例，避免重启服务才生效
  // 需求 4 toolsConfig 变更需同步内存实例，支持 Config 页面保存后即时生效
  updateConfig(updates: { provider?: string; baseUrl?: string; model?: string; apiKey?: string; maxSteps?: number; tokenBudget?: number; staleDays?: number; webSearchConfig?: WebSearchConfig; toolsConfig?: ToolsConfig; activeSkill?: string; systemPrompt?: string; scope?: SkillPreset['scope']; outputFormat?: string }): void;
  // FR-09-3 Podcast 生成：调用 podcast-workflow 生成脚本（+ 可选 TTS 合成）
  // 为什么放在 adapter：与其他 workflow（compile/query）一致，route 通过 adapter 调用，
  // 避免 route 直接持有 harnessConfig 私有引用
  podcast(topic: string, appConfig: AppConfig | undefined, scopeFilter?: { tags?: string[]; folder?: string }): Promise<PodcastResult>;
  // v3 视频生成：创建 Agnes Video 异步任务，返回 taskId/videoId（不阻塞，前端轮询）
  // 为什么独立于 query SSE 流：视频生成需数分钟，超出 SSE 60 秒超时，走独立 JSON 端点
  generateVideo(prompt: string, appConfig?: AppConfig): Promise<VideoTaskResult>;
  // v3 视频任务轮询：查询任务状态，完成时下载视频并归档到 vault
  pollVideoTask(taskId: string, appConfig?: AppConfig): Promise<VideoTaskResult>;
}

export interface CompileInput {
  type: 'file' | 'url' | 'text';
  // file: 文件路径；url: URL；text: 纯文本
  content: string;
  // 存档到 raw/ 的相对路径（可选，未提供时由 vault 自动生成）
  rawPath?: string;
  // 用户上传时的原始文件名（可选）。file 类型由路由层传入，用于 raw/ 存档时
  // 保留原名（去掉内部 wiki-batch-/wiki-compile- 前缀），避免用户无法识别。
  // 缺省时回退到 content 的 basename。
  originalName?: string;
}

// 批量编译配置：所有参数从 config.json 读取，禁止硬编码
// allowedExtensions: 文件夹扫描时允许的扩展名白名单（小写、不含点）
// maxBatchSize: 单次批量编译的文件数上限，防滥用与内存峰值
// maxFileSizeMb: 单文件大小上限，与 multipart fileSize 联动
export interface BatchCompileConfig {
  allowedExtensions: string[];
  maxBatchSize: number;
  maxFileSizeMb: number;
}

export interface ProgressEvent {
  // read_schema / extract / generate_page / update_index / done 等
  step: string;
  status: 'running' | 'done' | 'error';
  message: string;
  // 批量编译场景下扩展 fileIndex/fileCount/fileName，单文件编译时保持 undefined
  // 为什么放 data：避免新增顶层字段破坏现有 SSE 消费端，前端按需读取
  // path/title 保持可选：archive 步骤仅含 path，done 步骤含 path+cached，
  // page 事件才同时含 path+title（后端用 if (ev.data?.path && ev.data?.title) 守卫区分）
  data?: { path?: string; title?: string; cached?: boolean; fileIndex?: number; fileCount?: number; fileName?: string };
}

export interface QueryInput {
  question: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  // 线程隔离键：携带后由后端从本地记忆注入历史上下文，并在本地持久化该线程的会话与记忆。
  // 不携带时回退为前端透传 history（向后兼容），且后端自动创建新线程。
  // 与 §会话/线程隔离边界 对应：所有会话与记忆均按 threadId 命名空间隔离。
  threadId?: string;
  // §5.2 模式切换：'web' 联网搜索 / 'deep' 深度思考 / '' 默认
  mode?: string;
  // 是否启用联网搜索工具
  webSearch?: boolean;
  // 附件 base64 列表（data URL 格式：data:image/png;base64,xxx）
  // 为什么用 base64：IndexedDB blob 在前端，后端无法直接读取，内嵌到请求体最简单
  attachments?: Array<{ data: string; mimeType: string; filename: string }>;
  // 当前请求使用的模型（用于即时切换，覆盖 config.llm.model）
  model?: string;
  // FR-09-2 多模态输出模式：'normal'(默认) | 'mindmap' | 'faq' | 'timeline'
  // 为什么可选：未设置时走普通问答，设置非 normal 时在 done 前追加 multimodal 输出
  outputMode?: string;
  // v2 多输出模式过滤：控制 thinking/tool_call/answer/multimodal 哪些类别推送到前端
  // 为什么用数组而非 Set：JSON 序列化兼容，前端 localStorage 持久化直接存储
  outputModes?: string[];
  // §真流式开关：true 走 LLM 逐 token 推送（chatStream），false/undefined 走按句切分假流式
  // 未传时由路由层用 appConfig.llm.stream 默认值补齐
  stream?: boolean;
  // 中间件开关：query workflow 中可启用/禁用的功能模块
  // 为什么用数组而非对象：JSON 序列化兼容，前端 localStorage 持久化直接存储
  // 与已有字段（webSearch/mode/stream）关系：middlewares 优先，已有字段作为兜底兼容
  // - 'web_search' 启用联网搜索（覆盖 webSearch=false）
  // - 'deep_thinking' 启用深度思考（覆盖 mode !== 'deep'）
  // - 'extended_tools' 启用 MCP/CLI 扩展工具
  // - 'followups' 启用追问建议生成（默认开启，middlewares 不含时关闭）
  // - 'stream' 启用真流式（覆盖 stream=false）
  middlewares?: string[];
  // ── BYOK：按用户隔离的 per-request 配置覆盖项 ──
  // 设计动机（需求：AI 服务 / 搜索引擎 / 工具配置按用户隔离，各用户独立额度、互不抢占限流）：
  //   前端在「配置」页按当前登录用户保存各自的 API 信息（存浏览器 IndexedDB，密钥不落服务端磁盘），
  //   每次问答请求随 body 携带，后端以其覆盖服务端共享配置，再由 harness 用该用户自己的密钥调 LLM/搜索。
  //   密钥仅经此请求体一次性下发，后端不持久化；软件升级/重装不影响用户本地配置。
  // llmConfig：覆盖 harnessConfig.llm（provider/baseUrl/model/apiKey）。
  //   缺失或 apiKey 为空 → 后端拒绝（强制每用户各自配置，不允许服务端共享默认密钥兜底）。
  llmConfig?: { provider: string; baseUrl: string; model: string; apiKey: string };
  // searchConfig：覆盖 webSearchConfig（provider/apiKey/maxResults）；缺 apiKey 时回退服务端配置。
  searchConfig?: { provider: 'tavily' | 'bing'; apiKey: string; maxResults?: number };
  // toolsConfig：用户维度工具集（MCP/CLI/场景路由）。始终下发，整体替换服务端共享工具配置，
  //   避免某用户沿用服务端共享 MCP/CLI（即"各用户调用自己配置"的隔离要求）。
  toolsConfig?: ToolsConfig;
}

// 思考步骤：与前端 ThinkingStep 类型对齐
export interface ThinkingChunk {
  phase: 'thinking' | 'tool_call' | 'composing';
  message: string;
  tool?: string;
  args?: Record<string, unknown>;
  // v2 单步耗时时间戳：前端据此计算每步思考耗时
  ts?: string;
}

// §5.2 联网搜索引用：与本地 [[页面名]] 引用并行返回。
// 区分本地与外部来源，前端 RefsList 可差异化渲染（本地走内链，外部走外链 + URL 图标）
export interface WebRef {
  title: string;
  url: string;
  snippet: string;
}

export interface AnswerChunk {
  // 流式答案片段
  text?: string;
  // [[页面名]] 引用（本地 vault 页面）
  refs?: string[];
  // §5.2 联网搜索外部链接引用（与 refs 并行）
  webRefs?: WebRef[];
  done?: boolean;
  // §5.2 思考过程推送（前端 ThinkingBlock 渲染）
  thinking?: ThinkingChunk;
  // §5.2 联网搜索进度推送
  progress?: { step: string; count?: number };
  // §5.2 图片推送（多模态场景）
  // archivePath: 下载归档到 vault queries/ 后的相对路径，前端用它构造 /api/files 访问
  image?: { url: string; alt: string; width?: number; height?: number; archivePath?: string };
  // v3 PPT 推送：LLM 生成的 Marp Markdown，前端用 @marp-team/marp-core 渲染为幻灯片
  ppt?: { markdown: string; title: string; archivePath: string };
  // §5.2 追问建议
  followups?: string[];
  // §5.1 done 事件附带的会话信息（供归档用）
  sessionId?: string;
  messageIndex?: number;
  // FR-09-2 多模态结构化输出：done 前追加的思维导图/FAQ/时间线
  multimodal?: MultimodalOutput;
  // §X-1 步骤级追踪：本次问答对应的 harness runId，前端凭此调 /api/query/runs/:runId
  //   拉取每步耗时分解（llmMs/toolMs/tokens/toolNames），定位 143s/282s 级长耗时瓶颈。
  //   缺省不携带：仅 harness 路径（非流式/流式）在 done 事件附上，降级链兜底不携带。
  runId?: string;
}

export interface HealthReport {
  // 孤立页面路径
  orphans: string[];
  brokenLinks: Array<{ from: string; to: string }>;
  // 过期页面路径
  stale: string[];
}

// §4.6 一键修复输入。issueType 区分修复策略，target 是具体问题目标。
// broken_link 时 target 含 from/to；orphan 时 target 是页面路径字符串。
export interface FixInput {
  issueType: 'broken_link' | 'orphan';
  target: { from: string; to: string } | string;
}

// §5.2 fix 事件 schema（L-6）：scan/fixing/fixed/done 四类步骤
export interface FixProgressEvent {
  // scan（扫描）/ fixing（修复中）/ fixed（已修复）/ done（结束）/ update_log
  step: string;
  status: 'running' | 'done' | 'error';
  message: string;
  tool?: string;
  data?: { path?: string };
}

// 批量修复请求体：items 为单个修复任务的有序列表，后端按顺序串行执行。
// 为什么串行而非并发：fix 可能写入 vault 文件，并发会导致同一文件交错写入；
// 复用 withCompileLock 队列与 compile 互斥，避免 index.md/log.md 追加竞态。
export interface BatchFixRequest {
  items: FixInput[];
}

// 批量修复 SSE 事件：包装单个 FixProgressEvent 并附带定位信息。
// - issueIndex：当前修复在 items 数组中的下标（0-based）
// - totalIssues：items 总数，前端据此显示 "3/10" 进度
// - issueKey：前端生成的稳定 key（如 "orphan:foo.md"），便于日志与按钮状态联动
// - issueDone：当前问题是否已完成（fixed/done/error 都算结束），前端据此启用下一个按钮
export interface BatchFixProgressEvent extends FixProgressEvent {
  issueIndex: number;
  totalIssues: number;
  issueKey: string;
  issueDone: boolean;
}

// 内网穿透配置（参考 17_xianyu 项目，适配本架构）。
// localPort=0 表示从 server.port 继承；cpolarAuthtoken 仅 cpolar provider 需要。
// tunnelMode/hostname 等 named tunnel 字段仅 cloudflare provider + named 模式生效。
export interface TunnelConfig {
  provider: 'cloudflare' | 'cpolar' | 'tailscale';
  localPort: number;
  cpolarAuthtoken: string;
  binaryPath: string;
  autoStart: boolean;
  // Cloudflare Named Tunnel：固定域名模式（参考 17_xianyu）
  // quick=临时 trycloudflare 域名（每次重启变化）；named=固定域名（需三步向导配置）
  tunnelMode: 'quick' | 'named';
  tunnelName: string;
  tunnelId: string;
  credentialsFile: string;
  hostname: string;
  certFile: string;
  // Tailscale path prefix：'/wiki/' 用于同 ts.net host 多应用共存场景区分路由
  // 空字符串表示根路径模式（向后兼容旧配置）
  pathPrefix: string;
}

export interface WebSearchConfig {
  provider: 'tavily' | 'bing';
  apiKeyRef: string;
  apiKey?: string;
  maxResults?: number;
}

// 日志配置：控制 Fastify pino logger 级别与请求级日志开关
// 为什么需要：前端报错时后端日志无反馈，需可配置的请求级日志覆盖 HTTP 层
export interface LoggingConfig {
  // pino 日志级别：'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
  level: string;
  // 是否启用 onRequest/onResponse/onError 钩子记录每个 HTTP 请求
  enableRequestLog: boolean;
  // 日志文件落盘路径（相对 api/ 目录解析，与 vaultPath 风格一致）
  // 为什么可选：未配置时仅输出到 stdout，进程退出后日志丢失，配置后双写 stdout + 文件便于事后排障
  // 空串/undefined 表示禁用文件落盘，仅控制台输出
  logFilePath?: string;
}

// 应用配置。
// apiKeyRef 引用环境变量名（向后兼容）；apiKey 可选，前端配置时写入 config.json。
// 读取优先级：config.json.llm.apiKey > process.env[apiKeyRef]（M-7 安全要求）。
// apiKeys：按 provider 索引的多 key 持久化表，切换预设时自动迁移当前 key 到 apiKeys[旧provider]，
//   并从 apiKeys[新provider] 恢复 key，避免切换预设后 apiKey 仍显示旧 provider 的值。
//   为什么需要：单 apiKey 字段在预设切换时无法区分 provider 来源，导致 APIKEY 未跟随模型切换错误显示。
export interface AppConfig {
  vaultPath: string;
  // V1.3 仅 harness
  adapter: 'harness';
  // §真流式开关：stream=true 时 queryWorkflow 走 LLM 逐 token 推送（chatStream）
  // 为什么可选：保留向后兼容，老配置文件无此字段时 queryWorkflow 内部用 false 兜底
  // 权威源：后端 config.json 是默认值，前端可每次请求 body.stream 覆盖
  llm: { provider: string; baseUrl: string; model: string; apiKeyRef: string; apiKey?: string; apiKeys?: Record<string, string>; stream?: boolean };
  budget: { maxSteps: number; tokenBudget: number };
  server: { host: string; port: number };
  localOnly: boolean;
  healthCheck: { staleDays: number };
  tunnel: TunnelConfig;
  webSearch?: WebSearchConfig;
  logging?: LoggingConfig;
  // 批量编译配置：可选，缺失时由 defaultConfig 提供默认值
  batch?: BatchCompileConfig;
  // 可扩展工具配置：MCP 服务器 / CLI 工具 / 场景路由，缺失时无扩展工具
  tools?: ToolsConfig;
  // RBAC 权限管理配置：缺失时使用默认值（启用权限控制 + 默认参数）
  // 为什么可选：保留向后兼容，老配置文件无此字段时不阻断启动
  auth?: AuthConfig;
  // QQ 聊天记录导入子系统配置（qq-ingest/）：缺失时使用 defaultConfig 提供的默认值
  // 为什么可选：保留向后兼容，老配置文件无此字段时不阻断启动；不使用 QQ 导入功能的项目可忽略
  qq?: QqConfig;
  // FR-13-2 OCR config: independent from llm, allows configuring a vision-capable model for OCR
  // Why optional: when not configured, resolveOcrConfig falls back to llm config
  ocr?: OcrConfig;
  // FR-13-3 Audio transcription config: independent from llm for STT (Speech-to-Text)
  // Why optional: when not configured, resolveAudioConfig falls back to llm config;
  // audio/video uploads return error message prompting user to configure audio endpoint
  audio?: AudioConfig;
  // FR-09-3 Podcast config: TTS provider/voice settings for audio overview generation
  // Why optional: when not configured, podcast workflow only generates script without audio
  podcast?: PodcastConfig;
  // URL 爬取子系统配置：缺失时由 DEFAULT_CRAWL_CONFIG 提供默认值
  // 为什么可选：保留向后兼容，不使用 URL 爬取功能的老配置文件无需添加此字段
  urlCrawl?: UrlCrawlConfig;
  // FR-12 AI 伙伴预设列表（V3.1 新增）
  // 为什么可选：保留向后兼容，老配置文件无此字段时不阻断启动
  skills?: SkillPreset[];
  // 当前激活的 AI 伙伴 id（空=无预设，使用默认 query 行为）
  activeSkill?: string;
  // v3 媒体生成配置：Agnes Image/Video API 参数
  // 为什么可选：保留向后兼容，老配置文件无此字段时使用 defaultConfig 提供的默认值
  media?: MediaConfig;
  // 会话持久化配置（对应「问答会话本地存储 + 线程隔离 + 本地记忆」需求）
  // 默认 threadsPersist/conversationsPersist 均为 false：服务端不落盘会话（SRS 核心需求「会话不存服务端、仅本地维护」）。
  // 背景：本应用已引入多用户注册，服务端落盘会话会违反「注册用户间数据隔离 + 会话不上服务端」要求；
  //   会话历史唯一权威源为前端 IndexedDB（含 ownerId 隔离），Query 始终携带完整 history 兜底连续性。
  // threadsPersist=false：ThreadMemoryStore 不写 data/threads/，getHistoryContext 恒返回 []。
  // conversationsPersist=false：/api/conversations 路由族不注册，服务端不暴露任何会话 CRUD 端点（FR-RM-04/FR-RM-08）。
  // 如需开启（单用户本地优先调试）可在 config.json 的 sessionPersistence 显式设 true。
  // 为什么可选：保留向后兼容，老配置文件无此字段时由 defaultConfig 提供默认值（均为 false）。
  sessionPersistence?: { threadsPersist?: boolean; conversationsPersist?: boolean };
  // 上下文记忆治理配置（对应「上下文窗口受限场景下的对话历史主动管理」需求）
  // 默认开启：在把线程记忆注入 LLM 前，自动做语义压缩/清理/重组/容量淘汰。
  // 为什么可选：保留向后兼容，老配置文件无此字段时由 defaultConfig 提供默认值（开启）。
  contextGovernor?: ContextGovernorConfig;
  // 子智能体（多步 Agent）开关：开启时主问答路径自动注册 researcher 子智能体，
  // 父智能体可委派其在隔离上下文独立检索/研读知识库。默认关闭（零破坏，聚焦问答不受影响）。
  // 为什么可选：保留向后兼容，老配置文件无此字段时由 defaultConfig 提供默认值（false）。
  enableSubAgents?: boolean;
  // X-2 可恢复流式（resumable streaming）开关：开启后问答运行与 HTTP 请求解耦，
  // 客户端刷新/断网可凭 runId 重连继续接收同一响应，避免重跑昂贵的长耗时问答。
  // 默认关闭（零破坏）：关闭时路由走原有内联 SSE，完全不启用 StreamRunManager。
  // 为什么可选：保留向后兼容，老配置文件无此字段时由 defaultConfig 提供默认值（false）。
  enableResumableStream?: boolean;
}


// FR-13-2 OCR configuration structure
// apiKeyRef references env var name (backward compat); apiKey optional, written to config.json from frontend
// Read priority: config.json.ocr.apiKey > process.env[apiKeyRef] > fallback to llm config
export interface OcrConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyRef?: string;
  apiKey?: string;
}

// FR-13-3 Audio/Video transcription configuration
// Why independent from llm: main LLM may not support audio transcription (e.g., deepseek-chat),
// user may configure a dedicated Whisper/audio model endpoint
// Read priority: config.json.audio.apiKey > process.env[apiKeyRef] > fallback to llm config
export interface AudioConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyRef?: string;
  apiKey?: string;
}

// FR-09-3 Podcast (Audio Overview) configuration
// Why independent from llm: podcast TTS may use a different voice model (e.g., doubao-tts) than the main LLM
// Why optional: when not configured, podcast workflow only generates script without audio synthesis
export interface PodcastConfig {
  // TTS provider: doubao / openai / minimax (only doubao has backend stub)
  ttsProvider: string;
  // TTS API base URL (e.g., https://openspeech.bytedance.com)
  ttsBaseUrl: string;
  // TTS API key (optional: read from env var ttsApiKeyRef if not set)
  ttsApiKey?: string;
  ttsApiKeyRef?: string;
  // Voice ID for Host A (e.g., BV001_streaming)
  voiceA?: string;
  // Voice ID for Host B (e.g., BV002_streaming)
  voiceB?: string;
  // Speech rate (0.5 - 2.0, default 1.0)
  rate?: number;
}

// FR-09-3 Podcast generation result
export interface PodcastResult {
  // Generated script (Markdown with ## Host A/B sections)
  script: string;
  // Audio file paths relative to vault (empty when TTS not configured)
  audioFiles: string[];
  // Total duration in seconds (estimated from script length when TTS not available)
  durationSec: number;
  // Archive path under queries/ (e.g., queries/podcast-20260728-120000.md)
  archivePath: string;
  // Whether TTS synthesis was performed
  ttsEnabled: boolean;
}

// v3 媒体生成配置：Agnes Image/Video API 参数
// 为什么独立于 llm：图像/视频生成是专用模型，与主 LLM（如 deepseek-chat）解耦
// API key 优先级：media.agnes.apiKey > llm.apiKeys.agnes > process.env[apiKeyRef]
export interface MediaConfig {
  agnes: {
    // API base URL（OpenAI 兼容接口）
    baseUrl: string;
    // 环境变量名（向后兼容，与 apiKey 互斥）
    apiKeyRef: string;
    // 直接配置的 API key（可选，与 llm.apiKeys.agnes 互斥）
    apiKey?: string;
    // 图像生成模型名
    imageModel: string;
    // 视频生成模型名
    videoModel: string;
    // 默认图像尺寸（如 1024x768）
    defaultImageSize: string;
    // 默认图像比例（如 16:9）
    defaultImageRatio: string;
    // 默认视频尺寸（如 1280x720）
    defaultVideoSize: string;
    // 默认视频时长（秒）
    defaultVideoSeconds: number;
  };
}

// v3 视频生成异步任务结果
// 为什么独立接口：视频生成是异步任务，需轮询状态，与同步的 query/podcast 结果结构不同
export interface VideoTaskResult {
  // Agnes 任务 ID（创建任务时返回）
  taskId: string;
  // Agnes 视频 ID（轮询状态时用）
  videoId: string;
  // 任务状态：queued(排队) → processing(生成中) → completed(完成) / failed(失败)
  status: 'queued' | 'processing' | 'completed' | 'failed';
  // 进度百分比 0-100
  progress: number;
  // 完成后的视频下载 URL（仅 completed 时有值）
  url?: string;
  // 下载归档到 vault queries/ 后的相对路径（仅 completed 时有值）
  archivePath?: string;
  // 失败原因（仅 failed 时有值）
  error?: string;
}

// FR-09-2 多模态结构化输出：query 主问答完成后追加的思维导图/FAQ/时间线/图像/PPT
// 为什么独立接口：多种模式共享 content 字段，type 区分渲染方式
export interface MultimodalOutput {
  type: 'mindmap' | 'faq' | 'timeline' | 'image' | 'ppt';
  content: string;
  // image 模式：图片访问 URL（公开路由 /api/media/file/...，无需认证，浏览器 <img> 可直接加载）
  imageUrl?: string;
  // ppt 模式：Marp Markdown 源码，前端用 @marp-team/marp-core 渲染
  pptMarkdown?: string;
}

// FR-12 AI 伙伴预设：config.json skills 数组项
// 为什么独立于 toolsConfig：Skills 是预设的概念组合（模型+范围+提示词+工具子集），
//   toolsConfig 是底层工具注册配置，两者层级不同
export interface SkillPreset {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  // 可选覆盖 LLM 模型（未设置时使用全局默认）
  model?: string;
  // 检索范围限定：'all' 全库 | { tags: [...] } 标签过滤 | { folder: '...' } 目录过滤
  scope: 'all' | { tags?: string[]; folder?: string };
  // 额外系统提示词（追加到 query prompt 末尾，非替换）
  systemPrompt?: string;
  // 输出格式偏好：qa(问答)/summary(摘要)/podcast(播客)
  outputFormat?: string;
  // 工具子集（空数组=不限制，使用 queryWorkflow 默认工具集）
  tools?: string[];
}

// ============================================================================
// 数据清洗模块类型（data-clean/）
// 被 dedup-engine.ts / quality-scanner.ts / diff-engine.ts / scheduler-manager.ts 共享
// ============================================================================

// 页面质量评分：scanVault 返回的单页评估结果
export interface PageQualityScore {
  path: string;
  title: string;
  qualityScore: number;
  category: {
    length: number;
    links: number;
    frontmatter: number;
    citations: number;
    duplicate: number;
    freshness: number;
  };
  metadata: {
    wordCount: number;
    lineCount: number;
    internalLinks: number;
    inboundLinks: number;
    lastModified: string;
    hasFrontmatter: boolean;
    isDraft: boolean;
    fileSizeBytes: number;
    hasBom: boolean;
    encoding: string;
    directory: string;
  };
  issues: Array<{ code: string; severity: string; detail: string }>;
  suggestions: Array<{ type: string; detail: string; actionable: boolean }>;
}

// 重复页面对：deduplicatePages 两两判定结果
export interface DuplicatePair {
  pageA: PageQualityScore;
  pageB: PageQualityScore;
  similarity: number;
  matchType: 'exact' | 'near-duplicate' | 'semantic-similar';
  reason: string;
}

// 去重结果：deduplicatePages 返回的汇总
export interface DeduplicateResult {
  matches: DuplicatePair[];
  scannedPages: number;
  uniquePages: number;
  duplicateGroups: Array<{ pages: string[]; representativePath: string; totalWordsInGroup?: number }>;
}

// 合并结果：mergeDuplicatePages 返回
// kept/mergedFrom/updatesApplied/errors/dryRun 为必填：mergeDuplicatePages 初始化时即赋值
// linkReplacements/archiveResult 为可选：仅在链接替换或归档操作实际发生时赋值
export interface MergeResult {
  kept: string;
  mergedFrom: string[];
  updatesApplied: number;
  errors: string[];
  dryRun: boolean;
  linkReplacements?: number;
  archiveResult?: { archived: string[]; errors: string[] };
}

// 预检结果：precheckVault 返回的编码/frontmatter 健康检查
export interface PrecheckResult {
  scannedFiles: number;
  passed: boolean;
  warnings: string[];
  errors: string[];
  blocked: boolean;
}

// 定时扫描计划：scheduler-manager 持久化到 JSON 的调度配置
// lastRun/lastResult 可选：新建计划时尚未执行过扫描
export interface ScanSchedule {
  id: string;
  cron: string;
  enabled: boolean;
  lastRun?: string | null;
  lastResult?: { scannedFiles: number; passed: boolean } | null;
}

// 行级差异：diff-engine compareFiles 返回的单行 diff
export interface DiffLine {
  type: 'context' | 'add' | 'del';
  content: string;
  oldLine?: number;
  newLine?: number;
}

// 差异对比结果：diff-engine compareFiles 返回
export interface DiffResult {
  pathA: string;
  pathB: string;
  lines: DiffLine[];
  summary: {
    added: number;
    removed: number;
    unchanged: number;
    similarity: number;
  };
}

// MCP 服务器配置项。
// transport 三种模式：stdio（本地子进程）/ sse（HTTP+SSE）/ http（Streamable HTTP）。
// stdio 模式需要 command+args；sse/http 模式需要 url。
// env 注入子进程环境变量（如 API Key），避免命令行参数泄露。
//   注意：env 仅 stdio 模式生效，http/sse 模式不传递 env（避免 header 泄露 API Key）。
// timeoutMs：JSON-RPC 请求超时（ms），缺失时用 tools.mcpTimeoutMs 或内置默认值。
// triggerKeywords：懒加载触发关键词。非空时，只在用户问题命中任一关键词才连接该 MCP 服务器；
//   空数组/缺失时 auto 模式始终加载（保持兼容）。用于区分 Sequential Thinking 和 Excel 等使用场景。
// placeholderTools：懒加载占位工具列表。未触发关键词时注册占位 ToolDefinition，
//   让 LLM 从 name/description 感知可用能力，实际调用时才连接 MCP 并发现真实工具。
export interface McpServerEntry {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  // RPC 超时（ms），per-server 覆盖 tools.mcpTimeoutMs
  timeoutMs?: number;
  enabled: boolean;
  // 懒加载触发关键词（小写匹配，任一命中即启用）
  triggerKeywords?: string[];
  // 懒加载占位工具：name 为工具名（不含 mcp__server__ 前缀，buildLazyToolDef 会自动加上），
  // description 描述能力，parameters 为 JSON Schema
  placeholderTools?: Array<{
    name: string;
    description: string;
    parameters?: object;
  }>;
}

// CLI 工具配置项。
// command 必须在 CLI_EXECUTOR_WHITELIST 白名单内（防注入）。
// argsTemplate 支持 {input} 占位符，由 LLM 工具参数填充。
// timeoutMs 缺省由配置决定，防止恶意长时占用。
export interface CliToolEntry {
  name: string;
  command: string;
  argsTemplate?: string;
  description: string;
  timeoutMs?: number;
  enabled: boolean;
}

// 场景路由规则：关键词命中时启用指定工具。
// tools 字段为工具名列表（MCP 工具名格式：mcp__{server}__{tool}；CLI 工具名即 name）。
export interface SceneRule {
  name: string;
  keywords: string[];
  tools: string[];
  enabled: boolean;
}

// 工具配置总入口。
// routerMode: 'keyword' 关键词匹配场景工具 | 'auto' 注入所有启用工具让 LLM 自主决策。
// mcpTimeoutMs: MCP JSON-RPC 请求全局默认超时（ms），per-server 可用 McpServerEntry.timeoutMs 覆盖。
export interface ToolsConfig {
  mcpServers: McpServerEntry[];
  cliTools: CliToolEntry[];
  scenes: SceneRule[];
  routerMode: 'keyword' | 'auto';
  mcpTimeoutMs?: number;
}

// LLM 预设项（GET /api/ai/presets）。
// 数据源：api/llm-presets.json（外置 JSON，运维可编辑增删厂商预设）。
// vision 字段（F-3.5）：标识模型是否支持图片输入，前端据此决定图片按钮是否灰显。
// 与前端 types.ts 的 LlmPreset 接口对齐（type-sync-rule）。
export interface LlmPreset {
  key: string;
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyRef: string;
  apiKeyUrl: string;
  vision?: boolean;
}

// ===== 系统清理模块类型 =====
// 参考闲鱼项目系统清理模块设计，适配 wiki 项目（无数据库/无浏览器/Node.js 文件系统）。
// 核心机制：dry_run 预览 + 浏览器原生二次确认 + 审计日志 + 4 类清理对象独立配置。

// 清理请求体（4 类清理对象共用同一模型）
// - target: 清理目标，空时由路由默认为 'all'
// - days: 保留天数，仅 run_logs/raw_archive 使用（compile_cache/run_state 与时间无关）
// - dry_run: 预览模式，true 时只列出将删除项不实际执行
export interface CleanupRequest {
  target: string;
  days: number;
  dry_run: boolean;
}

// 清理结果统一结构
export interface CleanupResult {
  target: string;
  days: number;
  dry_run: boolean;
  // 成功列表（dry_run 模式下前缀 [预览]）
  cleaned: string[];
  // 错误列表（任一子项失败不影响其他子项）
  errors: string[];
  // 成功项数
  count: number;
  // 释放空间（MB），仅 run_logs/raw_archive 适用
  totalFreedMb?: number;
}

// 存储状态总览（GET /api/cleanup/status 返回结构）
// 统计范围必须与实际清理范围严格一致，避免「显示 0MB 但清理 271 项」歧义
export interface CleanupStorageStatus {
  // 编译缓存：.harness/compile-cache.json
  compileCache: {
    exists: boolean;
    sizeMb: number;
    entryCount: number;
  };
  // 运行状态：.harness/state/*.json
  runState: {
    fileCount: number;
    sizeMb: number;
    oldest: string | null;
  };
  // 运行日志：.harness/logs/*.log
  runLogs: {
    fileCount: number;
    sizeMb: number;
    oldest: string | null;
  };
  // 原始资料存档：vault/raw/ 下内部临时前缀文件（wiki-batch-*/wiki-compile-*/input-*）
  rawArchive: {
    fileCount: number;
    sizeMb: number;
    oldest: string | null;
  };
}

// ============================================================================
// QQ 聊天记录导入子系统（qq-ingest/）类型定义
// 对应 SRS §6.3，由 qq-preprocess.ts / qq-ingest routes / qq-extract.md 共享
// ============================================================================

// QQ 导入子系统配置：所有参数集中管理，遵循"配置化无硬编码"硬约束
// - noise_rules: 噪声过滤规则开关表（key=规则名，value=是否启用）
// - privacy_patterns: PII 脱敏正则表（key=规则名，value=正则字符串）
//   为什么用字符串而非 RegExp：JSON 不支持正则字面量，运行时由 qq-preprocess 编译
// - max_batch_size: 单次批量抽取的对话块上限，防 LLM 上下文溢出
// - chunk_threshold: 长群聊分块阈值（消息条数），超过则按时间窗口切分
// - extract_model: 价值抽取专用模型（可与主 llm.model 不同，支持按任务选型）
// - extract_base_url: 抽取专用模型 baseUrl（OpenAI 兼容协议）
//   为什么独立：extract_model 可能用不同 provider（如 glm-4-plus vs 主 model agnes-2.0-flash），
//   需独立 baseUrl 避免请求发错端点
// - extract_token_budget: 抽取阶段 token 预算上限，独立于 budget.tokenBudget
//   为什么独立：抽取任务长文本场景多，避免与编译任务争用预算
export interface QqConfig {
  noise_rules: Record<string, boolean>;
  privacy_patterns: Record<string, string>;
  max_batch_size: number;
  chunk_threshold: number;
  extract_model: string;
  extract_base_url: string;
  extract_token_budget: number;
}

// 预清洗阶段输出结构（POST /api/qq-ingest/preview 与 extract 内部共用）
// - rawId: UUID v4，作为整条流水线的唯一标识，用于 draft/compile 阶段溯源
// - meta: 统计元数据，前端进度条与 Browse 视图审核页消费
//   - chatName: 群名/好友昵称（从导出文件头部解析）
//   - dateRange: "YYYY-MM-DD ~ YYYY-MM-DD" 时间跨度
//   - originalCount: 原始消息条数（含噪声）
//   - filteredCount: 噪声过滤后保留条数
//   - redactedCount: 触发 PII 脱敏替换的消息条数
// - rawPath: 落盘到 vault/raw/ 的相对路径（如 "raw/qq-xxx-20260722.json"）
//   为什么落盘：raw/ 不可变是 Karpathy 三层架构硬约束，draft/compile 需基于存档而非内存
export interface QqPreprocessResult {
  rawId: string;
  meta: {
    chatName: string;
    dateRange: string;
    originalCount: number;
    filteredCount: number;
    redactedCount: number;
  };
  rawPath: string;
}

// 价值抽取阶段输出结构（POST /api/qq-ingest/extract 的 SSE done 事件 payload）
// qaPairs 与 solutions 均为候选 draft，需人工审核后才能触发 compile
export interface QqExtractResult {
  qaPairs: QaPair[];
  solutions: QqSolution[];
}

// 业务 Q&A 配对（抽取自群聊中的问答对话）
// - answerer: 答复者昵称（脱敏后保留，用于 frontmatter author 字段）
// - ts: ISO8601 时间戳，对应原文消息时间
// - context: 问答上下文（前后 N 条消息摘要），帮助审核者理解场景
// - original_refs: 原文片段引用数组（RAG 证据约束：LLM 必须基于原文，禁止编造）
//   为什么是数组：一条 Q&A 可能由多条原始消息综合而成
// - tags: LLM 自动标注的标签（如 ["部署","报错"]），用于 compile 阶段归类
export interface QaPair {
  question: string;
  answer: string;
  answerer: string;
  ts: string;
  context: string;
  original_refs: string[];
  tags: string[];
}

// 问题解决方案沉淀（抽取自群聊中"问题描述→排查→解决"的完整片段）
// - background: 问题背景描述（业务场景、触发条件）
// - steps: 解决步骤数组（有序列表，每项为一个操作步骤）
// - caveats: 注意事项/坑点（LLM 从对话中提取的避坑提示）
// - original_refs: 原文片段引用（RAG 证据约束）
// - ts: 首条相关消息的 ISO8601 时间戳
export interface QqSolution {
  title: string;
  background: string;
  steps: string[];
  caveats: string;
  original_refs: string[];
  ts: string;
}

// ============================================================================
// 技能（Skill）导入子系统类型定义
// 对应需求 3：支持上传 ZIP 压缩包或 .skill 格式文件的技能导入功能。
// 存储路径：karpathy-wiki/data/skills/{skillId}/
// 文件格式：.skill（ZIP 归档主格式，内含 SKILL.md + 可选 config/references/assets 等子目录）
//          或 .md（纯 Markdown 辅格式，单文件技能）
// ============================================================================

// 技能元数据（GET /api/skills 列表项 + GET /api/skills/:id 详情头）
// - id: 技能唯一标识（导入时从文件名派生，白名单清洗后作为目录名）
// - name: 技能名称（从 SKILL.md frontmatter name 字段或文件名派生）
// - description: 技能描述（从 SKILL.md frontmatter description 字段或首段文本派生）
// - format: 导入文件格式（'zip' ZIP 归档 | 'md' 纯 Markdown）
// - importedAt: 导入时间戳（ISO8601，落盘时生成）
// - size: 技能目录占用字节数（导入时计算，便于用户感知存储占用）
// - entryFile: 入口文件相对路径（如 'SKILL.md' 或 'skill.md'）
export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  format: 'zip' | 'md';
  importedAt: string;
  size: number;
  entryFile: string;
}

// 技能详情（GET /api/skills/:id 返回）
// 在 SkillMeta 基础上扩展内容字段，供前端预览技能全文
export interface SkillDetail extends SkillMeta {
  // SKILL.md 文件全文内容（Markdown）
  content: string;
  // 技能目录下所有文件相对路径列表（便于前端展示技能结构树）
  files: string[];
}

// 技能导入请求体（POST /api/skills/import multipart 上传）
// 由 multipart 解析后填充，file 字段为上传的 ZIP 或 .md 文件
export interface SkillImportResult {
  ok: boolean;
  skill: SkillMeta;
  // 警告信息列表（如跳过的非法文件、超出大小限制的单文件等，不阻断导入但需告知用户）
  warnings: string[];
}

// 技能导入校验错误（POST /api/skills/import 返回 400/500 时）
export interface SkillImportError {
  error: string;
  details?: string;
}

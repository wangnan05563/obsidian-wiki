// 业务层类型定义。
// EngineAdapter 是阶段切换抽象点（V1.3 仅 HarnessAdapter，但接口保留为后续替换预留）。

// RBAC 权限模块类型 re-export 便于外部统一从 types.ts 导入
// AuthConfig 本文件内 AppConfig 引用需 import type，其余类型仅 re-export 不在文件内使用
import type { AuthConfig } from './auth/types.js';

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

export interface EngineAdapter {
  compile(input: CompileInput): AsyncIterable<ProgressEvent>;
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
  updateConfig(updates: { provider?: string; baseUrl?: string; model?: string; apiKey?: string; maxSteps?: number; tokenBudget?: number; staleDays?: number; webSearchConfig?: WebSearchConfig; toolsConfig?: ToolsConfig }): void;
}

export interface CompileInput {
  type: 'file' | 'url' | 'text';
  // file: 文件路径；url: URL；text: 纯文本
  content: string;
  // 存档到 raw/ 的相对路径（可选，未提供时由 vault 自动生成）
  rawPath?: string;
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
  // §5.2 模式切换：'web' 联网搜索 / 'deep' 深度思考 / '' 默认
  mode?: string;
  // 是否启用联网搜索工具
  webSearch?: boolean;
  // 附件 base64 列表（data URL 格式：data:image/png;base64,xxx）
  // 为什么用 base64：IndexedDB blob 在前端，后端无法直接读取，内嵌到请求体最简单
  attachments?: Array<{ data: string; mimeType: string; filename: string }>;
  // 当前请求使用的模型（用于即时切换，覆盖 config.llm.model）
  model?: string;
}

// 思考步骤：与前端 ThinkingStep 类型对齐
export interface ThinkingChunk {
  phase: 'thinking' | 'tool_call' | 'composing';
  message: string;
  tool?: string;
  args?: Record<string, unknown>;
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
  image?: { url: string; alt: string; width?: number; height?: number };
  // §5.2 追问建议
  followups?: string[];
  // §5.1 done 事件附带的会话信息（供归档用）
  sessionId?: string;
  messageIndex?: number;
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
}

// 应用配置。
// apiKeyRef 引用环境变量名（向后兼容）；apiKey 可选，前端配置时写入 config.json。
// 读取优先级：config.json.llm.apiKey > process.env[apiKeyRef]（M-7 安全要求）。
export interface AppConfig {
  vaultPath: string;
  // V1.3 仅 harness
  adapter: 'harness';
  llm: { provider: string; baseUrl: string; model: string; apiKeyRef: string; apiKey?: string };
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
}

// MCP 服务器配置项。
// transport 三种模式：stdio（本地子进程）/ sse（HTTP+SSE）/ http（Streamable HTTP）。
// stdio 模式需要 command+args；sse/http 模式需要 url。
// env 注入子进程环境变量（如 API Key），避免命令行参数泄露。
//   注意：env 仅 stdio 模式生效，http/sse 模式不传递 env（避免 header 泄露 API Key）。
// timeoutMs：JSON-RPC 请求超时（ms），缺失时用 tools.mcpTimeoutMs 或内置默认值。
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
  // 原始资料存档：vault/raw/input-*.md
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

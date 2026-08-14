// SSE 事件相关类型定义
// 后端按 step 推送进度，这里保持与后端字段对齐

export type CompileStep =
  | 'archive'
  | 'read_schema'
  | 'extract'
  | 'generate_page'
  | 'finalize';

export type StepStatus = 'running' | 'done' | 'error';

export interface ProgressData {
  step: CompileStep;
  status: StepStatus;
  message: string;
  // generate_page 步骤会附带生成的页面信息；done 事件可能带 cached 标识
  // 批量编译场景下扩展 fileIndex/fileCount/fileName，单文件编译时为 undefined
  // path/title 保持可选：与后端 ProgressEvent.data 对齐（BR-026）
  // archive 步骤仅含 path，done 步骤含 path+cached，page 事件才同时含 path+title
  data?: {
    path?: string;
    title?: string;
    cached?: boolean;
    fileIndex?: number;
    fileCount?: number;
    fileName?: string;
    rejected?: Array<{ name: string; reason: string }>;
  };
}

export interface DoneData {
  pages: string[];
  indexUpdated: boolean;
  // §11.2 增量编译：命中缓存时后端会带 cached=true
  cached?: boolean;
}

// §12.3-7 热加载响应（POST /api/config/reload）
export interface ReloadResult {
  ok: boolean;
  applied: {
    model: string;
    maxSteps: number;
    tokenBudget: number;
    staleDays: number;
  };
  requireRestart: string[];
}

// §11.2 断点续传：历史编译任务摘要（GET /api/compile/runs）
export interface RunSummary {
  runId: string;
  status: 'done' | 'failed' | 'running';
  step: number;
  tokenUsed: number;
  startedAt: string;
}

// §12.3-8 日志条目（GET /api/compile/runs/:runId/log）
export interface RunLogEntry {
  ts: string;
  runId: string;
  step: number;
  event: 'step' | 'done' | 'error';
  tool?: string;
  tokenUsed?: number;
  message: string;
  error?: string;
}

// 时间线中展示的单条记录
export interface TimelineItem {
  step: CompileStep;
  status: StepStatus;
  message: string;
  page?: { path: string; title: string };
  timestamp: number;
}

// 投递载荷：文件用 FormData，URL/文本走 JSON
export type IngestPayload = FormData | { type: 'url' | 'text'; content: string };

// 批量编译相关类型

// 批量编译开始事件 (batch_start) 数据
export interface BatchStartData {
  fileCount: number;
  rejected: Array<{ name: string; reason: string }>;
}

// 单个文件的批量编译分组：包含该文件的所有时间线项与状态
export interface BatchFileGroup {
  fileIndex: number;
  fileName: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  timeline: TimelineItem[];
  pages: Array<{ path: string; title: string }>;
  errorMessage?: string;
}

// Element Plus UploadFile 兼容类型（避免直接引入复杂类型）
export interface UploadFileLike {
  raw: File | null;
  name: string;
}

// ===== query 问答相关类型 =====

// 单条问答记录（对话历史中的一轮）
export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  // assistant 消息可能附带引用页面
  refs?: string[] | Reference[];
  followups?: string[];
  thinking?: ThinkingStep[];
  feedback?: 'up' | 'down';
  createdAt?: string;
  // §5.1 L-7 归档所需：done 事件附带的会话 ID 与消息索引
  sessionId?: string;
  messageIndex?: number;
  // 线程隔离键：本条消息所属问答线程（与 sessionId 同源，1 线程 1 会话）。
  // 用于后续问答续接本地记忆，以及归档时定位线程会话。
  threadId?: string;
  // 是否已归档
  archived?: boolean;
  // 问答生成状态（FR-RM-09 问答状态持久化/断点续答）：
  // - 'complete'：正常完成（done 事件最终落盘）；缺省亦视为 complete
  // - 'streaming'：生成中（切页/刷新时被持久化的中间态），刷新重载后触发自动续答
  // - 'interrupted'：用户主动停止/超时停止，重载后不自动续答（保留 [已停止]/[已超时] 部分答案）
  // - 'error'：生成出错，重载后不自动续答（保留 [出错] 部分答案）
  // 仅用于本地 IndexedDB 暂存与续答判定，不回传后端。
  status?: 'complete' | 'streaming' | 'interrupted' | 'error';
  // 超时中断标记：reason==='timeout' 时由 bufStopLoading 置位，用于前端在超时 assistant
  // 消息下方常驻渲染"确认重发"按钮（区别于 hover 工具栏的"重新生成"）。
  // 随 IndexedDB 持久化，刷新重载后该标记仍保留，超时消息可持续提供重发入口。
  timedOut?: boolean;
  // FR-09-2 多模态输出（mindmap/faq/timeline），作为独立卡片渲染在主答案之后
  multimodal?: MultimodalOutput;
  // v3 图像生成结果：独立于 multimodal，通过 SSE image 事件推送
  image?: { url: string; alt: string; archivePath?: string };
  // v3 PPT 生成结果：Marp Markdown 源码，通过 SSE ppt 事件推送
  ppt?: { markdown: string; title: string; archivePath: string };
}

export interface Reference {
  path?: string;
  url?: string;
  title: string;
  snippet: string;
  source: 'vault' | 'web';
  citeIndex: number;
}

export interface ThinkingStep {
  // 字面量联合类型，后端 SSE thinking 事件的 phase 取值
  // NOSONAR: S6571 误报，无 string 类型覆盖字面量
  phase: 'thinking' | 'tool_call' | 'composing';
  message: string;
  tool?: string;
  args?: Record<string, unknown>;
  ts: string;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  blob: Blob;
  thumbnail: Blob;
}

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  isPinned: boolean;
  preview: string;
  messages: ChatMessage[];
  // 线程隔离键：该会话关联的问答线程（本地记忆/会话上下文的归属）。可选，老数据/旧版无此字段。
  threadId?: string;
  // 本地多账户隔离键（FR-RM-06）：会话归属的用户 id（= authStore.user.id）。
  // 老数据/升级前无此字段，读取时按「ownerId 缺失即归属当前用户」兼容，避免历史会话丢失。
  ownerId?: string;
  // 未读标记（会话状态图标用）：会话在用户「未正在查看」时完成更新（如后台生成结束），
  // 标记为未读，直到用户打开该会话（markRead 复位）。用于历史列表「已完成未读」状态动画。
  unread?: boolean;
}

// SSE answer 事件数据
export interface AnswerChunkData {
  text: string;
}

// SSE refs 事件数据
// §5.2 扩展 webRefs：与本地 refs 并行返回，渲染为外部链接
export interface RefsData {
  refs: string[];
  webRefs?: Array<{ title: string; url: string; snippet: string }>;
}

// ===== 知识浏览相关类型 =====

// Vault 目录树节点（与后端 TreeNode 对齐）
export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

// 文件内容响应（GET /api/files）
export interface FileContent {
  content: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

// FR-11 扁平化页面项（GET /api/files/pages）：用于看板视图按 type 分列、日历视图按 created 分组
export interface PageItem {
  path: string;
  name: string;
  dir: string;
  frontmatter: Record<string, unknown>;
}

// FR-10-1 待审核 AI 标签页面（GET /api/tags/pending）
export interface PendingTagPage {
  path: string;
  title: string;
  aiTags: string[];
  existingTags: string[];
}

// FR-14-2 Prompt 文件元信息（GET /api/prompts）
export interface PromptFile {
  name: string;
  label: string;
  description: string;
}

// FR-14-2 试运行进度事件（POST /api/prompts/test-run，SSE）
// 与后端 ProgressEvent 对齐：progress/page/done/error 四类事件复用同一接口
export interface PromptTestRunEvent {
  step: string;
  status: 'running' | 'done' | 'error';
  message: string;
  data?: {
    path?: string;
    title?: string;
    cached?: boolean;
  };
}

// 图谱数据（GET /api/graph）
export interface GraphData {
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
}

// 体检报告（POST /api/health-check）
export interface HealthReport {
  orphans: string[];
  brokenLinks: Array<{ from: string; to: string }>;
  stale: string[];
}

// 仪表盘统计（GET /api/stats）
export interface StatsData {
  totalPages: number;
  totalLinks: number;
  dirCounts: Record<string, number>;
  recentLog: string;
}

// ===== SCHEMA 与配置相关类型 =====

// SCHEMA 内容响应（GET /api/schema）
export interface SchemaContent {
  content: string;
}

// 配置响应（GET /api/config，API Key 脱敏）
// batch/logging 字段与后端 AppConfig.batch/logging 对齐（type-sync-rule BR-026）
export interface ConfigData {
  vaultPath: string;
  adapter: string;
  llm: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKeyRef: string;
    apiKeySet: boolean;
    // §真流式默认值（与后端 AppConfig.llm.stream 对齐）
    stream: boolean;
  };
  budget: { maxSteps: number; tokenBudget: number };
  server: { host: string; port: number };
  localOnly: boolean;
  healthCheck: { staleDays: number };
  batch: {
    allowedExtensions: string[];
    maxBatchSize: number;
    maxFileSizeMb: number;
  };
  logging: {
    level: string;
    enableRequestLog: boolean;
  };
}

// ===== 工具配置类型（与后端 types.ts 对齐，type-sync-rule）=====

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

export interface CliToolEntry {
  name: string;
  command: string;
  argsTemplate?: string;
  description: string;
  timeoutMs?: number;
  enabled: boolean;
}

export interface SceneRule {
  name: string;
  keywords: string[];
  tools: string[];
  enabled: boolean;
}

export interface ToolsConfig {
  mcpServers: McpServerEntry[];
  cliTools: CliToolEntry[];
  scenes: SceneRule[];
  routerMode: 'keyword' | 'auto';
  // MCP JSON-RPC 请求全局默认超时（ms），per-server 可用 McpServerEntry.timeoutMs 覆盖
  mcpTimeoutMs?: number;
}

// ===== 体检修复相关类型 =====

// §4.6 一键修复请求体
export interface FixRequest {
  issueType: 'broken_link' | 'orphan';
  target: { from: string; to: string } | string;
}

// 修复进度事件（SSE progress/fixed/done 通用结构）
export interface FixProgressEvent {
  step: string;
  status: 'running' | 'done' | 'error';
  message: string;
  tool?: string;
  data?: { path?: string };
}

// 批量修复请求体：items 为单个修复任务的有序列表，后端串行执行。
// issueKeys 可选，与 items 一一对应，用于日志与按钮状态联动。
export interface BatchFixRequest {
  items: FixRequest[];
  issueKeys?: string[];
}

// 批量修复 SSE 事件：在 FixProgressEvent 基础上附带定位信息。
// - issueIndex/totalIssues：当前问题在批次中的位置，前端显示 "3/10"
// - issueKey：稳定 key（如 "orphan:foo.md"），与列表项 key 对应
// - issueDone：当前问题是否已结束（done/error），前端据此更新单项状态
export interface BatchFixProgressEvent extends FixProgressEvent {
  issueIndex: number;
  totalIssues: number;
  issueKey: string;
  issueDone: boolean;
}

// 批量修复 batch_done 事件载荷：附统计信息
export interface BatchDoneEvent extends FixProgressEvent {
  totalIssues: number;
  successCount: number;
  failCount: number;
}

// ===== 全文检索相关类型 =====

// §5.1 搜索命中结果
export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  hits: number;
}

// 搜索响应（GET /api/search）
export interface SearchResponse {
  hits: SearchHit[];
  total: number;
}

// ===== SCHEMA 版本历史相关类型 =====

// Git 提交记录（GET /api/schema/history）
export interface SchemaCommit {
  hash: string;
  date: string;
  message: string;
  author: string;
}

// Diff 行（GET /api/schema/diff）
export interface DiffLine {
  type: 'add' | 'del' | 'context';
  content: string;
  oldLine?: number;
  newLine?: number;
}

// 版本历史响应
export interface SchemaHistoryResponse {
  commits: SchemaCommit[];
  gitEnabled: boolean;
}

// 版本对比响应
export interface SchemaDiffResponse {
  lines: DiffLine[];
  hasChanges: boolean;
}

// ===== 问答归档相关类型 =====

// 上下文记忆治理统计（与后端 api/src/engine/context-governor.ts 的 GovernorStats 对齐）；
// done 事件回传，便于前端/运维观测压缩/清理/淘汰效果。
export interface GovernorStats {
  inputTokens: number;
  outputTokens: number;
  inputMessages: number;
  outputMessages: number;
  removedDuplicates: number;
  removedLowValue: number;
  compressedTurns: number;
  evictedMessages: number;
  reordered: boolean;
  triggered: boolean;
  summaryChars: number;
}

// done 事件附带的会话信息（供归档用）
// 字段与后端 send('done', { threadId, sessionId, messageIndex, governor }) 对齐；
// threadId/governor 为向后兼容的加法字段，旧前端忽略不影响归档。
export interface QaSessionInfo {
  sessionId: string;
  messageIndex: number;
  threadId?: string;
  governor?: GovernorStats | null;
}

// 归档响应
export interface ArchiveResult {
  ok: boolean;
  path: string;
}

// ===== 内网穿透相关类型 =====

// 隧道运行状态（GET /api/tunnel/status）
export interface TunnelStatus {
  status: 'running' | 'stopped';
  publicUrl: string | null;
  provider: string;
}

// 隧道 provider 联合类型（与后端 TunnelConfig.provider 对齐）
export type TunnelProvider = 'cloudflare' | 'cpolar' | 'tailscale';

// 隧道配置响应（GET /api/tunnel/config，authtoken/certFile 脱敏）
// certFile 含敏感凭证仅返回是否已配置，路径不回显
export interface TunnelConfigData {
  provider: TunnelProvider;
  localPort: number;
  cpolarAuthtokenMasked: string;
  cpolarAuthtokenConfigured: boolean;
  binaryPath: string;
  autoStart: boolean;
  // Cloudflare Named Tunnel 字段
  tunnelMode: 'quick' | 'named';
  tunnelName: string;
  tunnelId: string;
  credentialsFile: string;
  hostname: string;
  certFileConfigured: boolean;
}

// 隧道配置保存请求体（POST /api/tunnel/config）
// cpolarAuthtoken 空串表示"不修改已有 token"
// Named Tunnel 字段可选：切换模式时传新值，留空保留已有值
export interface TunnelConfigBody {
  provider: TunnelProvider;
  localPort: number;
  cpolarAuthtoken: string;
  binaryPath: string;
  autoStart: boolean;
  tunnelMode?: 'quick' | 'named';
  tunnelName?: string;
  tunnelId?: string;
  credentialsFile?: string;
  hostname?: string;
}

// 二进制下载失败错误（POST /api/tunnel/start 返回 500 时）
export interface TunnelDownloadError {
  detail: string;
  errorType: 'binary_download_failed';
  manualPath: string;
  downloadUrls: string[];
}

// Tailscale Funnel 首次授权错误（POST /api/tunnel/start 返回 500 时）
// 携带授权链接供前端渲染授权向导
export interface TunnelAuthError {
  detail: string;
  errorType: 'tailscale_funnel_auth';
  authUrl: string;
}

// ===== Cloudflare Named Tunnel 向导类型 =====

// POST /api/tunnel/cloudflare/login 返回（启动 login 子进程）
export interface CloudflareLoginStartResult {
  status: 'waiting' | 'failed';
  authUrl: string | null;
  message: string;
  output?: string;
}

// GET /api/tunnel/cloudflare/login/status 返回（轮询 login 状态）
export interface CloudflareLoginStatusResult {
  status: 'waiting' | 'success' | 'failed' | 'idle';
  authUrl: string | null;
  certFile?: string;
  message: string;
  output?: string;
  checkedPaths?: string[];
}

// POST /api/tunnel/cloudflare/create 返回（创建命名隧道）
export interface CloudflareCreateResult {
  ok: boolean;
  tunnelId: string;
  credentialsFile: string;
  tunnelName: string;
  message: string;
}

// POST /api/tunnel/cloudflare/route-dns 返回（配置 DNS CNAME）
export interface CloudflareRouteDnsResult {
  ok: boolean;
  publicUrl: string;
  message: string;
}

// ===== AI 服务相关类型 =====

// AI 配置响应（GET /api/ai/config，API Key 脱敏）
export interface AiConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyRef: string;
  apiKeyMasked: string;
  apiKeySet: boolean;
  providerKeyStatus?: Record<string, boolean>;
}

// LLM 预设项（GET /api/ai/presets）
// vision 字段（F-3.5）：标识模型是否支持图片输入，前端据此决定图片按钮是否灰显
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

// 测试连接响应（POST /api/ai/test-connection）
export interface AiTestResult {
  ok: boolean;
  model?: string;
  detail: string;
}

// 保存配置响应（PUT /api/ai/config）
export interface AiSaveResult {
  ok: boolean;
  config: AiConfig;
}

// ===== 技能导入相关类型 =====

// 技能元数据（GET /api/skills 列表项）
// 与后端 SkillMeta 对齐（type-sync-rule CODING-015）
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
export interface SkillDetail extends SkillMeta {
  content: string;
  files: string[];
}

// 技能导入结果（POST /api/skills/import 返回）
export interface SkillImportResult {
  ok: boolean;
  skill: SkillMeta;
  warnings: string[];
}

// 技能列表响应（GET /api/skills 返回）
export interface SkillListResponse {
  skills: SkillMeta[];
}

// ===== 系统清理相关类型 =====

// 清理目标（4 类对象 + all）
export type CleanupTarget = 'compile_cache' | 'run_state' | 'run_logs' | 'raw_archive' | 'all';

// 清理请求体
export interface CleanupBody {
  target: CleanupTarget;
  // 仅 run_logs/raw_archive 使用（按天数清理）
  days?: number;
  // 默认 true（预览模式），强制用户主动关闭
  dry_run: boolean;
}

// 清理结果
export interface CleanupResult {
  target: string;
  days: number;
  dry_run: boolean;
  cleaned: string[];
  errors: string[];
  count: number;
  total_freed_mb?: number;
}

// 存储状态（GET /api/cleanup/status）
export interface CleanupStorageStatus {
  compileCache: {
    exists: boolean;
    sizeMb: number;
    entryCount: number;
  };
  runState: {
    fileCount: number;
    sizeMb: number;
    oldest: string | null;
  };
  runLogs: {
    fileCount: number;
    sizeMb: number;
    oldest: string | null;
  };
  rawArchive: {
    fileCount: number;
    sizeMb: number;
    oldest: string | null;
  };
}

// ===== RBAC 权限管理相关类型（与后端 auth/types.ts 对齐，type-sync-rule）=====

// 系统角色：管理员 / 普通用户 / 游客
export type AuthRole = 'admin' | 'user' | 'guest';

// 权限点：与 App.vue 的 ViewName 对齐，'users' 为独立权限点不对应菜单
export type AuthPermission =
  | 'dashboard'
  | 'ingest'
  | 'progress'
  | 'browse'
  | 'query'
  | 'graph'
  | 'health'
  | 'config'
  | 'tunnel'
  | 'cleanup'
  | 'help'
  | 'about'
  | 'users'
  | 'skill';

// 登录请求体
export interface LoginRequest {
  username: string;
  password: string;
}

// 自助注册请求体（公开接口，默认角色 user）
export interface RegisterRequest {
  username: string;
  password: string;
  confirmPassword?: string;
}

// 登录响应
export interface LoginResponse {
  ok: boolean;
  token?: string;
  user?: UserInfo;
  message?: string;
}

// 用户信息（脱敏后，不含 passwordHash/salt）
export interface UserInfo {
  id: string;
  username: string;
  role: AuthRole;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  // 当前用户权限列表（GET /api/auth/me 直接附带）
  permissions: AuthPermission[];
}

// 创建/更新用户请求体（管理员操作）
export interface CreateUserRequest {
  username: string;
  password: string;
  role: AuthRole;
}

export interface UpdateUserRequest {
  username?: string;
  password?: string;
  role?: AuthRole;
  enabled?: boolean;
}

// 审计日志条目
export interface AuditLogEntry {
  ts: string;
  userId: string | null;
  username: string | null;
  action: string;
  resource: string;
  ip: string;
  result: 'success' | 'fail';
  message?: string;
}

// 用户列表响应
export interface UserListResponse {
  users: UserInfo[];
}

// 审计日志响应
export interface AuditLogResponse {
  entries: AuditLogEntry[];
  count: number;
}

// ===== QQ 草稿审核相关类型（与后端 qq-ingest 路由对齐）=====

// 草稿列表项（GET /api/qq-ingest/drafts 返回）
export interface DraftItem {
  path: string;
  name: string;
}

// 草稿列表响应
export interface DraftListResponse {
  drafts: DraftItem[];
}

// 草稿编译 SSE 事件类型联合
// 与后端 send('progress'|'page'|'done'|'error') 对齐
export type DraftCompileEventType = 'progress' | 'page' | 'done' | 'error';

// 草稿编译 SSE 事件数据（与后端 ProgressEvent 对齐，扩展批量定位字段）
export interface DraftCompileEvent {
  step: string;
  status: 'running' | 'done' | 'error';
  message: string;
  data?: {
    path?: string;
    title?: string;
    cached?: boolean;
    fileIndex?: number;
    fileCount?: number;
    fileName?: string;
  };
}

// 批量编译单个 draft 的执行状态
export type DraftBatchStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

// 批量编译中单个 draft 的执行记录
export interface DraftBatchItem {
  path: string;
  name: string;
  status: DraftBatchStatus;
  message?: string;
  // 编译生成的正式页面路径列表
  pages: Array<{ path: string; title: string }>;
}

// ===== QQ 导入子系统配置类型（与后端 QqConfig 对齐，type-sync-rule）=====

// QQ 导入子系统配置（GET/PUT /api/qq-ingest/config）
// - noise_rules: 噪声过滤规则开关（NR-1~NR-6）
// - privacy_patterns: PII 脱敏正则（用户自定义，运行时编译）
// - max_batch_size: 批量上传上限
// - chunk_threshold: 长文本分块阈值（消息条数）
// - extract_model: 抽取阶段独立 LLM 模型
// - extract_base_url: 抽取阶段独立 baseUrl（空串回退至 llm.baseUrl）
// - extract_token_budget: 抽取阶段 token 预算（0 回退至 budget.tokenBudget）
export interface QqConfigData {
  noise_rules: Record<string, boolean>;
  privacy_patterns: Record<string, string>;
  max_batch_size: number;
  chunk_threshold: number;
  extract_model: string;
  extract_base_url: string;
  extract_token_budget: number;
}

// QQ 配置响应（GET /api/qq-ingest/config 返回）
export interface QqConfigResponse {
  qq: QqConfigData;
}

// QQ 上传 SSE 事件数据（与后端 send('progress'|'done'|'error') 对齐）
export interface QqUploadEvent {
  step: string;
  status: 'running' | 'done' | 'error';
  message: string;
  data?: {
    rawId?: string;
    meta?: {
      chatName: string;
      dateRange: string;
      originalCount: number;
      filteredCount: number;
      redactedCount: number;
    };
    rawPath?: string;
  };
}

// ===== URL 爬取相关类型（与后端 UrlCrawl* 对齐，type-sync-rule）=====

// 爬取到的附件元信息：仅记录元数据不实际下载二进制，避免大文件消耗内存
// - type: 附件分类（document/image/audio/video/other），用于前端图标差异化展示
// - extension: 文件扩展名（小写、不含点），从 URL pathname 提取
// - size: 附件字节数，未实际下载时为 undefined，前端显示"未获取"
export interface UrlCrawlAttachment {
  url: string;
  type: 'document' | 'image' | 'audio' | 'video' | 'other';
  extension: string;
  size?: number;
}

// SSE 事件统一结构：路由层通过 send(type, event) 推送给前端
// - type: 事件类型（progress/page_start/page_done/page_error/attachment/done/error）
// - step: 当前阶段标识（init/fetch/parse/limit/done 等），便于前端阶段感知
// - data: 类型化载荷，不同 type 携带不同字段
export interface UrlCrawlEvent {
  type: 'progress' | 'page_start' | 'page_done' | 'page_error' | 'page_skipped' | 'attachment' | 'done' | 'error';
  step: string;
  message: string;
  data?: UrlCrawlEventData;
}

// SSE 事件 data 字段联合类型：按事件类型携带不同字段
// 为什么用可选取交集而非判别联合：SSE 序列化为 JSON 后运行时无法区分判别联合，
// 可选取交集让前端按 type 判断字段存在性更直白
export interface UrlCrawlEventData {
  // init 阶段：入口 URL、路径前缀、最大跳数
  entryUrl?: string;
  prefix?: string;
  maxHops?: number;
  // page_start/page_done/page_error 阶段：当前页面定位信息
  url?: string;
  depth?: number;
  title?: string;
  contentLength?: number;
  attachmentCount?: number;
  error?: string;
  // attachment 事件：附件元信息
  attachment?: UrlCrawlAttachment;
  // done 阶段：汇总统计与合并 Markdown
  pagesCrawled?: number;
  totalAttachmentCount?: number;
  combinedMarkdown?: string;
  // 爬取耗时（ms），前端用于展示 "耗时 X.Xs"
  elapsedMs?: number;
  // 增量爬取跳过的页面数
  pagesSkipped?: number;
  pages?: Array<{ url: string; title: string; depth: number; contentLength: number; attachmentCount: number; markdown?: string }>;
  attachments?: UrlCrawlAttachment[];
}

// URL 爬取页面摘要（done 事件 pages 数组项的精简结构，前端列表展示用）
// markdown: 该页面对应的 Markdown 正文，用于勾选后拼接提交
export interface UrlCrawlPageSummary {
  url: string;
  title: string;
  depth: number;
  contentLength: number;
  attachmentCount: number;
  markdown?: string;
}

// ===== 数据清洗子系统类型（与后端 PageQualityScore/DuplicatePair 等对齐）=====

// 页面质量评分：包含路径、标题、总分、各维度分项、元数据、问题与建议
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
    encoding: 'utf-8' | 'gbk' | 'unknown';
    directory: string;
  };
  issues: Array<{
    code: string;
    severity: 'info' | 'warning' | 'error';
    detail: string;
    suggestion?: string;
  }>;
  suggestions: Array<{
    type: 'link_suggestion' | 'content_expand' | 'merge_duplicate' | 'summarize_large' | 'citation';
    detail: string;
    actionable: boolean;
  }>;
}

// 重复对：两个页面的对比信息，含相似度、匹配类型与原因
export interface DuplicatePair {
  pageA: PageQualityScore;
  pageB: PageQualityScore;
  similarity: number;
  matchType: 'exact' | 'near-duplicate' | 'semantic-similar';
  reason: string;
}

// 去重结果：匹配对列表、扫描统计与重复分组
export interface DeduplicateResult {
  matches: DuplicatePair[];
  scannedPages: number;
  uniquePages: number;
  duplicateGroups: Array<{
    pages: string[];
    representativePath: string;
    totalWordsInGroup: number;
  }>;
}

// Diff 结果（/api/data-clean/diff）：行级差异对比
// 注意：前端已存在 SchemaDiffResponse.DiffLine，此处 DiffResult 复用同结构
export interface DiffResult {
  pathA: string;
  pathB: string;
  lines: DiffLine[];
  summary: {
    added: number;
    removed: number;
    unchanged: number;
    // 相似度 = 2 * unchanged / (linesA + linesB)，与 Jaccard 一致
    similarity: number;
  };
}

// 合并结果：保留页、被合并页列表、应用更新数、链接替换数、归档结果与错误
export interface MergeResult {
  kept: string;
  mergedFrom: string[];
  updatesApplied: number;
  linkReplacements?: number;
  archiveResult?: { archived: string[]; errors: string[] };
  errors: string[];
  dryRun: boolean;
}

// 预检门禁结果：是否通过、扫描文件数、错误与警告列表、是否阻断
export interface PrecheckResult {
  passed: boolean;
  scannedFiles: number;
  errors: string[];
  warnings: string[];
  blocked: boolean;
}

// ===== 多模态输出类型（FR-09-2，与后端 MultimodalOutput 对齐）=====
// type: 'mindmap' Mermaid 思维导图 | 'faq' Q&A 问答对 | 'timeline' 按 created 排序的事件
//       'image' 图像生成 | 'ppt' Marp 幻灯片
// content: 对应格式的原始文本（mindmap=Mermaid 语法，faq/timeline=Markdown）
// imageUrl: image 模式下图片访问 URL（/api/files?path=...）
// pptMarkdown: ppt 模式下 Marp Markdown 源码（与 content 互补，content 为渲染预览文本）
export interface MultimodalOutput {
  type: 'mindmap' | 'faq' | 'timeline' | 'image' | 'ppt';
  content: string;
  imageUrl?: string;
  pptMarkdown?: string;
}

// ===== v3 视频生成异步任务结果（与后端 VideoTaskResult 对齐，type-sync-rule）=====
// 为什么独立于 SSE 流式类型：视频生成是异步任务，前端轮询 GET /api/media/video/:taskId
export interface VideoTaskResult {
  taskId: string;
  videoId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  url?: string;
  archivePath?: string;
  error?: string;
}

// ===== 推荐页面类型（FR-16-1，与后端 RecommendedPage 对齐）=====
// reason: 推荐理由（同目录/同标签: xxx/同作者: xxx），score: 匹配维度数量
export interface RecommendedPage {
  path: string;
  title: string;
  reasons: string[];
  score: number;
}


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
  data?: {
    path: string;
    title: string;
    cached?: boolean;
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
  // 是否已归档
  archived?: boolean;
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
export interface ConfigData {
  vaultPath: string;
  adapter: string;
  llm: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKeyRef: string;
    apiKeySet: boolean;
  };
  budget: { maxSteps: number; tokenBudget: number };
  server: { host: string; port: number };
  localOnly: boolean;
  healthCheck: { staleDays: number };
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

// done 事件附带的会话信息（供归档用）
export interface QaSessionInfo {
  sessionId: string;
  messageIndex: number;
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

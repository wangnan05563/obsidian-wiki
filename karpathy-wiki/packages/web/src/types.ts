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
  role: 'user' | 'assistant';
  content: string;
  // assistant 消息可能附带引用页面
  refs?: string[];
  // §5.1 L-7 归档所需：done 事件附带的会话 ID 与消息索引
  sessionId?: string;
  messageIndex?: number;
  // 是否已归档
  archived?: boolean;
}

// SSE answer 事件数据
export interface AnswerChunkData {
  text: string;
}

// SSE refs 事件数据
export interface RefsData {
  refs: string[];
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

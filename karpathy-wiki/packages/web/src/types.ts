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
  // generate_page 步骤会附带生成的页面信息
  data?: {
    path: string;
    title: string;
  };
}

export interface DoneData {
  pages: string[];
  indexUpdated: boolean;
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

// 业务层类型定义。
// EngineAdapter 是阶段切换抽象点（V1.3 仅 HarnessAdapter，但接口保留为后续替换预留）。

export interface EngineAdapter {
  compile(input: CompileInput): AsyncIterable<ProgressEvent>;
  query(input: QueryInput): AsyncIterable<AnswerChunk>;
  healthCheck(): Promise<HealthReport>;
}

export interface CompileInput {
  type: 'file' | 'url' | 'text';
  // file: 文件路径；url: URL；text: 纯文本
  content: string;
  // 存档到 raw/ 的相对路径（可选，未提供时由 vault 自动生成）
  rawPath?: string;
}

export interface ProgressEvent {
  // read_schema / extract / generate_page / update_index / done 等
  step: string;
  status: 'running' | 'done' | 'error';
  message: string;
  data?: { path?: string; title?: string };
}

export interface QueryInput {
  question: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface AnswerChunk {
  // 流式答案片段
  text?: string;
  // [[页面名]] 引用
  refs?: string[];
  done?: boolean;
}

export interface HealthReport {
  // 孤立页面路径
  orphans: string[];
  brokenLinks: Array<{ from: string; to: string }>;
  // 过期页面路径
  stale: string[];
}

// 应用配置。apiKeyRef 引用环境变量名，API Key 不落盘（M-7 安全要求）。
export interface AppConfig {
  vaultPath: string;
  // V1.3 仅 harness
  adapter: 'harness';
  llm: { provider: string; baseUrl: string; model: string; apiKeyRef: string };
  budget: { maxSteps: number; tokenBudget: number };
  server: { host: string; port: number };
  localOnly: boolean;
  healthCheck: { staleDays: number };
}

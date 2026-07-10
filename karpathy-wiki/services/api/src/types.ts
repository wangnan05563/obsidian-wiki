// 业务层类型定义。
// EngineAdapter 是阶段切换抽象点（V1.3 仅 HarnessAdapter，但接口保留为后续替换预留）。

export interface EngineAdapter {
  compile(input: CompileInput): AsyncIterable<ProgressEvent>;
  // §11.2 断点续传：从中断点恢复编译
  resumeCompile(runId: string): AsyncIterable<ProgressEvent>;
  query(input: QueryInput): AsyncIterable<AnswerChunk>;
  healthCheck(): Promise<HealthReport>;
  // §4.6 一键修复：走 LLM 引擎，SSE 流式返回修复进度
  healthCheckFix(input: FixInput): AsyncIterable<FixProgressEvent>;
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
  data?: { path?: string; title?: string; cached?: boolean };
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

// 内网穿透配置（参考 17_xianyu 项目，适配本架构）。
// localPort=0 表示从 server.port 继承；cpolarAuthtoken 仅 cpolar provider 需要。
export interface TunnelConfig {
  provider: 'cloudflare' | 'cpolar';
  localPort: number;
  cpolarAuthtoken: string;
  binaryPath: string;
  autoStart: boolean;
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

// 公共类型定义：Agent = LLM + Harness 公式中的契约边界
// 所有跨模块共享的接口集中在此，避免循环依赖

export interface LLMConfig {
  provider: 'glm' | 'qwen' | 'deepseek' | string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  // JSON Schema，类型无法精确表达故用 object
  parameters: object;
  handler: (args: unknown, ctx: RunContext) => Promise<unknown>;
}

// §事件溯源会话事件：追加式日志的原子单元
// 与 DeepSeek Harness "可见即可重放" 的不变式对齐 —— 一切（resume/fork/审计）
// 都派生于这条不可变、按追加顺序排列的事件序列，而非整存整取的 Message[]。
// ts 为事件时间戳；messages() 投影时仅保留 LLM 可见字段。
export type SessionEvent =
  | { type: 'user'; content: string; ts: string }
  | { type: 'assistant'; content: string; tool_calls?: ToolCall[]; ts: string }
  | { type: 'tool'; content: string; tool_call_id: string; ts: string }
  // §P2 上下文压缩产物：summary 是投影给 LLM 的 system 摘要；archived 是被压缩的
  // 原始事件（完整保留以便 resume 重放与审计，不进入 messages() 投影）
  | { type: 'compact'; summary: string; archived: SessionEvent[]; ts: string };

// 追加事件入参：与 SessionEvent 同构但省略自动生成的 ts
// 注意：不能直接用 Omit<SessionEvent,'ts'> —— Omit 在联合类型上会塌缩为
// 仅有公共键（type/content）的单一对象，丢失 tool_calls / tool_call_id 等
// 分支专属字段。故显式写出判别联合，保证 append 调用点类型精确。
export type AppendSessionEvent =
  | { type: 'user'; content: string }
  | { type: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { type: 'tool'; content: string; tool_call_id: string };

// 追加式会话日志接口：单一事实来源（single source of truth）
// 为什么是接口而非具体类：允许未来接入持久化/远程日志（DeepSeek Harness 的
// 能力接缝思想），本仓库当前提供内存实现 InMemorySessionLog。
export interface SessionLog {
  // 追加顺序即因果顺序，只读暴露以防外部破坏不变式
  readonly events: SessionEvent[];
  // 追加一条事件（自动补 ts），返回完整事件
  append(event: AppendSessionEvent): SessionEvent;
  // 投影出 LLM 可见的 Message[]（按事件顺序重建）
  messages(): Message[];
  // §P3 计划模式：注入全局意图锚点文本（由 Planner 生成），投影时置于消息最前
  setPlan(plan: string): void;
  // §P2 上下文压缩：把 [0, 安全边界) 的事件替换为 1 条 compact 事件
  // 被压缩事件存入 archived 供重放/审计，投影后仅留 summary（system 消息）。
  // 调用方负责计算安全边界并生成 summary（见 compaction.ts 的 compactLog）。
  compact(summary: string, archived: SessionEvent[]): void;
}

export interface RunContext {
  runId: string;
  task: string;
  // §事件溯源：上下文历史由 log 提供，不再直接持有 Message[]
  log: SessionLog;
  step: number;
  tokenUsed: number;
  state: Record<string, unknown>;
  // §X-1 步骤级追踪：runLoop 惰性填充，循环结束后随 RunState 持久化
  timings?: StepTiming[];
}

export interface RunResult {
  runId: string;
  status: 'done' | 'budget_exceeded' | 'failed';
  messages: Message[];
  finalContent: string;
  step: number;
  tokenUsed: number;
  // §X-1 步骤级追踪：随 RunResult 返回，便于调用方即时诊断
  timings?: StepTiming[];
}

// §X-1 步骤级追踪：单步耗时分解（定位 143s/282s 级长耗时瓶颈）
// llmMs = 本步 LLM 调用耗时（含重试退避）；toolMs = 本步全部工具执行耗时；
// tokens = 本步估算 token 消耗；toolNames = 本步调用工具名列表（用于定位卡点）。
export interface StepTiming {
  step: number;
  llmMs: number;
  toolMs: number;
  tokens: number;
  toolNames: string[];
}

export interface StepResult {
  step: number;
  toolCalls: ToolCall[];
  toolResults: unknown[];
  tokenUsed: number;
}

export interface Hooks {
  beforeLoop: (ctx: RunContext) => Promise<void>;
  beforeStep: (ctx: RunContext, step: number) => Promise<void>;
  afterStep: (ctx: RunContext, step: number, result: StepResult) => Promise<void>;
  afterLoop: (ctx: RunContext, result: RunResult) => Promise<void>;
}

// §P1 拦截总线（Interceptors）：对齐 DeepSeek Harness "事件瀑布 + next()" 思想
// 与 Hooks（通知式 fire-and-forget）互补：拦截器可改写请求/响应、短路（不调 next）、
// 或放行（调 next）。所有接缝点默认放行（不实现即原样透传），保证对现有集成层
// （api 重度依赖 afterStep 通知 hook）零破坏。
//
// 三类接缝点：
//  1) onLlmRequest  —— 改写发往 LLM 的请求（注入 system prompt / 动态裁剪 tools）
//  2) onToolCall    —— 工具调用护栏（审批拒绝 / 改写参数 / 替换执行）
//  3) onToolResult  —— 工具结果回填 LLM 前脱敏 / 改写

// 1) LLM 请求改写：纯改写器，无 next
//    为什么无 next：LLM 调用是 RAG 问答的必经路径，本场景无需短路 LLM；
//    改为纯改写器让流式 / 非流式共用同一拦截点（next 在流式下无法统一返回类型）。
export interface LlmRequestPayload {
  messages: Message[];
  tools: ToolDefinition[];
  ctx: RunContext;
}
export type LlmRequestInterceptor = (
  payload: LlmRequestPayload,
) => LlmRequestPayload | Promise<LlmRequestPayload>;

// 2) 工具调用拦截：可审批拒绝（不调 next）、改写参数（next(args)）、替换执行
export interface ToolCallPayload {
  toolCall: ToolCall;
  args: unknown;
  tool?: ToolDefinition;
  ctx: RunContext;
}
export type ToolCallNext = (args: unknown) => Promise<unknown>;
export type ToolCallInterceptor = (
  payload: ToolCallPayload,
  next: ToolCallNext,
) => Promise<unknown>;

// 3) 工具结果拦截：回填 LLM 前脱敏 / 改写；next 返回原始 result（供 hook 改写）
export interface ToolResultPayload {
  toolCallId: string;
  result: unknown;
  ctx: RunContext;
}
export type ToolResultNext = () => Promise<unknown>;
export type ToolResultInterceptor = (
  payload: ToolResultPayload,
  next: ToolResultNext,
) => Promise<unknown>;

export interface Interceptors {
  onLlmRequest?: LlmRequestInterceptor;
  onToolCall?: ToolCallInterceptor;
  onToolResult?: ToolResultInterceptor;
}

// §P2 上下文压缩器：接收将被压缩的旧 Message[]，返回压缩后的摘要文本
// 默认实现 SimpleConcatCompactor（无 LLM，纯截断拼接）；业务侧可注入 LLM 实现
// 真正摘要（如把长 vault 检索片段压成要点）。compaction.ts 负责何时触发。
export interface Compactor {
  summarize(messages: Message[], ctx: RunContext): string | Promise<string>;
}

// §P3 计划模式（Plan Mode）：可选的计划生成器，在循环开始前产出任务的高层计划
// 文本，作为全局意图锚点注入后续每步 LLM 上下文（经 SessionLog.messages() 投影为
// 开头 system 消息）。默认不提供 → 不启用计划模式，对集成层零破坏。
// 与 Compactor 平行：都是"可选能力接缝"，业务侧可注入 LLM 实现（LlmPlanner）或
// 静态实现（StaticPlanner，便于测试/无 LLM 场景）。
export interface Planner {
  plan(task: string): string | Promise<string>;
}

// §P3-SubAgent 子智能体声明：声明后框架自动注册 spawn_<name> 工具，父循环调用该
// 工具时 spawn 一个独立子 Harness（独立预算 / 上下文隔离）执行子任务，结果回填父循环。
// 默认无 subAgents 不注册，对集成层零破坏。对齐 DeepSeek Harness 的 sub-agents 能力，
// 但以"框架自动挂工具"的最小形态落地，而非 DSH 完整子 agent 调度/层级管理（overkill）。
export interface SubAgentConfig {
  // 子智能体标识；生成的工具名为 spawn_<name>
  name: string;
  // 工具描述（覆盖默认）；应说明子智能体擅长/负责的范围
  description?: string;
  // 子可用工具白名单（按父 tools 的 name 过滤）；缺省继承除 spawn_* 外的全部工具，
  // 切断隐式无限递归（子不应再 spawn 父的子智能体，除非业务显式多层委派）。
  tools?: string[];
  // 子独立预算（避免子任务耗尽父预算）；默认 10 步 / 20000 token
  maxSteps?: number;
  tokenBudget?: number;
}

export interface BudgetConfig {
  maxSteps: number;    // 默认 20
  tokenBudget: number; // 默认 50000
}

export interface RetryConfig {
  maxRetries: number;  // 默认 3
  baseDelayMs: number; // 默认 1000
  maxDelayMs: number;  // 默认 30000
  retryOn: ('timeout' | 'rate_limit' | 'tool_error' | 'parse_error')[];
}

export interface StateStore {
  save(runId: string, state: RunState): Promise<void>;
  load(runId: string): Promise<RunState | null>;
  list(): Promise<string[]>;
}

export interface RunState {
  runId: string;
  task: string;
  // §事件溯源：持久化的是事件序列；messages 由 events 投影得到，不再整存
  events: SessionEvent[];
  step: number;
  tokenUsed: number;
  status: 'running' | 'paused' | 'done' | 'failed';
  startedAt: string;
  // §X-1 步骤级追踪：持久化每步耗时分解，供 read-only trace API 投影
  timings?: StepTiming[];
}

export interface HarnessConfig {
  llm: LLMConfig;
  tools: ToolDefinition[];
  budget?: Partial<BudgetConfig>;
  retry?: Partial<RetryConfig>;
  hooks?: Partial<Hooks>;
  // §P1 拦截总线：可选，默认放行，对集成层零破坏
  interceptors?: Partial<Interceptors>;
  // §P2 上下文压缩：可选；缺省则不压缩。compactThreshold 为触发事件数阈值（默认 30）
  compactor?: Compactor;
  compactThreshold?: number;
  // §P3 计划模式：可选；缺省则不规划。提供后在循环前生成计划并以 system 上下文注入
  planner?: Planner;
  // §P3-SubAgent 子智能体：可选；缺省不注册 spawn 工具，零破坏
  subAgents?: SubAgentConfig[];
  stateStore?: StateStore;
}

export interface LLMResponse {
  content: string;
  tool_calls?: ToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface LLMChunk {
  // LLM 文本增量（可为空字符串，如纯 tool_call chunk）
  delta: string;
  // 工具调用：流式中 tool_calls 是分片累积，chatStream 实现需在流结束时 yield 一次完整数组
  // 未定义表示本 chunk 无 tool_calls；空数组表示流结束且无工具调用
  tool_calls?: ToolCall[];
}

// §真流式事件：runLoopStream 把 LLM token 与工具调用生命周期事件化
// 为什么用 discriminated union：消费端可基于 type 做穷尽性分支，避免漏处理
export type StepEvent =
  // LLM 文本增量：前端直接追加到 streamingAnswer
  | { type: 'delta'; text: string }
  // 工具调用开始：前端可展示 thinking "调用工具 X"
  | { type: 'tool_call'; step: number; toolCall: ToolCall }
  // 工具调用结束：前端可展示 thinking "工具 X 返回 Y"
  | { type: 'tool_result'; step: number; toolCall: ToolCall; result: unknown }
  // 任务完成：finalContent 是完整答案
  | { type: 'done'; finalContent: string; step: number; tokenUsed: number; runId?: string }
  // 异常：消费端应中断流
  | { type: 'error'; message: string; step: number; runId?: string };

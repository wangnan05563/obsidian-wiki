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

export interface RunContext {
  runId: string;
  task: string;
  messages: Message[];
  step: number;
  tokenUsed: number;
  state: Record<string, unknown>;
}

export interface RunResult {
  runId: string;
  status: 'done' | 'budget_exceeded' | 'failed';
  messages: Message[];
  finalContent: string;
  step: number;
  tokenUsed: number;
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
  messages: Message[];
  step: number;
  tokenUsed: number;
  status: 'running' | 'paused' | 'done' | 'failed';
  startedAt: string;
}

export interface HarnessConfig {
  llm: LLMConfig;
  tools: ToolDefinition[];
  budget?: Partial<BudgetConfig>;
  retry?: Partial<RetryConfig>;
  hooks?: Partial<Hooks>;
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
  | { type: 'done'; finalContent: string; step: number; tokenUsed: number }
  // 异常：消费端应中断流
  | { type: 'error'; message: string; step: number };

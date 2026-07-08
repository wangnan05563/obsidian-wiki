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
  delta: string;
  tool_calls?: ToolCall[];
}

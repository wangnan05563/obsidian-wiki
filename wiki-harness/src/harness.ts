import type {
  HarnessConfig,
  RunResult,
  RunContext,
  RunState,
  BudgetConfig,
  RetryConfig,
  StepEvent,
  ToolDefinition,
  StateStore,
} from './types.js';
import type { LLMAdapter } from './llm/llm-adapter.js';
import { runLoop, runLoopStream } from './loop/tool-loop.js';
import { OpenAICompatibleAdapter } from './llm/openai-compatible.js';
import { FileStateStore } from './state/file-state-store.js';
import { HookManager } from './hook/hook-manager.js';
import { randomUUID } from 'node:crypto';

// 默认预算：20 步 / 50000 token 覆盖大多数单轮任务
const DEFAULT_BUDGET: BudgetConfig = {
  maxSteps: 20,
  tokenBudget: 50000,
};

// 默认重试：3 次指数退避，仅对超时和限流重试（业务错误不应重试）
const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryOn: ['timeout', 'rate_limit'],
};

// Harness 主类：组合 LLM + 工具 + 预算 + 重试 + Hook，对外暴露 run/resume
export class Harness {
  private llm: LLMAdapter;
  private stateStore: StateStore;
  private hooks: HookManager;
  private tools: ToolDefinition[];
  private budget: BudgetConfig;
  private retry: RetryConfig;

  constructor(private config: HarnessConfig) {
    this.llm = new OpenAICompatibleAdapter(config.llm);
    // 未提供 stateStore 时回退到文件存储
    this.stateStore = config.stateStore ?? new FileStateStore();
    this.hooks = new HookManager(config.hooks ?? {});
    this.tools = config.tools;
    // 浅合并默认值与用户配置：用户字段覆盖默认字段
    this.budget = { ...DEFAULT_BUDGET, ...config.budget };
    this.retry = { ...DEFAULT_RETRY, ...config.retry };
  }

  async run(task: { task: string; context?: Record<string, unknown> }): Promise<RunResult> {
    const runId = randomUUID();
    // 在循环开始前记录时间戳：原实现放在循环结束后会丢失整个执行时长
    const startedAt = new Date().toISOString();
    const ctx: RunContext = {
      runId,
      task: task.task,
      messages: [],
      step: 0,
      tokenUsed: 0,
      state: task.context ?? {},
    };

    // 初始消息：用户任务作为对话起点
    ctx.messages.push({
      role: 'user',
      content: task.task,
    });

    await this.hooks.beforeLoop(ctx);

    const result = await runLoop(ctx, {
      llm: this.llm,
      tools: this.tools,
      budget: this.budget,
      retry: this.retry,
      hooks: this.hooks,
    });

    await this.hooks.afterLoop(ctx, result);

    // 持久化最终状态，供 resume 或审计使用
    const state: RunState = {
      runId,
      task: task.task,
      messages: ctx.messages,
      step: ctx.step,
      tokenUsed: ctx.tokenUsed,
      status: result.status === 'done' ? 'done' : result.status === 'failed' ? 'failed' : 'done',
      startedAt,
    };
    await this.stateStore.save(runId, state);

    return result;
  }

  async resume(runId: string): Promise<RunResult> {
    const state = await this.stateStore.load(runId);
    if (!state) {
      throw new Error(`No state found for runId: ${runId}`);
    }

    // 从断点恢复上下文，继续未完成的循环
    const ctx: RunContext = {
      runId: state.runId,
      task: state.task,
      messages: state.messages,
      step: state.step,
      tokenUsed: state.tokenUsed,
      state: {},
    };

    await this.hooks.beforeLoop(ctx);

    const result = await runLoop(ctx, {
      llm: this.llm,
      tools: this.tools,
      budget: this.budget,
      retry: this.retry,
      hooks: this.hooks,
    });

    await this.hooks.afterLoop(ctx, result);

    return result;
  }

  // §真流式入口：与 run() 平行，调用 runLoopStream，LLM 逐 token yield
  //   为什么独立方法：避免 runLoop 改动回归风险，且流式与非流式生命周期管理不同
  //   不做 stateStore.save：流式场景下中断恢复由消费端基于 sessionId 自行管理
  //   消费端（queryWorkflow）需在 done/error 时自行持久化
  async *runStream(task: { task: string; context?: Record<string, unknown> }): AsyncGenerator<StepEvent> {
    const runId = randomUUID();
    const ctx: RunContext = {
      runId,
      task: task.task,
      messages: [],
      step: 0,
      tokenUsed: 0,
      state: task.context ?? {},
    };

    ctx.messages.push({
      role: 'user',
      content: task.task,
    });

    await this.hooks.beforeLoop(ctx);

    yield* runLoopStream(ctx, {
      llm: this.llm,
      tools: this.tools,
      budget: this.budget,
      retry: this.retry,
      hooks: this.hooks,
    });
  }
}

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
  Compactor,
  Planner,
} from './types.js';
import type { LLMAdapter } from './llm/llm-adapter.js';
import { runLoop, runLoopStream } from './loop/tool-loop.js';
import { OpenAICompatibleAdapter } from './llm/openai-compatible.js';
import { FileStateStore } from './state/file-state-store.js';
import { HookManager } from './hook/hook-manager.js';
import { InMemorySessionLog } from './session/session-log.js';
import { DEFAULT_COMPACT_THRESHOLD } from './session/compaction.js';
import { createSubAgentTool } from './subagent.js';
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
  private compactor?: Compactor;
  private compactThreshold: number;
  // §P3 计划模式：可选，缺省不规划
  private planner?: Planner;

  constructor(private config: HarnessConfig) {
    this.llm = new OpenAICompatibleAdapter(config.llm);
    // 未提供 stateStore 时回退到文件存储
    this.stateStore = config.stateStore ?? new FileStateStore();
    this.hooks = new HookManager(config.hooks ?? {}, config.interceptors ?? {});
    this.tools = config.tools;
    // 浅合并默认值与用户配置：用户字段覆盖默认字段
    this.budget = { ...DEFAULT_BUDGET, ...config.budget };
    this.retry = { ...DEFAULT_RETRY, ...config.retry };
    // §P2 上下文压缩：可选，缺省不压缩
    this.compactor = config.compactor;
    this.compactThreshold = config.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    // §P3 计划模式：可选，缺省不规划
    this.planner = config.planner;

    // §P3-SubAgent 子智能体：声明式 subAgents → 自动注册 spawn_<name> 工具并追加进工具集
    // 默认无 subAgents 不注册，零破坏。子工具默认排除 spawn_* 防隐式无限递归。
    if (config.subAgents?.length) {
      this.tools = [
        ...this.tools,
        ...config.subAgents.map((sa) => createSubAgentTool(config, sa, this.tools)),
      ];
    }
  }

  async run(task: { task: string; context?: Record<string, unknown> }): Promise<RunResult> {
    const runId = randomUUID();
    // 在循环开始前记录时间戳：原实现放在循环结束后会丢失整个执行时长
    const startedAt = new Date().toISOString();
    // §事件溯源：用追加式日志作为上下文单一事实来源
    const log = new InMemorySessionLog();
    const ctx: RunContext = {
      runId,
      task: task.task,
      log,
      step: 0,
      tokenUsed: 0,
      state: task.context ?? {},
    };

    // 初始事件：用户任务作为对话起点（追加而非整存）
    log.append({ type: 'user', content: task.task });

    // §P3 计划模式：循环前生成计划，作为全局意图锚点注入后续每步 LLM 上下文
    // 缺省（无 planner）不执行，零破坏
    if (this.planner) {
      const plan = await this.planner.plan(task.task);
      log.setPlan(plan);
    }

    await this.hooks.beforeLoop(ctx);

    const result = await runLoop(ctx, {
      llm: this.llm,
      tools: this.tools,
      budget: this.budget,
      retry: this.retry,
      hooks: this.hooks,
      compactor: this.compactor,
      compactThreshold: this.compactThreshold,
    });

    await this.hooks.afterLoop(ctx, result);

    // 持久化最终状态（事件序列），供 resume 或审计使用
    const state: RunState = {
      runId,
      task: task.task,
      events: ctx.log.events,
      step: ctx.step,
      tokenUsed: ctx.tokenUsed,
      status: result.status === 'done' ? 'done' : result.status === 'failed' ? 'failed' : 'done',
      startedAt,
      // §X-1 步骤级追踪：持久化每步耗时分解，供 read-only trace API 投影
      timings: result.timings,
    };
    await this.stateStore.save(runId, state);

    return result;
  }

  async resume(runId: string): Promise<RunResult> {
    const state = await this.stateStore.load(runId);
    if (!state) {
      throw new Error(`No state found for runId: ${runId}`);
    }

    // 从断点恢复上下文（事件序列重建日志），继续未完成的循环
    const ctx: RunContext = {
      runId: state.runId,
      task: state.task,
      log: new InMemorySessionLog(state.events),
      step: state.step,
      tokenUsed: state.tokenUsed,
      state: {},
    };

    // §P3 计划模式：断点续跑同样注入计划（resume 不重放旧 plan，重新规划成本低、
    // 且能让续跑步骤对齐最新全局意图）。缺省不执行。
    if (this.planner) {
      const plan = await this.planner.plan(state.task);
      ctx.log.setPlan(plan);
    }

    await this.hooks.beforeLoop(ctx);

    const result = await runLoop(ctx, {
      llm: this.llm,
      tools: this.tools,
      budget: this.budget,
      retry: this.retry,
      hooks: this.hooks,
      compactor: this.compactor,
      compactThreshold: this.compactThreshold,
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
    // §X-1 步骤级追踪：runStream 记录 startedAt，trace 投影用其计算总时长
    const startedAt = new Date().toISOString();
    // §事件溯源：runStream 同样以日志为上下文来源
    const log = new InMemorySessionLog();
    const ctx: RunContext = {
      runId,
      task: task.task,
      log,
      step: 0,
      tokenUsed: 0,
      state: task.context ?? {},
    };

    log.append({ type: 'user', content: task.task });

    // §P3 计划模式（流式）：与非流式平行，循环前注入计划
    if (this.planner) {
      const plan = await this.planner.plan(task.task);
      log.setPlan(plan);
    }

    await this.hooks.beforeLoop(ctx);

    // §X-1 步骤级追踪：包裹 runLoopStream，在 done/error 终端事件时持久化状态（含 timings），
    // 供 read-only trace API 投影每步耗时分解，定位 143s/282s 级长耗时瓶颈。
    // 与原注释"恢复由消费端管理"不冲突：此处仅追加写入一次终端态 state 文件，不改变恢复语义。
    for await (const evt of runLoopStream(ctx, {
      llm: this.llm,
      tools: this.tools,
      budget: this.budget,
      retry: this.retry,
      hooks: this.hooks,
      compactor: this.compactor,
      compactThreshold: this.compactThreshold,
    })) {
      if (evt.type === 'done') {
        await this.stateStore.save(runId, {
          runId,
          task: task.task,
          events: ctx.log.events,
          step: ctx.step,
          tokenUsed: ctx.tokenUsed,
          status: 'done',
          startedAt,
          // §X-1 步骤级追踪：持久化每步耗时分解，供 read-only trace API 投影
          timings: ctx.timings ?? [],
        });
      } else if (evt.type === 'error') {
        await this.stateStore.save(runId, {
          runId,
          task: task.task,
          events: ctx.log.events,
          step: ctx.step,
          tokenUsed: ctx.tokenUsed,
          status: 'failed',
          startedAt,
          timings: ctx.timings ?? [],
        });
      }
      yield evt;
    }
  }
}

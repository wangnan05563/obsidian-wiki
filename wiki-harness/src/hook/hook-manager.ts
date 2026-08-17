import type {
  Hooks,
  RunContext,
  RunResult,
  StepResult,
  Interceptors,
  LlmRequestPayload,
  ToolCallPayload,
  ToolResultPayload,
  ToolCallNext,
  ToolResultNext,
} from '../types.js';

// Hook 管理器：统一封装两类扩展点
//  1) Hooks（通知式）：beforeLoop/afterLoop/beforeStep/afterStep，fire-and-forget，
//     业务 hook 异常不中断主循环。集成层（api）重度依赖 afterStep。
//  2) Interceptors（拦截总线，P1）：rewriteLlmRequest / interceptToolCall /
//     interceptToolResult，可改写或短路，对齐 DeepSeek Harness 的事件瀑布。
export class HookManager {
  constructor(
    private notifications: Partial<Hooks>,
    private interceptors: Partial<Interceptors> = {},
  ) {}

  // ---- 通知式 hooks（保持与现有集成层契约不变）----

  async beforeLoop(ctx: RunContext): Promise<void> {
    if (this.notifications.beforeLoop) {
      try {
        await this.notifications.beforeLoop(ctx);
      } catch (err) {
        console.warn('[Harness] beforeLoop hook error:', err);
      }
    }
  }

  async beforeStep(ctx: RunContext, step: number): Promise<void> {
    if (this.notifications.beforeStep) {
      try {
        await this.notifications.beforeStep(ctx, step);
      } catch (err) {
        console.warn('[Harness] beforeStep hook error:', err);
      }
    }
  }

  async afterStep(ctx: RunContext, step: number, result: StepResult): Promise<void> {
    if (this.notifications.afterStep) {
      try {
        await this.notifications.afterStep(ctx, step, result);
      } catch (err) {
        console.warn('[Harness] afterStep hook error:', err);
      }
    }
  }

  async afterLoop(ctx: RunContext, result: RunResult): Promise<void> {
    if (this.notifications.afterLoop) {
      try {
        await this.notifications.afterLoop(ctx, result);
      } catch (err) {
        console.warn('[Harness] afterLoop hook error:', err);
      }
    }
  }

  // ---- 拦截总线（P1）：对应 DeepSeek Harness 的事件瀑布 ----

  // LLM 请求改写：无拦截器时原样返回。拦截器异常不阻断主流程（回退透传）。
  async rewriteLlmRequest(payload: LlmRequestPayload): Promise<LlmRequestPayload> {
    const it = this.interceptors.onLlmRequest;
    if (!it) return payload;
    try {
      return await it(payload);
    } catch (err) {
      console.warn('[Harness] onLlmRequest interceptor error:', err);
      return payload;
    }
  }

  // 工具调用拦截：默认放行（调 next 执行真实 handler）。
  //   审批拒绝：拦截器不调 next，返回自定义结果（如 {error:'blocked'}）。
  //   改写参数：拦截器调 next(modifiedArgs)。拦截器异常回退为错误结果，不中断循环。
  async interceptToolCall(payload: ToolCallPayload, next: ToolCallNext): Promise<unknown> {
    const it = this.interceptors.onToolCall;
    if (!it) return next(payload.args);
    try {
      return await it(payload, next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[Harness] onToolCall interceptor error:', err);
      return { error: `Tool interceptor error: ${message}` };
    }
  }

  // 工具结果拦截：默认放行（next 返回原始 result）。
  //   脱敏/改写：拦截器不调 next，返回处理后结果。异常回退原始结果。
  async interceptToolResult(payload: ToolResultPayload, next: ToolResultNext): Promise<unknown> {
    const it = this.interceptors.onToolResult;
    if (!it) return next();
    try {
      return await it(payload, next);
    } catch (err) {
      console.warn('[Harness] onToolResult interceptor error:', err);
      return next();
    }
  }
}

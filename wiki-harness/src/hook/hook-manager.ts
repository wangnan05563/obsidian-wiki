import type { Hooks, RunContext, RunResult, StepResult } from '../types.js';

// Hook 管理器：统一封装 hook 的存在性检查，调用方无需每次判空
// 所有 hook 调用包裹 try-catch：业务 hook 异常不应中断主循环
export class HookManager {
  constructor(private hooks: Partial<Hooks>) {}

  async beforeLoop(ctx: RunContext): Promise<void> {
    if (this.hooks.beforeLoop) {
      try {
        await this.hooks.beforeLoop(ctx);
      } catch (err) {
        console.warn('[Harness] beforeLoop hook error:', err);
      }
    }
  }

  async beforeStep(ctx: RunContext, step: number): Promise<void> {
    if (this.hooks.beforeStep) {
      try {
        await this.hooks.beforeStep(ctx, step);
      } catch (err) {
        console.warn('[Harness] beforeStep hook error:', err);
      }
    }
  }

  async afterStep(ctx: RunContext, step: number, result: StepResult): Promise<void> {
    if (this.hooks.afterStep) {
      try {
        await this.hooks.afterStep(ctx, step, result);
      } catch (err) {
        console.warn('[Harness] afterStep hook error:', err);
      }
    }
  }

  async afterLoop(ctx: RunContext, result: RunResult): Promise<void> {
    if (this.hooks.afterLoop) {
      try {
        await this.hooks.afterLoop(ctx, result);
      } catch (err) {
        console.warn('[Harness] afterLoop hook error:', err);
      }
    }
  }
}

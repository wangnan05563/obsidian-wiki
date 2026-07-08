import type { Hooks, RunContext, RunResult, StepResult } from '../types.js';

// Hook 管理器：统一封装 hook 的存在性检查，调用方无需每次判空
// 使用可选链调用，未注册的 hook 直接跳过
export class HookManager {
  constructor(private hooks: Partial<Hooks>) {}

  async beforeLoop(ctx: RunContext): Promise<void> {
    await this.hooks.beforeLoop?.(ctx);
  }

  async beforeStep(ctx: RunContext, step: number): Promise<void> {
    await this.hooks.beforeStep?.(ctx, step);
  }

  async afterStep(ctx: RunContext, step: number, result: StepResult): Promise<void> {
    await this.hooks.afterStep?.(ctx, step, result);
  }

  async afterLoop(ctx: RunContext, result: RunResult): Promise<void> {
    await this.hooks.afterLoop?.(ctx, result);
  }
}

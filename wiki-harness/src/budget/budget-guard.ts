import type { BudgetConfig } from '../types.js';

// 预算守卫：返回 true 表示仍在预算内，可继续执行
// 步数和 token 任一耗尽即停止，防止失控循环
export function checkBudget(step: number, tokenUsed: number, budget: BudgetConfig): boolean {
  return step < budget.maxSteps && tokenUsed < budget.tokenBudget;
}

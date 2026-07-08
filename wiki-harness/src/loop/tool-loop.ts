import type {
  RunContext,
  RunResult,
  StepResult,
  Hooks,
  BudgetConfig,
  RetryConfig,
  Message,
  ToolDefinition,
} from '../types.js';
import type { LLMAdapter } from '../llm/llm-adapter.js';
import { checkBudget } from '../budget/budget-guard.js';
import { withRetry } from '../retry/retry-policy.js';
import { HookManager } from '../hook/hook-manager.js';

interface LoopConfig {
  llm: LLMAdapter;
  tools: ToolDefinition[];
  budget: BudgetConfig;
  retry: RetryConfig;
  hooks: Partial<Hooks>;
}

// 取最后一条 assistant 消息内容作为 finalContent
function getLastAssistantContent(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      return messages[i].content;
    }
  }
  return '';
}

// 工具调用循环：LLM 返回 tool_calls → 逐个执行 → 结果回填 → 下一轮
// 终止条件：LLM 返回纯文本无 tool_calls（done），或预算耗尽（budget_exceeded）
export async function runLoop(ctx: RunContext, config: LoopConfig): Promise<RunResult> {
  const hooks = new HookManager(config.hooks);

  while (true) {
    // 预算检查：步数或 token 任一耗尽立即终止，防止失控循环
    if (!checkBudget(ctx.step, ctx.tokenUsed, config.budget)) {
      return {
        runId: ctx.runId,
        status: 'budget_exceeded',
        messages: ctx.messages,
        finalContent: getLastAssistantContent(ctx.messages),
        step: ctx.step,
        tokenUsed: ctx.tokenUsed,
      };
    }

    await hooks.beforeStep(ctx, ctx.step);

    const stepResult: StepResult = {
      step: ctx.step,
      toolCalls: [],
      toolResults: [],
      tokenUsed: 0,
    };

    try {
      // LLM 调用失败按 retry 配置指数退避重试
      const response = await withRetry(
        () => config.llm.chat(ctx.messages, config.tools),
        config.retry,
      );

      // 构造 assistant 消息并入栈
      const assistantMessage: Message = {
        role: 'assistant',
        content: response.content,
        ...(response.tool_calls ? { tool_calls: response.tool_calls } : {}),
      };
      ctx.messages.push(assistantMessage);

      // 累加 token：优先用 API 返回值，缺失时用字符数估算
      const stepTokens =
        response.usage?.completion_tokens ?? config.llm.countTokens([assistantMessage]);
      ctx.tokenUsed += stepTokens;
      stepResult.tokenUsed = stepTokens;

      // 无 tool_calls 表示 LLM 认为任务完成
      if (!response.tool_calls || response.tool_calls.length === 0) {
        await hooks.afterStep(ctx, ctx.step, stepResult);
        return {
          runId: ctx.runId,
          status: 'done',
          messages: ctx.messages,
          finalContent: response.content,
          step: ctx.step + 1,
          tokenUsed: ctx.tokenUsed,
        };
      }

      stepResult.toolCalls = response.tool_calls;

      // 逐个执行工具调用：工具不存在或执行异常均回填错误对象，不中断循环
      for (const toolCall of response.tool_calls) {
        const tool = config.tools.find(t => t.name === toolCall.function.name);
        let result: unknown;
        if (!tool) {
          result = { error: `Tool not found: ${toolCall.function.name}` };
        } else {
          try {
            // arguments 是 JSON 字符串，需解析后传给 handler
            const args = JSON.parse(toolCall.function.arguments || '{}');
            result = await tool.handler(args, ctx);
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        stepResult.toolResults.push(result);
        // 工具结果以 role='tool' 消息回填，带 tool_call_id 供 LLM 关联
        ctx.messages.push({
          role: 'tool',
          content: JSON.stringify(result),
          tool_call_id: toolCall.id,
        });
      }
    } catch (err) {
      // 重试后仍失败，标记 failed
      await hooks.afterStep(ctx, ctx.step, stepResult);
      return {
        runId: ctx.runId,
        status: 'failed',
        messages: ctx.messages,
        finalContent: err instanceof Error ? err.message : String(err),
        step: ctx.step,
        tokenUsed: ctx.tokenUsed,
      };
    }

    await hooks.afterStep(ctx, ctx.step, stepResult);
    ctx.step++;
  }
}

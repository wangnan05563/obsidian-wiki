import type {
  RunContext,
  RunResult,
  StepResult,
  StepEvent,
  BudgetConfig,
  RetryConfig,
  Message,
  ToolCall,
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
  // 直接接收 HookManager 实例：避免 harness 与 loop 各创建一份实例导致 hook 状态分裂
  hooks: HookManager;
}

// 工具结果截断阈值：防大对象（如读取大文件、爬虫结果）撑爆 token 预算
const MAX_TOOL_RESULT_LENGTH = 8000;

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
  const hooks = config.hooks;

  while (true) {
    // 预算检查：步数或 token 任一耗尽立即终止，防止失控循环
    if (!checkBudget(ctx.step, ctx.tokenUsed, config.budget)) {
      return {
        runId: ctx.runId,
        status: 'budget_exceeded',
        messages: ctx.messages,
        finalContent: getLastAssistantContent(ctx.messages),
        // 与 done 路径保持一致：返回已执行到的步数，而非上一步编号
        step: ctx.step + 1,
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
      // 为什么用 prompt+completion：仅计 completion 会大幅低估实际消耗，预算控制失效
      const stepTokens =
        response.usage
          ? (response.usage.prompt_tokens + response.usage.completion_tokens)
          : config.llm.countTokens([assistantMessage]);
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
        // 工具结果截断：大对象会直接耗尽 token 预算导致后续 LLM 调用失败
        const resultStr = JSON.stringify(result);
        const truncatedContent = resultStr.length > MAX_TOOL_RESULT_LENGTH
          ? resultStr.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n...[truncated]'
          : resultStr;
        // 工具结果以 role='tool' 消息回填，带 tool_call_id 供 LLM 关联
        ctx.messages.push({
          role: 'tool',
          content: truncatedContent,
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
        // 与 done 路径保持一致：返回已执行到的步数，而非上一步编号
        step: ctx.step + 1,
        tokenUsed: ctx.tokenUsed,
      };
    }

    await hooks.afterStep(ctx, ctx.step, stepResult);
    ctx.step++;
  }
}

// §真流式 runLoop：与 runLoop 平行，差异在 LLM 调用走 chatStream
//   每个 delta 即时 yield，工具调用生命周期事件化（tool_call/tool_result）
//   为什么不修改 runLoop 而新增函数：保持非流式分支稳定，降低回归风险
//   约束：工具执行仍是非流式（工具内部逻辑不感知流式），仅 LLM 输出是流式
export async function* runLoopStream(ctx: RunContext, config: LoopConfig): AsyncGenerator<StepEvent> {
  const hooks = config.hooks;

  while (true) {
    // 预算检查：步数或 token 耗尽即终止
    if (!checkBudget(ctx.step, ctx.tokenUsed, config.budget)) {
      yield {
        type: 'error',
        message: 'Budget exceeded',
        step: ctx.step,
      };
      return;
    }

    await hooks.beforeStep(ctx, ctx.step);

    const stepResult: StepResult = {
      step: ctx.step,
      toolCalls: [],
      toolResults: [],
      tokenUsed: 0,
    };

    try {
      // §流式累积：chatStream 逐 chunk yield delta，最后可能 yield 一次完整 tool_calls
      //   这里用 for-await 消费，delta 即时转发给上层，tool_calls 在流结束后处理
      let assistantContent = '';
      let toolCalls: ToolCall[] | undefined;

      for await (const chunk of config.llm.chatStream(ctx.messages, config.tools)) {
        if (chunk.delta) {
          assistantContent += chunk.delta;
          yield { type: 'delta', text: chunk.delta };
        }
        if (chunk.tool_calls && chunk.tool_calls.length > 0) {
          toolCalls = chunk.tool_calls;
        }
      }

      // 构造 assistant 消息并入栈（与非流式分支保持一致）
      const assistantMessage: Message = {
        role: 'assistant',
        content: assistantContent,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      };
      ctx.messages.push(assistantMessage);

      // token 估算：流式无 usage 字段，用字符数粗略估
      const stepTokens = config.llm.countTokens([assistantMessage]);
      ctx.tokenUsed += stepTokens;
      stepResult.tokenUsed = stepTokens;

      // 无 tool_calls 表示 LLM 任务完成
      if (!toolCalls || toolCalls.length === 0) {
        await hooks.afterStep(ctx, ctx.step, stepResult);
        yield {
          type: 'done',
          finalContent: assistantContent,
          step: ctx.step + 1,
          tokenUsed: ctx.tokenUsed,
        };
        return;
      }

      stepResult.toolCalls = toolCalls;

      // 逐个执行工具调用，每个工具 yield 生命周期事件
      for (const toolCall of toolCalls) {
        yield { type: 'tool_call', step: ctx.step, toolCall };

        const tool = config.tools.find(t => t.name === toolCall.function.name);
        let result: unknown;
        if (!tool) {
          result = { error: `Tool not found: ${toolCall.function.name}` };
        } else {
          try {
            const args = JSON.parse(toolCall.function.arguments || '{}');
            result = await tool.handler(args, ctx);
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        stepResult.toolResults.push(result);

        // 工具结果截断：与非流式分支一致
        const resultStr = JSON.stringify(result);
        const truncatedContent = resultStr.length > MAX_TOOL_RESULT_LENGTH
          ? resultStr.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n...[truncated]'
          : resultStr;
        ctx.messages.push({
          role: 'tool',
          content: truncatedContent,
          tool_call_id: toolCall.id,
        });

        yield { type: 'tool_result', step: ctx.step, toolCall, result };
      }
    } catch (err) {
      await hooks.afterStep(ctx, ctx.step, stepResult);
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        step: ctx.step,
      };
      return;
    }

    await hooks.afterStep(ctx, ctx.step, stepResult);
    ctx.step++;
  }
}

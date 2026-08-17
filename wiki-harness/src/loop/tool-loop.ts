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
  Compactor,
} from '../types.js';
import type { LLMAdapter } from '../llm/llm-adapter.js';
import { checkBudget } from '../budget/budget-guard.js';
import { withRetry } from '../retry/retry-policy.js';
import { HookManager } from '../hook/hook-manager.js';
import { compactLog } from '../session/compaction.js';

interface LoopConfig {
  llm: LLMAdapter;
  tools: ToolDefinition[];
  budget: BudgetConfig;
  retry: RetryConfig;
  // 直接接收 HookManager 实例：避免 harness 与 loop 各创建一份实例导致 hook 状态分裂
  hooks: HookManager;
  // §P2 上下文压缩：可选，缺省不压缩
  compactor?: Compactor;
  compactThreshold?: number;
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
        messages: ctx.log.messages(),
        finalContent: getLastAssistantContent(ctx.log.messages()),
        // 与 done 路径保持一致：返回已执行到的步数，而非上一步编号
        step: ctx.step + 1,
        tokenUsed: ctx.tokenUsed,
        timings: ctx.timings ?? [],
      };
    }

    await hooks.beforeStep(ctx, ctx.step);

    // §P2 上下文压缩：在每步 LLM 调用前判断并压缩早期历史（默认不传 compactor 不触发）
    if (config.compactor) {
      await compactLog(ctx.log, config.compactor, ctx, config.compactThreshold);
    }

    const stepResult: StepResult = {
      step: ctx.step,
      toolCalls: [],
      toolResults: [],
      tokenUsed: 0,
    };

    try {
      // §拦截总线：onLlmRequest 可改写发往 LLM 的请求（注入 system prompt / 裁剪 tools）
      const llmReq = await hooks.rewriteLlmRequest({
        messages: ctx.log.messages(),
        tools: config.tools,
        ctx,
      });
      // §X-1 步骤级追踪：LLM 调用耗时（含重试退避）
      const llmT0 = Date.now();
      const response = await withRetry(
        () => config.llm.chat(llmReq.messages, llmReq.tools),
        config.retry,
      );
      const llmMs = Date.now() - llmT0;

      // 追加 assistant 事件（事件溯源：写入 log 而非直接持有 Message[]）
      ctx.log.append({
        type: 'assistant',
        content: response.content,
        ...(response.tool_calls ? { tool_calls: response.tool_calls } : {}),
      });

      // 累加 token：优先用 API 返回值，缺失时用字符数估算
      // 为什么用 prompt+completion：仅计 completion 会大幅低估实际消耗，预算控制失效
      const assistantMessage: Message = {
        role: 'assistant',
        content: response.content,
        ...(response.tool_calls ? { tool_calls: response.tool_calls } : {}),
      };
      const stepTokens =
        response.usage
          ? (response.usage.prompt_tokens + response.usage.completion_tokens)
          : config.llm.countTokens([assistantMessage]);
      ctx.tokenUsed += stepTokens;
      stepResult.tokenUsed = stepTokens;

      // 无 tool_calls 表示 LLM 认为任务完成
      if (!response.tool_calls || response.tool_calls.length === 0) {
        // §X-1 步骤级追踪：纯 LLM 步（无工具），记录耗时
        const timings = (ctx.timings ??= []);
        timings.push({ step: ctx.step, llmMs, toolMs: 0, tokens: stepTokens, toolNames: [] });
        console.log('[harness-step]', JSON.stringify({ runId: ctx.runId, step: ctx.step, llmMs, toolMs: 0, tokens: stepTokens, toolNames: [] }));
        await hooks.afterStep(ctx, ctx.step, stepResult);
        return {
          runId: ctx.runId,
          status: 'done',
          messages: ctx.log.messages(),
          finalContent: response.content,
          step: ctx.step + 1,
          tokenUsed: ctx.tokenUsed,
          timings: ctx.timings ?? [],
        };
      }

      stepResult.toolCalls = response.tool_calls;
      // §X-1 步骤级追踪：本步工具名列表（用于定位卡点）
      const toolNames = response.tool_calls.map((tc) => tc.function.name);

      // 逐个执行工具调用（经拦截总线）
      const toolT0 = Date.now();
      for (const toolCall of response.tool_calls) {
        const tool = config.tools.find(t => t.name === toolCall.function.name);
        // arguments 是 JSON 字符串，解析失败按空对象兜底（不中断循环）
        let baseArgs: unknown;
        try {
          baseArgs = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          baseArgs = {};
        }
        // §拦截总线：onToolCall 可审批拒绝 / 改写参数 / 替换执行；
        //   next 包裹真实 handler（含 tool-not-found 与异常包装），保持原语义
        const result = await hooks.interceptToolCall(
          { toolCall, args: baseArgs, tool, ctx },
          async (args) => {
            if (!tool) return { error: `Tool not found: ${toolCall.function.name}` };
            try {
              return await tool.handler(args, ctx);
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) };
            }
          },
        );
        stepResult.toolResults.push(result);
        // §拦截总线：onToolResult 可在回填 LLM 前脱敏 / 改写结果
        const finalResult = await hooks.interceptToolResult(
          { toolCallId: toolCall.id, result, ctx },
          async () => result,
        );
        // 工具结果截断：大对象会直接耗尽 token 预算导致后续 LLM 调用失败
        const resultStr = JSON.stringify(finalResult);
        const truncatedContent = resultStr.length > MAX_TOOL_RESULT_LENGTH
          ? resultStr.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n...[truncated]'
          : resultStr;
        // 工具结果以 role='tool' 事件回填，带 tool_call_id 供 LLM 关联
        ctx.log.append({
          type: 'tool',
          content: truncatedContent,
          tool_call_id: toolCall.id,
        });
      }
      // §X-1 步骤级追踪：本步工具执行总耗时
      const toolMs = Date.now() - toolT0;
      const tTimings = (ctx.timings ??= []);
      tTimings.push({ step: ctx.step, llmMs, toolMs, tokens: stepTokens, toolNames });
      console.log('[harness-step]', JSON.stringify({ runId: ctx.runId, step: ctx.step, llmMs, toolMs, tokens: stepTokens, toolNames }));
    } catch (err) {
      // 重试后仍失败，标记 failed
      await hooks.afterStep(ctx, ctx.step, stepResult);
      return {
        runId: ctx.runId,
        status: 'failed',
        messages: ctx.log.messages(),
        finalContent: err instanceof Error ? err.message : String(err),
        // 与 done 路径保持一致：返回已执行到的步数，而非上一步编号
        step: ctx.step + 1,
        tokenUsed: ctx.tokenUsed,
        timings: ctx.timings ?? [],
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

    // §P2 上下文压缩：与非流式分支平行，每步 LLM 调用前判断并压缩早期历史
    if (config.compactor) {
      await compactLog(ctx.log, config.compactor, ctx, config.compactThreshold);
    }

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

      // §拦截总线：onLlmRequest 改写请求后走流式（与非流式共用同一拦截点）
      const llmReq = await hooks.rewriteLlmRequest({
        messages: ctx.log.messages(),
        tools: config.tools,
        ctx,
      });
      // §X-1 步骤级追踪：流式 LLM 调用耗时（从首 chunk 到末 chunk）
      const llmT0 = Date.now();
      for await (const chunk of config.llm.chatStream(llmReq.messages, llmReq.tools)) {
        if (chunk.delta) {
          assistantContent += chunk.delta;
          yield { type: 'delta', text: chunk.delta };
        }
        if (chunk.tool_calls && chunk.tool_calls.length > 0) {
          toolCalls = chunk.tool_calls;
        }
      }

      // §X-1 步骤级追踪：流式 LLM 调用总耗时
      const llmMs = Date.now() - llmT0;
      const toolNames = toolCalls ? toolCalls.map((tc) => tc.function.name) : [];

      // 追加 assistant 事件（与非流式分支保持一致，事件溯源）
      ctx.log.append({
        type: 'assistant',
        content: assistantContent,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      });

      // token 估算：流式无 usage 字段，用字符数粗略估
      const assistantMessage: Message = {
        role: 'assistant',
        content: assistantContent,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      };
      const stepTokens = config.llm.countTokens([assistantMessage]);
      ctx.tokenUsed += stepTokens;
      stepResult.tokenUsed = stepTokens;

      // 无 tool_calls 表示 LLM 任务完成
      if (!toolCalls || toolCalls.length === 0) {
        // §X-1 步骤级追踪：纯 LLM 流式步（无工具），记录耗时
        const stTimings = (ctx.timings ??= []);
        stTimings.push({ step: ctx.step, llmMs, toolMs: 0, tokens: stepTokens, toolNames: [] });
        console.log('[harness-step]', JSON.stringify({ runId: ctx.runId, step: ctx.step, llmMs, toolMs: 0, tokens: stepTokens, toolNames: [] }));
        await hooks.afterStep(ctx, ctx.step, stepResult);
        yield {
          type: 'done',
          finalContent: assistantContent,
          step: ctx.step + 1,
          tokenUsed: ctx.tokenUsed,
          runId: ctx.runId,
        };
        return;
      }

      stepResult.toolCalls = toolCalls;

      // 逐个执行工具调用（经拦截总线），每个工具 yield 生命周期事件
      const toolT0 = Date.now();
      for (const toolCall of toolCalls) {
        yield { type: 'tool_call', step: ctx.step, toolCall };

        const tool = config.tools.find(t => t.name === toolCall.function.name);
        let baseArgs: unknown;
        try {
          baseArgs = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          baseArgs = {};
        }
        // §拦截总线：onToolCall 审批 / 改写参数；next 包裹真实 handler（含 not-found/异常）
        const result = await hooks.interceptToolCall(
          { toolCall, args: baseArgs, tool, ctx },
          async (args) => {
            if (!tool) return { error: `Tool not found: ${toolCall.function.name}` };
            try {
              return await tool.handler(args, ctx);
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) };
            }
          },
        );
        stepResult.toolResults.push(result);
        // §拦截总线：onToolResult 脱敏 / 改写
        const finalResult = await hooks.interceptToolResult(
          { toolCallId: toolCall.id, result, ctx },
          async () => result,
        );

        // 工具结果截断：与非流式分支一致
        const resultStr = JSON.stringify(finalResult);
        const truncatedContent = resultStr.length > MAX_TOOL_RESULT_LENGTH
          ? resultStr.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n...[truncated]'
          : resultStr;
        ctx.log.append({
          type: 'tool',
          content: truncatedContent,
          tool_call_id: toolCall.id,
        });

        yield { type: 'tool_result', step: ctx.step, toolCall, result: finalResult };
      }
      // §X-1 步骤级追踪：流式步工具执行总耗时
      const toolMs = Date.now() - toolT0;
      const stTimings2 = (ctx.timings ??= []);
      stTimings2.push({ step: ctx.step, llmMs, toolMs, tokens: stepTokens, toolNames });
      console.log('[harness-step]', JSON.stringify({ runId: ctx.runId, step: ctx.step, llmMs, toolMs, tokens: stepTokens, toolNames }));
    } catch (err) {
      await hooks.afterStep(ctx, ctx.step, stepResult);
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        step: ctx.step,
        runId: ctx.runId,
      };
      return;
    }

    await hooks.afterStep(ctx, ctx.step, stepResult);
    ctx.step++;
  }
}

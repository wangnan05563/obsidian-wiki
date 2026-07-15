import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMAdapter } from '../src/llm/llm-adapter.js';
import type { Message, ToolDefinition, RunContext, LLMResponse } from '../src/types.js';
import { runLoop } from '../src/loop/tool-loop.js';
import { HookManager } from '../src/hook/hook-manager.js';
import type { BudgetConfig, RetryConfig } from '../src/types.js';

// 模拟 LLM 适配器：按预设序列返回响应
class MockLLMAdapter implements LLMAdapter {
  private responses: LLMResponse[];
  private index = 0;

  constructor(responses: LLMResponse[]) {
    this.responses = responses;
  }

  async chat(): Promise<LLMResponse> {
    const resp = this.responses[this.index++];
    if (!resp) throw new Error('No more mock responses');
    return resp;
  }

  async *chatStream(): AsyncIterable<{ delta: string; tool_calls?: unknown[] }> {
    yield { delta: 'mock' };
  }

  countTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 3), 0);
  }
}

const defaultBudget: BudgetConfig = { maxSteps: 20, tokenBudget: 50000 };
const defaultRetry: RetryConfig = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, retryOn: ['timeout'] };

function makeCtx(): RunContext {
  return {
    runId: 'test-run-id',
    task: 'test task',
    messages: [{ role: 'user', content: 'hello' }],
    step: 0,
    tokenUsed: 0,
    state: {},
  };
}

describe('runLoop', () => {
  it('should return done when LLM responds without tool_calls', async () => {
    const llm = new MockLLMAdapter([
      { content: 'task completed', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    const hooks = new HookManager({});

    const result = await runLoop(makeCtx(), {
      llm,
      tools: [],
      budget: defaultBudget,
      retry: defaultRetry,
      hooks,
    });

    assert.equal(result.status, 'done');
    assert.equal(result.finalContent, 'task completed');
    assert.equal(result.step, 1);
  });

  it('should return budget_exceeded when maxSteps reached', async () => {
    // 每次都返回 tool_calls，永不 done
    const toolResponse: LLMResponse = {
      content: '',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'echo', arguments: '{}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const llm = new MockLLMAdapter(Array(30).fill(toolResponse));
    const hooks = new HookManager({});

    const ctx = makeCtx();
    ctx.step = 19; // 从第 19 步开始，下一步就超限

    const result = await runLoop(ctx, {
      llm,
      tools: [{
        name: 'echo',
        description: 'echo tool',
        parameters: {},
        handler: async () => 'echoed',
      }],
      budget: { maxSteps: 20, tokenBudget: 50000 },
      retry: defaultRetry,
      hooks,
    });

    assert.equal(result.status, 'budget_exceeded');
  });

  it('should return failed when LLM throws error', async () => {
    const llm = new MockLLMAdapter([]);
    const hooks = new HookManager({});

    const result = await runLoop(makeCtx(), {
      llm,
      tools: [],
      budget: defaultBudget,
      retry: { ...defaultRetry, maxRetries: 0 },
      hooks,
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.finalContent.length > 0);
  });

  it('should execute tools and continue loop', async () => {
    const llm = new MockLLMAdapter([
      { content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'echo', arguments: '{"msg":"hi"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { content: 'done after tool', usage: { prompt_tokens: 15, completion_tokens: 5 } },
    ]);
    const hooks = new HookManager({});

    const result = await runLoop(makeCtx(), {
      llm,
      tools: [{
        name: 'echo',
        description: 'echo tool',
        parameters: {},
        handler: async (args) => args,
      }],
      budget: defaultBudget,
      retry: defaultRetry,
      hooks,
    });

    assert.equal(result.status, 'done');
    assert.equal(result.finalContent, 'done after tool');
    assert.equal(result.step, 2);
  });

  it('should handle tool not found gracefully', async () => {
    const llm = new MockLLMAdapter([
      { content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'nonexistent', arguments: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { content: 'done', usage: { prompt_tokens: 15, completion_tokens: 5 } },
    ]);
    const hooks = new HookManager({});

    const result = await runLoop(makeCtx(), {
      llm,
      tools: [],
      budget: defaultBudget,
      retry: defaultRetry,
      hooks,
    });

    assert.equal(result.status, 'done');
    // 工具不存在的错误应该被回填到 messages 中
    const toolMsg = result.messages.find(m => m.role === 'tool');
    assert.ok(toolMsg);
    assert.ok(toolMsg.content.includes('Tool not found'));
  });
});

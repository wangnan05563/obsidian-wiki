import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMAdapter } from '../src/llm/llm-adapter.js';
import type { Message, ToolDefinition, RunContext, LLMResponse, LLMChunk } from '../src/types.js';
import { runLoop } from '../src/loop/tool-loop.js';
import { HookManager } from '../src/hook/hook-manager.js';
import { InMemorySessionLog } from '../src/session/session-log.js';
import { SimpleConcatCompactor } from '../src/session/compaction.js';
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
    // §事件溯源：上下文历史由日志提供
    log: new InMemorySessionLog([{ type: 'user', content: 'hello', ts: '' }]),
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

// §P1 集成测试：验证拦截总线贯穿 runLoop（护栏拒绝 / system prompt 注入）
class RecordingLLMAdapter implements LLMAdapter {
  lastMessages: Message[] = [];
  lastTools: ToolDefinition[] = [];
  private responses: LLMResponse[];
  private index = 0;

  constructor(responses: LLMResponse[]) {
    this.responses = responses;
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse> {
    this.lastMessages = messages;
    this.lastTools = tools;
    const resp = this.responses[this.index++];
    if (!resp) throw new Error('No more mock responses');
    return resp;
  }

  async *chatStream(): AsyncIterable<LLMChunk> {
    yield { delta: 'mock' };
  }

  countTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 3), 0);
  }
}

describe('runLoop with interceptors', () => {
  it('onToolCall guardrail blocks execution and result flows back to LLM', async () => {
    let toolExecuted = 0;
    const llm = new MockLLMAdapter([
      { content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'echo', arguments: '{"msg":"hi"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { content: 'done after block', usage: { prompt_tokens: 15, completion_tokens: 5 } },
    ]);
    // 护栏：拒绝任何工具调用，不执行真实 handler
    const hooks = new HookManager({}, {
      onToolCall: async () => ({ error: 'blocked by guardrail' }),
    });

    const result = await runLoop(makeCtx(), {
      llm,
      tools: [{
        name: 'echo',
        description: 'echo tool',
        parameters: {},
        handler: async () => { toolExecuted++; return 'echoed'; },
      }],
      budget: defaultBudget,
      retry: defaultRetry,
      hooks,
    });

    assert.equal(result.status, 'done');
    assert.equal(toolExecuted, 0); // handler 未执行
    const toolMsg = result.messages.find(m => m.role === 'tool');
    assert.ok(toolMsg);
    assert.ok(toolMsg.content.includes('blocked by guardrail'));
  });

  it('onLlmRequest injects system prompt into the LLM request', async () => {
    const llm = new RecordingLLMAdapter([
      { content: 'done', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    const hooks = new HookManager({}, {
      onLlmRequest: async (payload) => ({
        ...payload,
        messages: [{ role: 'system', content: 'You are a guard.' } as Message, ...payload.messages],
      }),
    });

    const result = await runLoop(makeCtx(), {
      llm,
      tools: [],
      budget: defaultBudget,
      retry: defaultRetry,
      hooks,
    });

    assert.equal(result.status, 'done');
    assert.equal(llm.lastMessages[0].role, 'system');
    assert.equal(llm.lastMessages[0].content, 'You are a guard.');
  });
});

// §P2 集成测试：验证上下文压缩接入 runLoop（压缩早期历史后再发往 LLM）
describe('runLoop with compaction', () => {
  it('compresses early history before LLM call when threshold exceeded', async () => {
    // 预置较长历史，含一个无 tool_calls 的 assistant 作为安全边界锚点
    const log = new InMemorySessionLog();
    log.append({ type: 'user', content: 'u0' });
    log.append({ type: 'assistant', content: 'a0', tool_calls: [{ id: 'c0', type: 'function', function: { name: 'f', arguments: '{}' } }] });
    log.append({ type: 'tool', content: 't0', tool_call_id: 'c0' });
    log.append({ type: 'user', content: 'u1' });
    log.append({ type: 'assistant', content: 'note' }); // 安全边界锚点
    log.append({ type: 'user', content: 'u2' });
    log.append({ type: 'assistant', content: 'a2', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'f', arguments: '{}' } }] });
    log.append({ type: 'tool', content: 't2', tool_call_id: 'c2' });

    const ctx: RunContext = {
      runId: 'compact-run',
      task: 'task',
      log,
      step: 0,
      tokenUsed: 0,
      state: {},
    };

    const llm = new RecordingLLMAdapter([
      { content: 'done', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    const hooks = new HookManager({});

    const result = await runLoop(ctx, {
      llm,
      tools: [],
      budget: defaultBudget,
      retry: defaultRetry,
      hooks,
      compactor: new SimpleConcatCompactor(),
      compactThreshold: 4,
    });

    assert.equal(result.status, 'done');
    // 压缩后 LLM 收到的首条消息是 system 摘要
    assert.equal(llm.lastMessages[0].role, 'system');
    assert.match(llm.lastMessages[0].content, /已压缩的早期上下文/);
    // 未被压缩的尾部保留（u2 仍在）
    assert.ok(llm.lastMessages.some((m) => m.role === 'user' && m.content === 'u2'));
  });
});

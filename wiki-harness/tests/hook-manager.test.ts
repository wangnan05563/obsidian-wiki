import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HookManager } from '../src/hook/hook-manager.js';
import { InMemorySessionLog } from '../src/session/session-log.js';
import type { RunContext, ToolDefinition, Message, ToolCall } from '../src/types.js';

function makeCtx(): RunContext {
  return {
    runId: 'test-run-id',
    task: 'test task',
    log: new InMemorySessionLog([{ type: 'user', content: 'hello', ts: '' }]),
    step: 0,
    tokenUsed: 0,
    state: {},
  };
}

// §P1 拦截总线单元测试：验证 rewriteLlmRequest / interceptToolCall / interceptToolResult
// 的三种核心语义——放行（调 next）、改写/短路（不调 next）、拦截器异常回退。
describe('HookManager interceptors', () => {
  // ---- rewriteLlmRequest（纯改写器，无 next）----

  it('rewriteLlmRequest passes payload through when no interceptor', async () => {
    const hm = new HookManager({});
    const payload = { messages: [], tools: [], ctx: makeCtx() };
    const out = await hm.rewriteLlmRequest(payload);
    assert.equal(out, payload);
  });

  it('rewriteLlmRequest injects system prompt into messages', async () => {
    const hm = new HookManager({}, {
      onLlmRequest: async (p) => ({
        ...p,
        messages: [{ role: 'system', content: 'guard' } as Message, ...p.messages],
      }),
    });
    const out = await hm.rewriteLlmRequest({ messages: [], tools: [], ctx: makeCtx() });
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, 'system');
    assert.equal(out.messages[0].content, 'guard');
  });

  it('rewriteLlmRequest falls back to original payload on interceptor error', async () => {
    const hm = new HookManager({}, {
      onLlmRequest: async () => { throw new Error('boom'); },
    });
    const payload = { messages: [], tools: [], ctx: makeCtx() };
    const out = await hm.rewriteLlmRequest(payload);
    assert.equal(out, payload);
  });

  // ---- interceptToolCall（带 next）----

  it('interceptToolCall defaults to running next', async () => {
    const hm = new HookManager({});
    let nextCalled = false;
    const next = async (args: unknown) => { nextCalled = true; return args; };
    const out = await hm.interceptToolCall(
      { toolCall: {} as ToolCall, args: { x: 1 }, ctx: makeCtx() },
      next,
    );
    assert.equal(nextCalled, true);
    assert.deepEqual(out, { x: 1 });
  });

  it('interceptToolCall guardrail blocks execution (does not call next)', async () => {
    const hm = new HookManager({}, {
      onToolCall: async () => ({ error: 'blocked by guardrail' }),
    });
    let nextCalled = false;
    const next = async () => { nextCalled = true; return { ok: true }; };
    const out = await hm.interceptToolCall(
      { toolCall: {} as ToolCall, args: {}, ctx: makeCtx() },
      next,
    );
    assert.equal(nextCalled, false);
    assert.deepEqual(out, { error: 'blocked by guardrail' });
  });

  it('interceptToolCall rewrites args before calling next', async () => {
    const hm = new HookManager({}, {
      onToolCall: async (p, next) => next({ ...(p.args as object), injected: true }),
    });
    let received: unknown;
    const next = async (args: unknown) => { received = args; return args; };
    await hm.interceptToolCall(
      { toolCall: {} as ToolCall, args: { a: 1 }, ctx: makeCtx() },
      next,
    );
    assert.deepEqual(received, { a: 1, injected: true });
  });

  it('interceptToolCall returns error result on interceptor throw (no crash)', async () => {
    const hm = new HookManager({}, {
      onToolCall: async () => { throw new Error('boom'); },
    });
    let nextCalled = false;
    const next = async () => { nextCalled = true; return { ok: true }; };
    const out = await hm.interceptToolCall(
      { toolCall: {} as ToolCall, args: {}, ctx: makeCtx() },
      next,
    );
    assert.equal(nextCalled, false);
    assert.ok((out as { error: string }).error.includes('Tool interceptor error: boom'));
  });

  // ---- interceptToolResult（带 next，next 返回原始 result）----

  it('interceptToolResult defaults to original result', async () => {
    const hm = new HookManager({});
    const next = async () => ({ secret: 'value' });
    const out = await hm.interceptToolResult(
      { toolCallId: 'tc1', result: { secret: 'value' }, ctx: makeCtx() },
      next,
    );
    assert.deepEqual(out, { secret: 'value' });
  });

  it('interceptToolResult redacts result without calling next', async () => {
    const hm = new HookManager({}, {
      onToolResult: async () => ({ redacted: true }),
    });
    let nextCalled = false;
    const next = async () => { nextCalled = true; return { secret: 'value' }; };
    const out = await hm.interceptToolResult(
      { toolCallId: 'tc1', result: { secret: 'value' }, ctx: makeCtx() },
      next,
    );
    assert.equal(nextCalled, false);
    assert.deepEqual(out, { redacted: true });
  });

  it('interceptToolResult falls back to original on interceptor error', async () => {
    const hm = new HookManager({}, {
      onToolResult: async () => { throw new Error('boom'); },
    });
    const original = { secret: 'value' };
    const next = async () => original;
    const out = await hm.interceptToolResult(
      { toolCallId: 'tc1', result: original, ctx: makeCtx() },
      next,
    );
    assert.deepEqual(out, original);
  });

  // ---- 通知式 hooks 仍可用（向后兼容，构造第二参数缺省）----

  it('notification hooks still work with only first constructor arg', async () => {
    let fired = false;
    const hm = new HookManager({ afterStep: async () => { fired = true; } });
    await hm.afterStep(makeCtx(), 0, { step: 0, toolCalls: [], toolResults: [], tokenUsed: 0 });
    assert.equal(fired, true);
  });
});

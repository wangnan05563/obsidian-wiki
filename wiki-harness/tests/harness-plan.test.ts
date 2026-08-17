import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Harness } from '../src/harness.js';
import { StaticPlanner } from '../src/session/planning.js';
import type { HarnessConfig, Message } from '../src/types.js';

// §P3 端到端验证：mock 原生 fetch，让 OpenAICompatibleAdapter 返回可控响应，
// 并捕获发给 LLM 的请求体，断言计划是否以 system 消息注入上下文开头。
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(capture: (body: { messages: Message[] }) => void): void {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { messages: Message[] };
    capture(body);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '完成', tool_calls: undefined } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

function baseConfig(planner?: HarnessConfig['planner']): HarnessConfig {
  return {
    llm: { provider: 'deepseek', baseUrl: 'http://x', apiKey: 'k', model: 'm' },
    tools: [],
    planner,
  };
}

describe('Harness 计划模式端到端', () => {
  it('提供 planner 时，plan 注入为 LLM 上下文开头 system 消息', async () => {
    let captured: { messages: Message[] } | null = null;
    mockFetch((b) => {
      captured = b;
    });
    const harness = new Harness(baseConfig(new StaticPlanner('全局计划文本')));
    await harness.run({ task: '做个实验' });

    assert.ok(captured, '主循环应调用 LLM');
    const msgs = captured!.messages;
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[0].content, '全局计划文本');
    assert.equal(msgs[1].role, 'user');
    assert.equal(msgs[1].content, '做个实验');
  });

  it('不提供 planner 时不注入额外 system 消息（零破坏）', async () => {
    let captured: { messages: Message[] } | null = null;
    mockFetch((b) => {
      captured = b;
    });
    const harness = new Harness(baseConfig());
    await harness.run({ task: '做个实验' });

    assert.ok(captured);
    assert.equal(captured!.messages[0].role, 'user');
  });
});

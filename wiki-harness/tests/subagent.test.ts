import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Harness } from '../src/harness.js';
import { createSubAgentTool } from '../src/subagent.js';
import type { HarnessConfig, Message } from '../src/types.js';

// §P3-SubAgent 验证：mock 原生 fetch，让 OpenAICompatibleAdapter 返回可控响应，
// 捕获发给 LLM 的请求，断言子智能体是否被真正 spawn 且结果回填父循环。
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (body: { messages: Message[] }) => unknown): void {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { messages: Message[] };
    const res = handler(body);
    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function baseConfig(subAgents?: HarnessConfig['subAgents']): HarnessConfig {
  return {
    llm: { provider: 'deepseek', baseUrl: 'http://x', apiKey: 'k', model: 'm' },
    tools: [],
    subAgents,
  };
}

// 标准 chat 响应构造助手
function chatRes(content: string, toolCalls?: unknown) {
  return { choices: [{ message: { content, tool_calls: toolCalls } }] };
}

describe('createSubAgentTool 静态属性', () => {
  it('生成 spawn_<name> 工具并含 task 必填参数', () => {
    const tool = createSubAgentTool(baseConfig(), { name: 'researcher' }, []);
    assert.equal(tool.name, 'spawn_researcher');
    assert.match(tool.description, /子智能体|researcher/);
    const params = tool.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    assert.ok(params.properties['task']);
    assert.deepEqual(params.required, ['task']);
  });

  it('白名单 tools 过滤子可用工具', () => {
    const parentTools = [
      { name: 'a', description: '', parameters: {}, handler: async () => {} },
      { name: 'spawn_other', description: '', parameters: {}, handler: async () => {} },
    ] as unknown as HarnessConfig['tools'];
    const tool = createSubAgentTool(baseConfig(), { name: 'x', tools: ['a'] }, parentTools);
    // 仅验证工具可构造（过滤逻辑在 handler 内 new Harness 时生效，单测聚焦静态属性）
    assert.equal(tool.name, 'spawn_x');
  });
});

describe('子智能体端到端 spawn', () => {
  it('父 LLM 调用 spawn 工具 → 子 Harness 被 spawn 且结果回填父', async () => {
    let calls = 0;
    mockFetch((body) => {
      calls++;
      const msgs = body.messages;
      const last = msgs[msgs.length - 1];
      // 父第 1 次：要求委派子任务
      if (last?.role === 'user' && last.content === '主任务') {
        return chatRes('', [
          { id: '1', type: 'function', function: { name: 'spawn_researcher', arguments: '{"task":"子任务"}' } },
        ]);
      }
      // 子：直接完成
      if (last?.role === 'user' && last.content === '子任务') {
        return chatRes('子结果');
      }
      // 父第 2 次：仅当 messages 真含子结果（证明 spawn 生效）才整合
      const hasChild = JSON.stringify(msgs).includes('子结果');
      return chatRes(hasChild ? '父整合: 子结果' : '父无子结果');
    });

    const harness = new Harness(baseConfig([{ name: 'researcher' }]));
    const result = await harness.run({ task: '主任务' });

    assert.equal(result.status, 'done');
    // 若 spawn 未生效，父第2次 messages 不含子结果 → 返回 '父无子结果'；断言收紧区分
    assert.equal(result.finalContent, '父整合: 子结果');
    assert.ok(calls >= 3, `应至少 3 次 LLM 调用（父+子+父），实际 ${calls}`);
  });

  it('未声明 subAgents 时不注册 spawn 工具（零破坏）', async () => {
    mockFetch((body) => {
      const last = body.messages[body.messages.length - 1];
      // 即便 LLM 想 spawn，工具未注册应被拒绝，父照常运行
      if (last?.role === 'user' && last.content === '主任务') {
        return chatRes('', [
          { id: '1', type: 'function', function: { name: 'spawn_researcher', arguments: '{"task":"x"}' } },
        ]);
      }
      return chatRes('无子智能体');
    });
    const harness = new Harness(baseConfig()); // 无 subAgents
    const result = await harness.run({ task: '主任务' });
    assert.equal(result.finalContent, '无子智能体');
  });
});

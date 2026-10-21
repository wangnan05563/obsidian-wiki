import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../src/harness.js';
import { FileStateStore } from '../src/state/file-state-store.js';
import { createSubAgentTool } from '../src/subagent.js';
import type { HarnessConfig, Message, StateStore } from '../src/types.js';

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

// T02809：本文件的每个 harness.run 都会写运行状态。不显式给 stateStore 时，
// Harness 回退 `new FileStateStore()`——目录相对进程 CWD，跑一次测试就在仓库里
// 攒一份无人认领的状态文件（清理侧按数据目录扫，永远扫不到）。
const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-harness-test-state-'));

function baseConfig(subAgents?: HarnessConfig['subAgents']): HarnessConfig {
  return {
    llm: { provider: 'deepseek', baseUrl: 'http://x', apiKey: 'k', model: 'm' },
    tools: [],
    stateStore: new FileStateStore(testStateDir),
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

// T02809：子 Harness 的状态存储必须继承父的（harness.ts 传「已解析」的 store、
// subagent.ts 把它交给子）。这条用例是因果锁——把 subagent.ts 里那行
// `stateStore: parentConfig.stateStore` 去掉后，子 Harness 会各自回退到
// `new FileStateStore()` 的相对默认目录 `.harness/state`（落点由进程 CWD 决定），
// 于是「清理/续传只认规范目录」的链路对这批文件永远不可见——
// api 侧 T02772 那 107 个清不掉的历史状态就是这个形态。
describe('子 Harness 继承父 stateStore（T02809）', () => {
  it('父子两次 run 的状态都写进父注入的同一个 store，且 CWD 相对目录不新增文件', async () => {
    const savedRunIds = new Set<string>();
    const store: StateStore = {
      save: async (runId: string) => {
        savedRunIds.add(runId);
      },
      load: async () => null,
      list: async () => [],
    };

    const cwdStateDir = path.join(process.cwd(), '.harness', 'state');
    const readDir = () => (fs.existsSync(cwdStateDir) ? fs.readdirSync(cwdStateDir) : []);
    const before = new Set(readDir());

    mockFetch((body) => {
      const msgs = body.messages;
      const last = msgs[msgs.length - 1];
      if (last?.role === 'user' && last.content === '主任务') {
        return chatRes('', [
          { id: '1', type: 'function', function: { name: 'spawn_researcher', arguments: '{"task":"子任务"}' } },
        ]);
      }
      if (last?.role === 'user' && last.content === '子任务') {
        return chatRes('子结果');
      }
      const hasChild = JSON.stringify(msgs).includes('子结果');
      return chatRes(hasChild ? '父整合: 子结果' : '父无子结果');
    });

    const harness = new Harness({ ...baseConfig([{ name: 'researcher' }]), stateStore: store });
    const result = await harness.run({ task: '主任务' });

    assert.equal(result.status, 'done');
    // 子确实跑过（否则只会写父一条状态）
    assert.equal(result.finalContent, '父整合: 子结果');
    assert.equal(
      savedRunIds.size,
      2,
      `父与子应各写一次状态到同一个 store，实际 runId 数=${savedRunIds.size}（${[...savedRunIds].join(', ')}）`,
    );

    const litter = readDir().filter((f) => !before.has(f));
    assert.deepEqual(
      litter,
      [],
      `子 Harness 把状态写进了 CWD 相对目录 ${cwdStateDir}：${litter.join(', ')}`,
    );
  });
});

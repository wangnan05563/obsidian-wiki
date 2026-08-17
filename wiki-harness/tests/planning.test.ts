import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LlmPlanner, StaticPlanner } from '../src/session/planning.js';
import { InMemorySessionLog } from '../src/session/session-log.js';
import type { LLMAdapter } from '../src/llm/llm-adapter.js';
import type { LLMResponse, Message } from '../src/types.js';

// 伪 LLM：记录收到的 messages，返回固定计划文本
class FakeLlm implements LLMAdapter {
  lastMessages: Message[] = [];
  async chat(messages: Message[]): Promise<LLMResponse> {
    this.lastMessages = messages;
    return { content: '1. 检索知识库\n2. 综合回答' };
  }
  async *chatStream() {}
  countTokens(): number {
    return 1;
  }
}

describe('LlmPlanner', () => {
  it('用独立 system 提示调用 LLM 生成计划', async () => {
    const llm = new FakeLlm();
    const planner = new LlmPlanner(llm);
    const plan = await planner.plan('解释注意力机制');
    assert.equal(plan, '1. 检索知识库\n2. 综合回答');
    // system 提示应明确"规划器"语义，且不带任何工具
    assert.equal(llm.lastMessages[0].role, 'system');
    assert.match(llm.lastMessages[0].content, /规划器|计划/);
    assert.equal(llm.lastMessages[1].role, 'user');
    assert.equal(llm.lastMessages[1].content, '解释注意力机制');
  });
});

describe('StaticPlanner', () => {
  it('静态字符串直接返回', async () => {
    const planner = new StaticPlanner('固定计划');
    assert.equal(await planner.plan('x'), '固定计划');
  });

  it('函数形式接收 task 并返回', async () => {
    const planner = new StaticPlanner((t) => `针对[${t}]的计划`);
    assert.equal(await planner.plan('检索A'), '针对[检索A]的计划');
  });
});

describe('InMemorySessionLog.plan 投影', () => {
  it('setPlan 后 messages 开头为 plan 的 system 消息', () => {
    const log = new InMemorySessionLog();
    log.append({ type: 'user', content: 'hi' });
    log.setPlan('我的计划');
    const msgs = log.messages();
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[0].content, '我的计划');
    assert.equal(msgs[1].role, 'user');
  });

  it('未 setPlan 时不插入额外 system 消息', () => {
    const log = new InMemorySessionLog();
    log.append({ type: 'user', content: 'hi' });
    const msgs = log.messages();
    assert.equal(msgs[0].role, 'user');
  });

  it('plan 位于 compact 摘要之前（双层 system 语义层级正确）', () => {
    const log = new InMemorySessionLog();
    log.append({ type: 'user', content: 'hi' });
    log.append({ type: 'assistant', content: 'a' });
    log.compact('历史摘要', [log.events[0], log.events[1]]);
    log.setPlan('全局计划');
    const msgs = log.messages();
    // [system(plan), system(compact), ...]
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[0].content, '全局计划');
    assert.equal(msgs[1].role, 'system');
    assert.equal(msgs[1].content, '历史摘要');
  });
});

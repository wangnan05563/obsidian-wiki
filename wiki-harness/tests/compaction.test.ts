import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionLog } from '../src/session/session-log.js';
import {
  compactLog,
  findSafeBoundary,
  SimpleConcatCompactor,
  DEFAULT_COMPACT_THRESHOLD,
} from '../src/session/compaction.js';
import type { RunContext, SessionEvent, ToolCall } from '../src/types.js';

function emptyCtx(): RunContext {
  return {
    runId: 'r',
    task: 't',
    log: new InMemorySessionLog(),
    step: 0,
    tokenUsed: 0,
    state: {},
  };
}

const tc: ToolCall = { id: 'c0', type: 'function', function: { name: 'f', arguments: '{}' } };

// 构造一段"全程 tool 配对"的历史（无安全边界）
function toolOnlyEvents(n: number): SessionEvent[] {
  const log = new InMemorySessionLog();
  for (let i = 0; i < n; i++) {
    log.append({ type: 'user', content: `u${i}` });
    log.append({ type: 'assistant', content: `a${i}`, tool_calls: [{ ...tc, id: `c${i}` }] });
    log.append({ type: 'tool', content: `t${i}`, tool_call_id: `c${i}` });
  }
  return log.events;
}

describe('findSafeBoundary', () => {
  it('全程 tool 配对时返回 -1（无安全边界，不切断）', () => {
    assert.equal(findSafeBoundary(toolOnlyEvents(3)), -1);
  });

  it('找到最后一个无 tool_calls 的 assistant 之后作为边界', () => {
    // u, a(tool), t, u, a(无tool) ← 锚点, u, a(tool), t
    const log = new InMemorySessionLog();
    log.append({ type: 'user', content: 'u0' });
    log.append({ type: 'assistant', content: 'a0', tool_calls: [tc] });
    log.append({ type: 'tool', content: 't0', tool_call_id: 'c0' });
    log.append({ type: 'user', content: 'u1' });
    log.append({ type: 'assistant', content: 'note' }); // 索引 4，无 tool_calls
    log.append({ type: 'user', content: 'u2' });
    log.append({ type: 'assistant', content: 'a2', tool_calls: [tc] });
    log.append({ type: 'tool', content: 't2', tool_call_id: 'c2' });
    // 边界 = 最后一个无 tool assistant(索引4) + 1 = 5
    assert.equal(findSafeBoundary(log.events), 5);
  });
});

describe('SimpleConcatCompactor', () => {
  it('生成包含消息数与截断 head 的摘要', () => {
    const log = new InMemorySessionLog();
    log.append({ type: 'user', content: 'hello world this is a long message' });
    log.append({ type: 'assistant', content: 'reply' });
    const summary = new SimpleConcatCompactor().summarize(log.messages(), emptyCtx());
    assert.match(summary, /已压缩的早期上下文/);
    assert.match(summary, /共 2 条消息/);
    assert.match(summary, /\[user\] hello world/);
  });
});

describe('compactLog', () => {
  it('超阈值且有安全边界时压缩：events 变短、首条消息为 system 摘要、archived 保留', async () => {
    const log = new InMemorySessionLog();
    log.append({ type: 'user', content: 'u0' });
    log.append({ type: 'assistant', content: 'a0', tool_calls: [tc] });
    log.append({ type: 'tool', content: 't0', tool_call_id: 'c0' });
    log.append({ type: 'user', content: 'u1' });
    log.append({ type: 'assistant', content: 'note' }); // 安全边界锚点
    log.append({ type: 'user', content: 'u2' });
    log.append({ type: 'assistant', content: 'a2', tool_calls: [tc] });
    log.append({ type: 'tool', content: 't2', tool_call_id: 'c2' });
    // 7 事件，阈值 4 → 触发；边界 5 → 压缩 [0,5)
    await compactLog(log, new SimpleConcatCompactor(), emptyCtx(), 4);

    assert.equal(log.events.length, 4); // compact + [u2, a2(tool), t2]
    const compactEvt = log.events[0];
    assert.equal(compactEvt.type, 'compact');
    if (compactEvt.type === 'compact') {
      assert.equal(compactEvt.archived.length, 5); // 前 5 条进 archived
    }
    const msgs = log.messages();
    assert.equal(msgs[0].role, 'system'); // compact 投影为 system
    assert.match(msgs[0].content, /已压缩的早期上下文/);
    assert.equal(msgs[1].role, 'user'); // 保留段未被压缩
    assert.equal(msgs[1].content, 'u2');
  });

  it('不超阈值时不压缩', async () => {
    const log = new InMemorySessionLog();
    log.append({ type: 'user', content: 'u0' });
    log.append({ type: 'assistant', content: 'a0', tool_calls: [tc] });
    log.append({ type: 'tool', content: 't0', tool_call_id: 'c0' });
    const before = log.events.length;
    await compactLog(log, new SimpleConcatCompactor(), emptyCtx(), 10);
    assert.equal(log.events.length, before);
  });

  it('无安全边界（全程 tool 配对）时不压缩', async () => {
    const log = new InMemorySessionLog(toolOnlyEvents(4));
    const before = log.events.length;
    await compactLog(log, new SimpleConcatCompactor(), emptyCtx(), 1);
    assert.equal(log.events.length, before);
  });

  it('压缩后再次调用不重复压缩（幂等）', async () => {
    const log = new InMemorySessionLog();
    log.append({ type: 'user', content: 'u0' });
    log.append({ type: 'assistant', content: 'a0', tool_calls: [tc] });
    log.append({ type: 'tool', content: 't0', tool_call_id: 'c0' });
    log.append({ type: 'user', content: 'u1' });
    log.append({ type: 'assistant', content: 'note' });
    await compactLog(log, new SimpleConcatCompactor(), emptyCtx(), 2);
    const afterFirst = log.events.length;
    await compactLog(log, new SimpleConcatCompactor(), emptyCtx(), 2);
    assert.equal(log.events.length, afterFirst); // 已无更多可压
  });

  it('默认阈值常量存在且为 30', () => {
    assert.equal(DEFAULT_COMPACT_THRESHOLD, 30);
  });
});

// T02462（PRD Q2）：流式期间排队输入的纯函数逻辑。
import { describe, it, expect } from 'vitest';
import { decideEnqueue, takeQueued, type ChatQueue } from '../src/utils/chatQueue';

function makeQueue(): ChatQueue {
  return { queued: null };
}

describe('chatQueue（T02462 Q2）', () => {
  it('空闲时提交立即发送，不入队', () => {
    const q = makeQueue();
    expect(decideEnqueue(q, false, '你好')).toBe('sent');
    expect(q.queued).toBeNull();
  });

  it('生成中提交入队，返回 queued', () => {
    const q = makeQueue();
    expect(decideEnqueue(q, true, '下一问')).toBe('queued');
    expect(q.queued).toBe('下一问');
  });

  it('takeQueued 取出并清空（消费一次）', () => {
    const q = makeQueue();
    q.queued = '下一问';
    expect(takeQueued(q)).toBe('下一问');
    expect(q.queued).toBeNull();
    expect(takeQueued(q)).toBeNull();
  });

  it('连续入队只保留最后一次', () => {
    const q = makeQueue();
    decideEnqueue(q, true, '第一问');
    decideEnqueue(q, true, '第二问');
    expect(takeQueued(q)).toBe('第二问');
  });
});

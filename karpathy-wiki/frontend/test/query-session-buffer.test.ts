// 按会话隔离缓冲 + consumeQuerySSE conversationId 路由 回归测试（v4 并行流式）
// 锁定核心不变量：不同会话的 SSE writer 写入各自缓冲、互不串台；
// 切换激活会话时后台流继续演进，writer 动态改写 active 缓冲；桌面默认缓冲兼容。
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useQueryStore, DEFAULT_ACTIVE } from '../src/stores/query';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('per-session 缓冲隔离', () => {
  it('不同 conversationId 的 writer 写入各自缓冲，不污染 active 缓冲', () => {
    const s = useQueryStore();
    const wA = s.getSessionWriter('A');
    const wB = s.getSessionWriter('B');
    wA.appendAnswer('A的回答');
    wB.appendAnswer('B的回答');
    expect(s.getSessionBuffer('A')?.streamingAnswer).toBe('A的回答');
    expect(s.getSessionBuffer('B')?.streamingAnswer).toBe('B的回答');
    // 默认 active 缓冲不受影响
    expect(s.messages).toEqual([]);
    expect(s.streamingAnswer).toBe('');
  });

  it('两个会话并行流式互不串台（各自 finalize 落各自消息）', () => {
    const s = useQueryStore();
    const wA = s.getSessionWriter('A');
    const wB = s.getSessionWriter('B');
    s.swapSession('A');
    s.beginStreaming();
    wA.appendAnswer('A答案');
    wA.finalizeAnswer('sess-A', 0);

    s.swapSession('B');
    s.beginStreaming();
    wB.appendAnswer('B答案');
    wB.finalizeAnswer('sess-B', 0);

    const aMsg = s.getSessionBuffer('A')?.messages ?? [];
    const bMsg = s.getSessionBuffer('B')?.messages ?? [];
    expect(aMsg.at(-1)?.content).toBe('A答案');
    expect(bMsg.at(-1)?.content).toBe('B答案');
    // 相互不应出现对方内容
    expect(aMsg.some((m) => m.content.includes('B答案'))).toBe(false);
    expect(bMsg.some((m) => m.content.includes('A答案'))).toBe(false);
  });
});

describe('切换激活会话时后台流继续演进（动态路由）', () => {
  it('切走后 writer 改写到后台缓冲；切回后 active 显示累计进度', () => {
    const s = useQueryStore();
    const wA = s.getSessionWriter('A');
    // A 成为激活会话并开始流式
    s.swapSession('A');
    s.beginStreaming();
    wA.appendAnswer('A-部分');
    expect(s.streamingAnswer).toBe('A-部分');
    expect(s.isLoading).toBe(true);

    // 切到 B（A 仍在后台流式）
    s.swapSession('B', { messages: [], threadId: null });
    // writer A 现在应写入后台 sessions['A']，而非 active(B)
    wA.appendAnswer('A-继续');
    expect(s.getSessionBuffer('A')?.streamingAnswer).toBe('A-部分A-继续');
    // active(B) 不应包含 A 的内容
    expect(s.streamingAnswer).toBe('');

    // 切回 A：active 缓冲显示 A 的累计进度，且仍在流式
    s.swapSession('A');
    expect(s.streamingAnswer).toBe('A-部分A-继续');
    expect(s.isSessionStreaming('A')).toBe(true);
  });

  it('后台会话的 isLoading 反映在 isSessionStreaming / anySessionStreaming', () => {
    const s = useQueryStore();
    const w = s.getSessionWriter('X');
    s.swapSession('X');
    s.beginStreaming();
    expect(s.isSessionStreaming('X')).toBe(true);
    expect(s.anySessionStreaming).toBe(true);

    // 切到 Y，X 仍在后台流式
    s.swapSession('Y');
    expect(s.isSessionStreaming('X')).toBe(true);
    expect(s.anySessionStreaming).toBe(true);

    // 完成 X：流式结束
    s.swapSession('X');
    s.finalizeAnswer('sess-X', 0);
    expect(s.isSessionStreaming('X')).toBe(false);
    expect(s.anySessionStreaming).toBe(false);
  });
});

describe('reset 清空所有后台会话（账户切换隔离）', () => {
  it('reset 删除全部缓冲并回落默认 active', () => {
    const s = useQueryStore();
    s.getSessionWriter('A').appendAnswer('x');
    s.getSessionWriter('B').appendAnswer('y');
    s.reset();
    expect(s.getSessionBuffer('A')).toBeUndefined();
    expect(s.getSessionBuffer('B')).toBeUndefined();
    expect(s.activeId).toBe(DEFAULT_ACTIVE);
    expect(s.streamingAnswer).toBe('');
  });
});

describe('桌面默认缓冲兼容（无 conversationId）', () => {
  it('无 id 的 writer 作用默认 active 缓冲，行为不变', () => {
    const s = useQueryStore();
    s.submitQuestion('你好');
    expect(s.messages.length).toBe(1);
    s.getSessionWriter().appendAnswer('默认答案');
    expect(s.streamingAnswer).toBe('默认答案');
    expect(s.messages.length).toBe(1); // 流式答案尚未 finalize
    s.finalizeAnswer('sess', 0);
    expect(s.messages.at(-1)?.content).toBe('默认答案');
  });
});

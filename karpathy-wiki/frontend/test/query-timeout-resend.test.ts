// 超时重发回归测试：核心不变量是 bufStopLoading 在 reason==='timeout' 时给新建的
// assistant 消息打 timedOut=true，从而前端能在超时消息下方常驻渲染"确认重发"按钮；
// 而用户主动停止（reason==='user'）不应打该标记（避免出现误重的重发入口）。
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useQueryStore } from '../src/stores/query';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('超时消息 timedOut 标记', () => {
  it('超时停止：新建 assistant 消息 timedOut=true 且内容含 [已超时]', () => {
    const s = useQueryStore();
    s.submitQuestion('什么是 LLM Wiki？');
    s.beginStreaming();
    s.appendAnswer('部分回答…');
    // 模拟 120s 无数据触发的超时中断
    s.stopLoading('timeout');

    const last = s.messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.timedOut).toBe(true);
    expect(last?.content).toContain('[已超时]');
    // 重载续答判定：超时消息为 interrupted，不应自动续答
    expect(last?.status).toBe('interrupted');
  });

  it('用户主动停止：新建 assistant 消息 timedOut 未置位且内容含 [已停止]', () => {
    const s = useQueryStore();
    s.submitQuestion('什么是 LLM Wiki？');
    s.beginStreaming();
    s.appendAnswer('部分回答…');
    s.stopLoading('user');

    const last = s.messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.timedOut).toBeFalsy();
    expect(last?.content).toContain('[已停止]');
  });

  it('无流式内容时用户主动停止：不落盘匿名消息（避免凭空出现重发入口）', () => {
    const s = useQueryStore();
    s.submitQuestion('什么是 LLM Wiki？');
    s.beginStreaming();
    // 没有任何 appendAnswer，用户主动停止不应产生 assistant 消息
    s.stopLoading('user');
    // 仅保留 user 问题，不应凭空生成 assistant 消息
    expect(s.messages.every((m) => m.role !== 'assistant')).toBe(true);
    expect(s.messages.at(-1)?.role).toBe('user');
  });

  it('无流式内容时超时停止：生成 timedOut 占位消息以承载"确认重发"入口', () => {
    const s = useQueryStore();
    s.submitQuestion('什么是 LLM Wiki？');
    s.beginStreaming();
    // 首字节前即超时（弱网/模型挂死），无部分答案可保留，但仍应生成 timedOut 占位消息
    s.stopLoading('timeout');
    const last = s.messages.at(-1);
    expect(last?.role).toBe('assistant');
    // 占位消息承载常驻"确认重发"按钮
    expect(last?.timedOut).toBe(true);
    expect(last?.content).toContain('[已超时]');
    // 重载续答判定：超时消息为 interrupted，不应自动续答
    expect(last?.status).toBe('interrupted');
  });
});

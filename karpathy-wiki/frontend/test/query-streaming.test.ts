// 重新生成流式 UI 即时可见性测试（F-3.13 修复）
// 背景：重新生成路径（handleRegenerate）直接调用 sendQuestion，不经 submitQuestion，
// 此前 isLoading 始终为 false，导致流式块 v-if="streamingAnswer || isLoading" 不渲染、
// 原回答已删除，用户要等 done 事件才看到结果。修复：sendQuestion 进入 SSE 前调用 beginStreaming()
// 立即置 isLoading=true，让 loading dots / 实时思考 / 流式答案即时出现。
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useQueryStore } from '../src/stores/query';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('beginStreaming 立即置 loading（重新生成可见性根因）', () => {
  it('beginStreaming 立即 isLoading=true 并清空上一轮暂存', () => {
    const s = useQueryStore();
    s.appendAnswer('上一轮残留');
    s.appendThinking({ phase: 'thinking', message: '残留思考', ts: new Date().toISOString() });
    s.beginStreaming();
    expect(s.isLoading).toBe(true);
    expect(s.streamingAnswer).toBe('');
    expect(s.currentThinking.length).toBe(0);
    expect(s.errorMessage).toBe('');
  });

  it('重新生成路径：删除旧回答后 beginStreaming 让流式 UI 即时出现', () => {
    const s = useQueryStore();
    // 第一轮：提交问题 → 流式回答 → 完成
    s.submitQuestion('什么是 LLM Wiki？');
    s.appendAnswer('这是一段回答');
    s.appendThinking({ phase: 'thinking', message: '在检索', ts: new Date().toISOString() });
    s.finalizeAnswer('session-1', 0);
    // 完成后 loading 应已归位
    expect(s.isLoading).toBe(false);
    expect(s.messages[s.messages.length - 1].role).toBe('assistant');

    // 用户点击"重新生成"：删除该回答（handleRegenerate 的 removeMessagesFrom(idx)）
    const lastIdx = s.messages.length - 1;
    s.removeMessagesFrom(lastIdx);
    expect(s.messages[s.messages.length - 1].role).toBe('user');

    // 进入 SSE 前应调用 beginStreaming（sendQuestion 开头）
    s.beginStreaming();
    // 关键断言：isLoading=true → 流式块 v-if 成立 → loading dots / 实时思考 / 流式答案即时可见，
    // 不再需要等到 done 事件
    expect(s.isLoading).toBe(true);
  });

  it('流式回答完成后 isLoading 归位且消息落盘', () => {
    const s = useQueryStore();
    s.beginStreaming();
    expect(s.isLoading).toBe(true);
    s.appendAnswer('最终答案');
    s.finalizeAnswer('session-2', 0);
    expect(s.isLoading).toBe(false);
    expect(s.messages[s.messages.length - 1].content).toBe('最终答案');
  });
});

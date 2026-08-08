// 用户消息编辑重发测试（F-3.x 增强）
// 验证：
//  1) stopLoading('edit') 终止当前回复时仅清空本轮 + isLoading=false，不追加 [已停止]、不污染 errorMessage；
//  2) stopLoading('user') 仍追加 [已停止]（回归对比，确保未破坏既有停止行为）；
//  3) removeMessagesFrom(idx) 截断正确（编辑重发会丢弃 idx 起的所有消息，含被编辑的 user 消息本身）；
//  4) 非流式路径：removeMessagesFrom + submitQuestion(newText) 后产生一条以新内容开头的 user 消息，后续被丢弃。
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useQueryStore } from '../src/stores/query';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('stopLoading 终止态差异（edit vs user）', () => {
  it('stopLoading("edit") 仅清空本轮，不追加 [已停止]、不污染 errorMessage', () => {
    const s = useQueryStore();
    s.beginStreaming();
    s.appendAnswer('部分答案');
    s.appendThinking({ phase: 'thinking', message: '在检索', ts: new Date().toISOString() });
    expect(s.isLoading).toBe(true);

    s.stopLoading('edit');

    // 当前轮被清空
    expect(s.isLoading).toBe(false);
    expect(s.streamingAnswer).toBe('');
    expect(s.currentThinking.length).toBe(0);
    // edit 场景：不向 messages 追加 [已停止] 占位
    expect(s.messages.some((m) => m.content.includes('[已停止]'))).toBe(false);
    // 不污染 errorMessage
    expect(s.errorMessage).toBe('');
  });

  it('stopLoading("user") 仍追加 [已停止]（回归对比）', () => {
    const s = useQueryStore();
    s.beginStreaming();
    s.appendAnswer('部分答案');
    s.stopLoading('user');
    expect(s.isLoading).toBe(false);
    expect(s.messages.some((m) => m.content.includes('[已停止]'))).toBe(true);
  });
});

describe('编辑重发：截断并重发', () => {
  it('removeMessagesFrom(idx) 丢弃 idx 起的全部消息（含被编辑的 user 消息）', () => {
    const s = useQueryStore();
    s.submitQuestion('原始问题');
    s.appendAnswer('旧回答');
    s.finalizeAnswer('sess-1', 0);
    expect(s.messages.length).toBe(2);
    expect(s.messages[0].content).toBe('原始问题');
    expect(s.messages[1].role).toBe('assistant');

    // 编辑第 0 条 user 消息：截断从 0 起（丢弃 user + assistant）
    s.removeMessagesFrom(0);
    expect(s.messages.length).toBe(0);
  });

  it('非流式路径：截断后 submitQuestion(newText) 以新内容开头重发', () => {
    const s = useQueryStore();
    s.submitQuestion('原始问题');
    s.appendAnswer('旧回答');
    s.finalizeAnswer('sess-1', 0);
    const userIdx = 0;
    const newText = '修改后的问题';

    // 复刻 handleConfirmEdit 的非 loading 分支
    s.removeMessagesFrom(userIdx);
    s.submitQuestion(newText);

    expect(s.messages.length).toBe(1);
    expect(s.messages[0].role).toBe('user');
    expect(s.messages[0].content).toBe(newText);
    expect(s.isLoading).toBe(true); // 立即进入流式态，新思考可见
  });
});

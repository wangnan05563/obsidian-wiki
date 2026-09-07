// query store 意图澄清状态测试。
// 覆盖：
// 1. middlewares 升级迁移：老用户 localStorage 数组不含 'clarify' 时自动补齐（默认开启）
// 2. 澄清卡片状态生命周期：setClarification（等待用户选择，isLoading 保持）→ 选择重发
//    （beginStreaming 不清卡）→ done 完成清卡 / 放弃清卡 / 出错清卡 / 停止清卡
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useQueryStore } from '../src/stores/query';
import { STORAGE_KEYS } from '../src/constants/storageKeys';
import type { Clarification } from '../src/types';

const FAKE_CLARIFICATION: Clarification = {
  id: 'clarify-abc',
  round: 1,
  maxRounds: 2,
  question: '什么是苹果？',
  prompt: '你的问题可能存在多种理解。请选择最符合你意图的一种。',
  interpretations: [
    { index: 0, label: '水果苹果', description: '指可食用的苹果水果' },
    { index: 1, label: '苹果公司', description: '指 Apple 公司相关话题' },
  ],
  recommendedIndex: 0,
};

describe('query store — 意图澄清', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('middlewares 升级迁移：旧数组自动补上新中间件 clarify', () => {
    // 老用户存量数据（无 clarify）
    localStorage.setItem(STORAGE_KEYS.MIDDLEWARES, JSON.stringify(['web_search', 'stream']));
    const store = useQueryStore();
    expect(store.middlewares).toContain('clarify');
    expect(store.middlewares).toContain('web_search');
  });

  it('setClarification 写入卡片且保持 isLoading（等待用户选择）', () => {
    const store = useQueryStore();
    store.beginStreaming();
    expect(store.isLoading).toBe(true);
    // 模拟 SSE clarify 事件
    store.setClarification(FAKE_CLARIFICATION);
    expect(store.currentClarification?.id).toBe('clarify-abc');
    expect(store.currentClarification?.interpretations.length).toBe(2);
    // 等待用户选择：isLoading 保持 true（阻止新提问/重新生成）
    expect(store.isLoading).toBe(true);
  });

  it('选择重发（beginStreaming）不清卡片：卡片保留为加载态载体', () => {
    const store = useQueryStore();
    store.submitQuestion('什么是苹果？');
    store.setClarification(FAKE_CLARIFICATION);
    // 用户选择后 sendQuestion 内部 beginStreaming —— 卡片应保留（显示"正在理解你的意图…"）
    store.beginStreaming();
    expect(store.currentClarification).not.toBeNull();
    expect(store.isLoading).toBe(true);
  });

  it('finalizeAnswer（done）后卡片清空', () => {
    const store = useQueryStore();
    store.submitQuestion('什么是苹果？');
    store.setClarification(FAKE_CLARIFICATION);
    store.beginStreaming();
    store.appendAnswer('苹果是水果。');
    store.finalizeAnswer();
    expect(store.currentClarification).toBeNull();
    expect(store.isLoading).toBe(false);
    expect(store.messages.length).toBe(2); // user + assistant
  });

  it('clearClarification（换个问法）清卡并解除 loading', () => {
    const store = useQueryStore();
    store.submitQuestion('什么是苹果？');
    store.setClarification(FAKE_CLARIFICATION);
    store.clearClarification();
    expect(store.currentClarification).toBeNull();
    expect(store.isLoading).toBe(false);
  });

  it('handleError 出错时卡片一并清空', () => {
    const store = useQueryStore();
    store.submitQuestion('什么是苹果？');
    store.setClarification(FAKE_CLARIFICATION);
    store.handleError('网络错误');
    expect(store.currentClarification).toBeNull();
    expect(store.isLoading).toBe(false);
  });

  it('stopLoading（用户停止）时卡片一并清空', () => {
    const store = useQueryStore();
    store.submitQuestion('什么是苹果？');
    store.setClarification(FAKE_CLARIFICATION);
    store.stopLoading('user');
    expect(store.currentClarification).toBeNull();
    expect(store.isLoading).toBe(false);
  });

  it('getSessionWriter 暴露 clarification 读写（SSE 消费端统一入口）', () => {
    const store = useQueryStore();
    const writer = store.getSessionWriter();
    writer.setClarification(FAKE_CLARIFICATION);
    expect(writer.clarification?.id).toBe('clarify-abc');
    writer.clearClarification();
    expect(writer.clarification).toBeNull();
  });

  it('多轮澄清：第二轮 clarify 覆盖第一轮卡片（同一 clarifyId）', () => {
    const store = useQueryStore();
    store.setClarification(FAKE_CLARIFICATION);
    store.setClarification({ ...FAKE_CLARIFICATION, round: 2, prompt: '仍然存在多种理解（第 2 次确认）…' });
    expect(store.currentClarification?.round).toBe(2);
    expect(store.currentClarification?.id).toBe('clarify-abc');
  });
});

// 上下文记忆治理模块 单元测试
// 覆盖：token 估算、清理（去重/低价值）、语义压缩（净缩减+保真）、相关性重组、容量淘汰、
//       govern 主流程（触发/未触发/关闭/既有摘要合并）。
import { describe, expect, it } from 'vitest';
import {
  govern,
  estimateTokens,
  extractiveCompress,
  DEFAULT_GOVERNOR_CONFIG,
  type ContextGovernorConfig,
  type HistoryMessage,
} from '../src/engine/context-governor.js';

function mk(role: 'user' | 'assistant', content: string, ts = '2026-01-01T00:00:00.000Z'): HistoryMessage {
  return { role, content, ts };
}

// 测试用历史：围绕"知识库概念"的多轮问答，单条约 50 字（~50 token）
function makeLongHistory(turns: number): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(mk('user', `问题${i}：请解释知识库中的概念${i}，包括它的定义、典型用法以及实际使用时的注意事项。`));
    out.push(mk('assistant', `概念${i}的定义是某一类结构化知识。它常用于检索与归档场景。结论：概念${i}在知识库里很重要，需要重点维护。`));
  }
  return out;
}

describe('estimateTokens', () => {
  it('CJK 字符约 1 token/字', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });
  it('拉丁连续串按 4 字符≈1 token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});

describe('清理（cleanup）', () => {
  it('移除近似重复消息', async () => {
    const history = [
      mk('assistant', '今天天气晴，适合外出散步。'),
      mk('assistant', '今天天气晴，适合外出散步！'), // 仅标点差异 → 近似重复
      mk('user', '那我们去公园吧。'),
    ];
    const res = await govern(history, {
      config: { enabled: true, warnRatio: 2, recencyWindow: 0, minContentChars: 1, dedupThreshold: 0.85 },
    });
    // warnRatio=2 → 不触发压缩；仅清理去重
    expect(res.stats.removedDuplicates).toBeGreaterThanOrEqual(1);
    expect(res.messages.length).toBe(2);
  });

  it('移除低价值短语（过短/问候）', async () => {
    const history = [
      mk('user', '谢谢'),
      mk('assistant', '好的'),
      mk('user', '请帮我查询 Karpathy 的简历要点。'),
    ];
    const res = await govern(history, {
      config: { enabled: true, warnRatio: 2, recencyWindow: 0, minContentChars: 1 },
    });
    expect(res.stats.removedLowValue).toBeGreaterThanOrEqual(2);
    expect(res.messages.length).toBe(1);
    expect(res.messages[0].content).toContain('Karpathy');
  });
});

describe('语义压缩（extractiveCompress）', () => {
  it('净缩减 token 且保留关键结论信息', () => {
    const turns = makeLongHistory(4); // 8 条消息
    const rawTokens = turns.reduce((s, m) => s + estimateTokens(m.content), 0);
    const summary = extractiveCompress(turns, DEFAULT_GOVERNOR_CONFIG);
    const summaryTokens = estimateTokens(summary);
    expect(summaryTokens).toBeLessThan(rawTokens); // 净缩减
    expect(summary).toContain('结论'); // 关键标记句被保留
    expect(summary).toContain('概念0'); // 保真
  });
});

describe('重组（relevance）', () => {
  it('相关性排序把与问题相关的更早消息前置（摘要恒置顶，最近窗口置尾）', async () => {
    const history = [
      mk('user', '今天中午吃什么比较好？'), // 不相关（older，置于相关消息之前）
      mk('user', '讲讲苹果公司的创立历史与发展。'), // 相关（older）
      mk('assistant', '我建议午餐吃轻食。'), // 最近窗口（tail）
    ];
    const res = await govern(history, {
      question: '苹果公司的历史',
      config: { enabled: true, warnRatio: 2, recencyWindow: 1, reorderMode: 'relevance' },
    });
    expect(res.stats.reordered).toBe(true);
    const idxApple = res.messages.findIndex((m) => m.content.includes('苹果公司'));
    const idxFood = res.messages.findIndex((m) => m.content.includes('中午吃什么'));
    expect(idxApple).toBeGreaterThanOrEqual(0);
    expect(idxFood).toBeGreaterThanOrEqual(0);
    // 苹果相关消息排在"吃什么"之前（都在 older 段内，最近窗口在尾部）
    expect(idxApple).toBeLessThan(idxFood);
    // 最近的"午餐"消息仍在尾部（最后一位）
    expect(res.messages[res.messages.length - 1].content).toContain('午餐');
  });

  it('chronological 模式不重排', async () => {
    const history = [mk('user', 'A'), mk('user', 'B'), mk('user', 'C')];
    const res = await govern(history, {
      config: { enabled: true, warnRatio: 2, recencyWindow: 0, reorderMode: 'chronological', minContentChars: 1 },
    });
    expect(res.stats.reordered).toBe(false);
    expect(res.messages.map((m) => m.content)).toEqual(['A', 'B', 'C']);
  });
});

describe('容量阈值与淘汰（govern 主流程）', () => {
  const govCfg: Partial<ContextGovernorConfig> = {
    enabled: true,
    maxTokens: 5000,
    warnRatio: 0.1, // 阈值 500 token，易触发
    recencyWindow: 12,
    maxMessages: 60,
    compressionStrategy: 'extractive',
    summaryMaxChars: 800,
    dedupThreshold: 0.85,
    minContentChars: 8,
    lowValuePatterns: ['谢谢'],
    reorderMode: 'chronological',
  };

  it('历史超阈值时触发治理：生成摘要、压缩旧历史、token 净减', async () => {
    const history = makeLongHistory(20); // 40 条消息 ~ 2000 token
    const res = await govern(history, { config: govCfg });
    expect(res.stats.triggered).toBe(true);
    expect(res.summary.length).toBeGreaterThan(0);
    expect(res.messages[0].content.startsWith('【历史摘要】')).toBe(true);
    expect(res.stats.compressedTurns).toBeGreaterThan(0);
    // 最近 12 条原文保留（连贯性底线）
    expect(res.messages.length).toBe(13); // 摘要 1 + 最近 12
    // 整体 token 净缩减（摘要 < 被折叠的旧历史）
    expect(res.stats.outputTokens).toBeLessThan(res.stats.inputTokens);
    // 最近一轮原文仍在（最近窗口包含最近的用户问题"问题19"）
    expect(res.messages.some((m) => m.content.includes('问题19'))).toBe(true);
  });

  it('历史较小（未超阈值）时不压缩、不生成摘要', async () => {
    const history = makeLongHistory(3);
    const res = await govern(history, { config: govCfg });
    expect(res.stats.triggered).toBe(false);
    expect(res.summary).toBe('');
    expect(res.messages.length).toBe(6); // 原文透传（仅可能清理，本例无冗余）
  });

  it('总开关关闭时原样透传', async () => {
    const history = makeLongHistory(20);
    const res = await govern(history, { config: { ...govCfg, enabled: false } });
    expect(res.stats.triggered).toBe(false);
    expect(res.summary).toBe('');
    expect(res.messages.length).toBe(40);
  });

  it('既有摘要与本次压缩合并（避免重复摘要）', async () => {
    const history = makeLongHistory(20);
    const existing = '【既有摘要】早期讨论过部署与配置。';
    const res = await govern(history, { config: govCfg, existingSummary: existing });
    expect(res.summary).toContain('早期讨论过部署与配置');
  });

  it('预算极紧时淘汰较旧的非关键消息，但保留摘要与最近若干条', async () => {
    const history = makeLongHistory(20);
    const tight: Partial<ContextGovernorConfig> = {
      ...govCfg,
      maxTokens: 250, // 摘要+最近窗口也超此值时触发淘汰
      recencyWindow: 12,
    };
    const res = await govern(history, { config: tight });
    expect(res.stats.triggered).toBe(true);
    // 保护集 = 摘要(1) + 连贯性底线(min(12,4)=4) = 5；其余被淘汰
    expect(res.messages.length).toBeLessThanOrEqual(5);
    // 摘要恒在首位
    expect(res.messages[0].content.startsWith('【历史摘要】')).toBe(true);
    // 最近的用户问题"问题19"必保留在最近窗口内（连贯性底线）
    expect(res.messages.some((m) => m.content.includes('问题19'))).toBe(true);
  });
});

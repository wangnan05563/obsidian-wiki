// T02924：确认弹窗的估算文案必须把「样本不足」说出口。
// 背景：旧文案只有 measured/default 两态，无样本时只写「按默认单题耗时估算」，
// 用户仍把「约 2 分钟」当承诺（T02605 实测实际 6 分钟）。三态化后 default 与
// measured-low 都必须显式标「仅供参考」，且耗时以区间呈现。
import { describe, it, expect } from 'vitest';
import { estimateBasisText, estimateRangeText, formatTokens } from '../src/utils/healthList';
import type { BatchFixEstimate } from '../src/types';

function estimate(over: Partial<BatchFixEstimate> = {}): BatchFixEstimate {
  return {
    count: 3,
    llmCalls: 17,
    avgStepsPerIssue: 5.7,
    avgMsPerIssue: 115_000,
    avgTokensPerIssue: 17_200,
    tokens: 51_600,
    samples: 0,
    estimatedMs: 345_000,
    estimatedMinMs: 172_500,
    estimatedMaxMs: 517_500,
    estimatedMinutes: 6,
    basis: 'default',
    ...over,
  };
}

describe('T02924 估算文案', () => {
  it('default：点名「尚无实测样本」并给出标定的默认口径', () => {
    const text = estimateBasisText(estimate());
    expect(text).toContain('尚无实测样本');
    expect(text).toContain('5.7 次往返');
    expect(text).toContain('1.7 万 tokens');
  });

  it('measured-low：样本 <5 时显式「不足 5 个，仅供参考」，不得写成确定值', () => {
    const text = estimateBasisText(estimate({ basis: 'measured-low', samples: 2 }));
    expect(text).toContain('仅 2 个实测样本');
    expect(text).toContain('不足 5 个，仅供参考');
  });

  it('measured：样本 ≥5 才展示「最近 N 次实测均值」', () => {
    const text = estimateBasisText(estimate({ basis: 'measured', samples: 6 }));
    expect(text).toContain('最近 6 次实测均值');
    expect(text).not.toContain('仅供参考');
  });

  it('耗时以区间呈现，宽度为 0 时不显示假精确区间', () => {
    expect(estimateRangeText(172_500, 517_500)).toBe('区间 约 3 分钟 ~ 约 9 分钟');
    expect(estimateRangeText(20_000, 20_000)).toBe('');
  });

  it('tokens：过万折成「万」，未知值不编造数字', () => {
    expect(formatTokens(51_600)).toBe('5.2 万');
    expect(formatTokens(17_200)).toBe('1.7 万');
    expect(formatTokens(9_000)).toBe('9000');
    expect(formatTokens(0)).toBe('—');
  });
});

import { describe, it, expect } from 'vitest';
import {
  splitText,
  volToSsml,
  pitchToSsml,
  rateToSsml,
} from '../src/composables/tts/edgeTtsProvider';

// EdgeTtsProvider 纯函数单元测试（无网络 / 无 DOM 依赖）：
//   - splitText 长文本分段：每段 <= 2000 字，超长单句硬切不丢失字符
//   - volToSsml / pitchToSsml / rateToSsml SSML 数值格式转换
//
// 这些函数决定"长文本朗读是否会超出后端 5000 字上限"以及"语速/音量/音调
// 是否被正确编码进 SSML"，是 Edge TTS 拟人化与健壮性的核心，故单独覆盖。

const MAX = 2000;

describe('edgeTtsProvider: splitText 分段', () => {
  it('短文本（<=2000 字）整段返回', () => {
    const text = '这是一段短文本。';
    expect(splitText(text)).toEqual([text]);
  });

  it('长文本按句末标点分段，每段不超过 2000 字', () => {
    const seg = '句子一。'.repeat(60); // 180 字
    const text = (seg + '\n').repeat(20); // 约 3600 字
    const parts = splitText(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(MAX);
  });

  it('单个超长句（无标点，>2000 字）硬切为 <=2000 的块且不丢字符', () => {
    const longSentence = '字'.repeat(4500);
    const parts = splitText(longSentence);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(MAX);
    expect(parts.join('')).toBe(longSentence);
  });

  it('含混合标点（。！？.!?）的分段后拼接还原原文（无分隔空白时）', () => {
    const text = '第一段。第二段！第三段？第四段。'.repeat(100);
    expect(splitText(text).join('')).toBe(text);
  });
});

describe('edgeTtsProvider: SSML 数值格式转换', () => {
  it('volToSsml: 0→+0%，正→+n%，负→n%', () => {
    expect(volToSsml(0)).toBe('+0%');
    expect(volToSsml(12)).toBe('+12%');
    expect(volToSsml(-5)).toBe('-5%');
  });

  it('pitchToSsml: 0→+0Hz，正→+nHz，负→nHz', () => {
    expect(pitchToSsml(0)).toBe('+0Hz');
    expect(pitchToSsml(3)).toBe('+3Hz');
    expect(pitchToSsml(-2)).toBe('-2Hz');
  });

  it('rateToSsml: 1→+0%，1.5→+50%，0.5→-50%', () => {
    expect(rateToSsml(1)).toBe('+0%');
    expect(rateToSsml(1.5)).toBe('+50%');
    expect(rateToSsml(0.5)).toBe('-50%');
  });
});

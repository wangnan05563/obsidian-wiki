import { describe, it, expect } from 'vitest';
import {
  buildSSML,
  generateSecMsGec,
  synthesizeEdgeTts,
  getEdgeTtsVoices,
} from '../src/utils/edgeTtsClient.js';

// Edge TTS 客户端纯函数单元测试（无网络）：
//   - 音色列表完整性
//   - synthesizeEdgeTts 参数校验（空白/超长，均在建立 WebSocket 前抛错）
//   - buildSSML 的 SSML 注入防护（转义 < > &）+ 结构（locale / prosody）
//   - generateSecMsGec 令牌格式（SHA-256 → 64 位大写十六进制）
//
// 为什么单独成文件、不 mock edgeTtsClient：这些断言需要真实实现；
// 需要 mock 避免网络的路由测试在 tts-route.test.ts。

const VOICE_PATTERN = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;

describe('edgeTtsClient: getEdgeTtsVoices', () => {
  it('返回 10 个预置中文神经音色，字段合法', () => {
    const voices = getEdgeTtsVoices();
    expect(voices.length).toBe(10);
    for (const v of voices) {
      expect(v.shortName).toMatch(VOICE_PATTERN);
      expect(v.locale).toBe('zh-CN');
      expect(['Female', 'Male']).toContain(v.gender);
      expect(typeof v.name).toBe('string');
      expect(v.name.length).toBeGreaterThan(0);
    }
  });
});

describe('edgeTtsClient: synthesizeEdgeTts 参数校验', () => {
  it('空白文本（trim 后为空）直接抛错，不建立 WebSocket', async () => {
    await expect(synthesizeEdgeTts({ text: '    ' })).rejects.toThrow(/空/);
  });

  it('超长文本（>5000 字）直接抛错，不建立 WebSocket', async () => {
    await expect(synthesizeEdgeTts({ text: 'x'.repeat(5001) })).rejects.toThrow(/过长/);
  });
});

describe('edgeTtsClient: buildSSML（SSML 注入防护 + 结构）', () => {
  it('转义 < > &，防止破坏 XML / 注入标签', () => {
    const ssml = buildSSML('a<b>&c', 'zh-CN-XiaoxiaoNeural', '+0%', '+0%', '+0Hz');
    expect(ssml).toContain('&lt;b&gt;');
    expect(ssml).toContain('&amp;c');
    // 原始危险字符不得原样出现
    expect(ssml).not.toContain('<b>');
    expect(ssml).not.toContain('&c');
  });

  it('从 voice 名提取 locale 写入 xml:lang', () => {
    const ssml = buildSSML('hi', 'en-US-AriaNeural', '+0%', '+0%', '+0Hz');
    expect(ssml).toContain('xml:lang="en-US"');
  });

  it('voice 名无 locale 片段时回退默认 zh-CN', () => {
    const ssml = buildSSML('hi', 'XiaoxiaoNeural', '+0%', '+0%', '+0Hz');
    expect(ssml).toContain('xml:lang="zh-CN"');
  });

  it('prosody 携带 rate/volume/pitch 属性', () => {
    const ssml = buildSSML('hi', 'zh-CN-XiaoxiaoNeural', '+10%', '-5%', '+3Hz');
    expect(ssml).toContain('rate="+10%"');
    expect(ssml).toContain('volume="-5%"');
    expect(ssml).toContain('pitch="+3Hz"');
  });

  it('speak 根节点与 voice 节点结构正确', () => {
    const ssml = buildSSML('hello', 'zh-CN-XiaoxiaoNeural', '+0%', '+0%', '+0Hz');
    expect(ssml).toContain('<speak version="1.0"');
    expect(ssml).toContain('<voice name="zh-CN-XiaoxiaoNeural">');
  });
});

describe('edgeTtsClient: generateSecMsGec 格式', () => {
  it('返回 64 位大写十六进制（SHA-256 输出）', async () => {
    const token = await generateSecMsGec();
    expect(token).toMatch(/^[0-9A-F]{64}$/);
  });
});

// @vitest-environment node
// LLM 配置纯函数回归测试：
//   - getEffectiveApiKey：llm.apiKey > apiKeys[provider]（多 key 持久化表）> 环境变量
//   - maskApiKey：空串/短 key/正常 key 的脱敏形态
// 覆盖回归：llm.apiKey 缺失但 apiKeys[provider] 有值时，必须能取回 key（否则 GET /api/ai/config
// 返回空 maskedKey，前端表现为「后台有值但 API Key 未返显」）。
import { describe, expect, it, afterEach } from 'vitest';
import { getEffectiveApiKey, maskApiKey } from '../src/config.js';

function makeConfig(llm: Partial<Record<string, unknown>>) {
  return { llm: { provider: 'agnes', baseUrl: '', model: '', apiKeyRef: 'DEEPSEEK_KEY', ...llm } } as any;
}

describe('getEffectiveApiKey', () => {
  const envBackup: Record<string, string | undefined> = {};

  afterEach(() => {
    // 恢复环境变量，避免用例间相互污染
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    envBackup.DEEPSEEK_KEY = process.env.DEEPSEEK_KEY;
  });

  it('llm.apiKey 优先', () => {
    const cfg = makeConfig({ apiKey: 'sk-direct', apiKeys: { agnes: 'sk-table' } });
    expect(getEffectiveApiKey(cfg)).toBe('sk-direct');
  });

  it('llm.apiKey 缺失时回退 apiKeys[当前 provider]（回归：多 key 表兜底）', () => {
    const cfg = makeConfig({ apiKey: '', apiKeys: { agnes: 'sk-table', deepseek: 'sk-other' } });
    expect(getEffectiveApiKey(cfg)).toBe('sk-table');
  });

  it('llm.apiKey 与 apiKeys 均缺失时回退环境变量 apiKeyRef', () => {
    envBackup.DEEPSEEK_KEY = process.env.DEEPSEEK_KEY;
    process.env.DEEPSEEK_KEY = 'sk-env';
    const cfg = makeConfig({ apiKey: '', apiKeys: {} });
    expect(getEffectiveApiKey(cfg)).toBe('sk-env');
  });

  it('全部缺失返回空串', () => {
    envBackup.DEEPSEEK_KEY = process.env.DEEPSEEK_KEY;
    delete process.env.DEEPSEEK_KEY;
    const cfg = makeConfig({ apiKey: '', apiKeys: {} });
    expect(getEffectiveApiKey(cfg)).toBe('');
  });
});

describe('maskApiKey', () => {
  it('空串返回空串', () => {
    expect(maskApiKey('')).toBe('');
  });

  it('短 key（<4 位）返回 ****', () => {
    expect(maskApiKey('abc')).toBe('****');
  });

  it('正常 key 返回 **** 前缀 + 末 4 位', () => {
    expect(maskApiKey('sk-1234567890abcd')).toBe('****abcd');
  });

  it('回归：apiKeys 表兜底后 maskedKey 非空（后台有值 → 前端可返显）', () => {
    const cfg = makeConfig({ apiKey: '', apiKeys: { agnes: '***REDACTED-SECRET***' } });
    const masked = maskApiKey(getEffectiveApiKey(cfg));
    expect(masked).toBe('****jLgW');
    expect(masked.length).toBeGreaterThan(0);
  });
});

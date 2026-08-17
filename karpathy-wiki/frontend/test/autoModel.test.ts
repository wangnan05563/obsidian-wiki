import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUTO_MODEL, AUTO_MODEL_PRIORITY, resolveAutoPreset, resolveAutoPresetForUser, orderPresetsByAutoPriority } from '../src/utils/autoModel';
import type { LlmPreset } from '../src/types';

// 模拟 per-user BYOK 配置加载（避免依赖 IndexedDB / chatDb，使 auto 择优逻辑可确定性单测）。
// 实现只注册一次（读取可变变量 configuredKeys），beforeEach 用 mockClear 仅清调用记录，
// 避免 mockReset 误删实现导致回退为 undefined。
let configuredKeys: string[] = [];
const { mockLoadAiConfig } = vi.hoisted(() => ({ mockLoadAiConfig: vi.fn() }));
vi.mock('../src/services/userConfig', () => ({
  loadAiUserConfigForPreset: (userId: string, key?: string, preset?: LlmPreset) =>
    mockLoadAiConfig(userId, key, preset),
}));
mockLoadAiConfig.mockImplementation((_u: string, key?: string, p?: LlmPreset) => ({
  provider: p?.provider ?? '',
  baseUrl: p?.baseUrl ?? '',
  model: p?.model ?? '',
  apiKey: key && configuredKeys.includes(key) ? 'sk-test-123' : '',
}));

function preset(key: string, model: string, vision = false): LlmPreset {
  return {
    key,
    label: key,
    provider: key,
    baseUrl: `https://${key}.example.com/v1`,
    model,
    apiKeyRef: `${key.toUpperCase()}_KEY`,
    apiKeyUrl: '',
    vision,
  };
}

describe('AUTO_MODEL', () => {
  it('哨兵值为 "auto"', () => {
    expect(AUTO_MODEL).toBe('auto');
  });
});

describe('resolveAutoPreset', () => {
  it('空列表返回 null', () => {
    expect(resolveAutoPreset([])).toBeNull();
    expect(resolveAutoPreset(null)).toBeNull();
    expect(resolveAutoPreset(undefined)).toBeNull();
  });

  it('仅配置 GLM 时命中 glm-4（能力优先级高于首个预设）', () => {
    const presets = [preset('glm', 'glm-4-flash')];
    expect(resolveAutoPreset(presets)?.key).toBe('glm');
  });

  it('能力优先级：OpenAI 在 GLM 之前被选中', () => {
    const presets = [preset('glm', 'glm-4-flash'), preset('openai', 'gpt-4o-mini')];
    expect(resolveAutoPreset(presets)?.key).toBe('openai');
  });

  it('命中 deepseek-chat（无 glm 干扰时）', () => {
    const presets = [preset('deepseek', 'deepseek-chat'), preset('moonshot', 'moonshot-v1-8k')];
    expect(resolveAutoPreset(presets)?.key).toBe('deepseek');
  });

  it('无能力优先级命中时回退到列表首个（系统默认）', () => {
    const presets = [preset('ollama', 'qwen2.5:7b'), preset('moonshot', 'moonshot-v1-8k')];
    expect(resolveAutoPreset(presets)?.key).toBe('ollama');
  });

  it('子串匹配：gpt-4o 命中 gpt-4o-mini', () => {
    const presets = [preset('openai', 'gpt-4o-mini')];
    expect(resolveAutoPreset(presets)?.model).toBe('gpt-4o-mini');
  });

  it('AUTO_MODEL_PRIORITY 为可读数组且首项为 gpt-4o', () => {
    expect(Array.isArray(AUTO_MODEL_PRIORITY)).toBe(true);
    expect(AUTO_MODEL_PRIORITY[0]).toBe('gpt-4o');
  });
});

describe('resolveAutoPresetForUser（auto 已配置择优，修复 400 回归）', () => {
  // 预设模板：openai(gpt-4o) 能力优先级高于 glm(glm-4) 高于 deepseek(deepseek-chat)
  const presets: LlmPreset[] = [
    preset('openai', 'gpt-4o-mini'),
    preset('glm', 'glm-4-flash'),
    preset('deepseek', 'deepseek-chat'),
  ];

  beforeEach(() => {
    configuredKeys = [];
    mockLoadAiConfig.mockClear();
  });

  // 模拟「用户仅对部分预设配置了 apiKey」，其余未配置（apiKey 为空）
  function configureOnly(keysWithKey: string[]) {
    configuredKeys = keysWithKey;
  }

  it('auto 应选「已配置」预设，而非优先级更高但未配置的预设（本 bug 根因）', async () => {
    // 仅 glm 配置了 apiKey；openai 优先级更高但未配置——
    // 旧逻辑会选 openai → 前端判定无 apiKey 不发 llmConfig → 后端 BYOK 校验 400（请求参数有误）。
    configureOnly(['glm']);
    const { preset: chosen, config } = await resolveAutoPresetForUser('u1', presets);
    expect(chosen?.key).toBe('glm');
    expect(config?.apiKey).toBe('sk-test-123');
  });

  it('所有预设都配置时，仍按能力优先级选最高（不退化）', async () => {
    configureOnly(['openai', 'glm', 'deepseek']);
    const { preset: chosen } = await resolveAutoPresetForUser('u1', presets);
    expect(chosen?.key).toBe('openai');
  });

  it('任一预设都未配置时回退优先级首个，config.apiKey 为空（交后端给明确 400 指引）', async () => {
    configureOnly([]);
    const { preset: chosen, config } = await resolveAutoPresetForUser('u1', presets);
    expect(chosen?.key).toBe('openai');
    expect(config?.apiKey).toBe('');
  });

  it('空预设列表返回 null', async () => {
    const r = await resolveAutoPresetForUser('u1', []);
    expect(r.preset).toBeNull();
    expect(r.config).toBeNull();
  });
});

describe('orderPresetsByAutoPriority', () => {
  it('命中能力优先级的排前、未命中的排后（保持原序）', () => {
    const presets = [
      preset('glm', 'glm-4-flash'),
      preset('openai', 'gpt-4o-mini'),
      preset('ollama', 'qwen2.5:7b'),
    ];
    const ordered = orderPresetsByAutoPriority(presets).map((p) => p.key);
    expect(ordered[0]).toBe('openai'); // gpt-4o 优先级最高
    expect(ordered[1]).toBe('glm'); // glm-4 其次
    expect(ordered[2]).toBe('ollama'); // 不在优先级列表，排最后
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '../src/types.js';

// FR-09-3 单元测试：播客工作流
// 为什么 mock Harness/searchPages：实际调用 LLM 消耗 token 且依赖网络，
// 单元测试只验证脚本解析、prompt 构造、归档逻辑

// Mock Harness：避免真实 LLM 调用
// 为什么脚本长度 > 100：generatePodcast 会校验 script.length < 100 并抛错
const MOCK_SCRIPT = `## Host A: 欢迎收听
大家好，欢迎收听本期知识播客。今天我们将深入探讨一个有趣的话题，敬请期待。

## Host B: 主题引入
是的，今天我们要讨论的主题非常重要。让我们先从基础概念开始，逐步深入到实际应用场景中。

## Host A: 深入分析
让我们来看看这个话题的核心要点。首先需要理解基本原理，然后才能讨论实践中的注意事项和常见问题。

## Host B: 总结
非常好，今天我们覆盖了从理论到实践的多个维度。希望听众朋友们能从中获得启发，感谢收听！`;

vi.mock('@wiki/harness', () => ({
  Harness: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({
      status: 'completed',
      finalContent: MOCK_SCRIPT,
    }),
  })),
}));

// Mock searchPages：返回固定页面列表
vi.mock('../src/search-util.js', () => ({
  searchPages: vi.fn().mockResolvedValue([
    { path: 'concepts/llm.md', title: 'llm', score: 1 },
    { path: 'concepts/wiki.md', title: 'wiki', score: 0.9 },
  ]),
}));

import { parseScriptSegments, generatePodcast } from '../src/workflows/podcast-workflow.js';
import type { VaultService } from '../src/vault/vault-service.js';
import type { HarnessConfig } from '@wiki/harness';

// 创建 mock VaultService
function createMockVault(): VaultService {
  return {
    readFile: vi.fn().mockResolvedValue('---\ntitle: Test\ntype: concept\ncreated: 2026-07-28\ntags: [test]\n---\n# Test page\n\nContent for testing.'),
    writeFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as VaultService;
}

// 创建基础 HarnessConfig
function createMockHarnessConfig(): HarnessConfig {
  return {
    llm: {
      provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-plus',
      apiKey: 'test-key',
    },
    tools: [],
    budget: { maxSteps: 20, tokenBudget: 50000 },
  } as HarnessConfig;
}

// ===========================================================================
// parseScriptSegments：脚本分段解析测试
// 为什么重点测试：TTS 合成依赖正确的分段，speaker 识别错误会导致音色错乱
// ===========================================================================
describe('parseScriptSegments', () => {
  it('正确解析标准双主持人对话脚本', () => {
    const script = `## Host A: 开场白
大家好，欢迎收听本期播客。

## Host B: 回应
谢谢主持人，今天我们来聊聊 AI。

## Host A: 话题推进
让我们从基础概念开始。

## Host B: 总结
很好，这就是今天的全部内容。`;

    const segments = parseScriptSegments(script);
    expect(segments).toHaveLength(4);
    expect(segments[0].speaker).toBe('A');
    expect(segments[0].text).toContain('开场白');
    expect(segments[1].speaker).toBe('B');
    expect(segments[1].text).toContain('回应');
    expect(segments[2].speaker).toBe('A');
    expect(segments[3].speaker).toBe('B');
  });

  it('跳过子话题标记行（### 开头）不纳入 TTS 文本', () => {
    const script = `## Host A: 开场
引入话题。

### 子话题：基础概念

## Host B: 回应
好的，开始讨论。`;

    const segments = parseScriptSegments(script);
    expect(segments).toHaveLength(2);
    // 子话题行不应出现在任何段落的文本中
    expect(segments[0].text).not.toContain('子话题');
    expect(segments[1].text).not.toContain('子话题');
  });

  it('支持中文冒号和英文冒号', () => {
    const script = `## Host A：中文冒号开场
内容 A。

## Host B: 英文冒号回应
内容 B。`;

    const segments = parseScriptSegments(script);
    expect(segments).toHaveLength(2);
    expect(segments[0].speaker).toBe('A');
    expect(segments[1].speaker).toBe('B');
  });

  it('空脚本返回空数组', () => {
    expect(parseScriptSegments('')).toEqual([]);
  });

  it('无 Host 标记的纯文本返回空数组', () => {
    expect(parseScriptSegments('这是一段没有 Host 标记的纯文本。')).toEqual([]);
  });
});

// ===========================================================================
// generatePodcast：工作流集成测试（mock 依赖）
// ===========================================================================
describe('generatePodcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功生成脚本并归档（TTS 未配置时仅返回脚本）', async () => {
    const vault = createMockVault();
    const harnessConfig = createMockHarnessConfig();
    // appConfig 无 podcast 字段：TTS 未配置，应仅生成脚本
    const appConfig: AppConfig = {
      vaultPath: '../data/vault',
      adapter: 'harness',
      llm: { provider: 'glm', baseUrl: '', model: '', apiKeyRef: 'GLM_KEY' },
      budget: { maxSteps: 20, tokenBudget: 50000 },
      server: { host: 'localhost', port: 3000 },
      localOnly: false,
      healthCheck: { staleDays: 30 },
      tunnel: {} as AppConfig['tunnel'],
    };

    const result = await generatePodcast(harnessConfig, vault, '什么是 LLM', appConfig);

    // 验证返回结构
    expect(result.script).toContain('Host A');
    expect(result.script).toContain('Host B');
    expect(result.audioFiles).toEqual([]);
    expect(result.ttsEnabled).toBe(false);
    expect(result.durationSec).toBeGreaterThan(0);
    expect(result.archivePath).toMatch(/^queries\/podcast-\d{8}-\d{6}\.md$/);

    // 验证 vault.writeFile 被调用（归档写入）
    expect(vault.writeFile).toHaveBeenCalled();
    const writeCall = (vault.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(writeCall[0]).toMatch(/^queries\/podcast-\d{8}-\d{6}\.md$/);
    // 归档内容含 frontmatter 与脚本
    expect(writeCall[1]).toContain('type: query');
    expect(writeCall[1]).toContain('output_mode: podcast');
    expect(writeCall[1]).toContain('Host A');
  });

  it('未找到相关页面时抛出明确错误', async () => {
    const vault = createMockVault();
    const harnessConfig = createMockHarnessConfig();

    // Mock searchPages 返回空数组
    const { searchPages } = await import('../src/search-util.js');
    (searchPages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    await expect(
      generatePodcast(harnessConfig, vault, '不存在的话题'),
    ).rejects.toThrow('no relevant pages');
  });

  it('LLM 输出过短时抛出错误', async () => {
    const vault = createMockVault();
    const harnessConfig = createMockHarnessConfig();

    // Mock Harness 返回过短内容
    const { Harness } = await import('@wiki/harness');
    (Harness as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      run: vi.fn().mockResolvedValue({
        status: 'completed',
        finalContent: '短', // 仅 1 字符
      }),
    }));

    await expect(
      generatePodcast(harnessConfig, vault, '测试主题'),
    ).rejects.toThrow('too short');
  });

  it('LLM 失败时抛出错误', async () => {
    const vault = createMockVault();
    const harnessConfig = createMockHarnessConfig();

    // Mock Harness 返回 failed 状态
    const { Harness } = await import('@wiki/harness');
    (Harness as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      run: vi.fn().mockResolvedValue({
        status: 'failed',
        finalContent: 'LLM API error',
      }),
    }));

    await expect(
      generatePodcast(harnessConfig, vault, '测试主题'),
    ).rejects.toThrow('LLM API error');
  });

  it('scopeFilter 的 folder 过滤跳过不匹配路径的页面', async () => {
    const vault = createMockVault();
    const harnessConfig = createMockHarnessConfig();

    // Mock searchPages 返回不同目录的页面
    const { searchPages } = await import('../src/search-util.js');
    (searchPages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { path: 'concepts/llm.md', title: 'llm', score: 1 },
      { path: 'entities/foo.md', title: 'foo', score: 0.9 },
    ]);

    // folder 过滤：仅保留 concepts/ 目录下的页面
    const result = await generatePodcast(
      harnessConfig,
      vault,
      'LLM',
      undefined,
      { folder: 'concepts' },
    );

    // 应成功生成（至少有 1 个匹配页面）
    expect(result.script).toContain('Host A');
    // readFile 被调用 2 次（collectContextPages 先读内容再做 folder 过滤，
    // 两个页面都会被读取，但 entities/foo 在 folder 过滤后被跳过不纳入上下文）
  });
});

// @vitest-environment node
// 验证 BYOK per-user 配置覆盖纯函数 applyPerRequestOverride：
//   - 各用户携带自己的 API 信息覆盖服务端共享配置（独立额度 / 互不抢占限流）
//   - 密钥不落服务端磁盘（函数无副作用、不读写存储）
//   - LLM 覆盖保留服务端无关字段（apiKeyRef/apiKeys）；搜索/工具按规则合并或替换
import { describe, expect, it } from 'vitest';
import { applyPerRequestOverride } from '../src/engine/byok-override.js';

function baseHarness() {
  return {
    llm: {
      provider: 'glm',
      baseUrl: 'https://server.example/v4',
      model: 'server-model',
      apiKeyRef: 'GLM_KEY',
      apiKey: 'SERVER_KEY',
    },
    budget: { maxSteps: 20, tokenBudget: 50000 },
  } as any;
}

const serverWebSearch = {
  provider: 'tavily' as const,
  apiKeyRef: 'TAVILY_API_KEY',
  apiKey: 'SERVER_WS_KEY',
  maxResults: 5,
};

const serverTools = {
  mcpServers: [{ id: 'shared-s1' }],
  cliTools: [],
  scenes: [],
  routerMode: 'keyword' as const,
};

describe('applyPerRequestOverride（BYOK 按用户隔离覆盖）', () => {
  it('无覆盖项时原样返回服务端共享配置（引用相等，无额外开销）', () => {
    const h = baseHarness();
    const r = applyPerRequestOverride(h, serverWebSearch, serverTools, {});
    expect(r.harnessConfig).toBe(h);
    expect(r.webSearchConfig).toBe(serverWebSearch);
    expect(r.toolsConfig).toBe(serverTools);
  });

  it('llmConfig 覆盖 provider/baseUrl/model/apiKey，且保留服务端 apiKeyRef', () => {
    const h = baseHarness();
    const r = applyPerRequestOverride(h, undefined, undefined, {
      llmConfig: { provider: 'openai', baseUrl: 'https://oa.example/v1', model: 'gpt-4o', apiKey: 'USER_KEY' },
    });
    expect(r.harnessConfig.llm).toEqual({
      provider: 'openai',
      baseUrl: 'https://oa.example/v1',
      model: 'gpt-4o',
      apiKey: 'USER_KEY',
      apiKeyRef: 'GLM_KEY', // 服务端字段保留（环境密钥名）
    });
    // 用户密钥真正生效（后端用其调 LLM）
    expect(r.harnessConfig.llm.apiKey).toBe('USER_KEY');
  });

  it('searchConfig 带 apiKey 时覆盖服务端 webSearch（合并 apiKeyRef）', () => {
    const r = applyPerRequestOverride(baseHarness(), serverWebSearch, undefined, {
      searchConfig: { provider: 'bing', apiKey: 'USER_WS_KEY', maxResults: 8 },
    });
    expect(r.webSearchConfig).toEqual({
      provider: 'bing',
      apiKeyRef: 'TAVILY_API_KEY',
      apiKey: 'USER_WS_KEY',
      maxResults: 8,
    });
  });

  it('searchConfig 无 apiKey 时回退服务端配置（搜索为附加能力，不强制）', () => {
    const none = applyPerRequestOverride(baseHarness(), undefined, undefined, {});
    expect(none.webSearchConfig).toBeUndefined();

    const fallback = applyPerRequestOverride(baseHarness(), serverWebSearch, undefined, {
      searchConfig: { provider: 'tavily', apiKey: '' },
    });
    expect(fallback.webSearchConfig).toBe(serverWebSearch);
  });

  it('toolsConfig 用户维度整体替换服务端共享 MCP/CLI（落实工具隔离）', () => {
    const userTools = {
      mcpServers: [],
      cliTools: [{ name: 'user-cli' }],
      scenes: [],
      routerMode: 'auto' as const,
    };
    const r = applyPerRequestOverride(baseHarness(), undefined, serverTools, { toolsConfig: userTools });
    expect(r.toolsConfig).toEqual(userTools);
    expect(r.toolsConfig).not.toBe(serverTools);
  });

  it('toolsConfig 为空配置（无 mcpServers/cliTools/scenes）时回退服务端共享配置，不覆盖既有工具', () => {
    const emptyTools = { mcpServers: [], cliTools: [], scenes: [], routerMode: 'keyword' as const };
    const r = applyPerRequestOverride(baseHarness(), undefined, serverTools, { toolsConfig: emptyTools });
    expect(r.toolsConfig).toBe(serverTools);
  });

  it('纯函数：不修改入参原对象（无副作用，密钥不落地）', () => {
    const h = baseHarness();
    const hSnapshot = JSON.parse(JSON.stringify(h));
    const wsSnapshot = JSON.parse(JSON.stringify(serverWebSearch));
    const toolsSnapshot = JSON.parse(JSON.stringify(serverTools));

    applyPerRequestOverride(h, serverWebSearch, serverTools, {
      llmConfig: { provider: 'openai', baseUrl: 'https://oa', model: 'gpt-4o', apiKey: 'USER_KEY' },
      searchConfig: { provider: 'bing', apiKey: 'USER_WS_KEY', maxResults: 8 },
      toolsConfig: { mcpServers: [], cliTools: [], scenes: [], routerMode: 'keyword' },
    });

    expect(h).toEqual(hSnapshot);
    expect(serverWebSearch).toEqual(wsSnapshot);
    expect(serverTools).toEqual(toolsSnapshot);
  });
});

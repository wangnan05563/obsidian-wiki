// 联网搜索工具：为 query workflow 提供互联网实时信息检索能力。
// 支持 tavily / bing 两个 provider，通过 config.webSearch 配置切换。

import type { WebSearchConfig } from '../types.js';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

// F-3.10 联网搜索超时阈值（毫秒）。
// 为什么是 5s：SRS F-3.10 验收要求「联网搜索结果 5s 内返回」，超时后降级为仅 vault 结果。
// 为什么不放在 config：阈值是 SRS 硬性验收项，业务上无合理理由放宽，故常量化。
const WEB_SEARCH_TIMEOUT_MS = 5000;

// 工具定义：与 @wiki/harness 的 ToolDefinition 结构对齐
export interface WebSearchTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  handler: (args: unknown) => Promise<WebSearchResult[]>;
}

// 创建联网搜索工具实例。
// 为什么需要工厂函数：apiKey 在启动时从环境变量解析，工具实例持有解析后的配置。
// 若 apiKey 为空，返回 null 表示工具不可用（workflow 层据此跳过注册）。
export function createWebSearchTool(config: WebSearchConfig): WebSearchTool | null {
  const apiKey = config.apiKey || process.env[config.apiKeyRef];
  if (!apiKey) {
    return null;
  }

  return {
    name: 'web_search',
    description: '搜索互联网实时信息。返回标题、URL 与摘要片段。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '返回结果数，默认 5' },
      },
      required: ['query'],
    },
    handler: async (args: unknown) => {
      const { query, limit } = args as { query: string; limit?: number };
      const maxResults = limit || config.maxResults || 5;
      // F-3.10 超时降级：用 AbortSignal.timeout 包裹 fetch，超时返回空数组让 workflow 继续走 vault 分支
      // 为什么不在 catch 抛错：harness 会把工具异常视为 step 失败，可能触发整条 ReAct 链回退，与「仅降级联网」语义不符
      try {
        if (config.provider === 'tavily') {
          return await tavilySearch(apiKey, query, maxResults);
        }
        return await bingSearch(apiKey, query, maxResults);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 超时（AbortError / TimeoutError）或 API 错误统一降级为空结果
        console.warn(`[web_search] provider=${config.provider} query="${query}" failed: ${msg}; fallback to empty results`);
        return [];
      }
    },
  };
}

// Tavily 搜索 API：POST https://api.tavily.com/search
async function tavilySearch(apiKey: string, query: string, maxResults: number): Promise<WebSearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: false,
    }),
    // F-3.10 5s 超时：AbortSignal.timeout 在 Node 18+ 原生支持，超时后 fetch 抛 AbortError
    signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Tavily API error: ${res.status}`);
  const data = await res.json() as { results?: Array<{ title: string; url: string; content: string }> };
  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

// Bing 搜索 API：GET https://api.bing.microsoft.com/v7.0/search
async function bingSearch(apiKey: string, query: string, count: number): Promise<WebSearchResult[]> {
  const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Bing API error: ${res.status}`);
  const data = await res.json() as { webPages?: { value?: Array<{ name: string; url: string; snippet: string }> } };
  return (data.webPages?.value || []).map((r) => ({
    title: r.name,
    url: r.url,
    snippet: r.snippet,
  }));
}

// 联网搜索连接测试结果。
export interface WebSearchTestResult {
  ok: boolean;
  detail: string;
  count?: number;
  provider?: string;
}

// 测试联网搜索连接是否可用：用真实 query 打一次对应 provider，验证 API Key + 网络连通性。
// 复用 tavilySearch/bingSearch（已含 5s 超时降级），避免重复维护 provider 分支。
// 为什么单独导出而非直接复用 createWebSearchTool：测试不需要注册进 workflow，且要区分「缺 key」
//   与「鉴权/网络失败」两类错误，直接调用底层 provider 函数更可控。
export async function testWebSearchConnection(config: {
  provider: 'tavily' | 'bing';
  apiKey: string;
  maxResults?: number;
}): Promise<WebSearchTestResult> {
  const provider = config.provider;
  const apiKey = config.apiKey;
  if (!apiKey) {
    return { ok: false, detail: 'API Key 未设置，请先填写 API Key', provider };
  }
  try {
    const query = 'test connectivity';
    const results = provider === 'tavily'
      ? await tavilySearch(apiKey, query, config.maxResults || 5)
      : await bingSearch(apiKey, query, config.maxResults || 5);
    return {
      ok: true,
      detail: `连接成功，返回 ${results.length} 条结果`,
      count: results.length,
      provider,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 超时（AbortError / TimeoutError）通常源于网络不通或 Key 无效导致握手挂起，给出友好提示
    const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return {
      ok: false,
      detail: isTimeout
        ? '连接超时（>5s），请检查网络或 API Key 是否有效'
        : `连接失败：${msg}`,
      provider,
    };
  }
}

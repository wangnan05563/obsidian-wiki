// LLM 错误友好化工具
// 为什么需要：wiki-harness 抛出的原始错误含完整 HTML（Cloudflare 520 页面），
// 直接透传给前端会让用户看到几十 KB 的 HTML 文本，无法定位问题。

// 已知 LLM provider 故障特征 URL/状态码
// 为什么用映射：不同 provider 故障特征不同，按 provider 分类更精准
const PROVIDER_FAULT_PATTERNS: Record<string, RegExp> = {
  // Cloudflare 5xx 错误页面特征
  cloudflare: /cloudflare|cf-error|Ray ID/i,
  // agnes-ai 服务特征
  agnes: /agnes-ai\.com|apihub\.agnes/i,
};

// 从原始错误信息中提取 HTTP 状态码
function extractStatusCode(errMsg: string): number | null {
  // 匹配 "LLM API error 520:" 或 "HTTP 502" 等模式
  const match = errMsg.match(/(?:HTTP|error)\s+(?<code>\d{3})\b/i);
  return match ? Number.parseInt(match.groups!.code, 10) : null;
}

// 检测错误是否来自特定 provider
function detectProvider(errMsg: string): string | null {
  for (const [provider, pattern] of Object.entries(PROVIDER_FAULT_PATTERNS)) {
    if (pattern.test(errMsg)) return provider;
  }
  return null;
}

// 判断是否为网络超时
function isTimeoutError(errMsg: string): boolean {
  return /timeout|abort|超时|操作超时/i.test(errMsg);
}

// 判断是否为 HTML 错误页面（Cloudflare/Nginx 等反向代理返回）
function isHtmlErrorResponse(errMsg: string): boolean {
  // 为什么用 <!DOCTYPE 或 <html：反向代理错误页面必有这些标识
  return /<!DOCTYPE|<html[\s>]/i.test(errMsg);
}

// 友好化 LLM 错误信息
// 返回结构：{ friendly: 用户可读的简短提示, category: 错误类别, provider: 故障 provider }
export function friendlyLlmError(rawErr: unknown): {
  friendly: string;
  category: 'service_down' | 'timeout' | 'auth' | 'rate_limit' | 'request_too_large' | 'unknown';
  provider?: string;
} {
  const errMsg = rawErr instanceof Error ? rawErr.message : String(rawErr);
  const statusCode = extractStatusCode(errMsg);
  const provider = detectProvider(errMsg);

  // 1. 超时类错误（含 AbortError / 操作超时）
  if (isTimeoutError(errMsg)) {
    return {
      friendly: `LLM 请求超时${provider ? `（${provider} 服务响应超时）` : ''}。可能原因：网络异常或服务端繁忙。建议稍后重试或切换 provider。`,
      category: 'timeout',
      provider: provider ?? undefined,
    };
  }

  // 2. 5xx 服务端错误（Cloudflare 520/502/503 等）
  if (statusCode !== null && statusCode >= 500 && statusCode < 600) {
    const providerName = provider ?? 'LLM 服务';
    return {
      friendly: `${providerName} 端故障（HTTP ${statusCode}）。这是服务端问题，非本地代码错误。建议切换到其他 provider 或稍后重试。`,
      category: 'service_down',
      provider: provider ?? undefined,
    };
  }

  // 3. 401/403 认证错误
  if (statusCode === 401 || statusCode === 403) {
    return {
      friendly: `LLM API 认证失败（HTTP ${statusCode}）。请检查 API Key 是否正确或是否已过期。`,
      category: 'auth',
    };
  }

  // 4. 429 限流
  if (statusCode === 429) {
    return {
      friendly: 'LLM API 请求被限流（429）。请降低请求频率或检查额度。',
      category: 'rate_limit',
    };
  }

  // 5. 413 请求体过大
  if (statusCode === 413) {
    return {
      friendly: 'LLM API 拒绝请求：内容过大（413）。请减少编译的页面数量或缩短单页内容。',
      category: 'request_too_large',
    };
  }

  // 6. HTML 错误页面（无法识别状态码但含 HTML 标签）
  if (isHtmlErrorResponse(errMsg)) {
    return {
      friendly: `LLM 服务返回了错误页面${provider ? `（${provider}）` : ''}。建议切换 provider 或稍后重试。`,
      category: 'service_down',
      provider: provider ?? undefined,
    };
  }

  // 7. 兜底：截断超长错误信息，保留前 200 字符
  const truncated = errMsg.length > 200 ? errMsg.slice(0, 200) + '...' : errMsg;
  return {
    friendly: truncated,
    category: 'unknown',
  };
}

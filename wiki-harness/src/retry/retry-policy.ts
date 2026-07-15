import type { RetryConfig } from '../types.js';

type RetryableErrorType = 'timeout' | 'rate_limit' | 'tool_error' | 'parse_error' | 'unknown';

// 错误分类：根据错误特征判断是否属于可重试类型
// 国产 API 错误格式未统一，采用关键词匹配保持兼容
// 未知错误统一归类为 'unknown'，便于调用方在 retryOn 中显式列入
export function classifyError(err: unknown): RetryableErrorType {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    const name = err.name.toLowerCase();
    if (name.includes('timeout') || msg.includes('timeout') || msg.includes('etimedout')) return 'timeout';
    if (msg.includes('rate_limit') || msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) return 'rate_limit';
    if (name.includes('tool') || msg.includes('tool')) return 'tool_error';
    if (err instanceof SyntaxError || msg.includes('parse') || msg.includes('unexpected token')) return 'parse_error';
  }
  return 'unknown';
}

// 指数退避重试：delay = min(maxDelayMs, baseDelayMs * 2^attempt) + random(0, 1000)
// 抖动（jitter）避免多实例同时重试引发雷群效应
export async function withRetry<T>(fn: () => Promise<T>, config: RetryConfig): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // 空数组表示不重试任何错误（符合常见约定）
      if (config.retryOn.length === 0) {
        throw err;
      }

      const errorType = classifyError(err);
      // errorType 为 'unknown' 或不在 retryOn 列表中时，不重试
      // 类型守卫：先排除 'unknown' 再 includes，避免 TS 类型不兼容
      if (errorType === 'unknown' || !config.retryOn.includes(errorType as Exclude<RetryableErrorType, 'unknown'>)) {
        throw err;
      }

      if (attempt === config.maxRetries) break;

      const exponentialDelay = Math.min(config.maxDelayMs, config.baseDelayMs * Math.pow(2, attempt));
      const jitter = Math.random() * 1000;
      const delay = exponentialDelay + jitter;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

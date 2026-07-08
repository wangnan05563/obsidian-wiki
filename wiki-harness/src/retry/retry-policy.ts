import type { RetryConfig } from '../types.js';

type RetryableErrorType = 'timeout' | 'rate_limit' | 'tool_error' | 'parse_error';

// 错误分类：根据错误特征判断是否属于可重试类型
// 国产 API 错误格式未统一，采用关键词匹配保持兼容
function classifyError(err: unknown): RetryableErrorType | null {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    const name = err.name.toLowerCase();
    if (name.includes('timeout') || msg.includes('timeout') || msg.includes('etimedout')) return 'timeout';
    if (msg.includes('rate_limit') || msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) return 'rate_limit';
    if (name.includes('tool') || msg.includes('tool')) return 'tool_error';
    if (err instanceof SyntaxError || msg.includes('parse') || msg.includes('unexpected token')) return 'parse_error';
  }
  return null;
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

      // 配置了 retryOn 时，只对列出的错误类型重试；为空则全部重试
      if (config.retryOn.length > 0) {
        const errorType = classifyError(err);
        if (errorType === null || !config.retryOn.includes(errorType)) {
          throw err;
        }
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

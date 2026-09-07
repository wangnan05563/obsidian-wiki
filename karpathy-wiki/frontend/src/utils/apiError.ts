// HTTP 状态码 → 中文可操作提示映射。
// 把后端/上游（LLM 服务商等）返回的状态码转成用户可读、可操作的提示，
// 避免直接暴露 "HTTP 402" 这类原始文案。402 常见于模型服务商额度不足/订阅过期
// （见 api/src/utils/audio-convert.ts、ocr-convert.ts 注释）。
const HTTP_STATUS_MESSAGES: Record<number, string> = {
  400: '请求参数有误，请检查输入后重试',
  401: '未授权或登录已失效，请重新登录',
  402: '调用模型服务返回 402：当前账户额度不足或订阅已过期，请检查 API Key 余额或充值后重试',
  403: '无权限访问该资源',
  404: '请求的资源不存在',
  429: '请求过于频繁（触发限流），请稍后重试',
  500: '服务端内部错误，请稍后重试',
  502: '网关错误，服务可能正在重启，请稍后重试',
  503: '服务暂不可用，请稍后重试',
};

// 从错误消息中提取 HTTP 状态码（消息形如 "HTTP 402" 或 "HTTP 402: Payment Required"）。
function extractHttpStatus(message: string): number | null {
  const m = message.match(/HTTP\s+(\d{3})/i);
  return m ? Number(m[1]) : null;
}

export function apiErrorMessage(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const isNetworkError = message.includes('Failed to fetch')
    || message.includes('NetworkError')
    || message.includes('ERR_CONNECTION');
  if (isNetworkError) {
    return `${action}：后端服务未运行，请启动 karpathy-wiki.exe 后再试。`;
  }
  const status = extractHttpStatus(message);
  if (status && HTTP_STATUS_MESSAGES[status]) {
    // 若消息在状态码后附带后端原文（形如 "HTTP 400: xxx"），优先透出服务器说明而非通用映射，
    // 避免掩蔽「未配置 API Key」这类明确指引，用户只看到"请求参数有误"而不知如何解决。
    const sep = message.indexOf(':');
    const custom = sep >= 0 ? message.slice(sep + 1).trim() : '';
    return custom ? `${action}：${custom}` : `${action}：${HTTP_STATUS_MESSAGES[status]}`;
  }
  return `${action}：${message}`;
}

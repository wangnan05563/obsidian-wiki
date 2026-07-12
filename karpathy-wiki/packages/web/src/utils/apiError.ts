export function apiErrorMessage(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const isNetworkError = message.includes('Failed to fetch')
    || message.includes('NetworkError')
    || message.includes('ERR_CONNECTION');
  return isNetworkError
    ? `${action}：后端服务未运行，请启动 karpathy-wiki.exe 后再试。`
    : `${action}：${message}`;
}

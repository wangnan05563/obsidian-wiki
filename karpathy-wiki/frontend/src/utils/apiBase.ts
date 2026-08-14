// API 基础路径：跟随 Vite base，base='/wiki/' 时为 '/wiki/api'
// Tailscale Funnel 路径区分模式：浏览器请求 /wiki/api/xxx → Funnel 剥离 /wiki/ → 后端收到 /api/xxx
// 为什么用 BASE_URL 而非硬编码：开发模式 base='/' 时为 '/api'，生产模式 base='/wiki/' 时为 '/wiki/api'
export const API_BASE = import.meta.env.BASE_URL + 'api'

// 统一 API 请求封装：自动注入 Authorization 头（携带登录 token）。
// 背景：后端开启 auth 后，受保护接口（/api/config、/api/ai/config 等）要求 Bearer token，
//   此前大量视图/store 直接用裸 fetch 调用这些接口，未带 token → 返回 401。
//   本函数与裸 fetch 完全兼容（签名一致），是裸 fetch 的超集：
//   - 已登录：注入 Authorization: Bearer <token>，受保护接口正常返回；
//   - 未登录（localStorage 无 token）：行为与裸 fetch 一致，公开接口照常工作；
//   - 公开接口带 token 也无副作用。
// 与 auth store 的 authFetch 区别：本函数不依赖 Pinia 实例，可在任意 .vue/.ts 上下文调用，
//   且不主动触发登出（会话失效由 App.vue 启动时 restoreSession 统一处理）。
// 为什么从 localStorage 直接读：token 由 auth store 持久化到 STORAGE_KEYS.AUTH_TOKEN，
//   避免在普通工具模块里耦合 Pinia（避免 SSR/非组件上下文调用 useAuthStore 的副作用）。
import { STORAGE_KEYS } from '../constants/storageKeys';

export async function apiFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  let token: string | null = null;
  try {
    token = localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  } catch {
    // localStorage 不可用时退化为裸 fetch（不注入 token）
  }
  // 默认 Content-Type: application/json（仅当 body 为字符串且调用方未显式指定时）。
  // 为什么限制为字符串：FormData / Blob / ArrayBuffer 等二进制 body 应由浏览器自动设置
  //   multipart/form-data 或对应 Content-Type；若此处强制 application/json 会破坏文件上传。
  if (!headers.has('Content-Type') && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(input, { ...init, headers });
  // 401 自动清理失效会话：本次携带了 token 却仍 401（典型场景：后端重启导致临时
  // 会话密钥变化，旧 token 失效），清理本地失效 token 并广播事件，由 App.vue 跳登录，
  // 避免持续 401 与未捕获 rejection 刷屏。未携带 token 的 401 不处理（本就未登录）。
  if (response.status === 401 && token) {
    try { localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN); } catch { /* ignore */ }
    try {
      if (typeof CustomEvent !== 'undefined' && globalThis.dispatchEvent) {
        globalThis.dispatchEvent(new CustomEvent('karpathy:auth-expired'));
      }
    } catch { /* ignore */ }
  }
  return response;
}

// 从 Content-Disposition 解析权威文件名：RFC 5987 的 filename*（UTF-8''<pct-encoded>）优先，
//   兼容旧浏览器的 ASCII filename="..."。下载落盘文件名以此为准，避免列表/卡片/移动端
//   因传入展示标题（无扩展名）而保存出无后缀文件（评审发现 #1）。
function parseDispositionName(disposition: string): string | null {
  if (!disposition) return null;
  const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1]); } catch { /* 解码失败回退 */ }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

// 下载默认超时（避免慢网/大文件下 await res.blob() 长时间挂起，评审发现 #3）。
// 知识库文档多为 KB~MB 级，120s 足够；超时会抛 AbortError 由调用方提示。
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;

// 下载知识库文件到本地设备（PC / 移动端复用）。
// 为什么必须用 apiFetch：鉴权为 localStorage 的 Bearer Token（非 Cookie），
//   普通 <a href> 直链不带 Token → 401；此函数经 apiFetch 注入 Token 后取 Blob 触发下载。
// 流程：GET /api/files/download（后端返回原始字节 + Content-Disposition: attachment）
//   → 读 Blob → 解析服务端权威文件名 → 生成 object URL → 创建隐藏 <a download> 触发保存。
// 兼容性策略：
//   - 桌面 Chrome/Edge/Firefox/Safari 与 Android Chrome：anchor download 可靠生效；
//   - iOS Safari 对 anchor download 支持有限（常改为预览而非保存），改用 window.open
//     在新标签打开 Blob，由用户借助系统「分享 / 存储到文件」完成保存（平台限制，非代码缺陷）。
export async function downloadVaultFile(
  relPath: string,
  fallbackName?: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const url = `${API_BASE}/files/download?path=${encodeURIComponent(relPath)}`;
  // 超时保护：未显式传入 signal 时，按默认/调用方超时构造 AbortSignal（特性检测，旧环境降级为无超时）
  let signal = opts.signal;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  if (!signal && timeoutMs > 0 && typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
    try { signal = AbortSignal.timeout(timeoutMs); } catch { /* 不支持则忽略 */ }
  }
  const res = await apiFetch(url, signal ? { signal } : undefined);
  if (!res.ok) {
    throw new Error(`下载失败：HTTP ${res.status}`);
  }
  const blob = await res.blob();
  // 落盘文件名优先级：服务端 Content-Disposition（含正确扩展名/中文）> 清洗后的展示名 > 路径 basename
  const name =
    parseDispositionName(res.headers.get('content-disposition') || '') ||
    (fallbackName ? fallbackName.replace(/[\\/]/g, '_') : null) ||
    relPath.split('/').pop() ||
    'download';
  const objectUrl = URL.createObjectURL(blob);
  const isIOS =
    /iP(hone|ad|od)/.test(navigator.platform || '') ||
    (/Macintosh/.test(navigator.userAgent || '') && 'ontouchend' in document);
  if (isIOS) {
    // iOS：新标签打开 Blob，由用户「分享 / 存储到文件」。延迟回收 object URL。
    window.open(objectUrl, '_blank');
    setTimeout(() => {
      try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
    }, 30000);
  } else {
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 延迟回收 object URL，确保下载已开始
    setTimeout(() => {
      try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
    }, 1500);
  }
}

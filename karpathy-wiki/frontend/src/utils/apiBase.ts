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
  try {
    const token = localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
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
  return fetch(input, { ...init, headers });
}

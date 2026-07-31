// API 基础路径：跟随 Vite base，base='/wiki/' 时为 '/wiki/api'
// Tailscale Funnel 路径区分模式：浏览器请求 /wiki/api/xxx → Funnel 剥离 /wiki/ → 后端收到 /api/xxx
// 为什么用 BASE_URL 而非硬编码：开发模式 base='/' 时为 '/api'，生产模式 base='/wiki/' 时为 '/wiki/api'
export const API_BASE = import.meta.env.BASE_URL + 'api'

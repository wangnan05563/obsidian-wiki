import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // 让 .ts/.vue 优先于可能残留的 .js 产物（clean-js.ps1 清理对象），避免陈旧编译产物遮蔽 .ts 源码
  resolve: {
    extensions: ['.mjs', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.vue', '.json'],
  },
  // Tailscale Funnel 路径区分模式：前端构建资源挂在 /wiki/ 前缀下
  // Tailscale Funnel --set-path /wiki/ 在 Funnel 层注册路径前缀，转发时自动剥离前缀
  // 浏览器请求 https://host/wiki/api/xxx → Funnel 剥离 /wiki/ → 后端收到 /api/xxx
  base: '/wiki/',
  server: {
    port: 5173,
    // 同时监听 IPv4 0.0.0.0 与 IPv6 [::]，避免 localhost 仅解析为 [::1] 时
    // Playwright/Chromium 用 IPv4 127.0.0.1 连接被拒（net::ERR_CONNECTION_REFUSED）
    host: true,
    proxy: {
      // 路径区分模式下前端 fetch 路径以 /wiki/api 开头，rewrite 去掉 /wiki 前缀转发到后端
      '/wiki/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wiki/, ''),
        // 批量编译 + SSE 流式响应：禁用超时，避免长耗时请求连接被中断导致 "Failed to fetch"
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  build: {
    // 统一生成内容：输出到项目根/release/spa/public，由后端 @fastify/static 托管
    // 为什么不输出到默认 dist：单端口部署需要后端直接服务前端静态资源
    outDir: '../../release/spa/public',
    emptyOutDir: true,
    // 为什么调高到 1800：项目依赖 Element Plus + vis-network + markdown-it，
    // 单 chunk 压缩后约 580kB（gzip），在单端口部署场景下可接受
    chunkSizeWarningLimit: 1800,
    rollupOptions: {
      // 过滤 @vueuse/core 的 /* #__PURE__ */ 注释位置警告
      // 为什么过滤：第三方库已发布，无法修改注释位置，警告不影响功能
      onwarn(warning, defaultHandler) {
        if (warning.code === 'INVALID_ANNOTATION') return;
        defaultHandler(warning);
      }
    }
  }
});

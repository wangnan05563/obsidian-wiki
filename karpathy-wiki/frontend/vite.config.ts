import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000'
    }
  },
  build: {
    // 输出到后端 public 目录，生产模式由 Fastify @fastify/static 托管
    // 为什么不输出到默认 dist：单端口部署需要后端直接服务前端静态资源
    outDir: '../api/public',
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

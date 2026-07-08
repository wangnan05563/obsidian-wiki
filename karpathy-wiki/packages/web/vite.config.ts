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
    outDir: '../../services/api/public',
    emptyOutDir: true
  }
});

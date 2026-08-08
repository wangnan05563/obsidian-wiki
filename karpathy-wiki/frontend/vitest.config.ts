import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// 前端 vitest 配置
// 为什么用 happy-dom：比 jsdom 性能更好，在 Windows 上启动快 10 倍以上
export default defineConfig({
  plugins: [vue()],
  // 与 vite.config.ts 一致：把 .ts 放在 .js 前，避免 src 下残留的陈旧 .js/.vue.js 编译产物
  // 遮蔽真实 .ts/.vue 源码（frontend-ts-js-shadowing 陷阱）。noEmit 已杜绝 vue-tsc 重新 emit，
  // 此处为双保险。
  resolve: {
    extensions: ['.mjs', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.vue', '.json'],
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/stores/auth.ts', 'src/composables/usePermission.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});

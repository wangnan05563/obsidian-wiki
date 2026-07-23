import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// 前端 vitest 配置
// 为什么用 happy-dom：比 jsdom 性能更好，在 Windows 上启动快 10 倍以上
export default defineConfig({
  plugins: [vue()],
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

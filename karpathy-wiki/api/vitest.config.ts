// Vitest 配置：vitest 1.x + vite 5.x（兼容配置）
// 为什么用 vitest 1.x：vitest 4.x 的 --coverage 需要 vite 6.x 的 module-runner，
// 但项目使用 vite 5.x，降级到 1.6.1 保证覆盖率功能可用
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 包含 test 目录下所有 .test.ts 文件（RBAC 单元测试 + 集成测试）
    // 同时包含 src 下的 .test.ts（项目原有测试）
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // 为什么单线程：Windows 上 vitest 多线程模式启动慢，
    // 单线程模式更稳定且本项目测试用例少，无需并行
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/auth/**/*.ts', 'src/middleware/auth.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});

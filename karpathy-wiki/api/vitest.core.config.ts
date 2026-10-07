// 核心口径覆盖率门禁（T01552）：只测鉴权链路，门槛固定 80%。
// 为什么单独一份配置：src/auth/**（用户存储、令牌签发/校验、口令哈希）与 src/middleware/auth.ts
// （请求级权限判定）是安全边界所在，它们的覆盖率不能被全量分母稀释；
// 全量口径见 vitest.config.ts（供 SonarQube 度量与防退化棘轮使用）。
//
// 用法：pnpm --filter @karpathy-wiki/api test:coverage:core
//       （= vitest run --coverage --config vitest.core.config.ts）
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      provider: 'v8',
      // 核心口径不需要 lcov 上报（同一批文件已由全量口径的 lcov.info 覆盖），只出门禁结论
      reporter: ['text', 'json-summary'],
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

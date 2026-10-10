// Vitest 配置：vitest 1.x + vite 5.x（兼容配置）
// 为什么用 vitest 1.x：vitest 4.x 的 --coverage 需要 vite 6.x 的 module-runner，
// 但项目使用 vite 5.x，降级到 1.6.1 保证覆盖率功能可用
//
// T01552 覆盖率口径拆分（两份配置，职责不同，别混用）：
//   vitest.config.ts            —— 全量口径：src/**/*.ts 都参与测量，供 SonarQube 读 lcov.info 用，
//                                  thresholds 是「棘轮基线」：只保证覆盖率不后退，达不到就红。
//   vitest.core.config.ts       —— 核心口径：仅鉴权相关（src/auth/**、src/middleware/auth.ts），
//                                  门槛固定 80%，这是安全核心模块的硬要求，不随全量数字稀释。
// 为什么要拆：把 80% 门槛挂在全量 include 上会让它永远失败（views/workflows 等大量未测模块），
// 团队只能选择「整条命令忽略」；拆开后核心模块的门禁真实有效，全量门禁变成可执行的防退化。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // FR-20：node:sqlite 是 Node 22.5+ 内置模块，vitest 1.x / vite 5 的模块解析器
  // 不认识它（内置模块清单未更新），会误当 npm 包解析 'sqlite' 导致加载失败。
  // ssr.external 让 vite 跳过打包直接交给 Node 运行时 require（测试跑在真实 Node 进程内）。
  ssr: {
    external: ['node:sqlite'],
  },
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
      // lcov：供 SonarQube 读取覆盖率（sonar-project.properties 的 sonar.javascript.lcov.reportPaths）
      reporter: ['text', 'json', 'html', 'lcov'],
      // 全量口径：src 下所有源文件（含 workflows/utils/routes/engine 等此前未参与测量的模块）
      include: ['src/**/*.ts'],
      // 纯声明/类型与打包入口不纳入覆盖率分母（无行为可测）：
      //   - types 目录与 *.d.ts：只有类型，运行时不存在语句
      exclude: ['src/**/*.d.ts', 'src/**/types.ts', 'src/**/index.ts.d'],
      // 棘轮基线（T01552 实测设定，2026-10-07）：数值来自 `pnpm test:coverage` 的真实输出，
      // 刻意略低于当前实测值，用于「禁止覆盖率后退」而非「宣称达标」。
      // 上调流程：加测试 → 跑覆盖率 → 把基线抬到新的实测值下方一档，并在此注明日期与数值来源。
      thresholds: {
        lines: 24,
        functions: 27,
        branches: 22,
        statements: 24,
      },
    },
  },
});

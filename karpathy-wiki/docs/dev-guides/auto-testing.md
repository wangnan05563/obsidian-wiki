# Obsidian Auto Testing Skill

## 概述

本技能提供 Karpathy-Wiki 项目（Obsidian 知识库）的自动化测试规范和流程。
所有测试参数通过配置文件管理，无硬编码值。

---

## 一、测试范围

### 1.1 前端测试

| 测试类别 | 覆盖范围 | 工具 |
|---------|---------|------|
| 组件渲染 | 所有 .vue 组件在浅色/深色主题下的渲染 | Vue Test Utils |
| 状态管理 | store 的 reset/load/persist 完整链路 | Pinia testing |
| API 对接 | fetch 调用 + apiErrorMessage 错误处理 | MSW / vitest-mock |
| 用户交互 | 按钮 disabled 状态、表单提交、错误反馈 | @testing-library/vue |

### 1.2 后端测试

| 测试类别 | 覆盖范围 | 工具 |
|---------|---------|------|
| 路由处理 | 所有 /api/* 路由的 try/catch 覆盖 | Fastify inject |
| 配置加载 | config.json 读写、默认值合并 | fs mock |
| 健康检查 | /api/health-check 端点可用性 | HTTP 断言 |
| 文件安全 | 路径遍历防护、编码一致性 | 边界值测试 |

### 1.3 Obsidian 数据测试

| 测试类别 | 覆盖范围 |
|---------|---------|
| 数据摄入 | Markdown 文件解析、frontmatter 提取 |
| 向量检索 | 问答结果相关性、空结果处理 |
| 图谱构建 | 实体关系提取完整性 |

---

## 二、测试执行流程

### 2.1 标准测试流程

`
1. 读取测试配置（config.yaml / test-config.json）
2. 启动后端服务（如未运行）
3. 执行前端类型检查（tsc --noEmit）
4. 执行后端路由测试
5. 执行前端组件测试
6. 执行端到端健康检查验证
7. 生成测试报告
`

### 2.2 快速验证流程（CI 友好）

`
1. tsc --noEmit -p karpathy-wiki/frontend/tsconfig.json
2. 启动后端服务
3. curl /api/health-check
4. curl /api/ai/presets
5. 验证响应格式
`

---

## 三、配置文件规范

### 3.1 测试配置结构

`yaml
# test-config.yaml
backend:
  url: http://127.0.0.1:8899
  health_check_path: /api/health-check
  startup_timeout_ms: 30000

frontend:
  build_dir: packages/web
  build_command: npm run build
  tsc_flag: --noEmit

obsidian:
  vault_path: ./data/obsidian-vault
  supported_extensions: [.md, .markdown]
  max_file_size_kb: 500

testing:
  parallel: true
  retry_count: 2
  report_format: json
`

### 3.2 无硬编码原则

- 所有 URL、端口、路径通过配置文件读取
- 文件扩展名、大小限制等参数可配置
- 测试超时时间、重试次数等通过配置管理
- 默认值仅在配置缺失时作为 fallback

---

## 四、常见问题自动化检测

### 4.1 "Failed to fetch" 检测

`
检查项：
1. 后端服务是否运行（curl /api/health-check）
2. 前端是否使用 apiErrorMessage() 处理网络错误
3. 所有 fetch 调用是否有 try/catch
4. ElMessage 是否正确显示错误信息
`

### 4.2 Loading 状态检测

`
检查项：
1. isLoading 在成功路径是否重置为 false
2. isLoading 在错误路径是否重置为 false
3. isLoading 在 finally 块是否重置为 false
4. 按钮 :disabled 绑定是否依赖 isLoading
`

### 4.3 类型同步检测

`
检查项：
1. 后端新增响应字段时，前端 types.ts 是否同步
2. API 返回值是否与 TypeScript 接口定义一致
3. fetch().json() 的结果是否有类型声明
`

---

## 五、适用场景与不适用场景

### 5.1 适用场景
- 新功能开发前的回归测试
- UI/UX 修复后的验证
- 配置变更后的端到端测试
- 部署前的 CI 检查

### 5.2 不适用场景
- 第三方库源码测试
- Vite 构建产物测试
- 手动探索性测试（留给 QA）

---

*最后更新：2026-07-13*

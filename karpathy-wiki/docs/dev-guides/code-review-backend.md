# Wiki Backend Code Review Skill

## 概述

后端代码审查规范，覆盖 Fastify + TypeScript + Node.js 技术栈。审查重点围绕配置管理、API Key 安全、适配器同步和错误处理。

---

## 一、审查流程

### 1.1 审查顺序

```
1. 类型定义检查（types.ts）
2. 配置管理检查（config.ts）
3. API 路由检查（routes/*.ts）
4. 适配器实现检查（engine/*.ts）
5. 工作流检查（workflows/*.ts）
6. 服务层检查（services/*.ts）
```

### 1.2 审查工具

- TypeScript 编译器：`tsc --noEmit -p services/api/tsconfig.json`
- 静态分析：`rg` 搜索潜在硬编码
- 运行时测试：启动服务验证配置变更

---

## 二、审查要点

### 2.1 配置管理

| 检查项 | 标准 | 违规示例 |
|--------|------|----------|
| 默认值 | 所有配置必须有 `defaultConfig()` 默认值 | 缺少默认值导致 undefined |
| 浅合并 | 嵌套对象使用条件合并 | `{ ...defaults, ...parsed }` 丢失子字段 |
| 可选字段 | 使用 `parsed.field ? { ...defaults.field, ...parsed.field } : defaults.field` | 直接展开导致 `string \| undefined` |
| 热加载 | 区分热更新字段和需重启字段 | 修改 provider 后未同步 adapter |
| 配置路径 | `getConfigPath()` 返回 null 时不崩溃 | 直接调用 `fs.writeFile(null, ...)` |

### 2.2 API Key 管理

| 检查项 | 标准 | 原因 |
|--------|------|------|
| 存储方式 | 使用 `apiKeys` 字典按 provider 存储 | 切换 provider 时 key 不丢失 |
| 读取优先级 | `apiKeys[provider]` > `apiKey` > `process.env[apiKeyRef]` | 向后兼容 + 安全性 |
| 脱敏返回 | GET 接口必须使用 `maskApiKey()` | 安全要求 M-7 |
| 脱敏回传 | `****` 开头的 apiKey 视为未修改 | 防止前端回传脱敏值覆盖真实 key |
| 空串处理 | 空字符串表示清除该 provider 的 key | 支持撤销操作 |
| 不落盘 | API Key 不写入日志、不返回完整值 | 安全要求 M-7 |

### 2.3 API 路由

| 检查项 | 标准 | 违规示例 |
|--------|------|----------|
| 路由注册 | `app.get/put/post()` 后立即 `});` 闭合 | 漏写 `});` 导致语法错误 |
| 错误处理 | 每个路由有 try/catch | 未处理的 Promise rejection |
| 参数校验 | 请求体必须有类型守卫 | `request.body as T` 无空值检查 |
| 适配器同步 | 配置变更后必须调用 `adapter.updateConfig()` | 配置落盘但运行时未生效 |
| 幂等性 | PUT 接口支持部分更新 | 全量覆盖导致未传字段丢失 |

### 2.4 适配器模式

| 检查项 | 标准 | 原因 |
|--------|------|------|
| 接口定义 | `EngineAdapter` 定义完整方法签名 | 确保各实现一致性 |
| 热更新 | `updateConfig()` 支持运行时参数变更 | 无需重启服务 |
| 依赖注入 | adapter 通过构造函数传入 | 便于测试和替换 |
| 配置同步 | 配置变更后同步到 adapter | 避免内存与磁盘不一致 |

### 2.5 错误处理

| 检查项 | 标准 |
|--------|------|
| 统一格式 | 错误响应使用 `{ error: string }` 格式 |
| 错误详情 | 生产环境不暴露堆栈跟踪 |
| 日志级别 | 使用 `logging.level` 配置控制 |
| 请求日志 | 启用 `enableRequestLog` 记录 HTTP 请求 |

---

## 三、常见错误模式

### 3.1 括号计数错误

**问题：** 修改路由注册代码时误删 `});`。

**检测：** 使用括号计数器：`[regex]::Matches($content, '\(')` 应与 `[regex]::Matches($content, '\)')` 相等。

**修复：** 每行 `app.get/put/post(...)` 必须对应一个 `});`。

### 3.2 变量声明顺序

**问题：** 在 `saveAiConfig` 中先使用 `effectiveKey` 再声明。

**检测：** TypeScript 报 `TS2448: used before declaration`。

**修复：** 将 `const effectiveKey = getEffectiveApiKey(merged)` 移到 `adapter.updateConfig()` 之前。

### 3.3 配置合并丢失

**问题：** 使用 `{ ...defaults, ...parsed }` 合并嵌套对象时，`parsed` 缺少子字段导致默认值被覆盖为 `undefined`。

**检测：** 运行时配置字段为 `undefined`。

**修复：** 嵌套对象使用条件合并：
```typescript
logging: parsed.logging
  ? { ...defaults.logging, ...parsed.logging }
  : defaults.logging,
```

### 3.4 适配器未同步

**问题：** 配置保存到 `config.json` 后，内存中的 adapter 未更新。

**检测：** 前端修改配置后，LLM 请求仍使用旧配置。

**修复：** `saveAiConfig()` 后必须调用 `adapter.updateConfig()`。

---

## 四、审查结果呈现

### 4.1 严重级别

| 级别 | 符号 | 含义 | 示例 |
|------|------|------|------|
| P0 | 🔴 | 阻塞发布 | API Key 明文日志、配置合并丢失、适配器未同步 |
| P1 | 🟡 | 建议修复 | 缺少错误处理、脱敏不规范、变量声明顺序 |
| P2 | 🟢 | 优化建议 | 代码风格、注释缺失、性能优化 |

### 4.2 审查报告模板

```markdown
## 后端代码审查报告

**文件：** `services/api/src/routes/ai.ts`
**审查人：** [姓名]
**日期：** YYYY-MM-DD

### 🔴 P0 问题（0）
无

### 🟡 P1 问题（2）
1. [L155] `adapter.updateConfig()` 在 `effectiveKey` 声明之前 → TS2448
2. [L200] PUT 响应缺少 `providerKeyStatus` 字段 → 前端无法显示 key 状态

### 🟢 P2 建议（3）
1. [L50] 添加注释说明 apiKeys 字典的设计意图
2. [L120] 使用常量替代魔法数字 `15000`（超时）
3. [L180] 错误消息应包含请求 ID 便于追踪

### ✅ 通过项
- API Key 脱敏处理正确
- 配置合并逻辑使用条件合并
- 适配器同步机制完善
```

---

## 五、配置变更影响评估矩阵

| 变更字段 | 影响范围 | 是否需要 adapter.updateConfig | 是否需要重启 |
|----------|----------|------------------------------|-------------|
| `llm.provider` | LLM 请求 | ✅ 是 | ❌ 否 |
| `llm.baseUrl` | LLM 请求 | ✅ 是 | ❌ 否 |
| `llm.model` | LLM 请求 | ✅ 是 | ❌ 否 |
| `llm.apiKey` | LLM 认证 | ✅ 是 | ❌ 否 |
| `llm.apiKeys` | 多 provider 管理 | ✅ 是 | ❌ 否 |
| `budget.maxSteps` | 编译/查询步数 | ✅ 是 | ❌ 否 |
| `budget.tokenBudget` | Token 限额 | ✅ 是 | ❌ 否 |
| `healthCheck.staleDays` | 过期检测阈值 | ✅ 是 | ❌ 否 |
| `server.port` | HTTP 监听端口 | ❌ 否 | ✅ 是 |
| `vaultPath` | 知识库路径 | ❌ 否 | ✅ 是 |
| `webSearch` | 联网搜索 | ✅ 是 | ❌ 否 |
| `logging` | 日志配置 | ❌ 否 | ✅ 是 |

---

## 六、适用与不适用场景

### 6.1 适用场景
- Fastify + TypeScript 后端项目
- 涉及 LLM API 集成的服务
- 配置驱动的多租户应用
- 需要热更新配置的系统

### 6.2 不适用场景
- 纯数据库操作（无配置逻辑）
- 静态文件服务
- 第三方库源码
- 测试文件（使用单独的测试审查规范）

---

## 七、API 错误处理审查要点（2026-07-13 新增）

### 7.1 路由错误处理

| 检查项 | 标准 | 违规示例 |
|--------|------|----------|
| try/catch 覆盖 | 每个 API 路由的 async handler 必须有 try/catch | pp.get('/api/xxx', async (c) => { return await db.query() }) 无异常处理 |
| 错误格式统一 | catch 块返回统一的 { ok: false, message: string } 格式 | 直接 	hrow new Error() 不捕获 |
| 500 状态码 | 未知错误返回 500，已知业务错误返回对应状态码 | 所有错误都返回 200 |
| 日志记录 | 错误必须记录日志，包含请求路径和错误堆栈 | 静默吞掉异常 |

### 7.2 前端对接兼容性

| 检查项 | 标准 |
|--------|------|
| CORS 头 | 开发环境下必须返回正确的 CORS 响应头 |
| 健康检查端点 | /api/health-check 必须可用，前端依赖此判断后端状态 |
| 空响应处理 | GET 接口在无数据时返回空数组/空对象，不可返回 null 或未定义 |
| 超时处理 | 耗时操作（如编译、数据摄入）必须支持超时和进度查询 |

### 7.3 配置端点审查

| 检查项 | 标准 |
|--------|------|
| config.json 读写 | 读取失败时返回默认配置而非 500 错误 |
| 配置验证 | PUT 接口必须验证配置合法性后再落盘 |
| 热加载 | 配置变更后必须通知运行中的 adapter 重新加载 |
| 权限控制 | 配置写入接口在生产环境应有鉴权 |

### 7.4 数据库/IndexedDB 兼容性

| 检查项 | 标准 |
|--------|------|
| IndexedDB 降级 | 后端不依赖 IndexedDB，IndexedDB 是纯前端存储 |
| 文件路径安全 | 所有文件操作必须验证路径不在工作目录之外 |
| 编码一致性 | 读取/写入 Markdown 文件时统一使用 UTF-8 编码 |

### 7.5 审查工具扩展

- **try/catch 覆盖率检查**：搜索 outes/ 目录下所有 pp.get/put/post，确认每个 handler 都有 try/catch
- **错误格式检查**：确认所有 catch 块返回 { ok: false, message: ... } 格式
- **健康检查可用性**：确认 /api/health-check 端点在所有环境下可访问

---

*最后更新：2026-07-13*
---

*最后更新：2026-07-13*
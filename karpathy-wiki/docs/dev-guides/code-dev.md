# Wiki Code Development Skill

## 概述

本文档系统化提炼 Karpathy-Wiki 项目的编码规范、技术标准和工作流程。所有规范均从实际开发中的问题反推而来，旨在预防同类问题再次发生。

---

## 一、成功执行任务的完整步骤

### 1.1 DeepSeek API 配置修复

**步骤：**
1. 使用 `rg` 搜索所有包含 `deepseek` / `apiKey` / `model` / `provider` 的文件，定位配置相关代码
2. 阅读 `config.ts` 了解默认配置结构和 `defaultConfig()` 函数
3. 阅读 `routes/ai.ts` 了解 LLM_PRESETS 预设列表和 API 路由
4. 访问 DeepSeek 官方文档 (`api-docs.deepseek.com`) 验证模型名称和 Base URL
5. 确认 `baseUrl` 应为 `https://api.deepseek.com/v1`（非 `https://api.deepseek.com`）
6. 确认模型名为 `deepseek-v4-flash`（全小写，非 `deepseek-chat`）
7. 更新 `routes/ai.ts` 中的 DeepSeek preset
8. 更新 `config.ts` 中的默认 LLM 配置
9. 使用 TypeScript 编译器验证无语法错误

### 1.2 API Key 按 Provider 独立持久化

**步骤：**
1. 分析现有 API Key 存储机制：`config.json.llm.apiKey` 单一字段
2. 识别问题：切换 provider 时旧 key 被覆盖丢失
3. 设计新方案：`config.json.llm.apiKeys` 字典，按 provider key 存储
4. 更新 `types.ts` 添加 `apiKeys?: Record<string, string>` 字段
5. 重构 `getEffectiveApiKey()` 函数，优先级：apiKeys[provider] > apiKey > 环境变量
6. 重构 `saveAiConfig()` 函数，保存时自动写入 apiKeys 字典
7. 更新前端 `Config.vue`，切换 preset 时清空 apiKey 输入框
8. 添加 `providerKeyStatus` 返回字段，前端显示 key-dot 指示器
9. 验证 TypeScript 编译通过

---

## 二、任务执行过程中的不确定性与失败点

### 2.1 文件编码问题（CRLF vs LF）

**问题：** PowerShell 的 `Get-Content` + `[System.IO.File]::WriteAllText` 在混合使用 CRLF 和 LF 时可能导致文件编码不一致。

**失败表现：** TypeScript 编译器报 `TS1005: ')' expected` 等语法错误，但肉眼检查代码结构正常。

**根因：** 多次编辑同一文件时，不同工具产生的换行符混用，导致括号计数出现偏差。

**解决方案：**
- 统一使用 `Get-Content` 读取 + `$lines -join "`r`n"` 写入
- 或在修改后始终运行 `git diff` 确认变更范围
- 修改完成后立即运行 `tsc --noEmit` 验证

### 2.2 正则表达式精确匹配失败

**问题：** 使用 `[regex]::Escape()` 做精确字符串替换时，由于缩进（空格 vs Tab）或注释差异导致匹配失败。

**失败表现：** `$content -replace [regex]::Escape($old), $new` 返回原字符串，无任何变更。

**解决方案：**
- 先使用 `Select-String` 定位精确行号
- 改用行号索引方式逐行替换，而非全文正则替换
- 对于大段代码替换，先 `git checkout` 恢复原文，再从头精确插入

### 2.3 括号/花括号计数遗漏

**问题：** 在修改 `ai.ts` 的 GET handler 时，删除了一行 `});` 以为它是"多余的"，但实际上它是闭合函数调用的必需符号。

**失败表现：** TypeScript 报 `TS1128: Declaration or statement expected`，因为 `});` 被误删导致函数调用未闭合。

**解决方案：**
- 修改前后始终用括号计数器验证：`[regex]::Matches($content, '\(')` 与 `[regex]::Matches($content, '\)')`
- 对于 `app.xxx()` 风格的注册函数，每增加一行 `app.` 调用，必须对应一个 `});` 闭合

### 2.4 变量作用域与声明顺序

**问题：** 在 `ai.ts` 的 PUT handler 中，先使用 `effectiveKey` 再声明它。

**失败表现：** `TS2448: Block-scoped variable 'effectiveKey' used before its declaration`

**解决方案：**
- 声明变量必须在首次使用之前
- 当需要调整代码顺序时，务必检查所有引用该变量的位置

### 2.5 前端适配后端 API 变更

**问题：** 后端新增 `providerKeyStatus` 字段后，前端 `AiConfig` 接口未同步更新。

**失败表现：** 前端 TypeScript 编译报错 `Property 'providerKeyStatus' does not exist on type 'AiConfig'`

**解决方案：**
- 前后端类型定义必须同步更新
- 后端新增响应字段时，前端 `types.ts` 必须对应添加

---

## 三、可抽象的固定流程与判断逻辑

### 3.1 配置变更标准流程

```
1. 确定变更范围（config.ts / routes/*.ts / types.ts / 前端组件）
2. 更新类型定义（types.ts）
3. 更新默认配置（config.ts defaultConfig()）
4. 更新配置加载/保存逻辑（config.ts loadConfig/saveAiConfig）
5. 更新 API 路由（routes/ai.ts GET/PUT）
6. 更新前端类型（karpathy-wiki/frontend/src/types.ts）
7. 更新前端组件（karpathy-wiki/frontend/src/views/Config.vue）
8. 运行 TypeScript 编译器验证（tsc --noEmit）
9. 运行 git diff 确认变更范围
```

### 3.2 API Key 管理判断逻辑

```
读取优先级：
  apiKeys[provider]  →  config.json.llm.apiKey  →  process.env[apiKeyRef]

写入规则：
  新 Key    →  存入 apiKeys[provider]
  空字符串  →  从 apiKeys 中删除该 provider 的 key
  ****开头  →  视为未修改，跳过写入

切换 Provider 时：
  前端清空 apiKey 输入框，提示用户输入新 key
  旧 provider 的 key 保留在 apiKeys 字典中，不会丢失
```

### 3.3 代码修改安全检查清单

```
□ 修改前后括号/花括号数量一致
□ 修改前后变量声明在使用之前
□ 前后端类型定义同步更新
□ TypeScript 编译器无报错
□ git diff 范围符合预期（无意外文件）
□ 配置文件无硬编码敏感信息（apiKey 已排除）
□ .gitignore 已排除 config.json
```

---

## 四、适用场景与不适用场景

### 4.1 本规范适用场景

- **多 LLM Provider 集成**：任何需要支持多个 AI 模型供应商的项目
- **配置驱动开发**：通过 config.json 管理应用行为的项目
- **前后端类型同步**：TypeScript 全栈项目
- **API Key 安全管理**：涉及敏感凭证存储和切换的场景
- **热更新配置**：无需重启服务即可生效的配置变更

### 4.2 本规范不适用场景

- **单 Provider 固定项目**：只需对接一个 LLM 供应商
- **纯静态配置**：配置在部署时确定，运行时不变更
- **非 TypeScript 项目**：无类型系统的语言（如纯 Python/Go）
- **硬编码密钥**：不使用 config.json 或环境变量管理密钥

---

## 五、技术标准

### 5.1 配置文件管理标准

| 标准项 | 要求 | 示例 |
|--------|------|------|
| 默认值 | 所有配置必须有 `defaultConfig()` 默认值 | `provider: 'deepseek'` |
| 加载合并 | 使用浅合并，嵌套对象需分别合并 | `{ ...defaults.llm, ...parsed.llm }` |
| 可选字段 | 使用条件合并避免 `string \| undefined` | `parsed.logging ? { ...defaults.logging, ...parsed.logging } : defaults.logging` |
| 敏感信息 | apiKey 不落盘或加密存储 | `config.json` 加入 `.gitignore` |
| 热加载 | 运行时参数变更无需重启 | `model/budget/staleDays` 可热更新 |

### 5.2 API 路由标准

| 标准项 | 要求 |
|--------|------|
| 路由注册 | `app.get/put/post('/api/xxx', async ...)` 后立即 `});` 闭合 |
| 错误处理 | 每个路由必须有 `try/catch`，返回统一错误格式 |
| 脱敏返回 | GET 接口返回 apiKey 时必须脱敏（`****xxxx`） |
| 适配器同步 | 配置变更后必须同步 `adapter.updateConfig()` |
| 幂等性 | PUT 接口应支持部分更新，未传字段保持不变 |

### 5.3 前端组件标准

| 标准项 | 要求 |
|--------|------|
| 类型导入 | 所有后端返回类型必须在 `types.ts` 中定义 |
| 表单隔离 | 编辑表单与只读状态分离（`aiForm` vs `aiConfig`） |
| 预设切换 | 切换 preset 时清空敏感字段（apiKey），保留非敏感字段 |
| 本地缓存 | 按预设 key 持久化到 localStorage，切换时恢复 |
| 错误提示 | 使用统一的 `apiErrorMessage()` 工具函数 |

### 5.4 编码风格标准

| 标准项 | 要求 |
|--------|------|
| 注释 | 关键逻辑必须加 `// 为什么需要：...` 注释 |
| 命名 | 函数名使用动词开头（`loadConfig`, `saveAiConfig`） |
| 缩进 | 统一 2 空格，不使用 Tab |
| 换行 | 统一 CRLF（Windows）或 LF（Linux/Mac），不混用 |
| 文件结尾 | 文件必须以换行符结尾 |

---

## 六、常见问题速查表

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| `TS1005: ')' expected` | 括号不匹配 | 用括号计数器验证 |
| `TS2448: used before declaration` | 变量先使用后声明 | 调整声明顺序 |
| `TS2339: property does not exist` | 前后端类型不同步 | 同步更新 types.ts |
| API Key 切换后丢失 | 单一字段存储 | 改用 apiKeys 字典 |
| 配置修改后不生效 | 未同步 adapter | 调用 `adapter.updateConfig()` |
| 前端表单残留旧值 | preset 切换未清空 | `aiForm.value.apiKey = ''` |
| config.json 被提交到 git | .gitignore 未排除 | 添加 `config.json` 到 `.gitignore` |
| 401 错误 | API Key 未正确加载 | 检查 `getEffectiveApiKey()` 优先级链 |
| 编译成功但运行时报错 | 类型定义与实际不符 | 检查运行时数据结构 |
| 热加载不生效 | 修改了需重启的字段 | 区分热更新字段和重启字段 |

---

## 七、配置迁移指南

### 7.1 旧配置 → 新配置

旧格式（单一 apiKey）：
```json
{ "llm": { "provider": "deepseek", "apiKey": "sk-xxx" } }
```

新格式（apiKeys 字典）：
```json
{
  "llm": {
    "provider": "deepseek",
    "apiKey": "sk-xxx",
    "apiKeys": {
      "deepseek": "sk-xxx",
      "glm": "sk-yyy"
    }
  }
}
```

迁移说明：
- 旧 `apiKey` 字段保留，作为向后兼容
- `getEffectiveApiKey()` 优先读取 `apiKeys[provider]`
- 保存配置时自动同步写入 `apiKeys` 字典
- 无需手动迁移，新旧格式共存

---

---

## 八、UI/UX 修复经验总结（2026-07-13）

### 8.1 对话框输入框背景黑框问题

**问题：** Query.vue 下方 textarea 背景为深色黑框，与页面整体主题化背景不协调。

**根因：** style.css 中 .el-textarea__inner 使用了硬编码深色值，未遵循 CSS 变量体系。

**修复：** 将 ackground: rgba(22, 10, 45, 0.3) 改为 ackground: rgba(255, 255, 255, 0.05) 并配合 !important 覆盖 Element Plus 默认样式。

**规范：**
- 所有全局样式修改必须优先使用 CSS 变量（ar(--bg-card), ar(--bg-glass) 等）
- 覆盖第三方组件样式时使用全局样式文件，避免在组件 <style scoped> 中硬编码颜色值
- 文本框背景应当跟随主题变化，不可使用固定深色值

### 8.2 左侧"新建会话"按钮灰色无法点击

**问题：** FloatingChat 组件中"新会话"按钮始终处于禁用状态。

**根因：** store.isLoading 状态在错误路径下未被正确重置，导致按钮 :disabled="store.isLoading" 永久禁用。

**修复：** 确保 eset() 函数中 isLoading.value = false 在所有路径下都被执行。

**规范：**
- 所有异步操作的 loading 状态必须在 inally 块或所有错误路径中重置
- 按钮的 :disabled 绑定条件应当审查其依赖的状态变量是否在所有场景下都能正确转换
- handleNewSession() 调用 store.reset() 后，确保 reset 包含 isLoading.value = false

### 8.3 对话历史记录为空

**问题：** 多次对话后，左侧对话历史栏无记录。

**根因：** persistConversation() 仅在消息非空时写入 IndexedDB，且 startNewConversation() 仅清空 currentConversationId 但不创建新记录。

**规范：**
- IndexedDB 操作必须处理 store unavailable 的降级场景
- 对话创建-保存-加载的完整链路需要在测试中覆盖

### 8.4 右上角模型下拉框为空

**问题：** ModelSelector 组件下拉框无选项，显示"模型服务不可用"。

**根因：** /api/ai/presets 接口在后端服务未运行时返回网络错误。

**规范：**
- 所有依赖后端数据的组件必须有 fallback UI（空状态提示）
- 模型预设加载失败时，应提供手动输入 model name 的备选方案
- loadError 必须在前端明确展示，不可静默失败

### 8.5 主题切换悬浮按钮集成

**问题：** 右下角悬浮主题切换按钮与页面风格不协调。

**修复：** 在 Config.vue 中使用 <ThemeSwitcher embedded />，将主题切换面板嵌入配置页面。

**规范：**
- ThemeSwitcher 组件支持 embedded prop：当 embedded=true 时，隐藏浮动 trigger 按钮，面板始终可见
- 悬浮按钮模式仅在全局工具栏场景使用，配置页面内必须使用 embedded 模式
- 组件 prop 契约必须在 TypeScript 类型中声明

### 8.6 "Failed to fetch" 错误信息优化

**问题：** 所有 API 调用失败时显示英文 "Failed to fetch"，用户不理解含义。

**根因：** 前端直接使用 error.message 展示给用户，未做网络错误检测和本地化。

**修复：** 建立统一的 piErrorMessage(action, error) 工具函数。

**规范：**
- 所有 etch() 调用必须使用 piErrorMessage() 或等效的友好错误处理
- 错误提示格式：${action}：后端服务未运行，请启动 karpathy-wiki.exe 后再试。
- 使用 ElMessage.error() / ElMessage.warning() 作为用户可见的错误反馈
- 网络错误不应显示技术细节，而应引导用户采取操作

### 8.7 构建系统注意事项

**构建命令：** cd karpathy-wiki/packages/web && npm run build（等价于 ue-tsc && vite build）

**输出路径：**
- 构建产物 -> ../../karpathy-wiki/api/public/（从 web package 相对路径）
- 部署路径 -> karpathy-wiki/dist/karpathy-wiki/public/

**PowerShell 编辑陷阱：**
- 模板字符串中的反引号在 PowerShell 中有特殊含义，使用 -replace 时需转义
- ${} 在双引号字符串中被解析为变量插值，需用单引号或 $script 块
- 文件写入后必须运行 	sc --noEmit 验证，不能仅依赖 git diff

### 8.8 跨文件协调修改清单

每次 UI/UX 修复需要同时检查的文件类型：
1. **CSS 变量**（style.css）- 全局样式调整
2. **Vue 组件**（iews/*.vue, components/*.vue）- 组件逻辑和模板
3. **工具函数**（utils/*.ts）- 错误处理、格式化等共享逻辑
4. **Store**（stores/*.ts）- 状态管理修正

---
*最后更新：2026-07-13*
*维护者：Karpathy-Wiki 开发团队*
# Wiki Frontend Code Review Skill

## 概述

前端代码审查规范，覆盖 Vue 3 + Element Plus + TypeScript 技术栈。审查重点围绕配置管理、数据安全、类型同步和用户体验。

---

## 一、审查流程

### 1.1 审查顺序

```
1. 类型定义检查（types.ts）
2. API 调用检查（fetch/axios）
3. 组件逻辑检查（<script setup>）
4. 模板检查（<template>）
5. 样式检查（<style scoped>）
6. 状态管理检查（stores/*.ts）
```

### 1.2 审查工具

- TypeScript 编译器：`tsc --noEmit -p packages/web/tsconfig.json`
- ESLint：`eslint packages/web/src/**/*.vue`
- 视觉检查：确保组件在不同主题下正常显示

---

## 二、审查要点

### 2.1 类型安全

| 检查项 | 标准 | 违规示例 |
|--------|------|----------|
| API 响应类型 | 所有 `fetch().json()` 结果必须类型声明 | `const data = await res.json()` ❌ |
| Props 类型 | 组件 props 必须使用 TypeScript 接口 | `props: ['name']` ❌ |
| Event 类型 | 自定义事件必须声明 payload 类型 | `$emit('update')` ❌ |
| 联合类型 | 状态字段使用联合类型而非 string | `status: string` ❌ |
| 可选字段 | 可选字段使用 `?` 而非 `|| default` | `config?.field ?? 'default'` ✅ |

### 2.2 配置管理

| 检查项 | 标准 | 原因 |
|--------|------|------|
| 预设切换 | 切换 preset 时必须清空 apiKey 输入框 | 防止旧 provider 的 key 被误用 |
| 本地缓存 | 按预设 key 持久化到 localStorage | 不同预设独立保存配置 |
| 脱敏显示 | GET 接口返回的 apiKey 必须脱敏 | 安全要求 M-7 |
| 默认值 | 表单字段必须有合理的默认值 | 避免 undefined 导致的运行时错误 |
| 配置同步 | 前端修改配置后必须调用后端 PUT 接口 | 确保服务端状态一致 |

### 2.3 API 调用

| 检查项 | 标准 | 违规示例 |
|--------|------|----------|
| 错误处理 | 每个 fetch 必须有 try/catch | `fetch(url).then(...)` ❌ |
| 状态码检查 | 必须检查 `res.ok` | `const data = await res.json()` 无检查 ❌ |
| 超时处理 | 长时间请求必须有超时控制 | 无 AbortController ❌ |
| 重试逻辑 | 网络错误应有重试机制 | 单次失败即报错 ❌ |
| SSE 流式 | SSE 连接必须有断开重连逻辑 | 无 error handler ❌ |

### 2.4 数据安全

| 检查项 | 标准 |
|--------|------|
| API Key 传输 | 绝不通过 URL 参数传递 apiKey |
| 本地存储 | localStorage 中的 apiKey 应为明文（用户主动输入），但不在控制台输出 |
| 表单验证 | apiKey 字段使用 `type="password"` |
| 脱敏回传 | 前端回传脱敏值（`****xxxx`）时，后端应视为未修改 |
| XSS 防护 | 动态渲染的内容使用 `v-html` 时需过滤 |

### 2.5 用户体验

| 检查项 | 标准 |
|--------|------|
| 加载状态 | 异步操作期间显示 loading spinner |
| 错误提示 | 使用 `ElMessage.error()` 而非 `console.error()` |
| 操作反馈 | 保存/提交成功后显示 success 消息 |
| 表单校验 | 必填字段为空时阻止提交并提示 |
| 快捷键 | 重要操作支持键盘快捷键 |

---

## 三、常见错误模式

### 3.1 类型不同步

**问题：** 后端新增字段后，前端 `AiConfig` 接口未更新。

**修复：** 后端类型变更后，立即同步更新前端 `packages/web/src/types.ts`。

### 3.2 状态泄漏

**问题：** 切换 preset 后，旧 provider 的 apiKey 残留在表单中。

**修复：** `applyPreset()` 中必须清空 `aiForm.value.apiKey = ''`。

### 3.3 异步竞态

**问题：** 快速连续点击保存按钮导致多次 PUT 请求。

**修复：** 使用 `savingAi.value = true` 禁用按钮，防止重复提交。

### 3.4 内存泄漏

**问题：** SSE 连接未正确关闭。

**修复：** 组件销毁时调用 `controller.abort()`。

---

## 四、审查结果呈现

### 4.1 严重级别

| 级别 | 符号 | 含义 | 示例 |
|------|------|------|------|
| P0 | 🔴 | 阻塞发布 | API Key 明文传输、类型不安全导致运行时崩溃 |
| P1 | 🟡 | 建议修复 | 缺少错误处理、脱敏不规范 |
| P2 | 🟢 | 优化建议 | 代码风格、注释缺失 |

### 4.2 审查报告模板

```markdown
## 前端代码审查报告

**文件：** `packages/web/src/views/Config.vue`
**审查人：** [姓名]
**日期：** YYYY-MM-DD

### 🔴 P0 问题（0）
无

### 🟡 P1 问题（2）
1. [L123] `applyPreset()` 未清空 apiKey 输入框 → 切换 preset 后旧 key 残留
2. [L456] fetch 请求缺少 try/catch → 网络错误时用户无反馈

### 🟢 P2 建议（3）
1. [L789] 添加注释说明配置持久化逻辑
2. [L1011] 使用常量替代魔法数字 `15000`
3. [L1213] 样式类名遵循 BEM 命名规范

### ✅ 通过项
- 类型定义与后端同步
- API Key 脱敏处理正确
- SSE 流式连接管理良好
```

---

## 五、适用与不适用场景

### 5.1 适用场景
- Vue 3 + TypeScript + Element Plus 项目
- 涉及 LLM 配置管理的页面
- 前后端类型同步要求高的项目
- 需要多预设切换的应用

### 5.2 不适用场景
- 纯 CSS/HTML 页面（无逻辑）
- 第三方库源码
- 自动生成代码（如 Vite 构建产物）
- 测试文件（使用单独的测试审查规范）

---

## 六、UI/UX 审查要点（2026-07-13 新增）

### 6.1 网络错误处理

| 检查项 | 标准 | 违规示例 |
|--------|------|----------|
| fetch 错误处理 | 所有 fetch 调用必须使用 piErrorMessage() 包装 | ElMessage.error(error.message) 直接显示技术错误 |
| 网络错误检测 | piErrorMessage() 必须检测 "Failed to fetch" / "NetworkError" / "ERR_CONNECTION" | 未覆盖常见网络错误关键词 |
| 用户引导 | 网络错误提示必须引导用户采取操作（如"请启动服务"） | 仅显示"连接失败"无操作指引 |
| ElMessage 使用 | 使用 ElMessage.error() / ElMessage.warning() / ElMessage.success() | 使用 console.error() 作为用户反馈 |

### 6.2 输入框/文本框样式

| 检查项 | 标准 |
|--------|------|
| 背景色 | 必须使用 CSS 变量或跟随主题的浅色值，不可硬编码深色 gba(22, 10, 45, 0.3) |
| 全局覆盖 | Element Plus 组件样式覆盖应在 style.css 中统一管理 |
| 主题适配 | 文本框 hover/focus 状态应有明确的视觉反馈 |

### 6.3 按钮禁用状态

| 检查项 | 标准 |
|--------|------|
| loading 状态重置 | 所有异步操作的 isLoading 必须在 inally 或所有错误路径中重置为 alse |
| disabled 依赖审查 | :disabled 绑定的状态变量必须确保在所有场景下都能正确转换 |
| 新会话按钮 | handleNewSession() 调用 store.reset() 后必须确保 isLoading = false |

### 6.4 组件 fallback UI

| 检查项 | 标准 |
|--------|------|
| 数据加载失败 | 依赖后端数据的组件必须有 fallback UI（空状态提示、错误提示） |
| ModelSelector | 预设加载失败时显示"模型服务不可用"，不可静默失败 |
| 降级方案 | 关键功能（如模型选择）应提供手动输入的备选方案 |

### 6.5 组件 prop 契约

| 检查项 | 标准 |
|--------|------|
| embedded prop | ThemeSwitcher 等组件的 embedded prop 必须在 TypeScript 类型中声明 |
| prop 默认值 | 使用 withDefaults(defineProps<...>(), { ... }) 设置默认值 |
| prop 使用一致性 | 组件使用时必须正确传递 prop（如 <ThemeSwitcher embedded />） |

### 6.6 状态管理审查

| 检查项 | 标准 |
|--------|------|
| reset 完整性 | store 的 eset() 必须重置所有相关状态（messages, isLoading, errorMessage） |
| IndexedDB 降级 | 持久化操作必须处理 store unavailable 的降级场景 |
| 对话生命周期 | startNewConversation -> selectConversation -> persistConversation 链路必须完整 |

### 6.7 审查工具扩展

除原有工具外，新增以下审查手段：
- **网络错误覆盖率检查**：搜索文件中所有 catch 块，确认是否使用 piErrorMessage()
- **样式变量一致性检查**：搜索 gba( 硬编码颜色值，确认是否应替换为 CSS 变量
- **状态重置完整性检查**：搜索 isLoading.value = true，确认对应的 alse 路径覆盖

---

*最后更新：2026-07-13*
---

*最后更新：2026-07-13*
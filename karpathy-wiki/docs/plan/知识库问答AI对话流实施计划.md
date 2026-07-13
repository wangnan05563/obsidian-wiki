# 知识库问答 AI 对话流 — 实施计划

| 字段 | 值 |
| --- | --- |
| 文档版本 | V1.0.1 |
| 编写日期 | 2026-07-11 |
| 修订日期 | 2026-07-11 |
| 编写人 | wiki-code-dev |
| 适用项目 | Karpathy AI + Obsidian 知识库（karpathy-wiki） |
| 需求基准 | 《知识库问答AI对话流需求规格说明书》v1.1.0 |
| 设计基准 | 《概要设计说明书》V1.0.1 + 《详细设计说明书》V1.0.1 |
| 范围 | v2 迭代的阶段划分、任务拆解、验证策略、风险控制 |
| 修订记录 | V1.0.1：按评审报告修正 P1-2/P1-4/P2-3 共 3 项问题 |

---

## 目录

1. [引言](#1-引言)
2. [实施阶段划分](#2-实施阶段划分)
3. [阶段一：基础设施搭建](#3-阶段一基础设施搭建)
4. [阶段二：后端扩展](#4-阶段二后端扩展)
5. [阶段三：前端核心组件](#5-阶段三前端核心组件)
6. [阶段四：前端高级功能](#6-阶段四前端高级功能)
7. [阶段五：集成与联调](#7-阶段五集成与联调)
8. [阶段六：测试与验收](#8-阶段六测试与验收)
9. [验证策略](#9-验证策略)
10. [风险控制](#10-风险控制)
11. [附录](#11-附录)

---

## 1. 引言

### 1.1 编写目的

本文档定义知识库问答 AI 对话流 v2 迭代的实施路径，覆盖阶段划分、任务拆解、验证策略与风险控制，作为开发执行的排期与跟踪依据。

### 1.2 实施原则

1. **自底向上**：先基础设施（依赖/类型/数据层）→ 后端 → 前端组件 → 集成
2. **持续验证**：每阶段结束前必须通过类型检查 + 编码检查
3. **增量交付**：每阶段产出可独立验证的功能切片
4. **不破坏 v1**：改造现有文件时保持向后兼容
5. **PowerShell 适配**：所有命令用分号分隔，不用 `&&`

### 1.3 环境约定

- 操作系统：Windows 10
- 终端：PowerShell
- 包管理：pnpm
- 镜像：淘宝镜像（`https://registry.npmmirror.com`）
- 编码：UTF-8 无 BOM

---

## 2. 实施阶段划分

### 2.1 阶段总览

| 阶段 | 名称 | 主要产出 | 依赖 |
| --- | --- | --- | --- |
| S1 | 基础设施搭建 | 依赖安装 + 类型扩展 + IndexedDB 初始化 | 无 |
| S2 | 后端扩展 | SSE 事件扩展 + web_search 工具 + query-workflow 改造 | S1 |
| S3 | 前端核心组件 | ThinkingBlock + ConversationSidebar + RefsList + FollowupsChips 改造 | S1 |
| S4 | 前端高级功能 | TTS + 多模态 + 模型切换 + 工具栏 + 消息操作 | S2 + S3 |
| S5 | 集成与联调 | Query.vue 重构 + 端到端 SSE 流 | S2 + S3 + S4 |
| S6 | 测试与验收 | Playwright E2E + 性能验证 + 编码门禁 | S5 |

### 2.2 里程碑

| 里程碑 | 交付物 | 验证标准 |
| --- | --- | --- |
| M1：基础设施就绪 | 类型 + 依赖 + IndexedDB | tsc 零错误 + 编码全 UTF-8 |
| M2：后端可联调 | SSE 扩展 + web_search | curl 验证 SSE 事件流 |
| M3：前端组件就绪 | 11 个组件 + 5 个 store | vue-tsc 零错误 |
| M4：功能集成完成 | Query.vue 重构 | 手工验证 13 项功能 |
| M5：验收通过 | E2E + 性能报告 | Playwright 100% 通过 |

---

## 3. 阶段一：基础设施搭建

### 3.1 任务清单

| 任务 ID | 任务 | 文件 | 说明 |
| --- | --- | --- | --- |
| S1-T1 | 安装前端依赖 | `packages/web/package.json` | 新增 `idb@^8.0.0` + `@vueuse/core@^10.0.0` |
| S1-T2 | 扩展前端类型 | `packages/web/src/types.ts` | 新增 Reference/ThinkingStep/ConversationRecord/Attachment |
| S1-T3 | 扩展后端类型 | `services/api/src/types.ts` | AnswerChunk 新增 thinking/image/progress 字段 |
| S1-T4 | 扩展 config.json | `services/api/src/config.ts` | 新增 llm.presets + webSearch + attachments 配置 |
| S1-T5 | IndexedDB 初始化 | `packages/web/src/stores/conversations.ts` | DB 创建 + 迁移函数 |

### 3.2 执行步骤

```powershell
# S1-T1：安装依赖
cd packages/web
pnpm add idb@^8.0.0 @vueuse/core@^10.0.0 --registry=https://registry.npmmirror.com
```

### 3.3 验证标准

- [ ] `pnpm install` 成功
- [ ] `npx tsc --noEmit` 零错误
- [ ] `node scripts/check-encoding.js` 全 UTF-8
- [ ] IndexedDB 在浏览器中可创建（手动验证）

---

## 4. 阶段二：后端扩展

### 4.1 任务清单

| 任务 ID | 任务 | 文件 | 说明 |
| --- | --- | --- | --- |
| S2-T1 | 新建 web-search 工具 | `services/api/src/tools/web-search.ts` | Tavily/Bing 搜索实现 |
| S2-T2 | 新建搜索路由 | `services/api/src/routes/search.ts` | POST /api/search/web |
| S2-T3 | 扩展 query-workflow | `services/api/src/workflows/query-workflow.ts` | 新增 thinking 推送 + web_search 注入 |
| S2-T4 | 扩展 query 路由 | `services/api/src/routes/query.ts` | 新增 SSE 事件发送 + 请求体扩展 |
| S2-T5 | 扩展 prompt | `services/api/src/prompts/query.md` | 新增 thinking 输出约定 |

### 4.2 执行步骤

```powershell
# 验证后端编译
cd services/api
npx tsc --noEmit
```

### 4.3 验证标准

- [ ] `tsc --noEmit` 零错误
- [ ] curl 验证 SSE 事件流：
  ```powershell
  curl -N -X POST http://localhost:3000/api/query -H "Content-Type: application/json" -d '{"question":"测试","history":[]}'
  ```
- [ ] curl 验证联网搜索：
  ```powershell
  curl -X POST http://localhost:3000/api/search/web -H "Content-Type: application/json" -d '{"query":"AI 资讯"}'
  ```

---

## 5. 阶段三：前端核心组件

### 5.1 任务清单

| 任务 ID | 任务 | 文件 | 说明 |
| --- | --- | --- | --- |
| S3-T1 | 新建 ThinkingBlock | `components/ThinkingBlock.vue` | 思考动画折叠块 |
| S3-T2 | 新建 ConversationSidebar | `components/ConversationSidebar.vue` | 历史对话侧栏 + 折叠 |
| S3-T3 | 新建 RefsList | `components/RefsList.vue` | 参考文章列表 |
| S3-T4 | 改造 FollowupsChips | `components/FollowupsChips.vue` | 纵向 → 横向 chip |
| S3-T5 | 改造 MarkdownRenderer | `components/MarkdownRenderer.vue` | 图片懒加载 + 代码块徽章 |
| S3-T6 | 新建 useConversationsStore | `stores/conversations.ts` | IndexedDB CRUD |
| S3-T7 | 改造 useQueryStore | `stores/query.ts` | 新增 thinking/progress 状态 |
| S3-T8 | 改造 useSSEStream | `composables/useSSEStream.ts` | 新增 thinking/image/progress 处理 |
| - | usePersistentState（沿用 v1） | `composables/usePersistentState.ts` | 通用 composable，无需改造，直接用于侧栏折叠状态持久化 |

### 5.2 验证标准

- [ ] `vue-tsc --noEmit` 零错误
- [ ] 每个组件可独立渲染（Storybook 风格手动验证）
- [ ] IndexedDB 读写正常

---

## 6. 阶段四：前端高级功能

### 6.1 任务清单

| 任务 ID | 任务 | 文件 | 说明 |
| --- | --- | --- | --- |
| S4-T1 | 新建 useTTS | `composables/useTTS.ts` | Web Speech API 封装 |
| S4-T2 | 新建 useClipboard | `composables/useClipboard.ts` | 剪贴板 + 降级 |
| S4-T3 | 新建 useImageCompress | `composables/useImageCompress.ts` | canvas 压缩 |
| S4-T4 | 新建 useTtsStore | `stores/tts.ts` | 朗读状态管理 |
| S4-T5 | 新建 useModelStore | `stores/model.ts` | 模型预设 + 切换（依赖 S2-T4：query 路由扩展支持 model 字段 + 后端 `/api/ai/config` PUT 端点） |
| S4-T6 | 新建 useAttachmentsStore | `stores/attachments.ts` | 图片附件管理 |
| S4-T7 | 新建 TtsController | `components/TtsController.vue` | 朗读控制按钮 |
| S4-T8 | 新建 MessageActions | `components/MessageActions.vue` | hover 浮窗（复制/朗读/重新生成/反馈） |
| S4-T9 | 新建 ModelSelector | `components/ModelSelector.vue` | 模型选择下拉框 |
| S4-T10 | 新建 InputToolbar | `components/InputToolbar.vue` | 工具栏 chip |
| S4-T11 | 新建 AttachmentUploader | `components/AttachmentUploader.vue` | 图片上传（粘贴/拖拽/点选） |

### 6.2 验证标准

- [ ] `vue-tsc --noEmit` 零错误
- [ ] TTS 在 Chrome 中可朗读
- [ ] 图片上传 + 压缩正常
- [ ] 模型切换生效

---

## 7. 阶段五：集成与联调

### 7.1 任务清单

| 任务 ID | 任务 | 文件 | 说明 |
| --- | --- | --- | --- |
| S5-T1 | 重构 Query.vue | `views/Query.vue` | 集成所有组件 + store + composables |
| S5-T2 | 端到端 SSE 流 | - | 验证 thinking → answer → refs → followups → done |
| S5-T3 | 历史对话持久化 | - | done 事件 → IndexedDB 写入 |
| S5-T4 | 侧栏折叠状态 | - | localStorage 持久化 |
| S5-T5 | 响应式适配 | - | 1280/1024/768 三断点验证 |

### 7.2 验证标准

- [ ] 发起问答，完整 SSE 事件流正常
- [ ] 历史对话新建/切换/删除/重命名/置顶均生效
- [ ] 侧栏三态切换 + 刷新保持
- [ ] 13 项功能手工验证通过

---

## 8. 阶段六：测试与验收

### 8.1 任务清单

| 任务 ID | 任务 | 说明 |
| --- | --- | --- |
| S6-T1 | Playwright E2E 用例编写 | 覆盖 13 项功能 |
| S6-T2 | 性能测试 | Markdown 渲染 50KB ≤ 30ms |
| S6-T3 | 兼容性测试 | Chrome/Edge/Firefox |
| S6-T4 | 编码门禁检查 | `node scripts/check-encoding.js` |
| S6-T5 | 类型检查 | tsc + vue-tsc 双零 |
| S6-T6 | SonarQube 扫描 | 0 新增 issue |
| S6-T7 | 更新 DELIVERY.md | 追加 §15 交付清单（含：新增文件清单 / 改造文件清单 / 验证结果 tsc+vue-tsc+编码+E2E+构建 / 已知问题与后续优化项） |

### 8.2 E2E 测试用例

| 用例 ID | 功能 | 操作 | 预期 |
| --- | --- | --- | --- |
| E2E-01 | F-3.1 思考动画 | 发起长问题 | 思考动画出现 |
| E2E-02 | F-3.2 流式渲染 | 发送含表格/代码块的回答 | 正确渲染 |
| E2E-03 | F-3.3 历史对话 | 新建 3 条 + 刷新 + 切换 | 持久化 |
| E2E-04 | F-3.4 工具栏 | 切换工具后发送 | mode 生效 |
| E2E-05 | F-3.5 多模态 | 粘贴 + 拖拽 + 点选图片 | 三种方式上传 |
| E2E-06 | F-3.6 TTS | 点击朗读 | 中文 voice |
| E2E-07 | F-3.7 复制 | hover + 点 3 种复制 | 格式正确 |
| E2E-08 | F-3.8 参考列表 | 触发联网搜索 | vault/web 区分 |
| E2E-09 | F-3.9 模型切换 | 切换 2 个模型 | 立即生效 |
| E2E-10 | F-3.10 互联网搜索 | 问"今日 AI 资讯" | 5s 内返回 |
| E2E-11 | F-3.11 侧栏折叠 | Ctrl+B | 250ms 折叠 |
| E2E-12 | F-3.12 联想提问 | 查看回答末尾 | 横向 chip |
| E2E-13 | F-3.13 消息操作 | 重新生成 + 反馈 | 符合预期 |

### 8.3 验收标准

| 项 | 要求 |
| --- | --- |
| TypeScript | 0 error（tsc + vue-tsc 双零） |
| 编码 | UTF-8 无 BOM（check-encoding.js 通过） |
| E2E | Playwright 13/13 通过 |
| 控制台 | 0 error 日志 |
| 构建 | `pnpm run build` 成功 |

---

## 9. 验证策略

### 9.1 每阶段验证清单

每阶段结束前必须执行：

```powershell
# 1. 类型检查
cd services/api; npx tsc --noEmit; cd ..\..
cd packages/web; npx vue-tsc --noEmit; cd ..\..

# 2. 编码检查
node scripts/check-encoding.js

# 3. 构建验证
Remove-Item -Recurse -Force "services\api\public" -ErrorAction SilentlyContinue
pnpm run build
```

### 9.2 集成验证

阶段五完成后执行端到端验证：

```powershell
# 启动服务
pnpm run dev

# 验证 SSE 流
curl -N -X POST http://localhost:3000/api/query `
  -H "Content-Type: application/json" `
  -d '{"question":"什么是 LLM Wiki","history":[],"webSearch":true}'
```

### 9.3 验收验证

阶段六完成后执行完整验收：

```powershell
# Playwright E2E
cd packages/web
npx playwright test

# 性能测试（浏览器 console）
# console.time('render'); markdownRenderer.render('50KB 文本'); console.timeEnd('render');
```

---

## 10. 风险控制

### 10.1 实施风险

| 风险 | 等级 | 缓解措施 |
| --- | --- | --- |
| idb 版本与浏览器不兼容 | 中 | S1 阶段优先验证 IndexedDB 创建 |
| Tavily API 限流 | 中 | S2 阶段实现 token bucket 限流 + 缓存 |
| Playwright 选择器变更 | 低 | S6 阶段统一更新选择器 |
| v1 改造破坏现有功能 | 高 | 改造文件保持向后兼容 + 每阶段回归测试 |
| pnpm install 网络超时 | 低 | 使用淘宝镜像 |

### 10.2 回滚策略

若某阶段失败：
1. 保留 v1 最后一次 commit 的 hash
2. `git reset --hard <v1-hash>` 回滚
3. 修复后重新执行该阶段

### 10.3 质量门禁

| 门禁 | 工具 | 阻塞级别 |
| --- | --- | --- |
| 类型检查 | tsc + vue-tsc | 阻塞（必须零错误） |
| 编码检查 | check-encoding.js | 阻塞（必须全 UTF-8） |
| E2E | Playwright | 阻塞（必须 100% 通过） |
| 构建 | pnpm run build | 阻塞（必须成功） |
| SonarQube | sonar-scanner | 非阻塞（记录 baseline） |

---

## 11. 附录

### 11.1 文件变更清单

| 操作 | 文件 | 阶段 |
| --- | --- | --- |
| 新增 | `packages/web/src/components/ThinkingBlock.vue` | S3 |
| 新增 | `packages/web/src/components/ConversationSidebar.vue` | S3 |
| 新增 | `packages/web/src/components/RefsList.vue` | S3 |
| 新增 | `packages/web/src/components/MessageActions.vue` | S4 |
| 新增 | `packages/web/src/components/ModelSelector.vue` | S4 |
| 新增 | `packages/web/src/components/InputToolbar.vue` | S4 |
| 新增 | `packages/web/src/components/AttachmentUploader.vue` | S4 |
| 新增 | `packages/web/src/components/TtsController.vue` | S4 |
| 改造 | `packages/web/src/components/FollowupsChips.vue` | S3 |
| 改造 | `packages/web/src/components/MarkdownRenderer.vue` | S3 |
| 改造 | `packages/web/src/views/Query.vue` | S5 |
| 改造 | `packages/web/src/stores/query.ts` | S3 |
| 新增 | `packages/web/src/stores/conversations.ts` | S3 |
| 新增 | `packages/web/src/stores/model.ts` | S4 |
| 新增 | `packages/web/src/stores/tts.ts` | S4 |
| 新增 | `packages/web/src/stores/attachments.ts` | S4 |
| 新增 | `packages/web/src/composables/useTTS.ts` | S4 |
| 新增 | `packages/web/src/composables/useClipboard.ts` | S4 |
| 新增 | `packages/web/src/composables/useImageCompress.ts` | S4 |
| 改造 | `packages/web/src/composables/useSSEStream.ts` | S3 |
| 改造 | `packages/web/src/types.ts` | S1 |
| 改造 | `packages/web/package.json` | S1 |
| 改造 | `services/api/src/types.ts` | S1 |
| 改造 | `services/api/src/routes/query.ts` | S2 |
| 新增 | `services/api/src/routes/search.ts` | S2 |
| 改造 | `services/api/src/workflows/query-workflow.ts` | S2 |
| 新增 | `services/api/src/tools/web-search.ts` | S2 |
| 改造 | `services/api/src/prompts/query.md` | S2 |
| 改造 | `services/api/src/config.ts` | S1 |
| 改造 | `DELIVERY.md` | S6 |

### 11.2 命令速查

```powershell
# 安装依赖
cd packages/web; pnpm add idb@^8.0.0 @vueuse/core@^10.0.0 --registry=https://registry.npmmirror.com

# 类型检查
cd services/api; npx tsc --noEmit
cd packages/web; npx vue-tsc --noEmit

# 编码检查
node scripts/check-encoding.js

# 构建
Remove-Item -Recurse -Force "services\api\public" -ErrorAction SilentlyContinue; pnpm run build

# E2E 测试
cd packages/web; npx playwright test

# 启动开发服务
pnpm run dev
```

### 11.3 修订历史

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| V1.0.0 | 2026-07-11 | 初版 |
| V1.0.1 | 2026-07-11 | 按评审报告修正：①S4-T5 补充依赖说明（P1-2）；②S6-T7 补充 DELIVERY.md 内容指引（P1-4）；③补充 usePersistentState 沿用说明（P2-3） |

---

## 阶段交接声明

- 当前阶段：实施计划 V1.0.0 ✅ 已完成
- 下一阶段：全面评审
- 下一阶段智能体：wiki-code-dev（评审）
- 下一阶段技能：wiki-code-dev
- 交接上下文：本文档将 v2 迭代拆解为 6 个阶段 + 30+ 任务，每阶段含验证标准与命令，可直接作为开发执行的跟踪依据。

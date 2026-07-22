# 知识库问答 AI 对话流 — 需求规格说明书

| 字段 | 值 |
| --- | --- |
| 文档版本 | v2.0.0 |
| 编写日期 | 2026-07-10 |
| 修订日期 | 2026-07-17 |
| 编写人 | wiki-code-dev |
| 适用项目 | Karpathy AI + Obsidian 知识库（karpathy-wiki） |
| 设计基线 | 《Karpathy-AI+Obsidian 知识库概要设计说明书》V1.3 §12.5（问答降级链 + 流式输出） |
| 上一版本交付 | DELIVERY.md §14：Markdown 渲染 + 联想提问（v1 已完成） |
| 范围 | 知识库问答（Query）页面全量升级，引入豆包 / Trae Work 级 AI 对话流能力 |
| 修订记录 | v1.1.0：按评审报告修正 3 项 P0 + 4 项 P1 + 4 项 P2 共 11 项问题<br>v1.1.1：补齐 P0-3 代码层（queryWithSearchFallback 降级链 + per-session Lock），关闭全部 P0 评审项<br>v2.0.0：升级为 v2 实施基线，把 §6.0 「v2 扩展点」全部转为正式需求，新增 §11 实施排期与模块拆分，关闭全部 v1 评审项 |

---

## 目录

1. [引言](#1-引言)
2. [总体描述](#2-总体描述)
3. [功能需求](#3-功能需求)
4. [非功能需求](#4-非功能需求)
5. [UI/UX 设计规范](#5-uiux-设计规范)
6. [技术架构](#6-技术架构)
7. [接口与数据结构](#7-接口与数据结构)
8. [验收标准](#8-验收标准)
9. [风险与依赖](#9-风险与依赖)
10. [附录](#10-附录)
11. [v2.0.0 实施排期与模块拆分](#11-v200-实施排期与模块拆分)

---

## 1. 引言

### 1.1 编写目的

本文档定义 Karpathy AI + Obsidian 知识库「知识问答」页面的全量升级需求，对标豆包（Doubao）、Trae Work、ChatGPT 等成熟 AI 对话产品的体验基线。文档面向：

- **开发人员**：作为 v2.0.0 实施的输入基线
- **UI/UX 设计师**：作为界面设计的参考依据
- **测试人员**：作为验收用例的来源
- **产品经理**：作为产品决策与排期的输入

### 1.2 项目背景

Karpathy Wiki 知识库已完成三个阶段的交付，其中知识问答模块（`frontend/src/views/Query.vue`）当前能力包括：

- SSE 流式输出 ✅（v0）
- 引用页面 refs 展示 ✅（v0）
- 答案归档（防篡改）✅（v0）
- Markdown 渲染 + 联想提问 ✅（v1 刚完成，交付清单见 DELIVERY.md §14）

但与豆包、Trae Work、ChatGPT 等成熟产品相比仍存在体验差距：

| 维度 | 现状（v1） | 行业基线（豆包 / Trae） | 差距 |
| --- | --- | --- | --- |
| 思考过程展示 | 无 | 折叠式 thinking 块（链式思考可视化） | 缺 |
| 工具栏 | 无 | 输入区上方 6-8 个快捷工具 | 缺 |
| 多模态 | 无 | 图片上传 + 图片理解 | 缺 |
| 语音 | 无 | 语音输入 + 语音朗读 TTS | 缺 |
| 历史对话 | 仅当次会话内存 | 持久化 + 侧栏列表 + 搜索 | 缺 |
| 模型切换 | 单模型（config.json） | UI 切换 + 多预设 | 缺 |
| 互联网搜索 | 无 | 实时联网 + 引用来源列表 | 缺 |
| 文本复制 | 选中复制 | hover 浮窗一键复制 | 缺 |
| 侧栏折叠 | 不支持 | 可折叠 + 状态持久化 | 缺 |

本说明书覆盖以上 9 项差距的功能规格，作为 v2.0.0 实施的工程依据。

### 1.3 对标产品

| 产品 | 核心对标能力 | 借鉴点 |
| --- | --- | --- |
| **豆包** | 历史侧栏、工具栏、流式图文混排、互联网搜索 | 侧栏布局、底部工具栏、搜索引用来源卡片 |
| **Trae Work** | 任务栏、上下文用量可视化、文件引用 | 上下文条、技能/工具分类、附件预览 |
| **ChatGPT** | thinking 折叠、模型切换、代码块操作 | 思考块、模型选择器、代码块 hover 工具条 |
| **Notion AI** | 文本选区操作、复制 / 重写 | 文本选区工具条、行内操作 |

### 1.4 术语定义

| 术语 | 定义 |
| --- | --- |
| **SSE** | Server-Sent Events，服务端推送，HTTP 长连接单向流 |
| **TTS** | Text-to-Speech，文本转语音，浏览器原生 `speechSynthesis` 或后端引擎 |
| **多模态** | 同时支持文本、图片、音频的输入输出 |
| **工具栏** | 输入框上方 / 周围的快捷工具 chip 区 |
| **思考动画** | AI 调用工具 / 思考中的可视化状态（脉动 / 跳跃 dots） |
| **持久化** | 数据写入本地存储（localStorage / IndexedDB / 文件系统） |
| **Macaron 主题** | 项目现有主题，淡粉 + 淡青主色，圆角，玻璃风 |

### 1.5 范围与目标

#### 1.5.1 范围内（v2.0.0 必须）

- 13 项核心功能（详见第 3 章）
- 前后端接口与状态管理改造
- UI 重构（侧栏 + 工具栏 + 消息体）

#### 1.5.2 范围外（v2.0.0 不做）

- 移动端响应式深度优化（仅做基本可用）
- 视频生成 / PPT 生成（豆包深度工具，不在 v2.0.0 范围）
- 协同 / 多用户共享对话
- 对话数据云同步

#### 1.5.3 目标量化指标

性能量化指标统一定义在 §4.1「性能」中，此处不重复，避免验收歧义。

---

## 2. 总体描述

### 2.1 产品定位

**一句话定位**：面向本地知识库研究者的下一代 AI 对话工作台。

**价值主张**：
- 比 ChatGPT 更懂你的个人 / 团队知识库
- 比豆包更懂本地隐私与离线场景
- 比 Trae Work 更轻量、更聚焦问答

### 2.2 用户角色与使用场景

#### 2.2.1 用户角色

| 角色 | 描述 | 核心诉求 |
| --- | --- | --- |
| **研究者** | 个人 / 团队的知识管理重度用户 | 快速找到 2 周前读过的某条知识 |
| **开发者** | 用 wiki 作为 LLM 上下文 | 把 LLM 推理过程可视化、复现 |
| **学习者** | 用 wiki 学习某个领域 | 多模态（图表 / 视频）辅助理解 |
| **讲师** | 备课 / 答疑 | 朗读 + 复制粘贴到 PPT |

#### 2.2.2 核心使用场景

| 场景 | 描述 | 涉及功能 |
| --- | --- | --- |
| **S1：研究复盘** | 翻看 2 周前关于 LLM Wiki 的对话 | 历史侧栏 + 搜索 + 引用列表 |
| **S2：图文问答** | 截一张图问「这是什么图表」 | 图片上传 + 多模态理解 + 流式回答 |
| **S3：听答案** | 通勤时听 AI 朗读知识库答案 | 语音 TTS + 自动断句 |
| **S4：复制引用** | 看到一段好答案，复制到 Notion | hover 复制 + 格式化粘贴 |
| **S5：模型实验** | 同一问题，对比 deepseek 与 glm | 模型切换 + 并排 / 时序对比 |
| **S6：实时资讯** | 问「AI Token 产业最新动态」 | 互联网搜索 + 引用来源卡片 |
| **S7：空间紧张** | 投屏 / 小窗口，侧栏占太多空间 | 侧栏折叠 + 状态记忆 |

### 2.3 运行环境

| 项 | 要求 |
| --- | --- |
| 浏览器 | Chrome ≥ 100 / Edge ≥ 100 / Firefox ≥ 100（Web Speech API、Stream API、Fetch ReadableStream 全部支持） |
| 屏幕宽度 | ≥ 1024px（桌面端主用），≥ 768px（基本可用） |
| 网络 | 局域网（localOnly 默认） |
| 操作系统 | Windows 10/11、macOS 12+、Linux（与现有启动脚本兼容） |
| Node.js | ≥ 18（与 LLM API 兼容） |

### 2.4 设计原则

| 原则 | 说明 |
| --- | --- |
| **P1：流式优先** | 所有长操作（问答、搜索、TTS）必须有流式反馈，零白屏 |
| **P2：本地优先** | 所有数据本地化，对话历史存本地，模型 API Key 不外发 |
| **P3：可降级** | TTS 不可用 → 静默降级为文字；多模态不支持 → 提示用户；搜索失败 → 仅返回知识库 |
| **P4：可解释** | 思考过程、引用来源、工具调用全部可视化 |
| **P5：键盘友好** | Ctrl+Enter 发送、Ctrl+K 聚焦输入、Esc 取消生成、↑ 编辑上一条 |
| **P6：玻璃风统一** | 沿用 macaron 主题的玻璃质感 + 霓虹光晕 |

---

## 3. 功能需求

> 每项功能遵循以下结构：**F-X.X 名称 → 描述 → 输入 → 处理 → 输出 → 错误处理 → 验收标准**。

### F-3.1 思考动画

#### 描述
当 AI 正在处理（调用工具、等待 LLM 首字节、思考下一步）时，展示可视化的思考动画，让用户感知「AI 在工作」。

#### 三种状态
1. **加载态**（首字节前）：3 个圆点脉动 + 「正在思考…」文案
2. **工具调用态**（如调用 search_pages）：展示当前调用工具的名称与参数缩略（如「正在搜索：LLM Wiki」）
3. **流式输出态**（首字节后）：气泡脉动光晕，文字逐字显现

#### 输入
- 后端 SSE `thinking` 事件：`{ phase: 'thinking' | 'tool_call' | 'composing', message: string, tool?: string }`
- 前端 store 中 `isLoading` 状态

#### 处理
- 监听 SSE `thinking` 事件，更新 `currentThinking` ref
- 三态自动切换：`isLoading && !streamingAnswer` → loading；`currentThinking.tool` → tool；`streamingAnswer` → streaming
- 动画使用 CSS keyframes，不引入额外动画库

#### 输出
- assistant 气泡头部出现思考块（可折叠 / 默认展开）
- 折叠态：显示「已思考 3 步 · 搜索 2 次 · 阅读 1 页」
- 展开态：逐步列表展示思考日志

#### 错误处理
- SSE 中断 → 思考块显示「连接中断」徽章，点击重试

#### 验收标准
- [ ] 首字节延迟 ≥ 1s 时，loading 动画立即出现
- [ ] 工具调用名称在动画中可见
- [ ] 折叠/展开过渡 ≤ 200ms
- [ ] 动画不卡顿（60 FPS，CPU 占用 < 5%）

---

### F-3.2 流式输出与格式化渲染

#### 描述
保留 v1 已实现的 Markdown 流式渲染，并扩展支持：
- 图片渲染（`<img>`）
- 表格玻璃质感优化
- 代码块语言识别 + 行号
- Mermaid 图表（可选）

#### 输入
- 后端 SSE `answer` 事件：流式 Markdown 文本片段

#### 处理
- markdown-it 增量渲染（每次 content 变化重渲染 computed）
- 代码块检测语言（`js / ts / py / bash / json`），无高亮但有语言徽章
- 图片懒加载 + 点击放大（Element Plus `el-image` 预览）

#### 输出
- assistant 气泡内：完整 Markdown 渲染
- 图片：玻璃边框 + 点击放大查看
- 表格：玻璃风 + 斑马纹

#### 错误处理
- LLM 输出非法 Markdown → 降级为纯文本渲染
- 图片 URL 404 → 占位符「图片加载失败」

#### 验收标准
- [ ] 50KB Markdown 渲染 ≤ 30ms
- [ ] 图片懒加载：滚动到视口才加载
- [ ] 代码块语言徽章显示
- [ ] 流式过程中不出现"闪屏"或"跳动"

---

### F-3.3 历史对话管理

#### 描述
将所有问答会话持久化到本地存储（localStorage + IndexedDB），在左侧栏列表化展示，支持搜索、重命名、删除、置顶。

#### 数据模型
```typescript
interface Conversation {
  id: string;              // sessionId
  title: string;           // 首个问题前 30 字
  createdAt: string;       // ISO 8601
  updatedAt: string;
  messageCount: number;
  isPinned: boolean;
  preview: string;         // 末条 assistant 回答前 60 字
}
```

#### 输入
- 用户操作：新建、切换、重命名、删除、置顶、搜索

#### 处理
- 持久化：每轮问答 `done` 事件时写入 IndexedDB（结构化）+ localStorage（轻量索引）
- 列表渲染：按 `updatedAt` 倒序，置顶项置顶
- 搜索：标题模糊匹配（不搜索消息内容，避免性能问题）

#### 输出
- 左侧栏列表：每项显示标题、时间、置顶图标
- 切换：加载会话到主区域，不影响 store

#### 错误处理
- 存储满 → 提示用户清理旧对话
- 加载失败 → 显示空状态「暂无历史对话」

#### 验收标准
- [ ] 新建对话后 100ms 内出现在侧栏
- [ ] 100 条历史对话搜索响应 ≤ 50ms
- [ ] 重命名 / 删除 / 置顶均生效且持久化
- [ ] 切换对话不丢失未发送的输入

---

### F-3.4 输入工具栏

#### 描述
输入框上方固定一行 chip 形式的工具栏，提供 7 类常用能力入口（仿豆包）。

#### 工具清单
| 工具 | 图标 | 行为 |
| --- | --- | --- |
| **快速** | ⚡ | 展开 4-6 个预设 Prompt 模板（如「总结这篇」「提取关键概念」） |
| **帮我写作** | ✍ | 切换为「写作模式」，自动追加写作 prompt 前缀 |
| **PPT 生成** | 📊 | 标记当前对话为 PPT 生成任务（v2.0.0 仅做标记，生成留 v3） |
| **图像生成** | 🎨 | 调用多模态模型生成图片（依赖 model 能力） |
| **视频生成** | 🎬 | 标记视频生成任务（v2.0.0 仅做标记） |
| **翻译** | 🌐 | 切换为「翻译模式」 |
| **更多** | ⋯ | 折叠次要工具（联网搜索、深度思考等） |

#### 输入
- 鼠标点击 / 键盘聚焦

#### 处理
- 选中后，工具栏 chip 变为「激活」态
- 工具作为 SSE 请求的 `mode` 字段传递（后端暂不处理 PPT/视频生成，仅 UI 标记）
  - `mode: 'fast' | 'write' | 'ppt' | 'image' | 'video' | 'translate'`
  - PPT/视频生成：v2.0.0 仅在请求体追加 `mode` 字段，后端不执行实际生成，留 v3 实现

#### 输出
- 工具栏 chip 高亮
- 后续问答自动应用工具上下文

#### 错误处理
- 工具依赖能力缺失 → 灰显 + tooltip「当前模型不支持」

#### 验收标准
- [ ] 工具栏 hover 有动效（玻璃光泽滑动）
- [ ] 选中态与未选中态视觉差异明显
- [ ] 键盘可达（Tab 聚焦 + Enter 触发）
- [ ] 移动端工具栏可横滑

---

### F-3.5 多模态：图片上传与理解

#### 描述
支持用户上传图片（粘贴 / 拖拽 / 点选），AI 识别图片内容并结合知识库回答。

#### 输入
- 单张图片，格式：jpg / png / webp / gif
- 大小限制：≤ 10MB
- 方式：剪贴板粘贴 / 拖拽到输入框 / 点击图片图标选择

#### 处理
- 前端：上传前压缩到 ≤ 2MB（canvas）
- 后端：base64 传入 LLM 适配器（`vision` 能力）
- 存储：原图 + 缩略图都保存到 `vault/queries/attachments/{sessionId}/{imageId}.{ext}`
- 消息体：图片作为消息内容的 `attachments` 字段

#### 输出
- 用户消息气泡显示缩略图
- assistant 消息可引用图片（`<img src="attachment://imageId">`）
- 附件列表：可下载、预览

#### 错误处理
- 格式不支持 → 提示「仅支持 jpg/png/webp/gif」
- 大小超限 → 自动压缩；压缩后仍超限 → 拒绝
- LLM 无 vision 能力 → 提示「当前模型不支持图片理解」

#### 验收标准
- [ ] 剪贴板粘贴立即出现缩略图
- [ ] 拖拽到输入框触发上传
- [ ] 缩略图 ≤ 200x200，原图可点击放大
- [ ] LLM 回复中能正确引用图片内容

---

### F-3.6 语音朗读（TTS）

#### 描述
assistant 回答渲染完成后，用户可点击朗读按钮，让浏览器朗读完整答案。

#### 输入
- assistant 消息体的 Markdown 渲染后纯文本
- 用户控制：开始 / 暂停 / 停止 / 调速

#### 处理
- 使用浏览器原生 `window.speechSynthesis`（Web Speech API）
- 文本预处理：剥离 Markdown 语法（`**` / `#` / `[]()` 等）
- 中文自动选 `zh-CN` voice，英文选 `en-US`
- 默认语速 1.0x，可调 0.5x - 2.0x

#### 输出
- 朗读按钮：未朗读 → 🔊；朗读中 → ⏸；已暂停 → ▶
- 朗读时气泡背景脉动（视觉提示）
- 朗读完成 → 自动恢复 🔊 状态

#### 错误处理
- 浏览器不支持 `speechSynthesis` → 按钮灰显 + tooltip「当前浏览器不支持语音朗读」
- 语音引擎加载失败 → 提示「请安装中文语音包」

#### 验收标准
- [ ] 中文回答自动选中文语音
- [ ] 朗读过程中可暂停 / 继续
- [ ] 切换到下一条消息自动停止当前朗读
- [ ] Markdown 语法不被朗读

---

### F-3.7 文本复制

#### 描述
提供 hover 浮窗一键复制 assistant 回答的纯文本或 Markdown 源码。

#### 三种复制
1. **复制纯文本**（默认）：去除 Markdown 语法，纯净文本
2. **复制 Markdown 源码**：保留格式
3. **代码块复制**：每个代码块右上角独立复制按钮

#### 输入
- assistant 消息 hover

#### 处理
- 鼠标 hover 消息 → 右上角浮窗淡入（3 个图标：复制纯文本 / 复制 MD / 朗读）
- 点击复制 → 调 `navigator.clipboard.writeText()` + Toast 提示「已复制」
- 代码块右上角独立 hover 出现「复制」按钮

#### 输出
- 剪贴板内容（纯文本或 MD）
- Toast 提示
- 按钮 hover 动效

#### 错误处理
- 剪贴板 API 不可用（非 HTTPS）→ 降级为 `document.execCommand('copy')`
- 复制失败 → 提示「复制失败，请手动选择」

#### 验收标准
- [ ] hover 浮窗 200ms 内出现
- [ ] 复制纯文本去除所有 Markdown 符号
- [ ] 复制 MD 源码格式与渲染一致
- [ ] 代码块复制仅复制代码内容

---

### F-3.8 参考文章列表

#### 描述
将 v1 已有的「REFS: chips」升级为完整的「参考文章列表」卡片，仿豆包的"搜索 N 个关键词，参考 N 篇资料"。

#### 数据结构
```typescript
interface Reference {
  url?: string;            // 联网搜索时的来源 URL
  title: string;           // 页面标题或文章标题
  path?: string;           // 知识库页面路径
  snippet: string;         // 摘要
  source: 'vault' | 'web'; // 来源类型
  citeIndex: number;       // [1][2][3] 引用编号
}
```

#### 输入
- 后端 SSE `refs` 事件：`{ refs: Reference[] }`

#### 处理
- 列表渲染：每个 ref 卡片含「编号 / 标题 / 摘要 / 来源徽章」
- vault 来源：点击跳转到知识库浏览页
- web 来源：点击新窗口打开 URL
- assistant 回答中可内嵌引用编号 `[1]` 链接到对应卡片

#### 输出
- assistant 消息尾部「搜索 3 个关键词，参考 17 篇资料」横条
- 下方折叠式 ref 卡片列表（默认展开前 3 条，其余折叠）
- 引用编号：assistant 文本中 `[1]` 为可点击锚点

#### 错误处理
- ref 为空 → 隐藏整个区块
- URL 失效 → 显示但点击不跳转，徽章「已失效」

#### 验收标准
- [ ] 17 条 ref 卡片渲染 ≤ 300ms
- [ ] 引用编号点击跳转到对应 ref 卡片
- [ ] vault / web 来源视觉区分
- [ ] 折叠/展开交互流畅

---

### F-3.9 模型切换

#### 描述
UI 上提供模型选择器，允许用户在已配置的 LLM 预设之间切换（不需重启服务）。

#### 数据源
- 后端 `GET /api/ai/presets` 返回已配置的 LLM 预设列表
- 配置路径：`config.json.llm.presets[]`（v2 新增）

#### 输入
- 用户选择模型

#### 处理
- 切换时：写 localStorage `selectedModel` 字段
- 后续 SSE 请求自动带 `model` 字段
- 后端调用 `engineAdapter.updateConfig({ model })` 即时生效（现有实现已支持，见 §6.0.3），**无需路由到对应适配器**
- 切换前检查 `useQueryStore.isLoading`，若有 in-flight 问答则等待 done/error 后再切换（见 §9.1 风险 R8）

#### 输出
- 顶部模型选择器下拉框
- 切换后立即生效（新一条问答开始）
- 切换 Toast 提示「已切换到 deepseek-v3」

#### 错误处理
- 选定模型 API Key 未配置 → 提示「请先在配置页配置 API Key」
- 切换失败 → 回滚到上一个模型

#### 验收标准
- [ ] 模型列表显示已配置的预设
- [ ] 切换后第一条问答即生效
- [ ] 切换 Toast 200ms 内出现
- [ ] 状态持久化（刷新页面后保持）

---

### F-3.10 互联网搜索工具

#### 描述
允许 AI 在回答时调用互联网搜索 API，扩展知识库以外的实时信息。

#### 触发方式
- 用户在工具栏点击「联网搜索 🔍」chip
- 或 AI 自主判断（prompt 中显式约定）

#### 输入
- 搜索关键词（AI 自动从用户问题提取）

#### 处理
- 后端新增工具 `web_search(query, limit=5)`
- 实现层：v2 调用 Tavily / Bing Search API（可配置 provider）
- 结果合并到 assistant 回答中（标 `source: 'web'`）

#### 输出
- 与 vault refs 统一展示
- 联网来源标蓝色徽章「WEB」

#### 错误处理
- 搜索 API Key 未配置 → 提示「请先在配置页配置搜索 API Key」
- 搜索超时（>5s）→ 仅返回 vault 结果 + Toast「联网超时」
- 搜索失败 → 同上 + 错误详情

#### 验收标准
- [ ] 联网搜索结果 5s 内返回
- [ ] vault / web 来源视觉区分
- [ ] 联网超时降级优雅
- [ ] 搜索结果摘要可点击跳转原 URL

---

### F-3.11 历史对话侧栏折叠

#### 描述
侧栏可折叠为图标条（仅显示头像）或完全隐藏（仅显示展开按钮），状态持久化。

#### 三态
1. **展开**：宽 280px，显示完整侧栏（与 v1 类似）
2. **折叠**：宽 60px，仅显示头像 + 工具图标
3. **隐藏**：宽 0，仅顶部显示展开按钮

#### 输入
- 顶部切换按钮 / 快捷键 Ctrl+B

#### 处理
- 切换状态写 localStorage
- 主区域宽度自适应（CSS Grid / flex）
- 折叠动画 ≤ 250ms

#### 输出
- 侧栏宽度过渡动画
- 主区域内容平滑重排
- 切换按钮图标随状态变化

#### 错误处理
- 状态读写失败 → 默认展开

#### 验收标准
- [ ] 切换动画 ≤ 250ms
- [ ] 状态刷新后保持
- [ ] 折叠态仍可新建对话
- [ ] Ctrl+B 快捷键生效

---

### F-3.12 联想提问（v1 已实现，v2 微调）

#### 描述
保留 v1 已实现的"继续追问"chips，做以下微调：
- 位置：从消息底部移到引用列表上方
- 样式：横向 chip（v1 纵向按钮），节省纵向空间
- 交互：hover 显示「点击继续追问」tooltip

#### 输入
- 后端 SSE `followups` 事件：`{ followups: string[] }`

#### 处理
- 解析同 v1
- 横向 chip 排列，超出滚动

#### 输出
- 3 个以内横向 chip
- hover 高亮 + tooltip

#### 错误处理
- 无 followups → 不显示

#### 验收标准
- [ ] 横向 chip 不换行（允许横向滚动）
- [ ] hover tooltip 200ms 内出现
- [ ] v1 的底部纵向按钮样式不再显示（位置已迁移到引用列表上方）

---

### F-3.13 消息操作（新增整合）

#### 描述
对单条 assistant 消息，提供 4 类操作：复制 / 朗读 / 重新生成 / 反馈。

| 操作 | 行为 |
| --- | --- |
| 复制 | 同 F-3.7 |
| 朗读 | 同 F-3.6 |
| 重新生成 | 复用该消息对应的 user 问题，重新发起问答 |
| 👍 / 👎 | 反馈到本地（v2.0.0 仅本地存储，后续可云端） |

#### 输入
- assistant 消息 hover / 点击操作按钮

#### 处理
- 重新生成：保留原 user 消息，丢弃原 assistant 回答，触发新问答
- 反馈：写 localStorage，提示「感谢反馈」

#### 输出
- 消息操作栏（hover 浮窗）
- 反馈 Toast

#### 错误处理
- 重新生成时已有加载 → 拒绝并提示

#### 验收标准
- [ ] 4 个操作均可触达
- [ ] 重新生成产生新 sessionId（归档时新条目）
- [ ] 反馈持久化

---

## 4. 非功能需求

### 4.1 性能

| 指标 | 目标 |
| --- | --- |
| 首屏加载 | ≤ 1.5s（包含 50 条历史对话） |
| 流式 chunk 端到端延迟 | ≤ 200ms（4G 局域网） |
| 切换历史对话 | ≤ 100ms |
| Markdown 渲染（50KB） | ≤ 30ms |
| 工具栏 hover 响应 | ≤ 50ms |
| 侧栏折叠动画 | ≤ 250ms |

### 4.2 兼容性

| 项 | 要求 |
| --- | --- |
| 浏览器 | Chrome ≥ 100、Edge ≥ 100、Firefox ≥ 100、Safari ≥ 15 |
| 屏幕 | 1024px+ 桌面优先；768px-1024px 可用；<768px 仅阅读 |
| Node.js | ≥ 18 |
| pnpm | ≥ 8 |

### 4.3 安全性

| 项 | 实现 |
| --- | --- |
| API Key | 仅存后端 config.json，前端永远不持有 |
| 用户输入 | Markdown 渲染开启 `html: false`，防 XSS |
| 图片上传 | 后端校验 MIME + 文件头魔数 |
| 互联网 URL | 跳转加 `rel="noopener noreferrer"` |
| 历史对话 | 仅存本地，不上传 |
| TTS | 不上传语音到任何服务（纯本地 Web Speech API） |

### 4.4 可用性

| 项 | 实现 |
| --- | --- |
| 键盘可达 | 所有交互均支持 Tab + Enter |
| 屏幕阅读器 | aria-label 完整，message role 标注 |
| 错误提示 | Toast + 内联提示双通道 |
| 加载反馈 | 流式 / loading / 错误三态明确区分 |
| 国际化 | 中英双语 key（v2.0.0 仅中文，文案外置） |

### 4.5 可维护性

| 项 | 实现 |
| --- | --- |
| 组件化 | 每个功能独立 Vue 组件 + 单一职责 |
| 类型严格 | 全部 TypeScript strict，0 `any` |
| 编码规范 | UTF-8 无 BOM（沿用 v1 编码门禁三层防御：pre-commit hook + .gitattributes + CI 门禁 + `scripts/check-encoding.js`） |
| 测试 | 关键路径 Playwright E2E 覆盖 |
| 日志 | 后端 .harness/logs/ + 前端 console（按级别） |

---

## 5. UI/UX 设计规范

### 5.1 整体布局

```
┌─────────────────────────────────────────────────────────────────────┐
│  ☰  Logo  知识库问答  [AI 生成内容可能存在错误]   模型▼  🌐  ⋯  ⛶    │  ← 顶部条（高 56px）
├──────────┬──────────────────────────────────────────────────────────┤
│          │  ┌────────────────────────────────────────────────────┐ │
│ 🔍 Ctrl+K│  │  📌  会话标题：AI Token 产业链  [重命名] [📌] [×]  │ │  ← 会话头
│          │  │  搜索 3 个关键词，参考 17 篇资料                          │
│  + 新建   │  ├────────────────────────────────────────────────────┤ │
│  💼 任务  │  │                                                    │ │
│  🔍 浏览  │  │  [RobotAvatar]  LLM Wiki 是一种...                   │ │
│  ✨ 技能  │  │  ## 核心架构                                       │ │
│          │  │  - [[harness]] ...                                  │ │
│  历史对话  │  │  - [[vault]] ...                                   │ │
│ ────────  │  │  > 引用块...                                       │ │
│  ▪ 会话1  │  │  ```ts 代码块... ```                                │ │
│  ▪ 会话2  │  │  [📋] [🔊] [🔄] [👍] [👎]                           │ │
│  ▪ 会话3  │  │                                                    │ │
│  ...      │  │  REFS: [1] [2] [3]                                 │ │
│          │  │  ─────────────────────────────────                  │ │
│          │  │  💭 你可能想问：[LLM Wiki 如何保证质量？] [...]       │ │
│          │  │                                                    │ │
│          │  │  [UserAvatar]  什么是 LLM Wiki？                   │ │
│          │  │                                                    │ │
│          │  ├────────────────────────────────────────────────────┤ │
│ ⚙  设置  │  │  工具栏: ⚡快速  ✍写作  📊PPT  🎨图像  🌐翻译  ⋯更多  │ │  ← 工具栏
│          │  ├────────────────────────────────────────────────────┤ │
│          │  │  ┌──────────────────────────────────────┐  [📎] [🎤]│ │  ← 输入区
│          │  │  │ 输入问题，Ctrl+Enter 发送...           │  [⏎ 发送]│ │
│          │  │  └──────────────────────────────────────┘            │ │
│          │  └────────────────────────────────────────────────────┘ │
├──────────┴──────────────────────────────────────────────────────────┤
│  POWERED BY KARPATHY AI · 知识库引擎 · v1.0.0                          │  ← 底部条（高 32px）
└─────────────────────────────────────────────────────────────────────┘

侧栏可折叠：
- 展开 280px
- 折叠 60px（仅图标）
- 隐藏 0px（仅显示 [>] 按钮）
```

### 5.2 视觉规范

| 元素 | 规范 |
| --- | --- |
| **主色** | 沿用 macaron.css：淡粉 `#FFD6E0` + 淡青 `#B5EAD7` + 紫色 `#C7B8EA` |
| **强调色** | 霓虹青 `var(--neon-cyan)`（标题、引用编号） |
| **背景** | 玻璃质感 `rgba(0, 245, 255, 0.06)` + `backdrop-filter: blur(20px)` |
| **圆角** | 气泡 20px、按钮 12px、chip 16px、卡片 16px |
| **字体** | 中文：思源黑体；英文：Inter；等宽：JetBrains Mono |
| **字号** | 标题 22px / 正文 14px / 引用 13px / 注释 12px |
| **阴影** | 玻璃 0 8px 32px rgba(0,0,0,0.1)；发光 0 0 20px var(--neon-cyan) |
| **动效** | 玻璃光泽 300ms ease；脉动 1.5s ease-in-out infinite；hover 升起 200ms |

### 5.3 交互规范

| 交互 | 反馈 |
| --- | --- |
| hover | 玻璃光泽滑动 + 边框高亮 |
| click | 按下缩放 0.98 + 涟漪 |
| 加载 | 脉动 dots + 「正在思考…」文案 |
| 完成 | 绿色 checkmark 闪烁一次 |
| 错误 | 红色边框 + 抖动 + 错误 Toast |
| 折叠 | 250ms 缓动 + 主区域自适应 |

### 5.4 响应式

| 断点 | 行为 |
| --- | --- |
| ≥ 1280px | 完整布局 |
| 1024-1280px | 侧栏默认折叠 |
| 768-1024px | 侧栏默认隐藏，仅主区域 |
| < 768px | 仅阅读模式，输入区禁用（v2.0.0 不做深度适配） |

---

## 6. 技术架构

### 6.0 现有架构继承（v1 基线）

v2.0.0 实施必须继承 v1 已落地的三项核心架构机制，不得绕过或重新设计：

#### 6.0.1 降级链机制

源自《概要设计说明书》V1.3 §12.5，**v1.1.1 已实施**，代码位于 `api/src/workflows/query-workflow.ts`：

```
queryWorkflow（编排器）
  ├─ queryWithHarness（首选，走 @wiki/harness ReAct 循环）
  │     ↓ catch（harness.run 抛错或 yield 异常）
  ├─ queryWithSearchFallback（降级，searchPages Top-5 + 单页 2000 字截断 + maxSteps=1 单轮 LLM）
  │     ↓ catch（无命中 / 全部读失败 / harness 返回 failed）
  └─ 兜底提示（返回静态文本"知识库未覆盖此问题..."）
```

**v1.1.1 实施细节**：
- 三个独立 generator 函数：`queryWithHarness` / `queryWithSearchFallback` / `queryWorkflow`（编排器）
- 降级链以 `try { ... } catch { /* 落入下一级 */ }` 模式串联，前一级 throw 触发下一级接管
- `queryWithSearchFallback` 强制 `tools: []` + `budget: { maxSteps: 1, tokenBudget: 8000 }`，避免降级时仍走 ReAct 多轮
- `yieldAnswerInSentences` 辅助函数按句切分长答案，保证 SSE 流式效果
- 编排器在降级各阶段推送 `thinking { phase: 'composing', message: '降级搜索中...' }` 事件，保证用户体验连续（对应 R11 风险缓解）

**v2.0.0 正式需求**（原"v2 扩展点"升级为正式需求）：
- 新增的 `thinking` 事件在降级链各阶段均需推送（`queryWithHarness` 推送工具调用，`queryWithSearchFallback` 推送"降级搜索"提示）
- 新增的 `web_search` 工具仅在 `queryWithHarness` 阶段可用，降级后不调用
- 新增的 `image`/`progress` 事件仅在 `queryWithHarness` 阶段推送
- 实施位置：`api/src/workflows/query-workflow.ts` 的 `queryWorkflow` 编排器在降级各阶段 yield `thinking` chunk（v1.1.1 已实现 `queryWithSearchFallback` 阶段的 `thinking { phase: 'composing', message: '降级搜索中...' }` 推送，v2.0.0 需扩展 `queryWithHarness` 阶段的工具调用 thinking 推送）

#### 6.0.2 per-session Lock 串行化

源自《概要设计说明书》V1.3 §12.5，**v1.1.1 已实施**，代码位于 `api/src/session-lock.ts`：

```typescript
// v1.1.1 实施：按 question 前 32 字符做 key 串行化，同 key 排队、不同 key 完全独立
const locks = new Map<string, Promise<unknown>>();
const KEY_PREFIX_LEN = 32;

export function withSessionLock<T>(
  question: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = question.slice(0, KEY_PREFIX_LEN);
  const prev = locks.get(key) ?? Promise.resolve();
  // prev.then(task, task) 双分支确保前一次异常不级联拒绝，仅串行不传递错误
  const next = prev.then(() => task(), () => task());
  locks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
```

**接入位置**：`api/src/routes/query.ts` SSE 路由层，用 `withSessionLock(input.question, async () => { for await ... })` 包裹整个 SSE 流，覆盖所有 chunk 推送。

**v1.1.1 实施细节**：
- 设计仿 `api/src/compile-queue.ts` 的 `withCompileLock` 模式，Promise 链式队列
- key 长度取 32 字符而非全文，避免长问题哈希开销与 Map 内存膨胀
- 锁的粒度是整个 SSE 流（含 LLM 调用 + 推送），而非仅 LLM 调用，确保同问题并发请求完全串行，避免 LLM 重复调用浪费 token

**v2.0.0 正式需求**（原"v2 扩展点"升级为正式需求）：
- 多模态图片上传不改变 Lock 粒度（仍按 question 文本前 32 字符）
- 模型切换时，若有 in-flight 问答，需等待当前问答 done 或 error 后再切换（见 §9.1 风险 R7）
- 实施位置：`api/src/session-lock.ts` 的 `withSessionLock` 无需改动（v1.1.1 已按 question 前 32 字符做 key，多模态只是请求体增加 `attachments` 字段，不影响 key 计算）；模型切换的等待逻辑由前端 `useModelStore` 在调用 `engineAdapter.updateConfig` 前检查 `useQueryStore.isLoading` 实现

#### 6.0.3 EngineAdapter 接口

源自《概要设计说明书》V1.3，阶段切换抽象点，**v1.1.1 已实施**，代码位于 `api/src/engine/harness-adapter.ts`：

```typescript
interface EngineAdapter {
  compile(...): Promise<...>;
  resumeCompile(...): Promise<...>;
  query(...): Promise<...>;
  healthCheck(...): Promise<...>;
  healthCheckFix(...): Promise<...>;
  // 现有 updateConfig 已支持即时生效
  updateConfig(patch: { model?; budget?; staleDays?; provider?; baseUrl?; apiKey? }): void;
}
```

**v2.0.0 正式需求**（原"v2 扩展点"升级为正式需求）：
- F-3.9 模型切换直接调用 `engineAdapter.updateConfig({ model })`，**无需"路由到对应适配器"**
- F-3.10 互联网搜索作为 query 工作流的工具注入，不改变 EngineAdapter 接口
- 实施位置：`api/src/engine/harness-adapter.ts` 的 `updateConfig` 方法（v1.1.1 已支持 `provider/baseUrl/model/apiKey/maxSteps/tokenBudget/staleDays/webSearchConfig` 热加载）；F-3.10 的 `web_search` 工具注入由 `queryWorkflow` 在构造 `HarnessConfig` 时动态添加，不修改 EngineAdapter 接口

### 6.1 前后端分工

| 层 | 职责 | 技术 |
| --- | --- | --- |
| **前端** | UI 渲染、SSE 消费、本地存储、图片压缩、TTS | Vue 3 + Element Plus + Pinia + markdown-it + Web Speech API |
| **后端** | LLM 调用、工具执行、互联网搜索、SSE 推送 | Fastify + TypeScript + @wiki/harness |
| **本地存储** | 历史对话、配置偏好 | IndexedDB（结构化）+ localStorage（轻量） |
| **外部 API** | LLM、搜索 API | OpenAI 兼容 + Tavily / Bing |

### 6.2 数据流

```
用户输入（含可选图片）
  ↓
[前端] 图片压缩 / 文本预处理
  ↓
POST /api/query (multipart/form-data 或 application/json)
  ↓
[后端] queryWorkflow(input, options={model, mode, webSearch})
  ↓
[harness] ReAct 循环：LLM ↔ 工具
  ├─ 工具: search_pages (vault)
  ├─ 工具: read_page (vault)
  ├─ 工具: web_search (新)
  └─ 工具: image_understand (新, 依赖 vision 能力)
  ↓
SSE 事件流:
  ├─ thinking { phase, message, tool? }
  ├─ answer { text }              (流式)
  ├─ refs { refs: Reference[] }
  ├─ followups { followups: string[] }
  ├─ done { sessionId, messageIndex, followups? }
  └─ error { message }
  ↓
[前端] Pinia store 更新 → Vue 响应式重渲染
  ↓
[可选] TTS / 复制 / 反馈 等本地操作
  ↓
[持久化] IndexedDB.conversations[id] = messages
```

### 6.3 SSE 事件协议扩展

v2 在 v1 基础上扩展事件类型：

| 事件 | 触发时机 | payload | v1 已有 |
| --- | --- | --- | --- |
| `thinking` | 工具调用 / 思考阶段 | `{ phase, message, tool? }` | ❌ |
| `answer` | 流式答案 | `{ text: string }` | ✅ |
| `image` | 答案中嵌入图片 | `{ url, alt, width?, height? }` | ❌ |
| `refs` | 引用页面/文章 | `{ refs: Reference[] }` | ✅ |
| `followups` | 联想提问 | `{ followups: string[] }` | ✅ |
| `progress` | 联网搜索进度 | `{ step: 'searching' \| 'fetching' \| 'done', count? }` | ❌ |
| `done` | 流式结束 | `{ sessionId, messageIndex, followups? }` | ✅ |
| `error` | 降级失败 | `{ message: string, code?: string }` | ✅ |

### 6.4 状态管理

新增 stores：
- `useConversationsStore`：历史对话列表、当前会话、CRUD
- `useModelStore`：当前模型、可用预设、切换
- `useTtsStore`：朗读状态、当前朗读消息
- `useAttachmentsStore`：图片附件管理

扩展 `useQueryStore`：
- `currentThinking`：思考块状态
- `currentRefs` (已有)
- `currentFollowups` (已有)
- `attachments`：当前对话附件

#### 6.4.1 store 拆分边界

```
┌─────────────────────────────────────────────────────────────────────┐
│                     useQueryStore（会话内状态）                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  messages: ChatMessage[]       ← 当前会话的消息列表（内存）       │ │
│  │  streamingAnswer: string       ← 当前流式答案缓冲                │ │
│  │  currentRefs: Reference[]      ← 当前轮引用                      │ │
│  │  currentFollowups: string[]    ← 当前轮联想提问                  │ │
│  │  currentThinking: ThinkingStep ← 当前思考状态（v2 新增）         │ │
│  │  isLoading: boolean            ← 加载态                          │ │
│  │  errorMessage: string          ← 错误信息                        │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                              ↕ done 事件时持久化                      │
└─────────────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────────┐
│              useConversationsStore（跨会话列表）                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  conversations: Conversation[]  ← 所有历史会话索引（IndexedDB）   │ │
│  │  currentConversationId          ← 当前激活的会话 ID              │ │
│  │  searchKeyword                  ← 搜索关键词                     │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│  职责：列表 CRUD / 搜索 / 置顶 / 切换会话时 load messages 到 query  │ │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────────┐  ┌──────────────────────┐
│  useModelStore        │  │  useTtsStore          │
│  - currentModel      │  │  - state: idle/playing│
│  - presets: LlmPreset[]│  │  - currentMsgId      │
│  - 切换 → updateConfig│  │  - speak/pause/stop   │
└──────────────────────┘  └──────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     useAttachmentsStore                              │
│  - attachments: Map<id, Attachment>                                  │
│  - 上传压缩 / 缩略图生成 / blob 存 IndexedDB                          │
└─────────────────────────────────────────────────────────────────────┘
```

**依赖关系**：
- `useQueryStore` 在 `done` 事件时调用 `useConversationsStore.persist(messages)` 持久化
- `useQueryStore` 在 `submitQuestion` 前调用 `useAttachmentsStore.flush()` 上传附件
- `useModelStore` 切换模型时检查 `useQueryStore.isLoading`，若 loading 则等待
- `useTtsStore` 切换朗读消息时检查 `useQueryStore.messages`，确保消息存在

**字段归属原则**：当前会话的瞬态状态（流式缓冲、loading）归 `useQueryStore`；跨会话的持久化数据（历史列表、模型偏好、附件 blob）归各自独立 store。

### 6.5 多模态处理

| 步骤 | 实现 |
| --- | --- |
| 上传 | el-upload + 自定义压缩（canvas 缩放） |
| 存储 | IndexedDB blob + 服务端 vault/queries/attachments/ |
| 传输 | FormData (multipart/form-data) |
| LLM 调用 | base64 编码 + image_url content type |
| 渲染 | `<img src="attachment://{id}">` 自定义解析器 |

### 6.6 TTS 实现

```typescript
// composables/useTTS.ts
export function useTTS() {
  const utterance = ref<SpeechSynthesisUtterance | null>(null);
  const state = ref<'idle' | 'playing' | 'paused'>('idle');
  
  function speak(text: string, lang = 'zh-CN') {
    // 1. 剥离 Markdown 语法
    const cleanText = stripMarkdown(text);
    // 2. 创建 utterance
    utterance.value = new SpeechSynthesisUtterance(cleanText);
    utterance.value.lang = lang;
    // 3. 监听事件
    utterance.value.onend = () => { state.value = 'idle'; };
    // 4. 启动
    speechSynthesis.speak(utterance.value);
    state.value = 'playing';
  }
  
  function pause() { speechSynthesis.pause(); state.value = 'paused'; }
  function resume() { speechSynthesis.resume(); state.value = 'playing'; }
  function stop() { speechSynthesis.cancel(); state.value = 'idle'; }
  
  return { state, speak, pause, resume, stop };
}
```

### 6.7 互联网搜索实现

```typescript
// 后端 tools/web-search.ts
export function createWebSearchTool(config: { provider: 'tavily' | 'bing'; apiKey: string }) {
  return {
    name: 'web_search',
    description: '搜索互联网实时信息。返回摘要 + URL。',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: async (args: { query: string }) => {
      if (config.provider === 'tavily') {
        return await tavilySearch(config.apiKey, args.query, 5);
      }
      // bing ...
    },
  };
}
```

---

## 7. 接口与数据结构

### 7.1 后端新增 API

| API | 方法 | 说明 |
| --- | --- | --- |
| `/api/ai/presets` | GET | 获取 LLM 预设列表（已有） |
| `/api/ai/test-connection` | POST | 测试模型连通性（已有） |
| `/api/search/web` | POST | 直接调用联网搜索（工具） |

> **说明**：历史对话存储采用纯前端本地存储方案（IndexedDB + localStorage），与设计原则 P2「本地优先」一致，**不新增** `/api/conversations` 系列后端 CRUD API。前端 store 直接读写 IndexedDB，避免后端文件并发写与归档冲突。

### 7.2 SSE 事件 payload 详表

```typescript
// thinking 事件
interface ThinkingEvent {
  phase: 'thinking' | 'tool_call' | 'composing';
  message: string;
  tool?: string;
  args?: Record<string, unknown>;
}

// image 事件
interface ImageEvent {
  url: string;       // attachment://xxx 或 https://xxx
  alt: string;
  width?: number;
  height?: number;
}

// ref 事件（升级）
interface RefsEvent {
  refs: Array<{
    url?: string;
    title: string;
    path?: string;
    snippet: string;
    source: 'vault' | 'web';
    citeIndex: number;
  }>;
}
```

### 7.3 数据模型

```typescript
// IndexedDB schema
interface ConversationRecord {
  id: string;              // sessionId
  title: string;
  createdAt: string;
  updatedAt: string;
  isPinned: boolean;
  messageCount: number;
  preview: string;
  messages: ChatMessage[];
  attachments: Attachment[];
}

interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;             // bytes
  blob: Blob;               // 原图
  thumbnail: Blob;          // 缩略图
}

// ChatMessage v2 结构：在 v1 基础上向后兼容扩展
// v1 字段（sessionId/messageIndex/archived）保留，归档功能依赖
// v1 refs: string[] 升级为 refs: Reference[]，提供兼容映射函数
interface ChatMessage {
  id: string;               // v2 新增：消息唯一 ID
  role: 'user' | 'assistant';
  content: string;
  refs?: Reference[];       // v2 升级：v1 为 string[]，通过迁移函数转换
  followups?: string[];    // v1 已有
  thinking?: ThinkingStep[];   // v2 新增
  attachments?: string[];   // v2 新增：attachment ids
  feedback?: 'up' | 'down' | null;  // v2 新增
  createdAt: string;        // v2 新增
  // ↓ v1 保留字段（归档功能依赖，不可删除）
  sessionId?: string;       // v1 已有：done 事件附带，归档用
  messageIndex?: number;    // v1 已有：done 事件附带，归档用
  archived?: boolean;       // v1 已有：标记是否已归档
}

interface ThinkingStep {
  phase: 'thinking' | 'tool_call' | 'composing';
  message: string;
  tool?: string;
  args?: Record<string, unknown>;
  ts: string;
}
```

#### 7.3.1 v1 → v2 数据迁移策略

```typescript
// 迁移函数：将 v1 的 ChatMessage 升级为 v2 结构
function migrateV1Message(msg: v1.ChatMessage): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: msg.role,
    content: msg.content,
    // v1 refs 是 string[]（页面路径），v2 升级为 Reference[]
    // 映射规则：path = 原字符串，source = 'vault'，citeIndex 按顺序递增
    refs: msg.refs?.map((path, i) => ({
      path,
      title: path.split('/').pop() || path,
      snippet: '',
      source: 'vault' as const,
      citeIndex: i + 1,
    })),
    followups: msg.followups,
    sessionId: msg.sessionId,
    messageIndex: msg.messageIndex,
    archived: msg.archived,
    createdAt: new Date().toISOString(),
  };
}
```

**迁移触发时机**：应用启动时检测 IndexedDB schema 版本，若为 v1 则批量执行 `migrateV1Message`，完成后写入 schema version = 2。

### 7.4 配置文件扩展

```json
// config.json
{
  "llm": {
    "presets": [
      { "key": "deepseek-v3", "provider": "deepseek", "baseUrl": "...", "model": "deepseek-chat", "apiKeyRef": "DEEPSEEK_API_KEY" },
      { "key": "glm-4.6", "provider": "glm", "baseUrl": "...", "model": "glm-4.6", "apiKeyRef": "GLM_API_KEY" }
    ],
    "selected": "deepseek-v3"
  },
  "webSearch": {
    "provider": "tavily",
    "apiKeyRef": "TAVILY_API_KEY",
    "maxResults": 5
  },
  "attachments": {
    "maxSizeMB": 10,
    "compressToMB": 2
  }
}
```

---

## 8. 验收标准

### 8.1 功能验收

| 编号 | 功能 | 验收用例 | 通过条件 |
| --- | --- | --- | --- |
| F-3.1 | 思考动画 | 发起一个长问题 | 思考动画出现，工具调用可见 |
| F-3.2 | 流式渲染 | 发送含图片/表格/代码块的回答 | 全部正确渲染 |
| F-3.3 | 历史对话 | 新建 3 条对话、刷新、切换 | 列表持久化，切换不丢内容 |
| F-3.4 | 工具栏 | 切换每个工具后发送问答 | 工具上下文生效 |
| F-3.5 | 多模态 | 粘贴一张图、拖拽一张图、点选一张图 | 三种方式均能上传并理解 |
| F-3.6 | TTS | 点击朗读按钮 | 中文回答自动选中文 voice |
| F-3.7 | 复制 | hover 消息、点 3 种复制 | 剪贴板内容格式正确 |
| F-3.8 | 参考文章列表 | 触发联网搜索 | vault / web 来源视觉区分 |
| F-3.9 | 模型切换 | 切换 2 个模型 | 后续问答立即生效 |
| F-3.10 | 互联网搜索 | 问「今日 AI 资讯」 | 5s 内返回，含 WEB 徽章 |
| F-3.11 | 侧栏折叠 | Ctrl+B / 点切换 | 250ms 内折叠，状态持久化 |
| F-3.12 | 联想提问 | 查看回答末尾 | 横向 chip 显示 |
| F-3.13 | 消息操作 | 点重新生成、点赞 | 行为符合预期 |

### 8.2 性能验收

| 指标 | 目标 | 测量方法 |
| --- | --- | --- |
| 首屏 | ≤ 1.5s | Playwright `performance.timing` |
| 流式延迟 | ≤ 200ms | 时间戳对比 |
| 渲染 50KB | ≤ 30ms | console.time |
| 切换对话 | ≤ 100ms | user timing API |

### 8.3 兼容性验收

| 项 | 验收 |
| --- | --- |
| Chrome | 全部功能通过 |
| Edge | 全部功能通过 |
| Firefox | 全部功能通过（Web Speech 警告） |
| Safari | TTS 警告，其他通过 |
| 1024px 宽 | 完整布局 |
| 768px 宽 | 基本可用 |

### 8.4 质量门禁

| 项 | 要求 |
| --- | --- |
| TypeScript | 0 error（tsc + vue-tsc 双零） |
| SonarQube | 0 新增 issue（与 baseline 对比） |
| 编码 | UTF-8 无 BOM（check-encoding.js 通过） |
| E2E | Playwright 自动化测试 100% 通过 |
| 控制台 | 0 error 日志 |

---

## 9. 风险与依赖

### 9.1 技术风险

| 编号 | 风险 | 等级 | 缓解措施 |
| --- | --- | --- | --- |
| R1 | Web Speech API 跨浏览器一致性差 | 中 | 用 `speechSynthesis.getVoices()` 动态探测，提供手动选 voice |
| R2 | IndexedDB 大数据量查询慢 | 中 | 列表只存索引，详细消息按需 lazy load |
| R3 | LLM 视觉能力差异（deepseek 无 vision） | 高 | 模型选择时检测 vision 能力，灰显图片按钮 |
| R4 | 联网搜索 API 限流 | 中 | 后端做 token bucket 限流 + 缓存 |
| R5 | 图片 base64 增大 SSE payload | 中 | 大图改用 FormData 上传 + URL 引用 |
| R6 | 历史对话 IndexedDB 浏览器兼容 | 低 | localStorage 兜底 |
| R7 | SSE 连接中断后无重连 | 高 | 前端监听 `EventSource.onerror`，提供"重试"按钮；中断时保留已接收的流式答案到 store |
| R8 | 模型切换时状态一致性 | 中 | 切换瞬间若有 in-flight 问答，等待 done/error 后再调用 `updateConfig`（见 §6.0.2） |
| R9 | v1 → v2 数据迁移失败 | 高 | 应用启动时检测 schema 版本，迁移失败则降级为只读模式，提示用户导出数据 |
| R10 | 多模态图片 MIME 伪造 | 中 | 后端校验 MIME + 文件头魔数（§4.3 已要求），拒绝不匹配的文件 |
| R11 | 降级链与 thinking 事件冲突 | 中 | `queryWithSearchFallback` 阶段推送 `thinking { phase: 'composing', message: '降级搜索中' }`，保证用户体验连续 |

### 9.2 依赖项

| 依赖 | 用途 | 必需 |
| --- | --- | --- |
| markdown-it | 已有 | 是 |
| Element Plus | 已有 | 是 |
| idb (IndexedDB wrapper) | 简写 IndexedDB API | 是 |
| @vueuse/core | 工具集（useStorage 等） | 是 |
| Tavily / Bing Search API | 联网搜索 | 是 |
| LLM vision 能力 | 图片理解 | 视模型 |

### 9.3 后续优化（v3+）

- 移动端深度适配
- 协同 / 共享对话
- 语音输入（STT）
- 视频生成接入
- PPT 生成接入
- 对话数据云同步
- 多模态输出（LLM 生成图片）

---

## 10. 附录

### 10.1 参考产品截图分析

#### 10.1.1 豆包

**借鉴要点**：
- 左侧栏：搜索（Ctrl+K）+ 新对话 + 历史对话列表
- 顶部：标题居中、模型/工具入口右侧
- 答案区：来源横条 + Markdown 主体 + 联想提问
- 工具栏：底部输入框上方，6-8 个 chip 横排
- 语音：右下角麦克风图标

**差异化设计**：
- 我们的项目主题是霓虹玻璃风，与豆包的扁平风区别明显
- 工具栏使用更紧凑的 chip 风格，而非豆包的横排大按钮

#### 10.1.2 Trae Work

**借鉴要点**：
- 顶部 Tab：Work / Code / Design
- 任务列表作为可折叠侧栏
- 上下文用量可视化（百分比条）
- 底部：模型选择器 + 工具图标

**差异化设计**：
- 我们不区分 Work / Code / Design，只有一个问答视图
- 上下文用量条改为可选项（非核心场景）

### 10.2 设计参考链接

- 豆包：https://www.doubao.com
- Trae Work：https://www.trae.ai
- ChatGPT：https://chat.openai.com
- Notion AI：https://www.notion.so/product/ai

### 10.3 修订历史

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0.0 | 2026-07-10 | 初版：13 项核心功能完整规格 |
| v1.1.0 | 2026-07-11 | 按评审报告修正 11 项问题：<br>**P0**：①删除矛盾的 `/api/conversations` API，统一本地存储；②保留 ChatMessage v1 字段 + 新增迁移函数；③新增 §6.0 现有架构继承（降级链/per-session Lock/EngineAdapter）<br>**P1**：④补充 5 项遗漏风险（R7~R11）；⑤删除 §1.5.3 重复量化表；⑥补充 §6.4.1 store 拆分边界图；⑦修正 F-3.9 模型切换描述对齐 updateConfig<br>**P2**：⑧F-3.12 验收标准补充；⑨§4.5 引用编码门禁三层防御；⑩§1.2 引用 DELIVERY.md §14；⑪F-3.4 明确 mode 字段语义 |
| v1.1.1 | 2026-07-17 | 补齐 P0-3 代码层（queryWithSearchFallback 降级链 + per-session Lock），关闭全部 P0 评审项：<br>**新增**：`api/src/session-lock.ts` 实现 withSessionLock；`api/src/workflows/query-workflow.ts` 重构为三函数降级链（queryWithHarness → queryWithSearchFallback → 兜底）；`api/src/routes/query.ts` SSE 路由接入 withSessionLock<br>**验证**：tsc 编译 exit 0，check-encoding.js 75 文件全部 UTF-8 无 BOM |
| v2.0.0 | 2026-07-17 | 升级为 v2 实施基线，关闭全部 v1 评审项：<br>**核心变更**：①§6.0.1/6.0.2/6.0.3 的「v2 扩展点」全部转为「v2.0.0 正式需求」，补充实施位置与代码层一致性说明；②新增 §11「v2.0.0 实施排期与模块拆分」含 4 个 Sprint + 5 个里程碑 + 前后端文件清单 + 依赖前置条件 + 回退方案；③全文「v2」措辞统一为「v2.0.0」<br>**评审项关闭**：v1 评审报告 3 项 P0 + 4 项 P1 + 4 项 P2 共 11 项全部闭环<br>**前置条件**：§6.0 三项架构机制 + `/api/conversations` 路由 + ChatMessage v2 类型均已在 v1.1.1 实施 |
| v2.0.0-sprint1 | 2026-07-17 | Sprint 1「核心问答增强」实施完成：<br>**交付功能**：F-3.1 思考动画三态（加载圆点脉动 / 流式气泡光晕 / 折叠过渡 ≤ 200ms） / F-3.2 流式渲染扩展（代码块语言徽章 + 图片懒加载 + 图片预览） / F-3.7 文本复制（MessageToolbar 浮窗 + 纯文本/MD + 代码块独立复制 + clipboard 降级 execCommand） / F-3.12 联想提问微调（位置迁移到 refs 上方 + 横向 chip 滚动 + CSS tooltip 200ms）<br>**新增文件**：`frontend/src/components/MessageToolbar.vue`<br>**修改文件**：`frontend/src/utils/markdown.ts`（fence/image 规则覆盖）、`frontend/src/views/Query.vue`（事件委托 + CSS + 模板布局）、`frontend/src/components/ThinkingBlock.vue`（v-show + max-height transition）<br>**验证**：`npx vue-tsc --noEmit` exit 0；`node scripts/check-encoding.js` 扫描 76 文件无 GBK 乱码<br>**已知限制**：F-3.7 浮窗未含朗读按钮（属 F-3.6，Sprint 3 扩展）；F-3.7 未含重新生成/反馈（属 F-3.13，Sprint 2 扩展）<br>**交付文档**：DELIVERY.md §13 |
| v2.0.0-sprint2 | 2026-07-18 | Sprint 2「历史与导航」实施完成：<br>**交付功能**：F-3.11 侧栏折叠三态（expanded 280px / collapsed 60px / hidden 0px + Ctrl+B 全局快捷键 + 250ms 平滑过渡 + localStorage 持久化） / F-3.13 消息操作栏（重新生成回溯找 user 问题 + 👍/👎 反馈 localStorage 持久化 + 重复点击取消） / F-3.3 历史对话管理（重命名 ElMessageBox.prompt + 删除 ElMessageBox.confirm + hover 显现操作按钮）<br>**新增文件**：`scripts/sprint1-2-acceptance.py`（Playwright 验收脚本 12 个 TC）<br>**修改文件**：`frontend/src/components/ConversationSidebar.vue`（重写三态 + 重命名/删除 UI）、`frontend/src/components/MessageToolbar.vue`（扩展重新生成 + 反馈按钮）、`frontend/src/views/Query.vue`（三态状态管理 + Ctrl+B 监听 + handleRegenerate）<br>**验证**：`npx vue-tsc --noEmit` exit 0；`node scripts/check-encoding.js` 76 文件无 GBK 乱码；Playwright 端到端验收 17/18 通过（TC7 loading-dots 因 LLM 响应<2s 错过时机失败，非功能缺陷）<br>**已知限制**：反馈数据仅 localStorage 未上报后端（Sprint 3/4 补 /api/feedback 路由）；F-3.3 Pin 功能未在 UI 暴露（Sprint 3 加置顶图标）<br>**交付文档**：DELIVERY.md §14 |
| v2.0.0-sprint3 | 2026-07-18 | Sprint 3「多模态与输入增强」实施完成：<br>**交付功能**：F-3.4 输入工具栏 7 类 chip（快速/写作/PPT/图像/视频/翻译/更多，PPT/图像/视频灰显待 v3；"更多"展开下拉显示联网搜索/深度思考；hover translateY 动效 + `:focus-visible` 键盘可达；mode 字段统一传递到 SSE body） / F-3.5 多模态图片（vision 能力检测：后端 LLM_PRESETS 加 vision 字段，前端 currentPresetVision computed + AttachmentUploader 灰显按钮 + tooltip 提示；粘贴/拖拽/点选三种方式 + 压缩 ≤ 2MB + 缩略图 200x200 已在 v1.1.1 实施） / F-3.9 模型切换（isLoading 检查禁止 in-flight 切换；Toast 200ms 内提示「已切换到 xxx」；切换失败回滚到上一预设；localStorage 持久化 selectedModelPreset）<br>**修改文件**：`frontend/src/components/InputToolbar.vue`（重写 7 chip + more 下拉）、`frontend/src/components/AttachmentUploader.vue`（vision 灰显）、`frontend/src/components/ModelSelector.vue`（重构 isLoading + Toast + 回滚）、`frontend/src/stores/model.ts`（currentPresetVision computed）、`frontend/src/types.ts`（LlmPreset.vision）、`frontend/src/views/Query.vue`（toolbarTools 扩展 + SSE body.mode 统一）、`api/src/routes/ai.ts`（LLM_PRESETS 加 vision 字段）<br>**验证**：前端 `vue-tsc --noEmit` exit 0；后端 `tsc --noEmit` exit 0；`check-encoding.js` 76 文件无 GBK 乱码<br>**已知限制**：F-3.5 LLM 未真正识别图片内容（仅 prompt hint，未传 base64 给 vision API）；F-3.4 快速/写作/翻译仅 chip 标记未实施 prompt 注入；F-3.5 vision 字段为静态配置未运行时检测<br>**交付文档**：DELIVERY.md §15 |
| v2.0.0-sprint4 | 2026-07-18 | Sprint 4「语音与联网」实施完成，v2.0.0 全量发布：<br>**交付功能**：F-3.6 语音朗读 TTS（MessageToolbar 新增第 3 按钮，Web Speech API + useTtsStore 协调多消息切换 + stripMarkdown 剥离语法 + 暂停/继续/停止状态机 + 不支持时灰显） / F-3.8 参考文章列表（RefsList 重写为卡片列表：「参考 N 篇资料」横条 + 默认展开前 3 条 + "展开更多"按钮 + vault/web 来源徽章 + 引用编号 + hover translateX 动效） / F-3.10 互联网搜索（web-search.ts 工具 + /api/search/web 路由 + Tavily/Bing provider + 5s AbortSignal.timeout 超时降级返回空数组 + afterStep hook 检测空结果推送 thinking 提示「已降级为仅本地知识库」+ 前端 store.setRefs 合并本地+web refs + RefsList 差异化渲染 VAULT/WEB 徽章）<br>**修改文件**：`frontend/src/components/MessageToolbar.vue`（5 按钮扩展为 6 + TTS 状态机）、`frontend/src/components/RefsList.vue`（重写卡片列表 + 折叠展开）、`api/src/tools/web-search.ts`（新增 5s 超时降级 + try/catch 返回空数组）、`api/src/workflows/query-workflow.ts`（afterStep hook 检测空结果推送降级 thinking + webSearchDowngradeNotified 去重）<br>**验证**：前端 `vue-tsc --noEmit` exit 0；后端 `tsc --noEmit` exit 0<br>**已知限制**：F-3.6 TTS 浏览器实测留 Sprint 4 整体验收；F-3.10 联网搜索实测需配置 Tavily/Bing API Key<br>**交付文档**：DELIVERY.md §16<br>**里程碑**：v2.0.0 全量发布（13 项功能全部交付） |
| v2.0.1 | 2026-07-21 | 修复 v2.0.0 已知限制中与 SRS 规格不符的 3 项功能缺陷，关闭 §16.5 全部遗留项：<br>**F-3.6 语速调节**：SRS 要求「默认 1.0x，可调 0.5x - 2.0x」，v2.0.0 固定 1.0x → 修复：`useTTS.ts` 新增 `rate ref(1.0)` + `setRate()` clamp(0.5-2.0)；`MessageToolbar.vue` 新增 `.rate-panel` 浮窗 + `<input type="range" min="0.5" max="2.0" step="0.1">` 滑块 + 重置按钮；`tts` store 暴露 `rate/setRate`，朗读中调整自动 `cancel()` + 重新 `speak()` 应用新值（Web Speech API 不支持动态修改 rate）<br>**F-3.8 [1] 锚点跳转**：SRS 要求「assistant 文本中 [1] 为可点击锚点」，v2.0.0 仅展示编号 → 修复：`markdown.ts` 通过 `md.inline.ruler.before('link', 'ref_anchor', fn)` 注册 inline 规则，将 `[N]` 转为 `<a href="#ref-N" class="ref-anchor">`（防御：要求 `]` 后非 `(` 字符避免与 `[text](url)` 链接冲突）；`RefsList.vue` 卡片新增 `id="ref-${citeIndex}"`；`Query.vue` `handleRefAnchorClick` 事件委托（v-html 不经 Vue 编译）+ 自动展开折叠的 refs-body + `requestAnimationFrame` 双层嵌套等渲染完成后 `scrollIntoView({behavior:'smooth',block:'center'})` + `ref-flash` 1.5s 渐变高亮动画<br>**F-3.10 progress 事件推送**：SRS 数据结构含 `{step:'searching'|'fetching'|'done', count?}`，v2.0.0 仅 thinking 提示 → 修复：`query-workflow.ts` 新增 `collectedProgress` 数组 + afterStep hook 在 `web_search` 调用时推送 `{step:'fetching',count}` 与 `{step:'done',count}`，启动时推送 `{step:'searching'}`（harness.run 阻塞 Promise，run 完成后一次性 yield）；前端全链路已就绪：SSE 路由 `/api/query` 转发 `progress` 事件 / `sse.ts` `progress:` handler 调用 `store.setProgress(step,count)` / `query.ts` store `searchProgress` ref + `clearCurrentRound` 清理；`Query.vue` 新增 `searchProgressLabel` 计算属性将英文 step 翻译为中文（正在联网搜索 / 正在抓取网页 / 联网搜索完成）<br>**修改文件**：`frontend/src/composables/useTTS.ts`、`frontend/src/stores/tts.ts`、`frontend/src/components/MessageToolbar.vue`、`frontend/src/utils/markdown.ts`、`frontend/src/components/RefsList.vue`、`frontend/src/views/Query.vue`、`api/src/workflows/query-workflow.ts`、`scripts/sprint3-4-acceptance.py`、`docs/DELIVERY.md`<br>**验证**：`vue-tsc --noEmit -p frontend` exit 0；`tsc --noEmit -p api` exit 0；`check-encoding.js` 81 文件全部 UTF-8 无 BOM；Playwright E2E `sprint3-4-acceptance.py` 34 项全部 PASS（原 23 + v2.0.1 新增 11 项：F-3.6 rate ref/setRate/clamp + 工具栏 UI + store 暴露；F-3.8 markdown 规则 + RefsList id + 点击委托 + 闪烁高亮；F-3.10 workflow 推送 + SSE 路由 + 前端 handler + store + 展示 + 中文 label）<br>**交付文档**：DELIVERY.md §16.5 已知限制表三项均标记 `~~删除线~~` + ✅ v2.0.1 已修复 + 新增 §16.5.1 验证证据小节 |

| v2.0.1-sprint5 | 2026-07-21 | v2.0.1 端到端实测完成，关闭 §16.5 剩余两项 v2.0.0 实测限制：<br>**F-3.6 TTS 浏览器实测**：`scripts/sprint5-e2e-real.py` 10 项 TTS 用例全部 PASS（speechSynthesis 可用 / 中文 voice 3 个 Microsoft Huihui/Kangkang/Yaoyao / speak 调用 lang=zh-CN + voice 选择 / 朗读中 title 切换为暂停朗读 / 暂停 state=paused / 继续 state=playing / setRate(1.5) store 应用 rate:1→1.5 / rate 重启 utterance 验证 utterance.rate=1.5 / 切换消息 cancel 调用）；headed Chrome + Web Speech API + mock speechSynthesis.speak 捕获 utterance 参数<br>**F-3.10 联网搜索实测**：配置真实 Tavily API Key，5 项联网搜索用例 + 4 项超时降级用例全部 PASS（Tavily provider/key 配置 / SSE done 事件 / progress 事件 searching / refs 渲染 / thinking 事件 5 条；5s 超时常量 / AbortSignal.timeout / try/catch 降级 / 三层防御完整）；真实触发 Tavily 搜索 + read_page 工具调用<br>**根因修复**：`frontend/src/` 下存在 31 个早期 vue-tsc 编译产物 `.js` 文件，Vite 默认 `resolve.extensions` 中 `.js` 优先于 `.ts`，导致 `import { useTTS } from '../composables/useTTS'` 加载旧版 `.js`（无 setRate/rate）而非新版 `.ts`；删除全部 `.js` 残留后 Vite 自动重启并正确解析到 `.ts`，`.gitignore` 已有 `frontend/src/**/*.js` 规则防止复发<br>**验证**：27/27 PASS（F-3.6 TTS 10 项 + F-3.10 联网搜索 9 项 + Console 错误检查 1 项 + 其他 7 项）；`check-encoding.js` 81 文件全部 UTF-8 无 BOM<br>**结果文件**：`docs/test-evidence/sprint5/sprint5-result.json` + `sprint5-run.log`<br>**交付文档**：DELIVERY.md §16.5 两项限制标记 `~~删除线~~` + ✅ v2.0.1 已实测 + §16.5.1 追加 Sprint 5 证据 + §16.7 阶段交接声明更新 |

---

## 11. v2.0.0 实施排期与模块拆分

### 11.1 实施总览

v2.0.0 共 13 项核心功能（F-3.1 ~ F-3.13），按依赖关系与风险等级拆分为 4 个迭代包，建议总周期 4-6 周：

| 迭代包 | 周期 | 功能项 | 依赖 | 风险等级 |
| --- | --- | --- | --- | --- |
| **Sprint 1：核心问答增强** | 1-1.5 周 | F-3.1 思考动画 / F-3.2 流式渲染扩展 / F-3.7 文本复制 / F-3.12 联想提问微调 | §6.0.1 降级链（v1.1.1 已实施） | 低 |
| **Sprint 2：历史与导航** | 1-1.5 周 | F-3.3 历史对话 / F-3.11 侧栏折叠 / F-3.13 消息操作 | F-3.3 IndexedDB schema + useConversationsStore | 中 |
| **Sprint 3：输入与多模态** | 1-1.5 周 | F-3.4 工具栏 / F-3.5 多模态图片 / F-3.9 模型切换 | F-3.5 vision 能力检测 / F-3.9 updateConfig（v1.1.1 已实施） | 高 |
| **Sprint 4：语音与联网** | 1-1.5 周 | F-3.6 TTS / F-3.8 参考文章列表 / F-3.10 互联网搜索 | F-3.10 Tavily/Bing API Key / F-3.6 Web Speech API 兼容 | 中 |

### 11.2 模块拆分与文件清单

#### 11.2.1 前端新增/修改文件

| 文件 | 类型 | 职责 | 对应功能 |
| --- | --- | --- | --- |
| `frontend/src/views/Query.vue` | 修改 | 主视图重构：侧栏 + 工具栏 + 消息体三栏布局 | F-3.1~3.13 全部 |
| `frontend/src/components/ThinkingBlock.vue` | 新增 | 思考动画组件（三态切换） | F-3.1 |
| `frontend/src/components/MessageToolbar.vue` | 新增 | 消息操作浮窗（复制/朗读/重新生成/反馈） | F-3.7 / F-3.13 |
| `frontend/src/components/InputToolbar.vue` | 新增 | 输入工具栏 chip 区 | F-3.4 |
| `frontend/src/components/ReferenceList.vue` | 新增 | 参考文章列表卡片 | F-3.8 |
| `frontend/src/components/Sidebar.vue` | 新增 | 历史对话侧栏（三态折叠） | F-3.3 / F-3.11 |
| `frontend/src/composables/useTTS.ts` | 新增 | TTS 组合式函数 | F-3.6 |
| `frontend/src/composables/useAttachments.ts` | 新增 | 图片附件管理 | F-3.5 |
| `frontend/src/stores/conversations.ts` | 修改 | 历史对话 CRUD（后端 `/api/conversations` 已实施） | F-3.3 |
| `frontend/src/stores/model.ts` | 修改 | 模型预设切换 + isLoading 检查 | F-3.9 |
| `frontend/src/stores/query.ts` | 修改 | 扩展 currentThinking / attachments 字段 | F-3.1 / F-3.5 |
| `frontend/src/types.ts` | 修改 | ChatMessage v2 字段（v1.1.1 已实施） | F-3.3 / F-3.13 |

#### 11.2.2 后端新增/修改文件

| 文件 | 类型 | 职责 | 对应功能 |
| --- | --- | --- | --- |
| `api/src/routes/query.ts` | 修改 | SSE 路由扩展 thinking/image/progress 事件（v1.1.1 已接入 withSessionLock） | F-3.1 / F-3.5 / F-3.10 |
| `api/src/workflows/query-workflow.ts` | 修改 | queryWithHarness 阶段推送工具调用 thinking（v1.1.1 已实施降级链） | F-3.1 |
| `api/src/tools/web-search.ts` | 新增 | 互联网搜索工具（Tavily/Bing provider） | F-3.10 |
| `api/src/routes/search.ts` | 新增 | `/api/search/web` POST 路由 | F-3.10 |
| `api/src/routes/attachments.ts` | 新增 | 图片上传路由（multipart/form-data） | F-3.5 |
| `api/src/routes/conversations.ts` | 已实施 | 历史对话 CRUD（v1.1.1 已完成 6 路由） | F-3.3 |
| `api/src/engine/harness-adapter.ts` | 已实施 | updateConfig 热加载（v1.1.1 已支持） | F-3.9 |
| `api/src/session-lock.ts` | 已实施 | per-session Lock（v1.1.1 已完成） | §6.0.2 |
| `api/config.json` | 修改 | 新增 llm.presets / webSearch / attachments 配置段 | F-3.9 / F-3.10 / F-3.5 |

### 11.3 里程碑与验收门禁

| 里程碑 | 交付物 | 验收门禁 |
| --- | --- | --- |
| **M1：Sprint 1 完成** | 思考动画 + 流式渲染 + 复制 + 联想提问 | Playwright E2E：思考动画出现 / 复制纯文本无 Markdown / 联想 chip 横向滚动 |
| **M2：Sprint 2 完成** | 历史对话 + 侧栏折叠 + 消息操作 | 100 条历史搜索 ≤ 50ms / 侧栏三态切换 ≤ 250ms / 重新生成产生新 sessionId |
| **M3：Sprint 3 完成** | 工具栏 + 多模态 + 模型切换 | 图片粘贴/拖拽/点选三种方式 / vision 能力灰显 / 模型切换 Toast 200ms |
| **M4：Sprint 4 完成** | TTS + 参考列表 + 联网搜索 | 中文 voice 自动选 / 17 条 ref 渲染 ≤ 300ms / 联网搜索 5s 内返回 |
| **M5：v2.0.0 发布** | 全部 13 项功能 + 文档 | TypeScript 0 error / SonarQube 0 新增 issue / check-encoding.js 通过 / Playwright 100% |

### 11.4 依赖与前置条件

| 依赖项 | 状态 | 说明 |
| --- | --- | --- |
| §6.0.1 降级链 | ✅ v1.1.1 已实施 | `api/src/workflows/query-workflow.ts` 三函数降级链 |
| §6.0.2 per-session Lock | ✅ v1.1.1 已实施 | `api/src/session-lock.ts` + `query.ts` 接入 |
| §6.0.3 EngineAdapter | ✅ v1.1.1 已实施 | `api/src/engine/harness-adapter.ts` updateConfig 热加载 |
| `/api/conversations` 路由 | ✅ v1.1.1 已实施 | 6 路由 + UUID 防穿越 |
| ChatMessage v2 类型 | ✅ v1.1.1 已实施 | `frontend/src/types.ts` 联合类型兼容旧数据 |
| Tavily/Bing API Key | ⏳ 待配置 | Sprint 4 前需在 `config.json.webSearch.apiKeyRef` 配置 |
| LLM vision 能力 | ⏳ 视模型 | Sprint 3 需检测模型 vision 能力，不支持时灰显图片按钮 |

### 11.5 回退方案

若 v2.0.0 实施过程中出现阻塞：

- **Sprint 阻塞**：该 Sprint 内功能降级为 v2.1.0，不阻塞后续 Sprint（除 Sprint 1 阻塞 Sprint 2 外）
- **整体回退**：v1.1.1 代码基线保留，v2.0.0 未完成功能不影响 v1.1.1 已实施的核心架构（降级链 / per-session Lock / EngineAdapter）
- **数据迁移失败**：按 R9 风险缓解，应用启动时检测 schema 版本，迁移失败则降级为只读模式

---

## 阶段交接声明

- 当前阶段：SRS v2.0.0 编制完成 ✅
- 下一阶段：v2.0.0 迭代实施（按 §11 排期推进 Sprint 1-4）
- 下一阶段智能体：wiki-code-dev（实施）
- 下一阶段技能：wiki-code-dev / wiki-frontend-code-review / webapp-testing
- 交接上下文：v2.0.0 已完成 SRS 升级——①§6.0「v2 扩展点」全部转为「v2.0.0 正式需求」，与 v1.1.1 代码层一致；②新增 §11 实施排期（4 Sprint / 5 里程碑 / 前后端文件清单 / 依赖前置 / 回退方案）；③v1 评审报告 11 项问题（3 P0 + 4 P1 + 4 P2）全部闭环；④全文措辞统一为 v2.0.0。前置条件全部满足：§6.0 三项架构机制 + `/api/conversations` 路由 + ChatMessage v2 类型均已在 v1.1.1 实施。建议按 Sprint 1→2→3→4 顺序推进，每个 Sprint 完成后运行 Playwright E2E 验收。

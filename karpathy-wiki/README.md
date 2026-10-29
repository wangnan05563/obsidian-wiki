<div align="center">

<img src="assets/design/social-preview/github-social-preview.png" alt="Karpathy Wiki" width="640">

# Karpathy Wiki

**Karpathy AI 内容 × Obsidian 知识库 —— 本地优先的可问答智能 Wiki**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2022.19-339933?logo=nodedotjs)](https://nodejs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs)](https://vuejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-4-000000?logo=fastify)](https://www.fastify.io/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm)](https://pnpm.io/)

</div>

## 简介

Karpathy Wiki 是一个**本地优先**的智能知识库系统，灵感来自 Andrej Karpathy 的 AI 教育理念，并借鉴 Obsidian 的 Markdown + 双向链接范式。

它通过自研的 LLM Agent 引擎（`@wiki/harness`）把原始资料自动**编译**为结构化的 Wiki 页面，支持图谱可视化、健康检查与基于知识库的 RAG 问答，让个人与团队能够把零散资料沉淀为可检索、可问答的知识资产。

核心闭环：

```
投递资料 → AI 编译 → 结构化页面 → 知识问答
```

## 特性

- 🧠 **AI 编译引擎**：ReAct 式 Agent 工具循环，LLM 将原始资料编译为符合 SCHEMA 的结构化 Wiki 页面，支持 SSE 流式进度、断点续传与预算守卫。
- 📚 **Obsidian 风格知识库**：原生 Markdown + `[[双向链接]]`，自动生成目录索引与链接图。
- 🕸️ **知识图谱**：基于 vis-network 的交互式图谱可视化，快速发现知识关联。
- 💬 **知识问答（RAG）**：检索知识库后流式回答，答案内嵌 `[[页面名]]` 引用，支持多会话。
- 🩺 **知识体检**：检查孤立页面、断链、重复标题等知识库健康问题。
- 📊 **仪表盘**：页面总数、链接数、目录分布一目了然。
- 🔑 **BYOK 模型配置**：自带 Key，支持智谱 GLM / 通义千问 / DeepSeek 等 OpenAI 兼容接口。
- 🎨 **多主题切换**：内置浅色 / 深色 / 马卡龙 / 商务等多套界面主题。
- 📱 **移动端适配**：独立的移动端 Shell，支持问答、浏览、聆听、投递与个人中心。
- 🔊 **TTS 朗读**：回答内容拟人化语音朗读。
- 🚀 **SPA 部署管线**：前端静态资源安全发布（safe-delete 沙箱），并提供 Linux 部署脚本（`scripts/deploy-linux`）。

## 架构

```
┌─────────────────────────────────────┐
│          前端 (Vue 3 + Vite)         │
│  仪表盘/投递/进度/浏览/问答/图谱/体检/配置 │
└──────────────┬──────────────────────┘
               │ HTTP + SSE
┌──────────────┴──────────────────────┐
│         后端 API (Fastify + TS)      │
│    routes / workflows / vault / search │
└──────────────┬──────────────────────┘
               │
┌──────────────┴──────────────────────┐
│       @wiki/harness (Agent 引擎)     │
│  LLM 适配 / 工具循环 / 预算 / 重试     │
└──────────────┬──────────────────────┘
               │
        LLM API (GLM / Qwen / DeepSeek / ...)
```

## 安装

### 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | >= 22.19 | 下限由后端依赖决定：`undici@8` 的 `engines.node` 为 `>=22.19.0`（`chokidar@5` 需 `>=20.19.0`）。按 18 安装会在启动时报引擎不满足 |
| pnpm | 11.12.0 | `package.json` 的 `packageManager` 已锁定该版本；未安装 pnpm 时 `install.ps1` 自动回退 npm |
| LLM API Key | — | 智谱 GLM / 通义千问 / DeepSeek 任选其一 |

### 一键安装

在 `karpathy-wiki` 目录下打开 PowerShell：

```powershell
.\scripts\install.ps1
```

脚本自动完成依赖安装（含同级 `wiki-harness` 的依赖与 `pnpm build`）、Vault 目录初始化，并进入 4 步向导（确认 Vault 路径 → 选模型 + 输入 Key → SCHEMA 提示 → 完成）。

- Vault 子目录清单不写死在脚本里：`install.ps1` 调用 `scripts/vault-dirs.mjs`（它是 `api/src/vault/page-scope.ts` 的镜像，一致性由 `api/test/vault-dirs-single-source.test.ts` 断言）。当前页面目录为 `entities / concepts / comparisons / queries / qa / solutions`，另有非页面目录 `raw`（投递原件存档）与 `drafts`。
- `SCHEMA.md` 不由向导生成：已存在则保持不变（可在「配置」页编辑），缺省时由 API 首次启动的 `VaultService.init()` 写入默认模板。
- 模型与路径配置写入 `api/config.json`（**不含** API Key）
- API Key 写入 `api/.env`（已被 git 忽略）

### 手动安装

`@wiki/harness` 是本地 `file:` 引用（`api/package.json` 写 `file:../../wiki-harness`），所以两个工程必须**同级摆放**，且 harness 要先产出 `dist/`：

```bash
cd wiki-harness && pnpm install && pnpm build   # 生成 dist/index.js + dist/*.d.ts
cd ../karpathy-wiki && pnpm install             # 之后 api 才能解析 @wiki/harness
```

跳过 harness 的 `build` 会留下没有 `dist/` 的引擎包，API 启动时按 `package.json` 的 `main: dist/index.js` 解析即失败。

## 快速开始

```powershell
# 一键启动前后端（推荐）
.\scripts\start.ps1

# 或分终端手动启动
pnpm dev:api   # 后端 http://localhost:3000
pnpm dev:web   # 前端 http://localhost:5173
```

打开 <http://localhost:5173>，按核心闭环走一遍：

1. **投递资料** —— 粘贴 Markdown 文本或上传 `.md` 文件，点击「开始编译」。
2. **编译进度** —— SSE 实时显示 AI 编译过程，完成后展示生成的页面。
3. **知识浏览** —— 目录树 + Markdown 预览，支持在线编辑。
4. **知识问答** —— 输入问题，AI 检索知识库后流式回答，含 `[[页面名]]` 引用。

## 配置

| 文件 | 用途 |
| --- | --- |
| `api/config.json` | 模型、Vault 路径等业务配置（支持热加载） |
| `api/.env` | API Key（`GLM_KEY` / `QWEN_KEY` / `DEEPSEEK_KEY`），不进 git |
| `api/llm-presets.json` | 内置 LLM 预设 |
| `api/media-presets.json` | 生图 / 视频等媒体服务预设 |

> 前端设置页提供 AI 服务、联网搜索、生图/视频、工具（MCP/CLI/场景路由）、QQ 导入、主题等可视化配置入口。

## 开发

```bash
pnpm install        # 安装全部依赖（pnpm workspace）
pnpm build          # 构建所有包
pnpm dev:api        # 后端开发模式（tsx watch）
pnpm dev:web        # 前端开发模式（Vite）

# 测试（前后端均为 Vitest）
pnpm --filter @karpathy-wiki/web test
pnpm --filter @karpathy-wiki/api test
```

### 项目结构

```
karpathy-wiki/
├── api/            # 后端：Fastify 路由、compile/query 工作流、Vault 服务
├── frontend/       # 前端：Vue 3 + Element Plus + Pinia + vis-network
├── scripts/        # 安装/启动/打包/部署脚本（含 deploy-linux）
├── docs/           # 设计文档、SRS、测试报告
└── package.json    # pnpm workspace 根配置
```

> Agent 引擎 `@wiki/harness` 位于同级独立仓库/目录 `wiki-harness/`，通过 `file:` 依赖引入。

## 文档

- [快速上手指南](docs/GETTING_STARTED.md)
- [交付文档（架构与模块清单）](docs/DELIVERY.md)
- [数据清洗 SRS](docs/data-cleaning-SRS.md) / [HLD](docs/data-cleaning-HLD.md)
- [MCP 接口说明](docs/mcp-interface.md)

## 贡献指南

欢迎 Issue 与 PR。

1. Fork 本仓库并创建你的分支（`git checkout -b feature/xxx`）。
2. 提交改动前请确保 `pnpm build` 与相关测试通过。
3. 保持提交信息清晰，描述改动动机与影响范围。
4. 如涉及 UI 改动，请附上前后端 typecheck 与构建结果。

> 项目仍处于早期快速迭代阶段，核心接口与配置 schema 可能随版本调整，建议在较大改动前先开 Issue 讨论。

## 致谢

- [Andrej Karpathy](https://github.com/karpathy) —— 项目理念来源
- [Obsidian](https://obsidian.md/) —— Markdown 知识库范式（双向链接）
- [Element Plus](https://element-plus.org/) / [Vue](https://vuejs.org/) / [Fastify](https://www.fastify.io/) —— 核心技术栈

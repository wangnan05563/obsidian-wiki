<div align="center">

<img src="docs/design/social-preview/github-social-preview.png" alt="Karpathy Wiki" width="640">

# Karpathy Wiki

**Karpathy AI 内容 × Obsidian 知识库 —— 本地优先的可问答智能 Wiki**

</div>

## 简介

Karpathy Wiki 是一个基于 Karpathy AI 理念构建的**本地优先**知识库系统。通过自研 LLM Agent 引擎（`@wiki/harness`），把原始资料自动**编译**为结构化 Markdown Wiki，支持双向链接、图谱可视化与知识问答。

核心闭环：**投递资料 → AI 编译 → 结构化页面 → 知识问答**

## 特性

- 🧠 **AI 编译引擎**：ReAct 式 Agent 工具循环，LLM 将原始资料编译为符合 SCHEMA 的结构化 Wiki 页面，支持 SSE 流式进度、断点续传与预算守卫
- 📚 **Obsidian 风格知识库**：Markdown + `[[双向链接]]`，自动生成目录索引与链接图
- 🕸️ **知识图谱**：基于 vis-network 的交互式图谱可视化
- 💬 **知识问答（RAG）**：检索知识库后流式回答，答案内嵌 `[[页面名]]` 引用，支持多会话
- 🩺 **知识体检**：检查孤立页面、断链等知识库健康问题
- 📊 **仪表盘**：页面总数、链接数、目录分布一目了然
- 🔑 **BYOK 模型配置**：自带 Key，支持智谱 GLM / 通义千问 / DeepSeek（OpenAI 兼容接口）
- 🔊 **TTS 朗读**：回答内容拟人化语音朗读
- 🌐 **SPA 部署管线**：前端静态资源安全发布（safe-delete 沙箱），并提供 Linux 部署脚本（`scripts/deploy-linux`）

## 架构

```
┌─────────────────────────────────────┐
│          前端 (Vue 3 + Vite)         │
│  仪表盘/投递/进度/浏览/问答/图谱/体检/配置 │
└──────────────┬──────────────────────┘
               │ HTTP + SSE
┌──────────────┴──────────────────────┐
│         后端 API (Fastify + TS)      │
│    routes / workflows / vault       │
└──────────────┬──────────────────────┘
               │
┌──────────────┴──────────────────────┐
│       @wiki/harness (Agent 引擎)     │
│  LLM 适配 / 工具循环 / 预算 / 重试     │
└──────────────┬──────────────────────┘
               │
        LLM API (GLM / Qwen / DeepSeek)
```

## 安装

### 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | >= 18 | [https://nodejs.org](https://nodejs.org) |
| pnpm | 任意（推荐） | `npm install -g pnpm`，未安装时脚本自动回退 npm |
| LLM API Key | — | 智谱 GLM / 通义千问 / DeepSeek 任选其一 |

### 一键安装

在 `karpathy-wiki` 目录下打开 PowerShell：

```powershell
.\scripts\install.ps1
```

脚本自动完成依赖安装、Vault 目录初始化（`entities/`、`concepts/`、`comparisons/`、`queries/`、`raw/`），并进入 4 步向导（确认 Vault 路径 → 选模型 + 输入 Key → SCHEMA 自动生成 → 完成）。

- 模型与路径配置写入 `api/config.json`（**不含** API Key）
- API Key 写入 `api/.env`（已被 git 忽略）

## 快速开始

```powershell
# 一键启动前后端（推荐）
.\scripts\start.ps1

# 或分终端手动启动
pnpm dev:api   # 后端 http://localhost:3000
pnpm dev:web   # 前端 http://localhost:5173
```

打开 <http://localhost:5173>，按核心闭环走一遍：

1. **投递资料** —— 粘贴 Markdown 文本或上传 `.md` 文件，点击「开始编译」
2. **编译进度** —— SSE 实时显示 AI 编译过程，完成后展示生成的页面
3. **知识浏览** —— 目录树 + Markdown 预览，支持在线编辑
4. **知识问答** —— 输入问题，AI 检索知识库后流式回答，含 `[[页面名]]` 引用

## 配置

| 文件 | 用途 |
| --- | --- |
| `api/config.json` | 模型、Vault 路径等业务配置（支持热加载） |
| `api/.env` | API Key（`GLM_KEY` / `QWEN_KEY` / `DEEPSEEK_KEY`），不进 git |
| `api/llm-presets.json` | 内置 LLM 预设 |
| `api/media-presets.json` | TTS 等媒体服务预设 |

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

## 致谢

- [Andrej Karpathy](https://github.com/karpathy) —— 项目理念来源
- [Obsidian](https://obsidian.md/) —— Markdown 知识库范式（双向链接）

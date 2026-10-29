<div align="center">

<img src="karpathy-wiki/assets/design/social-preview/github-social-preview.png" alt="Karpathy Wiki" width="640">

# Karpathy Wiki

**Karpathy AI 内容 × Obsidian 知识库 —— 本地优先的可问答智能 Wiki**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2022.19-339933?logo=nodedotjs)](https://nodejs.org/)
[![Vue](https://img.shields.io/badge/Vue-3.4-4FC08D?logo=vuedotjs)](https://vuejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-4-000000?logo=fastify)](https://www.fastify.io/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm)](https://pnpm.io/)

</div>

## 简介

Karpathy Wiki 是一个**本地优先**的智能知识库系统：灵感来自 Andrej Karpathy 的「Agent = LLM + Harness」理念，形态借鉴 Obsidian 的 Markdown + 双向链接范式。

它用自研的 LLM Agent 引擎把零散资料**编译**成符合 SCHEMA 的结构化 Wiki 页面，并在这些页面之上提供图谱、健康检查、数据清洗与 RAG 问答。数据全程留在本机 Vault 目录，模型自带 Key（BYOK）。

核心闭环：

```
投递资料 → AI 编译 → 结构化页面 → 知识问答
```

## 仓库结构

本仓库是多工程布局，根目录不设 npm 包，两个工程各自是独立 pnpm workspace：

```
.
├── karpathy-wiki/          # 应用工程（pnpm workspace：api + frontend）
│   ├── api/                # @karpathy-wiki/api —— Fastify 4 + TS 后端
│   ├── frontend/           # @karpathy-wiki/web  —— Vue 3 + Vite 前端（含移动端 Shell）
│   ├── scripts/            # 安装 / 启动 / 发布 / 部署脚本
│   ├── docs/               # 设计文档、SRS/HLD、术语表
│   └── assets/             # 设计稿与 GitHub 社交预览图
├── wiki-harness/           # @wiki/harness —— 轻量 LLM Agent 运行时（独立 workspace）
├── tooling/                # 治理脚本与性能测试（sonar 复核、TOC 校验、压测）
├── release/                # 统一发布产物目录（构建产物，已被 .gitignore 忽略）
└── logs/                   # 运行日志（同样不入库）
```

`karpathy-wiki/api` 通过 `file:../../wiki-harness` 引用 Agent 引擎，因此两个工程需保持同级摆放。

## 功能特性

- 🧠 **AI 编译引擎**：ReAct 式工具循环（`read_file` / `write_file` / `append_index` / `append_log`），SSE 流式进度、断点续传（resume）、预算守卫与上下文治理。
- 📥 **多形态投递**：文本、`.md`、单文件与文件夹批量上传、URL 抓取、书签导入、QQ 群聊导入；投递原件留存于 `raw/` 并可由本人下载。
- 📚 **Obsidian 风格 Vault**：原生 Markdown + `[[双向链接]]`；页面目录为 `entities / concepts / comparisons / queries / qa / solutions`，另有非页面目录 `raw`（投递原件存档）与 `drafts`，索引与日志自动维护。
- 💬 **知识问答（RAG）**：双路召回（FTS5 BM25 关键词 + BYOK embedding 语义）后流式回答，答案内嵌 `[[页面名]]` 引用，检索结果标注命中来源，支持多会话与线程记忆。
- 🕸️ **知识图谱**：基于 vis-network 的交互式关联图。
- 🩺 **知识体检 / 数据清洗**：孤立页、断链、重复标题等健康检查，配套批量修复作业与清理护栏（清理互斥、跨进程锁、写入口矩阵）。
- 🎙️ **播客与朗读**：把知识页生成播客脚本，回答支持 TTS 拟人朗读。
- 🖼️ **媒体生成**：生图 / 视频服务预设（BYOK）。
- 🔌 **MCP 接口**：把知识库能力暴露给外部 Agent（见 [MCP 接口说明](karpathy-wiki/docs/mcp-interface.md)）。
- 🌐 **隧道与 SPA 部署**：Tailscale Funnel 一键公网访问；前端产物由 `karpathy-wiki/api/_deploy_live.mjs` 以 safe-delete 沙箱发布到 `public_live_<时间戳>`，`/wiki/` 前缀由后端进程内注入桥转发。
- 🎨 **8 套界面主题 + 移动端 Shell**：商务浅白（默认）/ 暗色 / 马卡龙 / 现代企业 / 创意品牌 / 产品展示 / 电商零售 / 艺术作品集；移动端独立问答、浏览、聆听、投递与个人中心。
- 🔐 **多用户与部署模式**：登录 / 注册 / 用户管理，生产首登强制改密；`localOnly` 为本地调试模式（默认口令提示可见、不强制改密）。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Vue 3.4 + Vite、Element Plus 2.6、Pinia 2.1、vis-network 10、markdown-it 14、mermaid 11、marpit |
| 后端 | Fastify 4.26 + `@fastify/multipart` / `static` / `helmet` / `cors` / `rate-limit` / `compress`、undici 8 |
| Agent 引擎 | `@wiki/harness` 0.1.0（TS，工具循环 / 预算 / 重试 / 运行态持久化） |
| 文档解析 | gray-matter（frontmatter）、pdf-parse、adm-zip、pptxgenjs |
| 语言与工具链 | TypeScript 5.4、tsx、Vitest 1.6、pnpm workspace、PowerShell/Bash 脚本 |
| 模型 | 智谱 GLM / 通义千问 / DeepSeek 等 OpenAI 兼容接口，BYOK |

## 安装

### 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | >= 22.19 | 下限由后端依赖 `undici@8` 的 `engines` 决定（`chokidar@5` 需 >= 20.19）；开发与实测环境为 Node 24 |
| pnpm | 推荐 | 仓库锁定 `pnpm@11.12.0`；未安装时安装脚本自动回退 npm |
| LLM API Key | — | GLM / Qwen / DeepSeek 任选其一 |

### 一键安装（Windows）

在 `karpathy-wiki` 目录下打开 PowerShell：

```powershell
.\scripts\install.ps1
```

脚本依次完成依赖安装、Vault 目录初始化与 4 步向导（确认 Vault 路径 → 选模型 + 输入 Key → SCHEMA 提示 → 完成）；未检测到 pnpm 时自动回退 npm。

- Vault 子目录清单取自 `karpathy-wiki/scripts/vault-dirs.mjs`（`api/src/vault/page-scope.ts` 的镜像，两者一致性由 `api/test/vault-dirs-single-source.test.ts` 断言），安装脚本不再写死目录名。
- `SCHEMA.md` 不存在时由 API 首次启动的 `VaultService.init()` 自动生成，也可在「配置」页编辑。
- 模型与路径配置写入 `api/config.json`（**不含** API Key）。
- API Key 写入 `api/.env`，该文件已被根 `.gitignore` 排除。

### 手动安装

```bash
cd karpathy-wiki && pnpm install     # api + frontend
cd ../wiki-harness && pnpm install && pnpm build   # 生成 @wiki/harness 的 dist/
```

## 快速开始

```powershell
# 一键启动前后端（推荐）
.\scripts\start.ps1
```

```bash
# 或分终端启动
pnpm dev:api   # 后端 http://localhost:3000
pnpm dev:web   # 前端 http://localhost:5173
```

打开 <http://localhost:5173>，按核心闭环走一遍：

1. **投递资料** —— 粘贴文本、上传 `.md` 或整个文件夹，点击「开始编译」。
2. **编译进度** —— SSE 实时显示工具循环步骤，完成后结果卡给出产出页面与索引更新状态。
3. **知识浏览** —— 目录树 + Markdown 预览，支持在线编辑与双向链接跳转。
4. **知识问答** —— 提问后检索知识库流式作答，答案内嵌 `[[页面名]]` 引用。

## 配置

| 文件 | 用途 |
| --- | --- |
| `karpathy-wiki/api/config.json` | 业务配置，支持热加载；键含 `vaultPath`、`adapter`、`llm`、`budget`、`server`、`localOnly`、`healthCheck`、`tunnel`、`logging`、`webSearch`、`batch`、`mcp`、`knowledge`、`graph`、`refs` |
| `karpathy-wiki/api/config.example.json` | 配置样例（默认可参考此文件而非真实配置） |
| `karpathy-wiki/api/.env` | API Key（`GLM_KEY` / `QWEN_KEY` / `DEEPSEEK_KEY`），不进 git |
| `karpathy-wiki/api/llm-presets.json` | 内置 LLM 预设 |
| `karpathy-wiki/api/media-presets.json` | 生图 / 视频等媒体服务预设 |

> 前端「配置」页提供 AI 服务、联网搜索、生图/视频、工具（MCP/CLI/场景路由）、QQ 导入、隧道与主题等可视化入口；逐项脏标记，未保存不会静默覆盖。

## 构建与发布

```bash
cd karpathy-wiki
pnpm build                    # 各包 tsc / vite build
```

| 入口 | 作用 |
| --- | --- |
| `karpathy-wiki/scripts/一键发布.bat` | 构建 SPA → 部署到 `public_live_<时间戳>` → 重启生产服务 |
| `karpathy-wiki/scripts/publish-release.py` | 零依赖 GitHub Release 发布脚本：建 Release + 附带说明 md + 上传资产，凭据走 `GH_TOKEN` / git 凭据库，不落盘 |
| `karpathy-wiki/scripts/verify-publish.ps1` | 校验发布脚本自身的编码/格式规范（`.bat` 纯 ASCII + CRLF、`.ps1` UTF-8 BOM + 可解析） |
| `karpathy-wiki/scripts/deploy-linux/deploy.sh` | Linux 侧部署 |
| `karpathy-wiki/installer.iss` | Inno Setup 桌面安装包定义 |

SPA 资源根按动态顺序探测（`release/spa/public_live_*` 最新时间戳优先，逐级回退到 `frontend/dist`、`api/public` 等），`karpathy-wiki/api/src/spa-static.ts` 内注释维护该口径。

## 测试

```bash
cd karpathy-wiki
pnpm --filter @karpathy-wiki/web test     # 前端 Vitest
pnpm --filter @karpathy-wiki/api test     # 后端 Vitest
cd ../wiki-harness && pnpm test           # Agent 引擎（node --test）
```

类型门禁：前端 `vue-tsc --noEmit`（已并入 `pnpm --filter @karpathy-wiki/web build`），后端 `tsc --noEmit` 与 `tsc -p tsconfig.test.json --noEmit`。当前规模约为前端 928 例 / 后端 1294 例（以仓库内测试文件为准）。

## 文档

- [子工程 README（应用视角详解）](karpathy-wiki/README.md)
- [快速上手指南](karpathy-wiki/docs/GETTING_STARTED.md)
- [交付文档（架构与模块清单）](karpathy-wiki/docs/DELIVERY.md)
- [MCP 接口说明](karpathy-wiki/docs/mcp-interface.md)
- [媒体服务配置](karpathy-wiki/docs/media-config.md)
- [数据清洗 SRS](karpathy-wiki/docs/data-cleaning-SRS.md) / [HLD](karpathy-wiki/docs/data-cleaning-HLD.md)
- [术语表](karpathy-wiki/docs/术语表.md)

## 贡献指南

1. 从 `main` 切出分支（`git checkout -b feature/xxx`）。
2. 改动前后确保相关包 `pnpm build` 与测试通过；涉及 UI 的行为变更请用真机实测复验。
3. 提交信息写清动机与影响范围；一个提交只做一件事，便于按票回滚。
4. 仓库对临时产物有明确的忽略口径（`**/_smoke_*`、`_stale_js_quarantine/`、`**/test-batch*/`、`release/`、`logs/` 等均不入库；可复用的进程内冒烟入口 `_smoke_inject.mjs` 是显式例外）。新增临时产物请先补 `.gitignore` 规则或用后清理，并且提交前用 `git ls-files -i -c --exclude-standard` 确认没有把本应入库的已跟踪文件圈进来。
5. 触碰删除面/清理逻辑前请阅读 `karpathy-wiki/api/src/utils/cleanup-surface.ts` 的写入口矩阵——该文件是删除能力的单一口径。

> 项目仍在快速迭代，核心接口与配置 schema 可能随版本调整；较大改动建议先开 Issue 讨论。

## 致谢

- [Andrej Karpathy](https://github.com/karpathy) —— 项目理念来源
- [Obsidian](https://obsidian.md/) —— Markdown 知识库与双向链接范式
- [Element Plus](https://element-plus.org/) / [Vue](https://vuejs.org/) / [Fastify](https://www.fastify.io/) / [vis-network](https://visjs.github.io/vis-network/docs/network/) —— 核心技术栈

# 快速上手指南

Karpathy-AI + Obsidian 知识库 —— 15 分钟从零搭建到问答闭环。

> 本指南面向 Windows 用户（PowerShell）。macOS/Linux 用户可参照 `install.ps1` 逻辑手动执行。

---

## 1. 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | >= 18 | 下载 https://nodejs.org |
| pnpm | 任意（可选） | 未安装则自动回退 npm，建议安装：`npm install -g pnpm` |
| LLM API Key | — | 智谱 GLM / 通义千问 / DeepSeek 任选其一 |

无 TRAE CLI 依赖（V1.3 起默认使用自研 `@wiki/harness` 引擎）。

---

## 2. 一键安装（3 步）

### 步骤 1：打开终端

在 `karpathy-wiki` 目录下打开 PowerShell（右键 →「在终端中打开」）。

### 步骤 2：运行安装脚本

```powershell
.\scripts\install.ps1
```

脚本会自动完成：
1. 检查 Node.js 版本
2. 安装根目录 + `@wiki/harness` + 前后端依赖
3. 初始化 Vault 目录结构（`entities/`、`concepts/`、`comparisons/`、`queries/`、`raw/`）
4. 启动**向导式初始化**（4 步交互）

### 步骤 3：向导式初始化（跟随提示）

```
步骤 1/4：确认 Vault 路径（默认 ./vault，回车即可）
步骤 2/4：选择模型（1=GLM / 2=Qwen / 3=DeepSeek）+ 输入 API Key
步骤 3/4：SCHEMA.md 将在首次启动时自动生成
步骤 4/4：完成
```

向导结束后：
- `services/api/config.json` —— 模型与路径配置（**不含** API Key）
- `services/api/.env` —— API Key（已排除 git 跟踪，M-7 安全要求）

> 若跳过了 API Key 输入，可稍后手动编辑 `services/api/.env`，添加一行：
> `GLM_KEY=你的实际Key`

---

## 3. 启动服务

### 方式 A：一键启动（推荐）

```powershell
.\scripts\start.ps1
```

会自动弹出两个终端窗口分别运行前后端，并加载 `.env` 环境变量。

### 方式 B：分终端启动

```powershell
# 终端 1 — 后端
pnpm dev:api

# 终端 2 — 前端
pnpm dev:web
```

> 未安装 pnpm 时用 `npm run dev:api` / `npm run dev:web`。

### 访问地址

| 服务 | 地址 |
| --- | --- |
| 前端 Web | http://localhost:5173 |
| 后端 API | http://localhost:3000 |
| 健康检查 | http://localhost:3000/health |

---

## 4. 核心使用流程

打开 http://localhost:5173 ，顶部导航栏提供 8 个功能模块：

```
仪表盘 → 投递资料 → 编译进度 → 知识浏览 → 知识问答 → 图谱 → 体检 → 配置
```

### 4.1 首次闭环：投递 → 编译 → 问答

**① 仪表盘**（默认首页）
- 显示页面总数、链接数、目录分布
- 4 个快捷入口：投递 / 浏览 / 问答 / 体检

**② 投递资料**
- 粘贴 Markdown 文本（或上传 `.md` 文件）
- 点击「开始编译」→ 自动跳转「编译进度」

**③ 编译进度**
- 实时 SSE 流式显示 AI 编译过程
- 完成后展示生成的页面列表

**④ 知识浏览**
- 左侧目录树，右侧 Markdown 预览
- 支持在线编辑页面内容并保存

**⑤ 知识问答**
- 输入问题，AI 检索知识库后流式回答
- 回答中含 `[[页面名]]` 双向链接引用
- 支持 Ctrl+Enter 快速发送

### 4.2 辅助模块

**⑥ 图谱**：vis-network 可视化双向链接网络，按目录着色
**⑦ 体检**：检测孤儿页面、断链、过期页面
**⑧ 配置**：
  - SCHEMA 编辑器（直接修改 `SCHEMA.md`）
  - 系统配置展示（模型、预算、端口等）
  - API Key 状态检查

---

## 5. API Key 配置说明

### 安全模型（M-7）

```
config.json   →  仅存 apiKeyRef（环境变量名，如 "GLM_KEY"）
.env           →  存实际 Key（已 .gitignore）
运行时         →  process.env[apiKeyRef] 读取
```

### 切换模型

编辑 `services/api/config.json`：

```json
{
  "llm": {
    "provider": "qwen",
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "model": "qwen-plus",
    "apiKeyRef": "QWEN_KEY"
  }
}
```

同时在 `services/api/.env` 添加对应 Key：

```
QWEN_KEY=你的千问Key
```

重启后端生效。

### 支持的模型

| provider | baseUrl | model | apiKeyRef |
| --- | --- | --- | --- |
| glm | https://open.bigmodel.cn/api/paas/v4 | glm-4-plus | GLM_KEY |
| qwen | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-plus | QWEN_KEY |
| deepseek | https://api.deepseek.com | deepseek-chat | DEEPSEEK_KEY |

---

## 6. 常见问题（FAQ）

### Q1：启动后问答报 401 / API Key 错误

**原因**：`.env` 中 API Key 未配置或错误。

**解决**：
```powershell
# 检查 .env
Get-Content services\api\.env
# 应包含：GLM_KEY=你的实际Key
```
若无，手动创建或重跑 `.\scripts\install.ps1`。

### Q2：前端打开空白 / 连接超时

**原因**：后端未启动。

**解决**：确认 `http://localhost:3000/health` 返回 `{"ok":true}`。

### Q3：端口被占用

修改 `services/api/config.json` 中 `server.port`，前端 `vite.config.ts` 中代理目标同步修改。

### Q4：编译后没有生成页面

**原因**：API Key 无效或 LLM 调用失败。

**解决**：查看后端终端日志，确认 LLM 返回正常。可在「体检」页检查知识库状态。

### Q5：如何重置知识库

删除 `vault/` 目录后重启后端，`VaultService.init()` 会重建空目录与默认 SCHEMA.md。

### Q6：install.ps1 执行被策略阻止

```powershell
# 临时放开执行策略（当前会话）
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\install.ps1
```

---

## 7. 项目结构速览

```
karpathy-wiki/
├── packages/web/          前端（Vue 3 + Vite + Element Plus）
├── services/api/          后端（Fastify + @wiki/harness）
│   ├── src/
│   │   ├── routes/        REST 路由（8 个）
│   │   ├── workflows/     compile / query 工作流
│   │   ├── vault/         Vault 文件服务
│   │   └── prompts/       prompt 单点存储
│   ├── vault/             知识库内容（运行时生成）
│   ├── config.json        配置（模型/路径/预算）
│   └── .env               API Key（不入仓库）
├── scripts/
│   ├── install.ps1        一键安装 + 向导
│   └── start.ps1          一键启动
└── GETTING_STARTED.md     本文件
```

---

## 8. 下一步

- 阅读《Karpathy-AI+Obsidian知识库概要设计说明书》了解架构设计
- 在「配置」页定制 SCHEMA.md 规范
- 持续投递资料，让知识库自动生长

如有问题，先查「体检」模块的诊断报告。

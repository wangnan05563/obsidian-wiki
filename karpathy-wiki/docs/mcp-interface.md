# Karpathy Wiki MCP 接口文档

本服务以 **MCP（Model Context Protocol）Server** 形式暴露知识库能力，供外部 AI Agent（如 Claude Code、Cursor、Cline 等支持 MCP 客户端接入的工具）进行知识库的**查询、检索、维护与增强**，实现"借助外部 AI Agent 全方位维护知识库"。

- 传输：Streamable HTTP（`POST /mcp`，纯 JSON-RPC 2.0，服务端始终回 `application/json`）
- 默认协议版本：`2025-03-26`
- 鉴权：配置式 Bearer Token 双轨鉴权（读工具 / 写工具分级授权）
- 工具总数：**15 个**（查询检索类 8 + 维护增强类 7）

> 本文档对应后端实现：`api/src/mcp/`（`json-rpc.ts`、`tools.ts`）与 `api/src/routes/mcp-route.ts`。

---

## 1. 启用配置

MCP 默认**关闭**。在 `api/config.json` 的 `mcp` 段开启并把 `authenticated` 设为 `true`：

```json
{
  "mcp": {
    "enabled": true,
    "endpointPath": "/mcp",
    "name": "karpathy-wiki",
    "version": "1.0.0",
    "userToken": "在此填入只读 Token（不透传给客户端之外的人）",
    "adminToken": "在此填入写操作 Token（权限更高，务必保密）",
    "authenticated": true
  }
}
```

复制的参考模板见 `api/config.example.json` 的 `mcp` 段。

### 配置项说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `false` | 是否启用 MCP 端点。未启用时访问返回 `503` |
| `endpointPath` | string | `/mcp` | HTTP 端点路径，可自定义避免与现有路由冲突 |
| `name` | string | `karpathy-wiki` | 对客户端展示的服务名（`initialize` 返回 `serverInfo.name`） |
| `version` | string | `1.0.0` | 对客户端展示的版本号 |
| `userToken` | string | `''` | 读/查询类工具的 Bearer Token |
| `adminToken` | string | `''` | 写/维护类工具的 Bearer Token；未配置时写工具回退校验 `userToken` |
| `authenticated` | boolean | `true` | 是否要求鉴权。`false` 且未配置任何 token 时，对端点开放全部工具（仅建议内网使用） |

**鉴权规则（双轨）：**

- 读工具（8 个）可用 `userToken` **或** `adminToken` 访问
- 写工具（7 个）必须用 `adminToken`；未配置 `adminToken` 时回退用 `userToken`
- 鉴权失败统一返回 HTTP `401`，错误码 `-32801`
- 配置 `authenticated: false` **且** 未配置任何 token → 开放全部工具（内网自用）

请求时在请求头携带：`Authorization: Bearer <token>`

---

## 2. 支持的 JSON-RPC 方法

| 方法 | 说明 |
|------|------|
| `initialize` | 握手，返回协议版本、能力（`tools`）与服务信息 |
| `notifications/initialized` | 客户端初始化完成通知（无响应，返回 `202`） |
| `ping` | 存活探测，返回 `{}` |
| `tools/list` | 列出全部 15 个工具（名称/描述/输入 schema） |
| `tools/call` | 调用指定工具（参数 `{ name, arguments }`），返回 `content` + `isError` |

> 当前**不支持并行/批量请求**（JSON-RPC batch 会被拒绝，错误码 `-32600`）。`initialize` 响应即表明服务端就绪（`serverInfo`），后续可直接 `tools/list`。

---

## 3. 工具清单（15 个）

### 3.1 查询 / 检索类（读，8 个）

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `vault_list_pages` | 列出全部正式页面（路径/名称/目录/frontmatter） | 无 |
| `vault_get_tree` | 获取知识库目录树 | `dir`（可选） |
| `vault_search` | 全文检索，支持 source/type 过滤 | `q`（必填）、`limit`、`source`、`type` |
| `vault_read_page` | 读取单页（frontmatter + 正文） | `path` |
| `vault_find_page` | 按页面名（含 `[[双链]]`）解析实际路径 | `title` |
| `kb_stats` | 总页数 / 链接数 / 各目录页数 | 无 |
| `llm_query` | 跨库智能问答（调用大模型综合检索回答） | `question` |
| `tags_list_pending` | 列出待审核标签建议的页面 | 无 |

### 3.2 维护 / 增强类（写，7 个）

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `vault_write_page` | 写入/覆盖页面 Markdown（含 frontmatter） | `path`、`content` |
| `vault_create_page` | 新建页面（自动补 `.md` 与 frontmatter 骨架） | `dir`、`name`、`title`、`body` |
| `vault_delete_page` | 删除页面文件 | `path` |
| `vault_ingest_raw` | 归档原稿到 `raw/`（文件名安全化，防路径穿越） | `filename`、`content` |
| `vault_compile` | 触发编译工作流（文本 → 知识页面） | `content`、`rawPath` |
| `tags_suggest` | AI 为页面生成标签并写入 `frontmatter.ai_tags` | `path` |
| `tags_confirm` | 确认某条标签建议（`ai_tags` → `tags`，去重合并） | `path`、`tag` |

> 所有路径参数经**白名单目录校验 + `..` 越界拦截**双重护栏，防止路径穿越。可写目录白名单：`raw`、`entities`、`concepts`、`comparisons`、`queries`、`drafts`、`qa`、`solutions`。

---

## 4. 接入示例

### 4.1 用 curl 探测（读工具）

```bash
# 1) 握手
curl http://localhost:3000/mcp \
  -H "Authorization: Bearer <userToken>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# 2) 列出工具
curl http://localhost:3000/mcp \
  -H "Authorization: Bearer <userToken>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 3) 调用读工具（全文检索）
curl http://localhost:3000/mcp \
  -H "Authorization: Bearer <userToken>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"vault_search","arguments":{"q":"知识图谱"}}}'
```

### 4.2 调用写工具（需 adminToken）

```bash
curl http://localhost:3000/mcp \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"vault_create_page","arguments":{"dir":"entities","name":"deepseek-r1","title":"DeepSeek R1","body":"### 概述\n..."}}}'
```

### 4.3 通用 MCP 客户端

凡支持"远程 streamable HTTP / MCP server URL"形式接入的 MCP 客户端（Claude Desktop、Cline、Continue 等），将服务地址填为 `http://<host>:3000/mcp`，并在 HTTP 头注入 `Authorization: Bearer <token>`（部分客户端在配置里提供 `headers` 字段）。各客户端具体配置语法以其文档为准。

---

## 5. 安全注意事项

- **Token 即权限**：`userToken` 对知识库只读；`adminToken` 可写/删/编译页面。请务必用环境变量或密钥管理方式注入 `config.json`，**不要提交到版本库**。
- **保持 `authenticated: true`**：仅当服务只在本机/可信内网时，才可关闭鉴权。公网暴露务必启用 token 并在服务外层加网关鉴权。
- **写操作有 LLM 开销**：`llm_query`、`vault_compile`、`tags_suggest` 会调用大模型，消耗 API 配额；请按客户端调用频率监控用量。
- **编译是异步流式过程**：`vault_compile` 返回编译步骤摘要（`done` 与各步 `steps`），长文本编译耗时较长，客户端应设置合理超时（建议 ≥120s）。
- 端点受后端全局限流保护（`tools/call` 等写路径按默认限流策略执行），高频调用请合理设计客户端节流。
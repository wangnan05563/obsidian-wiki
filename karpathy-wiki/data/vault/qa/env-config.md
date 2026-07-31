---
title: 如何配置环境变量？
type: qa
created: 2026-07-27
updated: 2026-07-27
source: qq-chat:f1da6d5e-5a7f-4b39-93b4-248f4078c839
tags: [配置, 环境变量, 最佳实践, .env]
status: published
confidence: medium
contested: false
answerer: 李四
ts: 2026-07-20T14:30:20Z
original_refs:
  - "如何配置环境变量？请详细说明步骤。"
  - "在 .env 文件中添加 CONFIG_KEY=value 即可，重启服务后生效。"
---

## 问题

如何配置环境变量？请详细说明步骤。

## 答案

在 `.env` 文件中添加 `CONFIG_KEY=value` 即可，重启服务后生效。

## 详细说明

### 步骤

1. **找到或创建 `.env` 文件**  
   通常在项目的根目录下。若不存在，手动创建一个 `.env` 文件。

2. **添加环境变量**  
   按 `KEY=VALUE` 格式逐行添加，例如：
   ```
   DB_HOST=localhost
   DB_PORT=5432
   API_KEY=your-secret-key
   ```

3. **保存文件**  
   保存 `.env` 文件到项目根目录。

4. **重启服务**  
   重新启动应用或服务，使新的环境变量生效。

### 注意事项

- `.env` 文件**不应提交到版本控制**（应加入 `.gitignore`），因其可能包含敏感信息。
- 不同语言/框架加载 `.env` 的方式不同，通常依赖 [[env-file-spec|.env 文件规范]] 中描述的工具（如 `dotenv` 库）。

## 参见

- [[环境变量管理]] — 环境变量的加载策略与最佳实践
- [[env-file-spec|.env 文件规范]] — `.env` 文件的命名与格式约定

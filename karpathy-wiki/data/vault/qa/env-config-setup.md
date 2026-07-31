---
title: 如何配置环境变量？详细步骤说明
type: qa
created: 2026-07-27
updated: 2026-07-27
source: qq-chat:3c970c77-d96c-4bd0-b2db-afb72a51124d
tags: [配置, 环境变量, .env]
status: published
confidence: medium
contested: false
answerer: 李四
ts: 2026-07-20T14:30:20Z
original_refs:
  - "如何配置环境变量？请详细说明步骤。"
  - "在 .env 文件中添加 CONFIG_KEY=value 即可，重启服务后生效。"
---

# 如何配置环境变量？详细步骤说明

## 问题

如何配置环境变量？请详细说明步骤。

## 答案

在 `.env` 文件中添加 `CONFIG_KEY=value` 即可，重启服务后生效。

## 详细说明

环境变量是应用程序运行时的重要配置手段，通常用于管理数据库连接串、API Key、密钥等敏感信息。推荐使用 `.env` 文件进行管理。

### 配置步骤

1. 在项目根目录创建 `.env` 文件（如已存在则跳过）
2. 按 `KEY=value` 格式添加配置项，例如：
   ```bash
   DATABASE_URL=postgres://user:pass@localhost:5432/db
   API_KEY=sk-xxxxxx
   APP_ENV=production
   ```
3. 确保 `.env` 文件已加入 `.gitignore`，避免敏感信息泄露
4. 重启应用服务使新配置生效

### 注意事项

- 不同的编程语言/框架加载 `.env` 的方式可能不同（如 Node.js 使用 `dotenv` 包，Python 使用 `python-dotenv`）
- 不要在 `.env` 中使用引号包裹值（除非值本身包含特殊字符）
- 生产环境建议通过容器/云平台的环境变量管理功能注入，而非直接使用 `.env` 文件

## 关联页面

- [[项目配置最佳实践]] — 更全面的项目配置管理方案
- [[.env 文件规范]] — `.env` 文件的格式与安全注意事项

## 原文引用

> 如何配置环境变量？请详细说明步骤。

> 在 .env 文件中添加 CONFIG_KEY=value 即可，重启服务后生效。

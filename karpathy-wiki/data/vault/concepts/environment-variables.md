---
title: 环境变量
type: concept
created: '2026-07-27'
updated: '2026-07-27'
source: '通用知识'
tags:
  - 环境变量
  - 配置管理
  - 运维
---
## 概述

**环境变量**（Environment Variables）是操作系统或应用运行时环境中保存的动态键值对，用于在不修改代码的情况下改变程序行为。常见用途包括数据库连接信息、API 密钥、运行模式（开发/生产）等。

## 常见配置方式

- **系统级环境变量**：通过 `export`（Linux/macOS）或 `set`（Windows）设置，影响整个用户会话
- **`.env` 文件**：项目级别的环境变量文件，常配合 `dotenv` 类库加载，方便本地开发和测试
- **容器/云平台环境变量**：Docker、Kubernetes、云服务商控制台提供独立的环境变量配置入口

## 最佳实践

- 敏感信息（密码、Token）不应硬编码在代码中，应通过环境变量注入
- `.env` 文件应加入 `.gitignore`，避免泄露
- 为不同环境（dev/staging/prod）维护独立的配置文件

## 相关页面

- [[qa/env-config|如何配置环境变量？请详细说明步骤。]]
- [[frontmatter-spec]]

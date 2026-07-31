---
title: .env 文件规范
type: concept
created: 2026-07-27
updated: 2026-07-27
source: qq-chat:3c970c77-d96c-4bd0-b2db-afb72a51124d
tags: [配置, 环境变量, .env, 规范]
---

# .env 文件规范

`.env` 文件是一种广泛使用的项目配置管理方式，用于存储环境变量。

## 基本格式

每条配置占一行，格式为 `KEY=value`：

```bash
DATABASE_URL=postgres://localhost:5432/mydb
SECRET_KEY=abc123def456
```

## 安全注意事项

- **必须**将 `.env` 加入 `.gitignore`，避免提交到版本控制系统
- 为每个团队成员提供 `.env.example` 模板（不含真实敏感值）
- 生产环境优先使用容器编排工具（如 Docker/K8s Secret）或云平台的环境变量管理

## 关联页面

- [[env-config-setup]] — 环境变量配置的详细步骤
- [[项目配置最佳实践]] — 项目配置的综合管理方案

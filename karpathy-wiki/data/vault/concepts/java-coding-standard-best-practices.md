---
title: Java 编码规范最佳实践
type: concept
created: 2025-05-22
updated: 2025-05-22
source: raw/wiki-batch-1784698696023-10-____-Java____.md
tags: [java, coding-standard, best-practice, programming]
---

# Java 编码规范最佳实践

**Java 编码规范最佳实践**总结了 Java 开发中普遍认可的编码规范和经验法则，包括命名约定、代码结构、设计原则等方面的指导。

## 核心原则

### 命名规范
- 类名使用 **UpperCamelCase**（如 `UserService`, `OrderFactory`）
- 方法名、变量名使用 **lowerCamelCase**（如 `getUserById()`, `userName`）
- 常量使用全大写 + 下划线（如 `MAX_RETRY_COUNT`）
- 包名使用全小写（如 `com.company.project.module`）

### 代码质量
- 遵循 [[OOP]] 设计原则（SOLID、DRY、KISS）
- 合理使用设计模式，在命名中体现（如 `OrderFactory`, `LoginProxy`）
- 避免魔法数字，使用常量代替

## 知名编码规范

- [[恒生电子 Java 编码规范]] — 恒生电子企业级 Java 编码规范
- [[阿里巴巴 Java 开发手册]] — 业界广泛采用的 Java 开发规范

## 相关概念

- [[代码质量]]
- [[代码审查]]
- [[软件工程最佳实践]]

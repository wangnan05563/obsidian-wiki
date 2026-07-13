---
title: Harness
type: concept
created: 2025-01-06
updated: 2025-01-06
source: raw/input-1783482064470.md
tags: [llm, agent, runtime, tool-calling]
---

# Harness

**Harness** 是 [[LLM Wiki]] 系统中的 LLM Agent 运行时组件。它包裹大语言模型，为其提供一套完整的运行支撑能力。

## 核心能力

- **工具调用循环** — 管理 LLM 与外部工具的交互流程
- **状态管理** — 维护 Agent 对话与执行状态
- **重试机制** — 在失败时自动重试调用
- **预算控制** — 限制 token 消耗，控制成本

## 核心公式

> **Agent = LLM + Harness**

即：一个完整的 AI Agent 由底层大语言模型（LLM）和上层运行时框架（Harness）共同构成。Harness 赋予了 LLM 与环境交互、持续运行的能力。

## 与 Vault 的关系

Harness 负责调用 LLM 执行编译任务，而 [[vault]] 负责存储编译结果。二者共同构成 [[LLM Wiki]] 的核心架构。

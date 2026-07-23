---
title: 稠密模型
type: concept
created: 2025-01-01
updated: 2025-01-01
source: raw/input-1783497121180.md
tags: [神经网络, 密集参数, 模型架构]
---

# 稠密模型

**稠密模型（Dense Model）** 是一种传统的神经网络架构，在推理时激活全部参数。与 [[mixture-of-experts|Mixture of Experts]] 的稀疏激活方式不同，稠密模型的计算成本与总参数量严格正相关。

## 特点

- 所有参数在每次前向传播中均被使用
- 参数量与计算量成正比
- 训练和推理的实现相对简单
- 参数扩展成本随模型规模线性增长

## 与 MoE 对比

稠密模型通常作为 MoE 架构的基线对照：在相同总参数量下，MoE 的推理成本更低；在相同推理成本下，MoE 可以拥有更多参数从而获得更好性能。

## 与嵌入的关系

稠密模型是 [[embedding|嵌入（Embedding）]] 技术的底层架构基础——嵌入模型通常基于稠密模型将输入数据映射为稠密向量表示。

---

## 关联页面

- [[mixture-of-experts|Mixture of Experts]] — 稀疏激活的替代架构
- [[embedding|嵌入（Embedding）]] — 基于稠密模型生成的向量表示技术

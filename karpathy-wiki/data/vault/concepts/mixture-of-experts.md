---
title: Mixture of Experts 混合专家模型
type: concept
created: "2024-05-20"
updated: "2024-05-20"
source: "raw/file1.md"
tags: [MoE, 稀疏激活, 深度学习架构, 路由器, 专家子网络]
---

# Mixture of Experts (MoE) 混合专家模型

MoE (Mixture of Experts) 是一种先进的深度学习架构，主要用于提升大语言模型的训练和推理效率。其核心思想是将大规模参数分散到多个独立的“专家”子网络中，并通过路由器机制决定每个输入具体由哪些专家处理，从而实现**稀疏激活**。

## 核心组件

*   **Router (路由器)**：负责分析输入数据，并将其分配给最合适的专家子模型。
*   **Experts (专家子网络)**：由多个独立的子模型组成，各自擅长处理特定类型或特征的数据。
*   **Aggregation (聚合层)**：将各个被选中的专家输出的结果，按照路由器的权重进行加权组合，得到最终的输出。

## 与稠密模型 (Dense Model) 的对比

传统的稠密模型在每一次前向传播时都需要激活全部参数，计算成本高昂。相比之下，MoE 仅激活总参数中的一小部分（即特定的几个专家），极大地降低了推理成本并提升了扩展性。更多信息可查阅 [[dense-model]]。

## 代表应用

目前许多主流的大语言模型（LLM）都采用了 MoE 架构来增强性能，例如：
*   **GShard**
*   **Switch Transformer**
*   **Mixtral**

## 关联概念
*   [[router]]
*   [[sparse-activation]]
*   [[aggregation-layer]]

# Mixture of Experts 混合专家模型

MoE 是一种稀疏激活架构，通过路由器将输入分配给多个专家子模型。

## 核心组件
- Router 路由器：决定输入交给哪个专家
- Experts 专家子网络：多个独立子模型，各擅长特定输入
- Aggregation 聚合层：按路由权重组合专家输出

## 与稠密模型对比
稠密模型（Dense Model）激活全部参数，MoE 仅激活部分专家，实现稀疏激活，降低推理成本。

## 代表应用
GShard、Switch Transformer、Mixtral 等大语言模型采用 MoE 架构。
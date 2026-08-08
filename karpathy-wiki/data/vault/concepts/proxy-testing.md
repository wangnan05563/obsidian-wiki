---
title: Proxy Testing
type: concept
created: 2025-01-22
updated: 2025-01-22
source: raw/proxy-test2.md
tags: [proxy, testing, network, methodology]
---

# Proxy Testing

**Proxy Testing** 是指对代理服务器（Proxy Server）进行连通性、转发效率、安全性和稳定性验证的方法论。

## 概述

代理测试通常涉及对代理服务的中间人转发能力进行验证。一个典型的测试用例如 [[Proxy Test 2]]。

## 测试要点

- **连通性**：代理服务是否能够成功建立连接
- **转发正确性**：请求与响应是否被正确转发
- **延迟与性能**：代理引入的额外延迟
- **安全性**：代理是否泄露源 IP 或其他敏感信息

## 相关概念

- [[Proxy Test 2]] — 一个具体的代理测试用例

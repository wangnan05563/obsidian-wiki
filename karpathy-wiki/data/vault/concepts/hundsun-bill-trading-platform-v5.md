---
title: HUNDSUN票据交易管理平台V5.0
type: concept
created: 2025-01-20
updated: 2025-01-20
source: raw/HUNDSUN__________V5.0-______.md
tags: [恒生电子, 票据交易, 金融科技, 后端开发, 微服务]
---

# HUNDSUN票据交易管理平台V5.0

**HUNDSUN电子商业汇票综合处理平台V5.0**（简称 HUNDSUN 票据平台）是恒生电子推出的票据交易后端开发平台，采用分层架构设计，支持个性化需求开发和适配器（Adapter）扩展。

## 架构分层

平台采用经典的四层架构：

| 层级 | 职责 | 技术栈 |
| --- | --- | --- |
| **前端层** | 数据展示与操作交互 | Vue.js（HUI 框架） |
| **控制层** | 接收请求、调用服务、返回结果 | Spring Boot（`@RestController`），继承 `BaseController` |
| **服务层** | 业务服务 / 公共服务 / 基础服务 | `@CloudService`、`@CloudComponent` |
| **原子层** | 服务内容的最小逻辑单元 | 原子组件组合出完整业务服务 |
| **数据访问层** | 数据库与缓存操作 | MyBatis + Redis |

### 前端开发

- 框架：基于 Vue.js 的 HUI 前端框架
- 页面路径：`src/views/bizViews/banks/xxbank/一级模块编号/二级模块编号/`
- 支持 UI 组件发布

### 控制层开发

- 工程命名：`xxbank-biz-ar`
- 包路径：`com.hundsun.bemp.xxbank.biz`
- 必须继承 `BaseController`
- 使用 `@RequestMapping` 注解定义访问 URL 和方法

### 服务层开发

- **业务服务**：满足业务办理需求
- **公共服务**：供业务服务复用的偏业务功能
- **基础服务**：供业务/公共服务复用的偏技术/平台功能

创建服务工程 `xxbank-biz-as`，接口工程 `xxbank-biz-api`，包路径 `com.hundsun.bemp.xxbank.biz`。

### 数据访问层

- 集成 MyBatis 开源组件
- 缓存采用 Redis 中间件
- 自动生成 POJO 和映射文件（`mybatis-generator`）

## 功能改造

### 前端传参改造

- DTO 中如有预留字段直接使用
- 否则继承产品定义的 [[BaseDto]]（含三个预留字段 `reserve1`/`reserve2`/`reserve3`）

### 数据库字段保存改造

- 各业务模块表已添加预留字段
- 超过三个字段时可将多个字段转为 JSON 或逗号分隔保存

### 服务层/原子层/DAO 层改造

- 新建 Java 类继承产品部原有类
- 添加 `@CustomizedBean` 注解表示个性化扩展，将替换产品部原功能
- 可重写父类方法（`super.get(req)` 复用或拷贝改造）
- 注册为 Spring Bean 的方式：
  - 非微服务：添加 `@Service` 等注解
  - 微服务：添加 `@CloudComponent`，必须 `implements` 原接口

## Adapter（通讯适配）开发

Adapter 模块负责系统间通讯适配，分为两大场景：

### Bemp 调用外部系统（Client 方）

1. **接口定义**：在 `bemp-adapter-client-api` 中定义操作码（OpCode）和泛型 DTO
2. **路由配置**：三层路由（全局 > 模块 > 功能点），配置文件路径 `served/conf/src/main/resources/adapter/clientroute/`
3. **扩展实现**：
   - 自定义请求通道：实现 `ServiceReqChannel`
   - 自定义转换器：当前仅提供 JSON
   - 自定义连接通道

### 外部系统调用 Bemp（Server 方）

1. **路由配置**：在 `bemp-conf/resources/adapter/serviceroute/` 中配置 `*.serviceroute.xml`
2. **配置项**：`moduleName`、`opCode`（交易号）、`serverConverter`（转换器）、`functionId`（服务编号）

### 个性化接口开发

当产品不能满足对接需求时，由项目组创建适配模块：
- `xxbank-adapter-api`：适配器接口工程
- `xxbank-adapter-as`：适配器服务工程
- `xxbank-conf`：个性化配置工程

**配置生效原则**：个性化功能点 > 产品功能点 > 个性化模块 > 产品模块 > 个性化全局 > 产品全局

## 部署配置

### 配置中心参数

| 场景 | 参数 | 说明 |
| --- | --- | --- |
| WebService 请求 | `adapter.wsoutchannel_wsdl_address` / `operation` / `namespace_uri` | 连接外围 WebService |
| Socket 请求 | `adapter.socket_client_ip` / `socket_client_timeout` | Socket 连接 |
| HTTP 请求 | `adapter.http_client_address` | HTTP 客户端地址 |
| WebService 服务端 | `adapter.is_open_webservice_server` / `adapter.webservice_base_address` | 发布 WS 标准接口 |
| Socket 服务端 | `adapter.is_open_socket_server` / `adapter.socket_server_port` | Socket 服务发布 |

### 打包发布

新增工程 `xxbank-adapter`，配置 pom.xml 依赖，打包为 WAR 包部署。

## 相关链接

- [[BaseDto]] — 预留字段 DTO 基类
- [[恒生电子]] — 平台开发商恒生电子
- [[电子商业汇票综合处理平台]] — 恒生电子票据业务管理总线系统
- [[hundsun-bill-trade-v5-frontend]] — 本平台前端开发指导

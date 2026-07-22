---
title: BaseDto
type: concept
created: 2025-01-20
updated: 2025-01-20
source: raw/wiki-batch-1784698527259-6-HUNDSUN__________V5.0-______.md
tags: [恒生电子, DTO, 数据对象, 票据平台]
---

# BaseDto

**BaseDto** 是 [[HUNDSUN票据交易管理平台V5.0]] 中定义的基类 DTO（数据传输对象），主要用于个性化开发场景下的参数传递。

## 结构

```java
public class BaseDto implements Serializable {
    private static final long serialVersionUID = 1988052246401885570L;
    
    private String reserve1;  // 保留字段1，个性化开发使用
    private String reserve2;  // 保留字段2，个性化开发使用
    private String reserve3;  // 保留字段3，个性化开发使用
}
```

## 用途

- 为个性化开发预留三个扩展字段（`reserve1`/`reserve2`/`reserve3`）
- 产品部自身代码逻辑不使用这些保留字段
- 当新增前端传参或数据库字段时，可直接使用预留字段，无需修改表结构

## 扩展方式

- 单个字段：直接放入预留字段
- 多字段（超过3个）：将多个字段转换为 JSON 字符串或逗号分隔形式存入单个预留字段

## 相关链接

- [[HUNDSUN票据交易管理平台V5.0]] — 所属平台
- [[hundsun]] — 恒生电子

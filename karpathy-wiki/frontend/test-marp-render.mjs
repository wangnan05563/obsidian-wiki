// 测试 marp-core 渲染用户提供的 PPT markdown，定位渲染失败根因
import { Marp } from '@marp-team/marp-core';

const markdown = `---
marp: true
theme: default
type: query
output_mode: ppt
generated_at: 2026-07-29T16:13:34.084Z
question: 票交所接口文档1.4都更新了哪些内容
---

# 票交所接口规范 V1.4 更新内容

从通用信息、交易分册、公共控制三大维度解读

---

## 目录

1. 版本背景概述
2. 通用信息分册 V1.4 更新
3. 票据交易分册 V1.4 更新
4. 公共控制分册 V1.4 更新
5. 总结

---

## 版本背景概述

- 票交所直连接口规范于 **2026年6月** 统一发布 V1.4
- 涵盖通用信息、交易分册、公共控制三本分册
- V1.0（2021年5月）以来历经七次修订
- 详见 [[中国票据业务系统直连接口规范-通用信息分册]]

---

## 通用信息分册 V1.4 更新

- **新增**：批量背书子票区间下发功能
- **新增**：主动付款业务场景
- **新增报文**：CIM.034.001 与 CIM.035.001
- **新增场景**：参与者票据清单查询（含申请与应答）
- 详见 [[中国票据业务系统直连接口规范-通用信息分册]]

---

## 票据交易分册 V1.4 更新

- **字段调整**："信用主体类型/信用主体"改为"贴现行类型/贴现行机构代码"
- **报文清理**：意向询价、点击成交、匿名点击报文删除旧字段
- 覆盖转贴现、质押式回购、买断式回购三类业务
- 详见 [[票据交易分册接口规范]]

---

## 公共控制分册 V1.4 更新

- **新增功能**：支持查询背书转让的通用确认报文
- 调整扩展信息组件字段属性值类型为 UnType
- 14 种公共控制报文（CCM.001 ~ CCM.014）保持不变
- 详见 [[票据业务系统公共控制接口规范]]

---

## 总结

- **通用信息分册**：新增批量背书、主动付款及两个报文
- **交易分册**：调整贴现行字段，清理旧报文字段
- **公共控制分册**：扩展背书转让查询支持
- 三本分册同步升级至 V1.4，提升系统兼容性

---

## 谢谢

感谢阅读

如需详细报文结构，请查阅各分册原文`;

console.log('=== 测试 1: 模拟前端配置 (html: true, emoji) ===');
try {
  const marp = new Marp({ html: true, emoji: { shortcode: true, unicode: true } });
  const { html, css } = marp.render(markdown);
  console.log('渲染成功！html 长度:', html.length, 'css 长度:', css.length);
} catch (err) {
  console.log('渲染失败:', err.message);
  console.log('错误堆栈:', err.stack);
}

console.log('\n=== 测试 2: 默认配置 ===');
try {
  const marp = new Marp();
  const { html, css } = marp.render(markdown);
  console.log('渲染成功！html 长度:', html.length);
} catch (err) {
  console.log('渲染失败:', err.message);
  console.log('错误堆栈:', err.stack);
}

console.log('\n=== 测试 3: 去掉归档字段（只保留 marp+theme）===');
const minimalMarkdown = `---
marp: true
theme: default
---

# 测试标题

---

## 第二页
- 内容`;
try {
  const marp = new Marp({ html: true });
  const { html, css } = marp.render(minimalMarkdown);
  console.log('渲染成功！html 长度:', html.length);
} catch (err) {
  console.log('渲染失败:', err.message);
}

console.log('\n=== 测试 4: 去掉 generated_at 时间戳字段 ===');
const noTimestampMarkdown = `---
marp: true
theme: default
type: query
output_mode: ppt
question: 票交所接口文档1.4都更新了哪些内容
---

# 测试标题`;
try {
  const marp = new Marp({ html: true, emoji: { shortcode: true, unicode: true } });
  const { html, css } = marp.render(noTimestampMarkdown);
  console.log('渲染成功！html 长度:', html.length);
} catch (err) {
  console.log('渲染失败:', err.message);
}

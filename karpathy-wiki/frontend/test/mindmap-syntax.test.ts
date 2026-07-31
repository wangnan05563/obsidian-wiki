import { describe, it, expect, beforeAll } from 'vitest';
import type Mermaid from 'mermaid';

// FR-09-2 mindmap 语法回归测试
// 背景：曾因 prompt 错误要求 LLM 生成 `[[页面名]]` 双方括号引用，
// 而 mermaid mindmap 解析器（jison lexer）不支持子例程形状 `[[...]]`，
// 第二个 `]` 在 INITIAL 状态无匹配规则，导致解析失败、前端渲染报错。
// 修复：prompt 改为单方括号 `[页面名]`（mermaid mindmap 支持的矩形节点）。
// 这里用 mermaid.parse 校验语法，避免依赖 DOM（render 才需要 SVG/canvas）。

let mermaid: typeof Mermaid;

beforeAll(async () => {
  mermaid = (await import('mermaid')).default;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'strict',
    mindmap: { padding: 16 },
  });
});

// 检查给定 mindmap 文本能否被 mermaid 正确解析
async function expectParseOk(content: string, label: string) {
  let err: unknown = null;
  try {
    await mermaid.parse(content);
  } catch (e) {
    err = e;
  }
  // eslint-disable-next-line no-console
  if (err) console.log(`[FAIL ${label}]`, err instanceof Error ? err.message : String(err));
  expect(err, `mindmap 语法应合法: ${label}`).toBeNull();
}

async function expectParseFail(content: string, label: string) {
  let err: unknown = null;
  try {
    await mermaid.parse(content);
  } catch (e) {
    err = e;
  }
  // eslint-disable-next-line no-console
  if (!err) console.log(`[UNEXPECTED OK ${label}]`);
  expect(err, `mindmap 语法应非法: ${label}`).not.toBeNull();
}

describe('mermaid mindmap 语法 - 双方括号回归', () => {
  // 用户原始报错内容（带 [[...]]）：必须仍然失败，证明根因诊断正确
  it('用户报错原文 [[页面名]] 应解析失败', async () => {
    await expectParseFail(
      `mindmap
  root((票交所接口文档 V1.4 更新))
    通用信息分册
      批量背书子票区间下发
        [[中国票据业务系统直连接口规范-通用信息分册]]`,
      'user-original-double-bracket',
    );
  });

  // 修复后等价内容（单方括号）：应能正确解析
  it('修复后 [页面名] 单方括号应解析成功', async () => {
    await expectParseOk(
      `mindmap
  root((票交所接口文档 V1.4 更新))
    通用信息分册
      批量背书子票区间下发
        [中国票据业务系统直连接口规范-通用信息分册]`,
      'fixed-single-bracket',
    );
  });

  // 修复后的用户完整输入（用单方括号重写）
  it('修复后用户完整 mindmap 应解析成功', async () => {
    await expectParseOk(
      `mindmap
  root((票交所接口文档 V1.4 更新))
    通用信息分册
      批量背书子票区间下发
        [中国票据业务系统直连接口规范-通用信息分册]
      新增主动付款业务场景
        [中国票据业务系统直连接口规范-通用信息分册]
      新增CIM.034.001/CIM.035.001报文
        [中国票据业务系统直连接口规范-通用信息分册]
      新增参与者票据清单查询
        [中国票据业务系统直连接口规范-通用信息分册]
    票据交易分册
      字段变更:信用主体改为贴现行
        [票据交易分册接口规范]
      旧字段删除:意向询价/点击成交/匿名点击
        [票据交易分册接口规范]
    公共控制分册
      支持查询背书转让的通用确认报文
        [票据业务系统公共控制接口规范]`,
      'user-input-after-fix',
    );
  });

  // prompt 文档中给出的示例：应能正确解析
  it('prompt 文档示例应解析成功', async () => {
    await expectParseOk(
      `mindmap
  root((LLM Wiki))
    核心架构
      Harness抽象
        [llm-wiki]
      双链图谱
        [graph-design]
    知识页面
      实体页
        [entities]
      概念页
        [concepts]`,
      'prompt-doc-example',
    );
  });
});

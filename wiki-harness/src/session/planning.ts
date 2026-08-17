// §P3 计划模式（Plan Mode）：在工具循环开始前，把用户任务转化为一份高层执行计划，
// 作为全局意图锚点注入后续每一步 LLM 上下文（经 SessionLog.messages() 投影为开头
// system 消息）。对齐 DeepSeek Harness 的 "plan mode" 一等能力，但保持可选、默认
// 关闭 —— 不提供 Planner 即不启用，对现有 RAG 问答链路零破坏。
//
// §本模块职责：提供两种 Planner 实现
//   - LlmPlanner：用 LLMAdapter 调一次 chat 生成计划（真实场景默认选择）
//   - StaticPlanner：静态字符串或函数（测试 / 无 LLM / 固定脚本场景）
// Planner 接口本体定义在 types.ts（与 Compactor 平行，都是可选能力接缝）。

import type { Planner } from '../types.js';
import type { LLMAdapter } from '../llm/llm-adapter.js';
import type { Message } from '../types.js';

// 真实计划生成器：委托 LLM 产出高层步骤计划
// 为什么单独构造一次 chat 而非复用主循环：计划是"元意图"，用独立 system 提示更可控，
// 且不污染主对话角色链；tools 传空数组避免 LLM 在规划阶段误触发工具。
export class LlmPlanner implements Planner {
  constructor(private llm: LLMAdapter) {}

  async plan(task: string): Promise<string> {
    const messages: Message[] = [
      {
        role: 'system',
        content:
          '你是一个任务规划器。请针对用户任务输出一份简洁的高层执行步骤计划' +
          '（中文要点，3-6 条）。计划只描述"将如何完成"，不要执行，不要输出多余解释。',
      },
      { role: 'user', content: task },
    ];
    const res = await this.llm.chat(messages, []);
    return res.content.trim();
  }
}

// 静态计划生成器：便于测试与无 LLM 场景，或业务侧注入固定脚本
export class StaticPlanner implements Planner {
  constructor(private planText: string | ((task: string) => string)) {}

  async plan(task: string): Promise<string> {
    return typeof this.planText === 'function' ? this.planText(task) : this.planText;
  }
}

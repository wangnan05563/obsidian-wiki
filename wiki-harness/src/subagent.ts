// §P3-SubAgent 子智能体：框架自动注册 spawn_<name> 工具，父循环调用该工具时
// spawn 一个独立子 Harness 执行子任务。对齐 DeepSeek Harness 的 sub-agents 能力，
// 但以最小形态落地：声明式配置 + 工具化委派，子拥有独立预算与工具集（上下文隔离）。
//
// 设计要点：
//  - 子继承父的 llm 配置（同一 provider/baseUrl/apiKey），独立预算避免拖垮父循环
//  - 子工具集默认排除 spawn_*（切断隐式无限递归）；业务可显式白名单多层委派
//  - 子不继承父的 hooks/interceptors/planner/compactor（子智能体独立运行，隔离护栏）
//  - 子默认文件持久化（runId 唯一，不冲突），可审计/重放

import type { HarnessConfig, SubAgentConfig, ToolDefinition } from './types.js';
import { Harness } from './harness.js';

// 子智能体默认独立预算：比父（20 步 / 50000 token）更收紧，防止子任务失控
const DEFAULT_SUBAGENT_MAX_STEPS = 10;
const DEFAULT_SUBAGENT_TOKEN_BUDGET = 20000;

// 由父配置 + 子声明派生一个 spawn_<name> 工具。
// parentTools 用于过滤子可用工具集（声明式白名单或默认排除 spawn_*）。
export function createSubAgentTool(
  parentConfig: HarnessConfig,
  sa: SubAgentConfig,
  parentTools: ToolDefinition[],
): ToolDefinition {
  // 子可用工具：显式白名单按 name 过滤；否则继承除 spawn_* 外的全部（防隐式递归）
  const childTools = sa.tools
    ? parentTools.filter((t) => sa.tools!.includes(t.name))
    : parentTools.filter((t) => !t.name.startsWith('spawn_'));

  const toolName = `spawn_${sa.name}`;

  return {
    name: toolName,
    description:
      sa.description ??
      `委托子智能体「${sa.name}」在隔离上下文中独立执行子任务并返回结果。` +
      `适用于需要独立探索、不应污染主对话上下文的子任务。`,
    // JSON Schema：子任务描述
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子智能体要完成的子任务描述' },
      },
      required: ['task'],
    },
    handler: async (args: unknown) => {
      const task = (args as { task?: string } | null)?.task ?? '';
      // §spawn：构造独立子 Harness，仅继承 llm 与（过滤后的）工具集，独立预算
      const child = new Harness({
        llm: parentConfig.llm,
        tools: childTools,
        budget: {
          maxSteps: sa.maxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS,
          tokenBudget: sa.tokenBudget ?? DEFAULT_SUBAGENT_TOKEN_BUDGET,
        },
        // 不传 hooks/interceptors/planner/compactor：子智能体独立运行，隔离护栏与规划
      });
      const result = await child.run({ task });
      // 子结果以结构化对象回填父循环（父 LLM 可读 status/content/steps/tokenUsed）
      return {
        status: result.status,
        content: result.finalContent,
        steps: result.step,
        tokenUsed: result.tokenUsed,
      };
    },
  };
}

import { describe, it, expect } from 'vitest';

// scene-router 单元测试：验证 triggerKeywords 懒加载触发机制。
// 为什么需要独立测试：triggerKeywords 决定"什么是 LLM Wiki？" 这类问题是否会触发 Excel MCP 加载，
// 是本次修复的核心验收点。若此处逻辑回归，用户会再次看到无关 MCP 的 initialize 超时错误。

import { routeTools, isToolEnabled, isMcpServerTriggered } from '../src/tools/scene-router.js';
import type { ToolsConfig, McpServerEntry } from '../src/types.js';

// 构造最小 ToolsConfig，聚焦 routerMode 和 triggerKeywords 逻辑
function makeAutoConfig(servers: McpServerEntry[]): ToolsConfig {
  return {
    mcpServers: servers,
    cliTools: [],
    scenes: [],
    routerMode: 'auto',
    mcpTimeoutMs: 30000,
  };
}

function serverOf(name: string, triggerKeywords?: string[], enabled = true): McpServerEntry {
  return {
    name,
    transport: 'stdio',
    command: 'npx',
    args: [],
    url: '',
    env: {},
    enabled,
    triggerKeywords,
  };
}

describe('scene-router: isMcpServerTriggered', () => {
  it('triggerKeywords 为空/undefined 视为始终命中（向后兼容）', () => {
    expect(isMcpServerTriggered('任意问题', {})).toBe(true);
    expect(isMcpServerTriggered('任意问题', { triggerKeywords: [] })).toBe(true);
  });

  it('任一关键词命中即启用（不区分大小写）', () => {
    const srv = { triggerKeywords: ['excel', '表格', 'xlsx'] };
    expect(isMcpServerTriggered('请帮我处理这个表格', srv)).toBe(true);
    expect(isMcpServerTriggered('分析 EXCEL 报表', srv)).toBe(true);
    expect(isMcpServerTriggered('导出成 Xlsx', srv)).toBe(true);
    expect(isMcpServerTriggered('和 excel 无关的问题', srv)).toBe(true);
  });

  it('未命中任何关键词时不启用', () => {
    const srv = { triggerKeywords: ['excel', '表格', 'xlsx'] };
    expect(isMcpServerTriggered('什么是 LLM Wiki？', srv)).toBe(false);
    expect(isMcpServerTriggered('请解释一下数据库', srv)).toBe(false);
  });
});

describe('scene-router: routeTools (auto 模式 + triggerKeywords)', () => {
  it('什么是 LLM Wiki？ 不启用 Excel MCP（关键词未命中）', () => {
    const seqThink = serverOf('Sequential Thinking', ['推理', '分析', '思考']);
    const excel = serverOf('Excel', ['excel', '表格', 'xlsx']);
    const cfg = makeAutoConfig([seqThink, excel]);

    const enabled = routeTools('什么是 LLM Wiki？', cfg);
    // 两个关键词都未命中
    expect(enabled).toEqual([]);
  });

  it('分析这个错误的原因：启用 Sequential Thinking，不启用 Excel', () => {
    const seqThink = serverOf('Sequential Thinking', ['推理', '分析', '思考']);
    const excel = serverOf('Excel', ['excel', '表格', 'xlsx']);
    const cfg = makeAutoConfig([seqThink, excel]);

    const enabled = routeTools('分析这个错误的原因是什么？', cfg);
    expect(enabled).toContain('mcp__Sequential Thinking');
    expect(enabled).not.toContain('mcp__Excel');
  });

  it('帮我读取这个 xlsx 文件：启用 Excel，不启用 Sequential Thinking', () => {
    const seqThink = serverOf('Sequential Thinking', ['推理', '分析', '思考']);
    const excel = serverOf('Excel', ['excel', '表格', 'xlsx']);
    const cfg = makeAutoConfig([seqThink, excel]);

    const enabled = routeTools('帮我读取这个 xlsx 文件并统计汇总', cfg);
    expect(enabled).not.toContain('mcp__Sequential Thinking');
    expect(enabled).toContain('mcp__Excel');
  });

  it('分析表格中的数据趋势：同时命中两个服务器', () => {
    const seqThink = serverOf('Sequential Thinking', ['推理', '分析', '思考']);
    const excel = serverOf('Excel', ['excel', '表格', 'xlsx']);
    const cfg = makeAutoConfig([seqThink, excel]);

    const enabled = routeTools('请分析表格中的数据趋势', cfg);
    expect(enabled).toContain('mcp__Sequential Thinking');
    expect(enabled).toContain('mcp__Excel');
  });

  it('disabled 的 MCP 服务器永远不启用', () => {
    const seqThink = serverOf('Sequential Thinking', ['推理', '分析'], false);
    const cfg = makeAutoConfig([seqThink]);

    const enabled = routeTools('请推理原因', cfg);
    expect(enabled).toEqual([]);
  });

  it('未配置 triggerKeywords 保持原 auto 模式语义（始终启用）', () => {
    // 无 triggerKeywords，保持兼容：始终加载
    const noKw = serverOf('SomeTool');
    const cfg = makeAutoConfig([noKw]);

    const enabled = routeTools('任意问题', cfg);
    expect(enabled).toContain('mcp__SomeTool');
  });
});

describe('scene-router: isToolEnabled 前缀匹配', () => {
  it('MCP 服务器级前缀启用后，具体工具名被启用', () => {
    const enabledList = ['mcp__Excel'];
    expect(isToolEnabled('mcp__Excel__readWorkbook', enabledList)).toBe(true);
    expect(isToolEnabled('mcp__Excel__writeWorkbook', enabledList)).toBe(true);
    expect(isToolEnabled('mcp__Sequential Thinking__sequentialThinking', enabledList)).toBe(false);
  });

  it('精确工具名也能匹配', () => {
    const enabledList = ['mcp__Excel__readWorkbook'];
    expect(isToolEnabled('mcp__Excel__readWorkbook', enabledList)).toBe(true);
    expect(isToolEnabled('mcp__Excel__writeWorkbook', enabledList)).toBe(false);
  });

  it('非 MCP 工具名精确匹配', () => {
    const enabledList = ['cli-tool-1'];
    expect(isToolEnabled('cli-tool-1', enabledList)).toBe(true);
    expect(isToolEnabled('cli-tool-2', enabledList)).toBe(false);
  });
});

// 工具配置路由：提供 MCP/CLI/场景路由配置的读取、保存与工具列表查询。
//   GET  /api/tools/config   读取工具配置（从 config.json）
//   PUT  /api/tools/config   保存工具配置到 config.json + 刷新缓存
//   GET  /api/tools/list     列出已配置的扩展工具概览
//   POST /api/tools/test-cli 测试 CLI 工具执行（白名单校验 + 安全执行）
//
// 为什么独立路由而非合并到 /api/ai：工具配置与 AI 模型配置职责不同，
// 工具配置涉及 MCP/CLI/场景路由三类，逻辑复杂度高，独立路由便于维护。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadConfig, saveToolsConfig } from '../config.js';
import type { ToolsConfig, CliToolEntry, EngineAdapter } from '../types.js';
import { listConfiguredTools } from '../tools/registry.js';
import { executeCliTool } from '../tools/cli-executor.js';

export function registerToolsRoute(app: FastifyInstance, adapter?: EngineAdapter) {
  // GET /api/tools/config：返回当前工具配置。
  // 直接返回 ToolsConfig 对象（非 { tools: ... } 包装），与前端 Config.vue 期望对齐（BR-026-1）。
  // 无敏感字段需脱敏（MCP env 可能含 API Key，但本接口仅后端调用，前端 Config 页面需展示）。
  app.get('/api/tools/config', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (_request, reply) => {
    const config = await loadConfig();
    const toolsConfig: ToolsConfig = config.tools ?? {
      mcpServers: [],
      cliTools: [],
      scenes: [],
      routerMode: 'auto',
    };
    return reply.send(toolsConfig);
  });

  // PUT /api/tools/config：保存工具配置。
  // 为什么整体替换而非部分更新：工具配置项（mcpServers/cliTools/scenes）是数组，
  // 部分更新数组语义复杂（增删改索引），整体替换更清晰且前端管理方便。
  app.put('/api/tools/config', async (request: FastifyRequest, reply) => {
    const body = request.body as {
      mcpServers?: ToolsConfig['mcpServers'];
      cliTools?: ToolsConfig['cliTools'];
      scenes?: ToolsConfig['scenes'];
      routerMode?: ToolsConfig['routerMode'];
    };

    // 基本校验：routerMode 必须是合法枚举值
    if (body.routerMode !== undefined && !['keyword', 'auto'].includes(body.routerMode)) {
      return reply.code(400).send({ error: 'routerMode must be "keyword" or "auto"' });
    }

    const updated = await saveToolsConfig({
      mcpServers: body.mcpServers,
      cliTools: body.cliTools,
      scenes: body.scenes,
      routerMode: body.routerMode,
    });

    // 热加载：同步 adapter 运行时实例，下次 query 即时生效
    if (adapter && updated.tools) {
      adapter.updateConfig({ toolsConfig: updated.tools });
    }

    return reply.send({ ok: true, tools: updated.tools });
  });

  // GET /api/tools/list：列出已配置的扩展工具概览。
  // 前端 Config 页面用此接口展示当前配置状态（不触发 MCP 连接）。
  app.get('/api/tools/list', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (_request, reply) => {
    const config = await loadConfig();
    const overview = listConfiguredTools(config.tools);
    return reply.send(overview);
  });

  // POST /api/tools/test-cli：测试 CLI 工具执行。
  // 为什么需要：用户在 Config 页面配置 CLI 工具后需验证是否能正常执行。
  // 安全：执行时仍受白名单 + 参数校验 + 超时约束。
  app.post('/api/tools/test-cli', async (request: FastifyRequest, reply) => {
    const body = request.body as {
      command: string;
      argsTemplate?: string;
      input?: string;
      timeoutMs?: number;
    };

    if (!body.command) {
      return reply.code(400).send({ error: 'command is required' });
    }

    // 构造临时 CliToolEntry 用于测试执行
    const entry: CliToolEntry = {
      name: '__test__',
      command: body.command,
      argsTemplate: body.argsTemplate,
      description: '',
      timeoutMs: body.timeoutMs,
      enabled: true,
    };

    const result = await executeCliTool(entry, body.input || '');
    // 返回字段名与前端 Config.vue testCliTool 期望对齐（BR-026-1）：
    // - output: 标准输出（前端展示在 pre 标签）
    // - error: 错误输出（失败时展示）
    return reply.send({
      ok: result.ok,
      output: result.stdout,
      error: result.stderr || (result.timedOut ? `Command timed out after ${body.timeoutMs ?? 30000}ms` : ''),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
  });
}

// T02802：MCP「JSON 编辑模式」往返不能吃掉后端懒加载配置。
// 缺陷形状与 T02773 同类但更狠：不是显示被吃掉，是配置被删——JSON 模式按 name 重建 stdio 条目时，
// Claude Desktop 格式里不存在的 timeoutMs / triggerKeywords / placeholderTools 会一起消失，
// 而保存是整份配置回传。合并逻辑已从 Config.vue 抽到 utils/mcpConfigMode.ts，这里直接验行为。
import { describe, it, expect } from 'vitest';
import { mergeMcpJsonIntoServers, type McpJsonFile } from '../src/utils/mcpConfigMode';
import type { McpServerEntry } from '../src/types';

const lazyServer: McpServerEntry = {
  name: 'fs',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server-fs'],
  env: { TOKEN: 'x' },
  timeoutMs: 30000,
  enabled: true,
  triggerKeywords: ['表格', 'excel'],
  placeholderTools: [{ name: 'read_file', description: '读文件' }],
};

const remoteServer: McpServerEntry = { name: 'search', transport: 'sse', url: 'https://e/sse', enabled: true };

function json(servers: Record<string, { command?: string; args?: unknown; env?: Record<string, string> }>): McpJsonFile {
  return { mcpServers: servers };
}

describe('T02802 MCP JSON 模式往返（mergeMcpJsonIntoServers）', () => {
  it('按 name 带回 JSON 格式里没有的三个键', () => {
    const merged = mergeMcpJsonIntoServers([lazyServer, remoteServer], json({ fs: { command: 'npx', args: ['-y', 'new'] } }));
    expect(merged.error).toBe('');
    const fs = merged.servers.find((s) => s.name === 'fs');
    expect(fs?.args).toEqual(['-y', 'new']); // JSON 是权威源：改过的键以 JSON 为准
    expect(fs?.command).toBe('npx');
    expect(fs?.timeoutMs).toBe(30000);
    expect(fs?.triggerKeywords).toEqual(['表格', 'excel']);
    expect(fs?.placeholderTools).toEqual([{ name: 'read_file', description: '读文件' }]);
  });

  it('非 stdio 条目原样保留，JSON 里没有的 stdio 视为删除', () => {
    const merged = mergeMcpJsonIntoServers([lazyServer, remoteServer], json({ other: { command: 'node' } }));
    expect(merged.servers.map((s) => s.name)).toEqual(['search', 'other']);
    expect(merged.servers.find((s) => s.name === 'search')).toEqual(remoteServer);
  });

  it('JSON 新增的 server 默认 stdio 且 enabled，不带回不相干旧键', () => {
    const merged = mergeMcpJsonIntoServers([remoteServer], json({ brand: { command: 'uvx', env: { K: 'V' } } }));
    const brand = merged.servers.find((s) => s.name === 'brand');
    expect(brand).toEqual({ name: 'brand', transport: 'stdio', command: 'uvx', args: [], env: { K: 'V' }, enabled: true });
  });

  it('同名撞上现存非 stdio 条目时报错并保持原配置（不静默删远程服务器）', () => {
    const merged = mergeMcpJsonIntoServers([remoteServer], json({ search: { command: 'npx' } }));
    expect(merged.error).toContain('非 stdio 类型');
    expect(merged.servers).toEqual([remoteServer]);
  });

  it('缺 command 时报错并保持原数组不动', () => {
    const merged = mergeMcpJsonIntoServers([lazyServer], json({ fs: {} }));
    expect(merged.error).toContain('缺少 command 字段');
    expect(merged.servers).toEqual([lazyServer]);
  });

  it('args/env 形状不符时归一，而不是把脏形状写回配置', () => {
    const dirty = { command: 'npx', args: 'oops', env: 'oops' as unknown as Record<string, string> };
    const merged = mergeMcpJsonIntoServers([], json({ fs: dirty }));
    expect(merged.servers[0].args).toEqual([]);
    expect(merged.servers[0].env).toEqual({});
  });

  it('mcpServers 缺失时只留非 stdio（与清空 stdio 的口径一致）', () => {
    const merged = mergeMcpJsonIntoServers([lazyServer, remoteServer], {});
    expect(merged.error).toBe('');
    expect(merged.servers.map((s) => s.name)).toEqual(['search']);
  });
});

// T02802：MCP「JSON 编辑模式」往返不能吃掉后端懒加载配置。
// 缺陷形状与 T02773 同类但更狠：不是显示被吃掉，是配置被删——JSON 模式按 name 重建 stdio 条目时，
// Claude Desktop 格式里不存在的 timeoutMs / triggerKeywords / placeholderTools 会一起消失，
// 而保存是整份配置回传。合并逻辑已从 Config.vue 抽到 utils/mcpConfigMode.ts，这里直接验行为。
// T02834：更隐蔽的一层——禁用态 stdio 从不写进 JSON（Claude Desktop 格式无 enabled 键），
// 「切到 JSON 再切回」曾把禁用服务器静默删除。合并口径改为：JSON 未提及的禁用态 stdio 原样带回。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

const disabledServer: McpServerEntry = {
  name: 'disabled-fs',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server-fs'],
  env: { TOKEN: 'y' },
  timeoutMs: 15000,
  enabled: false,
  triggerKeywords: ['禁用词'],
};

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

  it('非 stdio 条目原样保留；JSON 里没有的「启用态」stdio 视为删除（JSON 里看得见才会被删）', () => {
    const merged = mergeMcpJsonIntoServers([lazyServer, remoteServer], json({ other: { command: 'node' } }));
    expect(merged.servers.map((s) => s.name)).toEqual(['search', 'other']);
    expect(merged.servers.find((s) => s.name === 'search')).toEqual(remoteServer);
  });

  it('T02834：JSON 未提及的禁用态 stdio 原样带回（切模式不再丢数据）', () => {
    const merged = mergeMcpJsonIntoServers(
      [lazyServer, remoteServer, disabledServer],
      json({ fs: { command: 'npx', args: ['-y', 'server-fs'] } }),
    );
    expect(merged.error).toBe('');
    const kept = merged.servers.find((s) => s.name === 'disabled-fs');
    expect(kept).toEqual(disabledServer); // 逐字段不变，含 enabled:false 与懒加载键
  });

  it('T02834：JSON 里出现禁用服务器的名字 → 以 JSON 为权威重建为启用态', () => {
    const merged = mergeMcpJsonIntoServers(
      [disabledServer],
      json({ 'disabled-fs': { command: 'node', args: ['x.js'] } }),
    );
    expect(merged.error).toBe('');
    const revived = merged.servers.find((s) => s.name === 'disabled-fs');
    expect(revived?.enabled).toBe(true);
    expect(revived?.command).toBe('node'); // JSON 是权威源
    expect(revived?.timeoutMs).toBe(15000); // 懒加载键仍按 name 带回
  });

  it('T02834：两次连续往返（切 JSON → 切回 → 再切 → 再切回）条目集合与 enabled 逐字段不变', () => {
    // 模拟 serializeMcpToJson（只写启用态 stdio）→ merge 的完整往返
    const serialize = (servers: McpServerEntry[]): McpJsonFile => {
      const mcpServers: Record<string, { command?: string; args?: unknown; env?: Record<string, string> }> = {};
      for (const s of servers) {
        if (s.transport === 'stdio' && s.enabled && s.command?.trim()) {
          mcpServers[s.name] = { command: s.command, ...(s.args?.length ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) };
        }
      }
      return { mcpServers };
    };
    const start = [lazyServer, remoteServer, disabledServer];
    const once = mergeMcpJsonIntoServers(start, serialize(start));
    expect(once.error).toBe('');
    const twice = mergeMcpJsonIntoServers(once.servers, serialize(once.servers));
    expect(twice.error).toBe('');
    // 合并会先放保留项再放 JSON 重建项，数组顺序与初始不同——按 name 归位后逐字段比
    const byName = (arr: McpServerEntry[]) => [...arr].sort((a, b) => a.name.localeCompare(b.name));
    expect(byName(twice.servers)).toEqual(byName(start));
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

  it('mcpServers 缺失时只留非 stdio 与禁用态（与 T02834 豁免口径一致）', () => {
    const merged = mergeMcpJsonIntoServers([lazyServer, remoteServer, disabledServer], {});
    expect(merged.error).toBe('');
    expect(merged.servers.map((s) => s.name)).toEqual(['search', 'disabled-fs']);
  });

  it('Config.vue 的口径与 utils 同源：空文本保留禁用态、切 JSON 模式提示被隐藏条目', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/views/Config.vue'), 'utf8');
    // 空文本分支：清空只针对启用的 stdio，禁用态保留
    expect(src).toMatch(/filter\(s => s\.transport !== 'stdio' \|\| s\.enabled === false\)/);
    // 切走前提名被隐藏的禁用条目，避免「看不见」被误读成「被删除」
    expect(src).toContain('个已禁用的服务器不会出现在 JSON 中');
  });
});

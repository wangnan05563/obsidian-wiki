import { describe, it, expect } from 'vitest';
import { parseRequest, success, failure, isNotification, isBatch, ErrCodes } from './json-rpc.js';
import { listTools, getTool, callTool, tools } from './tools.js';
import type { McpToolContext } from './tools.js';

const stubVault = {
  listAllPages: async () => [{ path: 'concepts/foo.md', name: 'foo', dir: 'concepts', frontmatter: {} }],
  listTree: async () => [],
  getVaultPath: () => '/kb',
  buildLinkGraph: async () => ({ nodes: ['foo'], edges: [] }),
  readFile: async (rel: string) => (rel === 'concepts/foo.md' ? '---\ntitle: Foo\n---\n\nbody' : (() => { throw new Error('ENOENT'); })()),
  writeFile: async () => undefined,
  resolvePageName: async (t: string) => (t === 'foo' ? 'concepts/foo.md' : null),
  archiveRaw: async () => 'raw/file.txt',
};
const stubAdapter = {
  query: async function* () { yield { text: 'hi', refs: ['[[foo]]'] }; },
  compile: async function* () { yield { step: 'done', status: 'done', message: 'ok' }; },
};

function makeCtx(): McpToolContext {
  return { vault: stubVault as never, adapter: stubAdapter as never, config: {} as never };
}

describe('json-rpc', () => {
  it('合法请求可解析', () => {
    const r = parseRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(r?.method).toBe('tools/list');
    expect(r?.id).toBe(1);
  });

  it('非法请求返回 null', () => {
    expect(parseRequest({ id: 1, method: 'x' })).toBeNull();
    expect(parseRequest({ jsonrpc: '2.0', id: 1 })).toBeNull();
    expect(parseRequest(null)).toBeNull();
    expect(parseRequest('str')).toBeNull();
  });

  it('通知识别：有 method 无 id', () => {
    expect(isNotification({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(true);
    expect(isNotification({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(false);
  });

  it('批量（数组）识别', () => {
    expect(isBatch([{ jsonrpc: '2.0', method: 'x' }])).toBe(true);
    expect(isBatch({ jsonrpc: '2.0', method: 'x' })).toBe(false);
  });

  it('success / failure 构造符合 JSON-RPC 2.0', () => {
    expect(success(1, { ok: true })).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const f = failure(2, ErrCodes.methodNotFound, 'no method');
    expect(f.error?.code).toBe(-32601);
    expect(f.error?.message).toBe('no method');
  });
});

describe('tools 清单', () => {
  it('共 15 个工具，8 读 / 7 写', () => {
    const ls = listTools();
    expect(ls.tools.length).toBe(15);
    expect(tools.filter((t) => !t.write).length).toBe(8);
    expect(tools.filter((t) => t.write).length).toBe(7);
  });

  it('getTool 能查到每个定义工具，未知名返回 undefined', () => {
    for (const t of tools) expect(getTool(t.name)).toBeDefined();
    expect(getTool('nope')).toBeUndefined();
  });
});

describe('tools 分发与护栏', () => {
  it('调用未知工具 → isError 且带提示', async () => {
    const r = await callTool('not_a_tool', {}, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('未找到工具');
  });

  it('读工具调用成功（vault_list_pages）', async () => {
    const r = await callTool('vault_list_pages', {}, makeCtx());
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain('concepts/foo.md');
  });

  it('写工具标记 write=true，读工具标记 write=false', () => {
    expect(getTool('vault_write_page')?.write).toBe(true);
    expect(getTool('vault_search')?.write).toBe(false);
  });

  it('路径穿越在目录白名单校验前即被读工具护栏拒绝', async () => {
    const r = await callTool('vault_read_page', { path: '../../etc/passwd' }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('读取被拒绝');
  });

  it('非白名单目录写操作被拒绝', async () => {
    const r = await callTool('vault_write_page', { path: 'config/secret.txt', content: 'x' }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('写入被拒绝');
  });

  it('llm_query 汇总流式回答', async () => {
    const r = await callTool('llm_query', { question: 'hi' }, makeCtx());
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.content[0].text) as { answer: string; refs: string[] };
    expect(parsed.answer).toBe('hi');
    expect(parsed.refs).toContain('[[foo]]');
  });
});
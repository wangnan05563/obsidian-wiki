// MCP Server 工具注册与分发：把知识库的查询/检索/维护能力暴露给外部 AI Agent。
// 为什么直接复用 vault/search/tag-suggest 而非重新实现：避免与现有路由/工作流逻辑漂移（DRY）。
//
// 工具分两类（对应双 token 鉴权）：
//   - 读：查询/检索类，需 userToken
//   - 写：维护/增强类（写页/删页/编译/打标签），需 adminToken（未配置时回退 userToken）

import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { VaultService } from '../vault/vault-service.js';
import type { EngineAdapter, AppConfig } from '../types.js';
import { searchPages } from '../search-util.js';
import {
  suggestTagsForPage,
  confirmTagForPage,
  listPendingTagPages,
} from '../workflows/tag-suggest-workflow.js';

export interface McpToolContext {
  vault: VaultService;
  adapter: EngineAdapter;
  config: AppConfig;
}

export interface McpTool {
  name: string;
  description: string;
  // JSON Schema（MCP inputSchema）
  inputSchema: Record<string, unknown>;
  // 是否写/维护类工具（需要 adminToken）
  write: boolean;
  handler: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<unknown>;
}

// 允许写入的顶层目录（与 vault-service 的 WRITE_ALLOWED_DIRS 保持一致）
const WRITABLE_DIRS = new Set(['raw', 'entities', 'concepts', 'comparisons', 'queries', 'drafts', 'qa', 'solutions']);
const READABLE_DIRS = ['entities', 'concepts', 'comparisons', 'queries', 'qa', 'solutions', 'raw', 'drafts'];

function requireString(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`缺少必填参数: ${key}`);
}

function requireNumber(args: Record<string, unknown>, key: string, fallback?: number): number {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`缺少必填数值参数: ${key}`);
}

// 校验相对路径在知识库合法目录内且不越界（防路径穿越），返回规范化相对路径
function validateKbPath(rel: string, allowWrite: boolean): string {
  const norm = rel.replaceAll('\\', '/');
  const top = norm.split('/')[0];
  if (!top) throw new Error(`非法路径: ${rel}`);
  if (allowWrite) {
    if (!WRITABLE_DIRS.has(top)) throw new Error(`写入被拒绝，目录不在白名单: ${rel}`);
  } else {
    if (!READABLE_DIRS.includes(top)) throw new Error(`读取被拒绝，目录不在白名单: ${rel}`);
  }
  if (/(^|\/)\.\.(\/|$)/.test(norm)) throw new Error(`路径越界: ${rel}`);
  return norm;
}

// 收集 adapter.compile 的流式进度事件，返回简洁结果
async function collectCompile(
  adapter: EngineAdapter,
  input: { type: 'file' | 'url' | 'text'; content: string; rawPath?: string },
  config: AppConfig,
): Promise<unknown> {
  const steps: string[] = [];
  let done = false;
  for await (const ev of adapter.compile(input, config)) {
    if (ev.status === 'error') throw new Error(`编译失败: ${ev.message}`);
    steps.push(ev.message);
    if (ev.status === 'done') done = true;
  }
  return { done, steps };
}

const definitions: McpTool[] = [
  // ── 查询 / 检索类（7）──
  {
    name: 'vault_list_pages',
    description: '列出知识库全部正式页面（含路径/名称/目录/frontmatter）。',
    write: false,
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, { vault }) {
      return vault.listAllPages();
    },
  },
  {
    name: 'vault_get_tree',
    description: '获取知识库目录树（文件与目录层级）。',
    write: false,
    inputSchema: { type: 'object', properties: { dir: { type: 'string', description: '可选：子目录相对路径' } } },
    async handler(args, { vault }) {
      const dir = typeof args.dir === 'string' && args.dir ? validateKbPath(args.dir, false) : undefined;
      return vault.listTree(dir);
    },
  },
  {
    name: 'vault_search',
    description: '全文检索知识库页面，支持关键词、source/type 过滤。',
    write: false,
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '检索关键词，空格分隔多个' },
        limit: { type: 'number', description: '返回条数上限（默认 20）' },
        source: { type: 'string' },
        type: { type: 'string' },
      },
      required: ['q'],
    },
    async handler(args, { vault }) {
      const q = requireString(args, 'q');
      const limit = requireNumber(args, 'limit', 20);
      const filter = {
        source: typeof args.source === 'string' ? args.source : undefined,
        type: typeof args.type === 'string' ? args.type : undefined,
      };
      return searchPages(vault, q, limit, filter);
    },
  },
  {
    name: 'vault_read_page',
    description: '读取单个知识库页面内容（拆分为 frontmatter 与正文 Markdown）。',
    write: false,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '页面相对路径，如 concepts/foo.md' } },
      required: ['path'],
    },
    async handler(args, { vault }) {
      const rel = validateKbPath(requireString(args, 'path'), false);
      const content = await vault.readFile(rel);
      const parsed = matter(content);
      return { path: rel, frontmatter: parsed.data, body: parsed.content };
    },
  },
  {
    name: 'vault_find_page',
    description: '按页面名（含 [[双链]] 名）解析实际文件路径。',
    write: false,
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    async handler(args, { vault }) {
      const title = requireString(args, 'title');
      const rel = await vault.resolvePageName(title);
      return { title, resolved: rel };
    },
  },
  {
    name: 'kb_stats',
    description: '知识库统计：总页数、链接数、各目录页数。',
    write: false,
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, { vault }) {
      const graph = await vault.buildLinkGraph();
      const dirCounts: Record<string, number> = {};
      await Promise.all(
        READABLE_DIRS.map(async (d) => {
          const dirFull = path.join(vault.getVaultPath(), d);
          try {
            const entries = await fs.readdir(dirFull);
            dirCounts[d] = entries.filter((f) => f.endsWith('.md')).length;
          } catch {
            dirCounts[d] = 0;
          }
        }),
      );
      return { totalPages: graph.nodes.length, totalLinks: graph.edges.length, dirCounts };
    },
  },
  {
    name: 'llm_query',
    description: '跨知识库智能问答：调用大模型综合检索回答。回答为整体文本。',
    write: false,
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
    async handler(args, { adapter }) {
      const text: string[] = [];
      const refs: string[] = [];
      for await (const chunk of adapter.query({ question: requireString(args, 'question'), stream: false })) {
        if (chunk.text) text.push(chunk.text);
        if (chunk.refs?.length) refs.push(...chunk.refs.map((r) => (typeof r === "string" ? r : r.path)));
      }
      return { answer: text.join(''), refs };
    },
  },

  // ── 维护 / 增强类（8）──
  {
    name: 'vault_write_page',
    description: '写入/覆盖知识库页面内容（Markdown，含 frontmatter），需存在于白名单目录。',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async handler(args, { vault }) {
      const rel = validateKbPath(requireString(args, 'path'), true);
      await vault.writeFile(rel, requireString(args, 'content'));
      return { ok: true, path: rel };
    },
  },
  {
    name: 'vault_create_page',
    description: '新建知识库页面（自动补 .md 与 frontmatter 骨架）。',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '目录（entities/concepts/comparisons/queries/qa/solutions/raw/drafts）' },
        name: { type: 'string', description: '页面名，如 deepseek-r1' },
        title: { type: 'string', description: 'frontmatter title（默认取 name）' },
        body: { type: 'string', description: '正文 Markdown' },
      },
      required: ['dir', 'name'],
    },
    async handler(args, { vault }) {
      const dir = requireString(args, 'dir');
      const name = requireString(args, 'name');
      const rel = validateKbPath(`${dir}/${name.endsWith('.md') ? name : `${name}.md`}`, true);
      const title = typeof args.title === 'string' && args.title ? args.title : name.replace(/\.md$/, '');
      const body = typeof args.body === 'string' ? args.body : '';
      const content = `---\ntitle: ${title}\n---\n\n${body}\n`;
      await vault.writeFile(rel, content);
      return { ok: true, path: rel };
    },
  },
  {
    name: 'vault_delete_page',
    description: '删除知识库页面文件。删除后对应内容缓存会因 stat 查无文件而自然失效。',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    async handler(args, { vault }) {
      const rel = validateKbPath(requireString(args, 'path'), true);
      const full = path.join(vault.getVaultPath(), rel);
      await fs.unlink(full);
      return { ok: true, path: rel };
    },
  },
  {
    name: 'vault_ingest_raw',
    description: '归档原始资料到 raw/ 目录（文件名安全化，防路径穿越）。',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { filename: { type: 'string' }, content: { type: 'string' } },
      required: ['filename', 'content'],
    },
    async handler(args, { vault }) {
      const rel = await vault.archiveRaw(requireString(args, 'filename'), requireString(args, 'content'));
      return { ok: true, path: rel };
    },
  },
  {
    name: 'vault_compile',
    description: '触发编译工作流：将纯文本/资料编译生成知识库页面。',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: '待编译的源文本' }, rawPath: { type: 'string' } },
      required: ['content'],
    },
    async handler(args, { adapter, config }) {
      return collectCompile(adapter, {
        type: 'text',
        content: requireString(args, 'content'),
        rawPath: typeof args.rawPath === 'string' ? args.rawPath : undefined,
      }, config);
    },
  },
  {
    name: 'tags_suggest',
    description: 'AI 为指定页面生成标签建议并写入 frontmatter.ai_tags（不覆盖现有 tags）。',
    write: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async handler(args, { vault, config }) {
      const rel = validateKbPath(requireString(args, 'path'), true);
      const tags = await suggestTagsForPage(vault, rel, config);
      return { path: rel, ai_tags: tags };
    },
  },
  {
    name: 'tags_list_pending',
    description: '列出待审核标签建议的页面（frontmatter 含 ai_tags 且未确认的页面）。',
    write: false,
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, { vault }) {
      return listPendingTagPages(vault);
    },
  },
  {
    name: 'tags_confirm',
    description: '确认某个标签建议：将其从 ai_tags 移动到 tags（合并且去重）。',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, tag: { type: 'string' } },
      required: ['path', 'tag'],
    },
    async handler(args, { vault }) {
      const rel = validateKbPath(requireString(args, 'path'), true);
      const tag = requireString(args, 'tag');
      const res = await confirmTagForPage(vault, rel, tag);
      return { path: rel, ...res };
    },
  },
];

export const tools: ReadonlyArray<McpTool> = definitions;

// 工具名 → 定义索引映射，工具调时分发用（避免每次线性查找）
const byName = new Map<string, McpTool>(definitions.map((t) => [t.name, t]));

export function getTool(name: string): McpTool | undefined {
  return byName.get(name);
}

export interface ToolListResult {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export function listTools(): ToolListResult {
  return { tools: definitions.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
}

export interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

export async function callTool(toolName: string, rawArgs: unknown, ctx: McpToolContext): Promise<ToolCallResult> {
  const tool = byName.get(toolName);
  if (!tool) {
    return { content: [{ type: 'text', text: `未找到工具: ${toolName}` }], isError: true };
  }
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  try {
    const result = await tool.handler(args, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false };
  } catch (err: unknown) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}
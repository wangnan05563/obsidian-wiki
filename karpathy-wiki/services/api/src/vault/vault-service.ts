import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

// 写入路径白名单：AI 仅可写这些目录/文件，禁止改 SCHEMA.md（10.4 写入约束）
const WRITE_ALLOWED_DIRS = new Set(['raw', 'entities', 'concepts', 'comparisons', 'queries']);
const WRITE_ALLOWED_FILES = new Set(['index.md', 'log.md']);

// 默认 SCHEMA 内容。init 时若 SCHEMA.md 不存在则写入此内容，保证首次启动即可用。
const DEFAULT_SCHEMA = `# 知识库页面规范 SCHEMA

## 页面类型
- entity: 实体页（人/物/项目）
- concept: 概念页（方法/理论/技术）
- comparison: 对比页（多实体/多概念对照）
- query: 归档的高价值问答

## frontmatter 必填字段
\`\`\`yaml
---
title: 页面标题
type: entity|concept|comparison|query
created: YYYY-MM-DD
updated: YYYY-MM-DD
source: 原始资料来源（URL 或文件名）
tags: [tag1, tag2]
---
\`\`\`

## 双向链接
- 使用 [[页面名]] 链接到其他页面
- 文件名与页面名一致（例如 [[llm-wiki]] 对应 concepts/llm-wiki.md）

## 目录约定
- entities/ 实体
- concepts/ 概念
- comparisons/ 对比
- queries/ 归档问答
- raw/ 原始资料存档
`;

const DEFAULT_INDEX = `# 知识库目录\n\n`;
const DEFAULT_LOG = `# 操作日志\n\n`;

export class VaultService {
  constructor(private readonly vaultPath: string) {}

  // 公开 vaultPath 供 adapter 等外部模块拼接路径用（如 healthCheck 扫描目录）
  getVaultPath(): string {
    return this.vaultPath;
  }

  // 初始化 Vault 目录结构。已存在的文件不覆盖，避免破坏用户内容。
  async init(): Promise<void> {
    await fs.mkdir(this.vaultPath, { recursive: true });
    const dirs = ['raw', 'entities', 'concepts', 'comparisons', 'queries'];
    for (const d of dirs) {
      await fs.mkdir(path.join(this.vaultPath, d), { recursive: true });
    }
    await this.ensureFile('SCHEMA.md', DEFAULT_SCHEMA);
    await this.ensureFile('index.md', DEFAULT_INDEX);
    await this.ensureFile('log.md', DEFAULT_LOG);
  }

  private async ensureFile(rel: string, defaultContent: string): Promise<void> {
    const full = path.join(this.vaultPath, rel);
    try {
      await fs.access(full);
    } catch {
      await fs.writeFile(full, defaultContent, 'utf8');
    }
  }

  // 解析并校验相对路径，防止路径遍历攻击（如 ../../etc/passwd）
  private resolve(rel: string): string {
    const full = path.resolve(this.vaultPath, rel);
    const relFromVault = path.relative(this.vaultPath, full);
    if (relFromVault.startsWith('..') || path.isAbsolute(relFromVault)) {
      throw new Error(`路径越界: ${rel}`);
    }
    return full;
  }

  async readFile(relativePath: string): Promise<string> {
    const full = this.resolve(relativePath);
    return fs.readFile(full, 'utf8');
  }

  // 写入文件，含路径白名单校验。SCHEMA.md 不允许 AI 写（10.4 写入约束）。
  async writeFile(relativePath: string, content: string): Promise<void> {
    const full = this.resolve(relativePath);
    const top = relativePath.split(/[\\/]/)[0];
    const allowed = WRITE_ALLOWED_DIRS.has(top) || WRITE_ALLOWED_FILES.has(relativePath.replaceAll('\\', '/'));
    if (!allowed) {
      throw new Error(`写入被拒绝，路径不在白名单: ${relativePath}`);
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }

  async appendIndex(pageName: string, summary: string): Promise<void> {
    const line = `- [[${pageName}]] — ${summary}\n`;
    const full = this.resolve('index.md');
    await fs.appendFile(full, line, 'utf8');
  }

  async appendLog(
    operation: 'compile' | 'query' | 'health-check',
    affectedFiles: string[],
    note?: string,
  ): Promise<void> {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const lines = [
      `\n## ${ts}\n`,
      `- 操作类型：${operation}\n`,
      `- 影响文件：${affectedFiles.join(', ') || '(无)'}\n`,
    ];
    if (note) lines.push(`- 备注：${note}\n`);
    const full = this.resolve('log.md');
    await fs.appendFile(full, lines.join(''), 'utf8');
  }

  // 存档原始资料到 raw/，返回相对路径。filename 仅取 basename 防注入。
  async archiveRaw(filename: string, content: string): Promise<string> {
    const safeName = path.basename(filename).replace(/[^\w.-]/g, '_'); // NOSONAR: 用正则字符类做白名单过滤，replaceAll 不适用
    const rel = `raw/${safeName}`;
    const full = this.resolve(rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    return rel;
  }

  async listTree(dir?: string): Promise<TreeNode[]> {
    const root = dir ? this.resolve(dir) : this.vaultPath;
    const entries = await fs.readdir(root, { withFileTypes: true });
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      const childPath = path.relative(this.vaultPath, path.join(root, e.name)).replaceAll('\\', '/');
      if (e.isDirectory()) {
        nodes.push({
          name: e.name,
          path: childPath,
          type: 'dir',
          children: await this.listTree(childPath),
        });
      } else {
        nodes.push({ name: e.name, path: childPath, type: 'file' });
      }
    }
    return nodes;
  }

  // 构建双向链接图。纯确定性逻辑，不调 LLM（M-2 healthCheck 与 harness 关系）。
  // 节点 = 页面文件（去 .md 后缀作页面名），边 = [[页面名]] 引用。
  // 页面收集与边抽取拆分为辅助方法，降低主函数认知复杂度（S3776）
  async buildLinkGraph(): Promise<{ nodes: string[]; edges: Array<{ from: string; to: string }> }> {
    const pageDirs = ['entities', 'concepts', 'comparisons', 'queries'];
    const nameToPath = new Map<string, string>();
    const nodes: string[] = [];

    // 收集所有页面，建立 页面名 → 相对路径 映射
    for (const d of pageDirs) {
      await this.collectPagesFromDir(d, nodes, nameToPath);
    }

    // 解析每个页面的 [[link]]，建立边
    const edges: Array<{ from: string; to: string }> = [];
    for (const [, fromPath] of nameToPath) {
      const pageEdges = await this.extractEdgesFromPage(fromPath, nameToPath);
      edges.push(...pageEdges);
    }

    return { nodes, edges };
  }

  // 收集单个目录下的 .md 页面，填充 nodes 与 nameToPath 映射
  private async collectPagesFromDir(
    dir: string,
    nodes: string[],
    nameToPath: Map<string, string>,
  ): Promise<void> {
    const dirFull = path.join(this.vaultPath, dir);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dirFull);
    } catch {
      return;
    }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue;
      const pageName = f.slice(0, -3);
      const rel = `${dir}/${f}`;
      nodes.push(rel);
      nameToPath.set(pageName, rel);
    }
  }

  // 读取单个页面内容，解析 [[link]] 并返回指向已存在页面的边
  private async extractEdgesFromPage(
    fromPath: string,
    nameToPath: Map<string, string>,
  ): Promise<Array<{ from: string; to: string }>> {
    let content = '';
    try {
      content = await this.readFile(fromPath);
    } catch {
      return [];
    }
    const edges: Array<{ from: string; to: string }> = [];
    const wikilinkRe = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = wikilinkRe.exec(content)) !== null) {
      const target = m[1].trim();
      const toPath = nameToPath.get(target);
      if (toPath) {
        edges.push({ from: fromPath, to: toPath });
      }
    }
    return edges;
  }

  // 提取页面 frontmatter 的 updated 字段。供 healthCheck 判定过期用。
  async getPageUpdated(rel: string): Promise<string | null> {
    try {
      const content = await this.readFile(rel);
      const parsed = matter(content);
      const updated = parsed.data?.updated;
      return typeof updated === 'string' ? updated : null;
    } catch {
      return null;
    }
  }
}

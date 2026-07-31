import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { watch, type FSWatcher } from 'chokidar';

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

// 写入路径白名单：AI 仅可写这些目录/文件，禁止改 SCHEMA.md（10.4 写入约束）
// drafts: QQ 导入子系统候选 draft 存放（SRS §5.3.3 状态机 draft → published）
// qa: QQ 导入子系统 Q&A 编译产物（SRS §3.2 阶段3 体系化编译）
// solutions: QQ 导入子系统方案沉淀编译产物（SRS §3.2 阶段3 体系化编译）
const WRITE_ALLOWED_DIRS = new Set(['raw', 'entities', 'concepts', 'comparisons', 'queries', 'drafts', 'qa', 'solutions']);
const WRITE_ALLOWED_FILES = new Set(['index.md', 'log.md']);

// 页面目录列表：extractRefs 解析 [[页面名]] 与 buildLinkGraph 收集节点均复用此列表
// 为什么抽取为常量：避免 resolvePageName 与 buildLinkGraph 两处硬编码不一致
// qa/solutions 加入：QQ 导入子系统编译产物需参与双向链接图（SRS §3.2 建立双向链接）
// drafts 不加入：draft 是中间状态，不应参与正式页面的链接图
const PAGE_DIRS = ['entities', 'concepts', 'comparisons', 'queries', 'qa', 'solutions'];

// title 规范化：返回主名称 + 括号内英文别名，用于跨命名变体去重
// 解决 LLM 每次编译自选 slug 导致同实体重复（中英文混合 title 需提取括号内英文做二次匹配）
// 例：「上海票据交易所 (Shanghai Commercial Paper Exchange)」→ ['shanghai commercial paper exchange', '上海票据交易所']
function normalizeTitle(title: string): string[] {
  const lower = title.toLowerCase().trim();
  if (!lower) return [];
  const keys: string[] = [];
  // 提取括号内英文别名（中英文同实体场景）
  const aliasMatch = lower.match(/\(([^)]+)\)/) || lower.match(/（([^)]+)）/);
  if (aliasMatch) {
    const alias = aliasMatch[1].replace(/[()（）\-—::]/g, ' ').replace(/\s+/g, ' ').trim();
    if (alias) keys.push(alias);
  }
  // 主名称：去括号及括号内内容，再去标点
  const main = lower
    .replace(/\([^)]+\)/g, ' ')
    .replace(/（[^）]+）/g, ' ')
    .replace(/[()（）\-—::]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (main) keys.push(main);
  return keys;
}

// 待审核标签页面（FR-10-1：含 ai_tags 字段的页面）
// 为什么定义在 VaultService：listPendingTagPages 的缓存失效需要与 writeFile 联动
export interface PendingTagPage {
  path: string;
  title: string;
  aiTags: string[];
  existingTags: string[];
}

// 默认 SCHEMA 内容。init 时若 SCHEMA.md 不存在则写入此内容，保证首次启动即可用。
// 与 data/vault/SCHEMA.md 保持同步：扩展 qa/solutions 类型与 QQ 导入子系统状态机规范
const DEFAULT_SCHEMA = `# 知识库页面规范 SCHEMA

## 页面类型
- entity: 实体页（人/物/项目）
- concept: 概念页（方法/理论/技术）
- comparison: 对比页（多实体/多概念对照）
- query: 归档的高价值问答
- qa: 业务问答页（QQ 聊天记录抽取的单问题 + 答案 + 原文引用）
- solution: 方案沉淀页（QQ 聊天记录抽取的背景 + 步骤 + 注意事项 + 原文引用）

## frontmatter 必填字段
\`\`\`yaml
---
title: 页面标题
type: entity|concept|comparison|query|qa|solution
created: YYYY-MM-DD
updated: YYYY-MM-DD
source: 原始资料来源（URL 或文件名，QQ 导入格式为 qq-chat:<rawId>）
tags: [tag1, tag2]
---
\`\`\`

## frontmatter 扩展字段（QQ 导入子系统使用）
\`\`\`yaml
---
# status: draft 待人工审核，published 已审核发布
status: draft|published
# confidence: 信息可信度，QQ 来源默认 medium（借鉴 Hermes）
confidence: high|medium|low
# contested: 是否存在争议答案（多人给出不同解答时标注）
contested: false
# original_refs: 原文片段引用数组（RAG 证据约束，禁止编造）
original_refs: ["原文片段1", "原文片段2"]
# expires_at: 业务方案时效性（可选，过期方案可在 healthCheck 标记）
expires_at: YYYY-MM-DD
# answerer: 答复者昵称（仅 qa 类型，脱敏后保留）
answerer: 昵称
# ts: 对应原文消息的 ISO8601 时间戳（qa/solution 类型）
ts: 2026-07-20T14:30:15Z
---
\`\`\`

## 双向链接
- 使用 [[页面名]] 链接到其他页面
- 文件名与页面名一致（例如 [[llm-wiki]] 对应 concepts/llm-wiki.md）
- 每个页面至少包含 1 条双向链接（compile 阶段由 LLM 建立）

## 目录约定
- entities/ 实体
- concepts/ 概念
- comparisons/ 对比
- queries/ 归档问答
- qa/ QQ 导入业务问答（draft → published 流转）
- solutions/ QQ 导入方案沉淀（draft → published 流转）
- drafts/ QQ 导入候选 draft 存放（待人工审核，不参与正式链接图）
- raw/ 原始资料存档

## QQ 导入子系统状态机
1. 抽取阶段：LLM 从脱敏对话流抽取 qa_pairs/solutions，写入 drafts/ 目录，status=draft
2. 人工审核：Browse 视图按 status=draft 过滤，审核通过后触发 compile
3. compile 阶段：LLM 组织为体系化 qa/ 或 solutions/ 页面，status 改为 published，建立双向链接
4. published 页面进入正常知识库流通（query/graph/healthCheck）
`;

const DEFAULT_INDEX = `# 知识库目录\n\n`;
const DEFAULT_LOG = `# 操作日志\n\n`;

export class VaultService {
  // buildLinkGraph 共享缓存：避免 /api/graph 与 /api/stats 各自缓存导致重复计算
  // 为什么下沉到 VaultService：单一数据源，writeFile 时自动失效
  private _linkGraphCache: { nodes: string[]; edges: Array<{ from: string; to: string }> } | null = null;
  private _linkGraphCachedAt = 0;
  private static readonly LINK_GRAPH_TTL_MS = 30 * 1000; // 30 秒

  // 文件级 mtime + rawLinks 缓存（P2-5 增量更新）
  // 为什么独立于 _linkGraphCache：跨 TTL 失效保留，仅文件 mtime 变化时清除对应条目
  // rawLinks = 文件中所有 [[target]] 的 target 字符串列表（未解析为 path）
  // 为什么缓存 rawLinks 而非 edges：edges 依赖 nameToPath 完整映射，节点增删时需重新解析
  private _fileLinksCache = new Map<string, { mtime: number; rawLinks: string[] }>();

  // 文件内容二级缓存（P2-7 inode 缓存）
  // 为什么需要：listAllPages/healthCheck 等多次 readFile 同一文件，stat 比 readFile 快 10-100 倍
  // 失效策略：chokidar 监听文件变化 + writeFile 时主动清除
  private _fileContentCache = new Map<string, { mtime: number; content: string }>();
  private _fileWatcher: FSWatcher | null = null;

  // pending tags 结果缓存（P3-2）：避免 /api/tags/pending 每次请求都全量扫描
  // 为什么需要：listPendingTagPages 无缓存，大 vault 下 1000+ readFile + frontmatter 解析耗时长
  // 失效策略：writeFile 时主动失效（ai_tags 的增删改都经过 writeFile）
  private _pendingTagsCache: PendingTagPage[] | null = null;
  private _pendingTagsCachedAt = 0;
  private static readonly PENDING_TAGS_TTL_MS = 30 * 1000; // 30 秒

  constructor(private readonly vaultPath: string) {}

  // 公开 vaultPath 供 adapter 等外部模块拼接路径用（如 healthCheck 扫描目录）
  getVaultPath(): string {
    return this.vaultPath;
  }

  // 失效 link graph 缓存（写入文件后调用）
  // 为什么不直接置 null：避免在并发请求中产生缓存击穿，保留旧缓存让下一次调用主动重算
  // § P2-5：不清除 _fileLinksCache，由 buildLinkGraph 通过 mtime 检测变化
  //   写入的文件 mtime 已变，下次 buildLinkGraph 会重新读取该文件
  private invalidateLinkGraphCache(): void {
    this._linkGraphCache = null;
    this._linkGraphCachedAt = 0;
  }

  // 失效单文件的内容缓存（P2-7）：writeFile / chokidar 变更时调用
  private invalidateFileContentCache(rel: string): void {
    this._fileContentCache.delete(rel);
    // 文件内容变化也意味着 [[links]] 可能改变，清除该文件的 rawLinks 缓存
    this._fileLinksCache.delete(rel);
  }

  // 失效 pending tags 缓存（P3-2）：ai_tags 的增删改都经过 writeFile
  private invalidatePendingTagsCache(): void {
    this._pendingTagsCache = null;
    this._pendingTagsCachedAt = 0;
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

  // 启动 chokidar 文件监听器（P2-7）
  // 为什么需要：外部编辑器（Obsidian/VSCode）直接修改 vault 文件时，readFile 的 mtime 缓存无法感知
  // chokidar 监听文件变化，自动失效对应缓存条目，保证缓存与磁盘一致
  // 为什么 ignored 排除 .git/.obsidian：这些是编辑器元数据，不应触发缓存失效
  // 为什么加超时：大 vault（1000+ 文件）下 chokidar ready 事件可能延迟数十秒，
  //   阻塞服务启动。超时后关闭 watcher 并降级到 mtime 检测模式（仍能感知 writeFile 修改）
  async startFileWatcher(): Promise<void> {
    if (this._fileWatcher) return;
    const watcher = watch(this.vaultPath, {
      ignored: /(^|[/\\])\.(git|obsidian|trae-cache)/,
      persistent: true,
      ignoreInitial: true, // 启动时不触发已有文件的 add 事件
    });

    // 等待 ready 事件，最多 5 秒（超时则关闭 watcher 并降级）
    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        console.warn('[vault] chokidar ready 超时（5s），关闭 watcher 并降级到 mtime 检测模式');
        resolve(false);
      }, 5000);
      watcher.on('ready', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    const isReady = await ready;
    if (!isReady) {
      // 超时：先移除所有监听器，避免 close() 期间触发 invalidate 导致缓存反复失效
      // 为什么需要：大 vault（1000+ 文件）下 close() 是异步操作，
      //   在文件句柄释放完成前 chokidar 内部 add 事件仍可能触发回调，
      //   回调中 invalidateFileContentCache + invalidateLinkGraphCache 会使后续请求缓存命中率为 0
      watcher.removeAllListeners();
      await watcher.close().catch(() => {});
      return;
    }

    this._fileWatcher = watcher;
    const invalidate = (absPath: string): void => {
      const rel = path.relative(this.vaultPath, absPath).replaceAll('\\', '/');
      this.invalidateFileContentCache(rel);
      this.invalidateLinkGraphCache();
    };

    watcher
      .on('add', invalidate)
      .on('change', invalidate)
      .on('unlink', invalidate);
  }

  // 释放资源：关闭 chokidar 监听器，清空缓存
  // 为什么需要：进程退出时若不关闭 watcher，Node.js 会延迟退出
  async dispose(): Promise<void> {
    if (this._fileWatcher) {
      await this._fileWatcher.close();
      this._fileWatcher = null;
    }
    this._fileContentCache.clear();
    this._fileLinksCache.clear();
    this.invalidateLinkGraphCache();
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

  // 读取文件内容（P2-7：带 mtime 二级缓存）
  // 为什么需要：listAllPages、healthCheck、buildLinkGraph 多处重复 readFile 同一文件
  // 策略：stat 获取 mtime，命中缓存且 mtime 一致则直接返回缓存 content
  // 比 readFile 快 10-100 倍（stat 不读文件内容，只读 inode 元数据）
  async readFile(relativePath: string): Promise<string> {
    const full = this.resolve(relativePath);
    const rel = relativePath.replaceAll('\\', '/');

    // 先 stat 获取 mtime（比 readFile 快，不读文件内容）
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      // stat 失败说明文件不存在，直接抛错让调用方处理
      throw new Error(`文件不存在: ${relativePath}`);
    }

    const cached = this._fileContentCache.get(rel);
    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.content;
    }

    // 缓存未命中或 mtime 变化，重新读取
    const content = await fs.readFile(full, 'utf8');
    this._fileContentCache.set(rel, { mtime: stat.mtimeMs, content });
    return content;
  }

  // 二进制文件读取：绕过 utf8 编码与文本缓存，直接返回 Buffer
  // 为什么需要：图片/音频等二进制文件经 utf8 编码会损坏，
  // /api/files 对图片扩展名需返回原始二进制流供前端 <img> 显示
  async readFileBuffer(relativePath: string): Promise<Buffer> {
    const full = this.resolve(relativePath);
    try {
      // 不传编码参数，fs.readFile 返回 Buffer 而非 string
      return await fs.readFile(full);
    } catch {
      throw new Error(`文件不存在: ${relativePath}`);
    }
  }

  // 解析 [[页面名]] 为实际文件相对路径（如 llm-wiki → concepts/llm-wiki.md）。
  // 为什么需要：RefsList 点击参考资料跳转 Browse 时，前端直接把 ref 字符串当作 path 传给 /api/files，
  // 若 ref 是页面名（无目录前缀、无 .md 后缀），后端 readFile 找不到文件返回 404。
  // 这里在 query 阶段就把页面名解析为路径，保证 refs 数组元素即文件相对路径。
  // 找不到对应文件时返回 null，调用方保留原页面名作向后兼容。
  // 两阶段匹配：
  //   1. 精确匹配（向后兼容，文件名与页面名完全一致）
  //   2. 规范化匹配（大小写不敏感 + 空格↔连字符），处理 LLM 命名变体
  //      例如 [[LLM Wiki]] 对应文件 concepts/llm-wiki.md
  async resolvePageName(pageName: string): Promise<string | null> {
    // 阶段 1：精确匹配
    for (const dir of PAGE_DIRS) {
      const rel = `${dir}/${pageName}.md`;
      try {
        const full = this.resolve(rel);
        await fs.access(full);
        return rel;
      } catch {
        // 文件不存在，继续下一个目录
      }
    }
    // 阶段 2：规范化匹配（大小写不敏感 + 空格转连字符）
    // 为什么不直接用精确匹配：LLM 可能返回 [[LLM Wiki]] 但 vault 文件名是 llm-wiki.md，
    // 精确匹配会 404。规范化后用 readdir 扫描目录，找到变体命名文件。
    const normalized = pageName.toLowerCase().replaceAll(/\s+/g, '-');
    for (const dir of PAGE_DIRS) {
      const dirFull = path.join(this.vaultPath, dir);
      let entries: string[] = [];
      try {
        entries = await fs.readdir(dirFull);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith('.md')) continue;
        const baseName = f.slice(0, -3);
        const normBase = baseName.toLowerCase().replaceAll(/\s+/g, '-');
        if (normBase === normalized) {
          return `${dir}/${f}`;
        }
      }
    }
    return null;
  }

  // 写入文件，含路径白名单校验。SCHEMA.md 不允许 AI 写（10.4 写入约束）。
  // 为什么支持 Buffer：FR-09-3 播客 TTS 合成产物为二进制 mp3，需绕过 utf8 编码
  async writeFile(relativePath: string, content: string | Buffer): Promise<void> {
    const full = this.resolve(relativePath);
    const top = relativePath.split(/[\\/]/)[0];
    const allowed = WRITE_ALLOWED_DIRS.has(top) || WRITE_ALLOWED_FILES.has(relativePath.replaceAll('\\', '/'));
    if (!allowed) {
      throw new Error(`写入被拒绝，路径不在白名单: ${relativePath}`);
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    // Buffer 直接写入避免 utf8 编码破坏二进制数据；string 保持 utf8 编码
    if (typeof content === 'string') {
      await fs.writeFile(full, content, 'utf8');
    } else {
      await fs.writeFile(full, content);
    }
    // § P2-7：失效该文件的内容缓存（writeFile 后 mtime 已变，旧缓存失效）
    // § P2-5：失效该文件的 rawLinks 缓存，并失效主 link graph 缓存
    this.invalidateFileContentCache(relativePath.replaceAll('\\', '/'));
    this.invalidateLinkGraphCache();
    // § P3-2：失效 pending tags 缓存（ai_tags 增删改都经过 writeFile）
    this.invalidatePendingTagsCache();
  }

  async appendIndex(pageName: string, summary: string): Promise<{ ok: boolean; skipped: boolean }> {
    // 查重：按 [[pageName]] 行首匹配，避免同实体多次编译重复追加
    // 为什么读 index.md 而非维护内存集合：index.md 可能被外部编辑器修改，读盘保证一致
    try {
      const existing = await this.readFile('index.md');
      // 转义 pageName 中的正则元字符，防止注入
      const escaped = pageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const dupRe = new RegExp(`^- \\[\\[${escaped}\\]\\]`, 'm');
      if (dupRe.test(existing)) {
        return { ok: true, skipped: true };
      }
    } catch {
      // index.md 读取失败时降级为直接追加（不阻断主流程）
    }
    const line = `- [[${pageName}]] — ${summary}\n`;
    const full = this.resolve('index.md');
    await fs.appendFile(full, line, 'utf8');
    // 失效 index.md 内容缓存，保证下次 readFile 拿到最新内容
    this.invalidateFileContentCache('index.md');
    return { ok: true, skipped: false };
  }

  // 按 frontmatter title 查找已有页面，用于编译前去重重定向
  // 解决 LLM 每次编译自选 slug（如 shanghai-commercial-paper-exchange vs 上海票据交易所）导致同实体重复
  // 比对策略：normalizeTitle 返回主名称 + 括号内英文别名，任一 key 相同视为同实体
  async findPageByTitle(title: string, dir: string): Promise<string | null> {
    const newKeys = normalizeTitle(title);
    if (newKeys.length === 0) return null;
    const dirFull = path.join(this.vaultPath, dir);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dirFull);
    } catch {
      return null;
    }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue;
      const rel = `${dir}/${f}`;
      try {
        const content = await this.readFile(rel);
        const parsed = matter(content);
        const existingTitle = typeof parsed.data.title === 'string' ? parsed.data.title : '';
        if (!existingTitle) continue;
        const existingKeys = normalizeTitle(existingTitle);
        // 交集判断：任一规范化 key 相同则视为同实体
        if (newKeys.some((k) => existingKeys.includes(k))) {
          return rel;
        }
      } catch {
        // 读取/解析失败跳过该文件
      }
    }
    return null;
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

  // 列出所有正式页面的扁平化结构（FR-11 看板/日历视图数据源）。
  // 仅扫描 PAGE_DIRS 下的 .md 文件，跳过 drafts/raw 等非正式页面。
  // 并行化 IO：每个目录独立 readdir + 解析 frontmatter，避免串行等待。
  async listAllPages(): Promise<
    Array<{
      path: string;
      name: string;
      dir: string;
      frontmatter: Record<string, unknown>;
    }>
  > {
    const results = await Promise.all(
      PAGE_DIRS.map(async (dir) => {
        const dirFull = path.join(this.vaultPath, dir);
        let entries: string[] = [];
        try {
          entries = await fs.readdir(dirFull);
        } catch {
          return [];
        }
        // 每个文件并行解析 frontmatter
        return Promise.all(
          entries
            .filter((f) => f.endsWith('.md'))
            .map(async (f) => {
              const rel = `${dir}/${f}`;
              let frontmatter: Record<string, unknown> = {};
              try {
                const content = await this.readFile(rel);
                frontmatter = matter(content).data;
              } catch {
                // 解析失败时返回空 frontmatter，不阻断整体列表
              }
              return {
                path: rel,
                name: f.slice(0, -3),
                dir,
                frontmatter,
              };
            }),
        );
      }),
    );
    return results.flat();
  }

  // 构建双向链接图。纯确定性逻辑，不调 LLM（M-2 healthCheck 与 harness 关系）。
  // 节点 = 页面文件（去 .md 后缀作页面名），边 = [[页面名]] 引用。
  // 页面收集与边抽取拆分为辅助方法，降低主函数认知复杂度（S3776）
  // 并行化 IO：4 目录收集 + 全部页面边抽取用 Promise.all，避免串行 fs 等待
  // § 缓存下沉到 VaultService：/api/graph 与 /api/stats 共享同一份缓存，
  //   避免 30s TTL 同步过期时双倍重算；writeFile 时主动失效
  // § P2-5 增量更新：TTL 过期后重算时，通过 mtime 检测文件是否变化
  //   未变化的文件复用缓存的 rawLinks，跳过 readFile（stat 比 readFile 快 10-100 倍）
  async buildLinkGraph(): Promise<{ nodes: string[]; edges: Array<{ from: string; to: string }> }> {
    const now = Date.now();
    if (this._linkGraphCache && (now - this._linkGraphCachedAt) < VaultService.LINK_GRAPH_TTL_MS) {
      return this._linkGraphCache;
    }

    const nameToPath = new Map<string, string>();
    const nodes: string[] = [];

    // 并行收集 4 个目录：Promise.all 同时发起 readdir，避免串行等待
    await Promise.all(
      PAGE_DIRS.map((d) => this.collectPagesFromDir(d, nodes, nameToPath)),
    );

    // 并行获取每个文件的 rawLinks（命中 mtime 缓存则跳过 readFile）
    const rawLinksArrays = await Promise.all(
      Array.from(nameToPath).map(([, fromPath]) =>
        this.getRawLinksForPage(fromPath),
      ),
    );

    // 用最新 nameToPath 解析 rawLinks 为 edges
    const edges: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < rawLinksArrays.length; i++) {
      const fromPath = Array.from(nameToPath.values())[i];
      const rawLinks = rawLinksArrays[i];
      for (const target of rawLinks) {
        const toPath = nameToPath.get(target);
        if (toPath) {
          edges.push({ from: fromPath, to: toPath });
        }
      }
    }

    const result = { nodes, edges };
    this._linkGraphCache = result;
    this._linkGraphCachedAt = now;
    return result;
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

  // 获取页面文件的 [[link]] 原始引用列表（P2-5：带 mtime 缓存）
  // 为什么缓存 rawLinks 而非 edges：edges 依赖 nameToPath 完整映射
  //   节点增删时即使文件内容未变，edges 也需用新 nameToPath 重新解析
  // 命中缓存时跳过 readFile，仅 stat 获取 mtime（快 10-100 倍）
  private async getRawLinksForPage(fromPath: string): Promise<string[]> {
    const full = this.resolve(fromPath);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      return [];
    }

    const cached = this._fileLinksCache.get(fromPath);
    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.rawLinks;
    }

    // mtime 变化或无缓存，重新读取并提取 rawLinks
    let content = '';
    try {
      content = await this.readFile(fromPath);
    } catch {
      return [];
    }

    const rawLinks: string[] = [];
    const wikilinkRe = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = wikilinkRe.exec(content)) !== null) {
      rawLinks.push(m[1].trim());
    }

    this._fileLinksCache.set(fromPath, { mtime: stat.mtimeMs, rawLinks });
    return rawLinks;
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

  // 列出所有含 ai_tags 字段的页面（FR-10-1 / P3-2）
  // 为什么在 VaultService：缓存失效需要与 writeFile 联动
  // § P3-2：添加 30s TTL 结果缓存，大 vault 下连续请求命中缓存从全量扫描降至 < 5ms
  // § P3-3：分批并发（每批 50 个），避免 1000+ readFile 同时发起耗尽 libuv 线程池
  async listPendingTagPages(): Promise<PendingTagPage[]> {
    // 缓存命中：TTL 内直接返回
    if (
      this._pendingTagsCache !== null &&
      Date.now() - this._pendingTagsCachedAt < VaultService.PENDING_TAGS_TTL_MS
    ) {
      return this._pendingTagsCache;
    }

    // 第 1 步：并行 readdir 所有页面目录
    const dirEntries = await Promise.all(
      PAGE_DIRS.map(async (dir) => {
        try {
          const entries = await fs.readdir(path.join(this.vaultPath, dir));
          return { dir, files: entries.filter((f) => f.endsWith('.md')) };
        } catch {
          return { dir, files: [] as string[] };
        }
      }),
    );

    // 第 2 步：扁平化所有 .md 文件路径
    const allFiles = dirEntries.flatMap(({ dir, files }) =>
      files.map((f) => ({ dir, file: f, rel: `${dir}/${f}` })),
    );

    // 第 3 步：分批并行读取 + 解析 frontmatter（P3-3）
    // 为什么分批：Promise.all 同时发起 1055 个 readFile 会耗尽 libuv 线程池（默认 4 个），
    //   每批 50 个既能利用并行，又避免事件循环阻塞 + Windows Defender 实时扫描放大延迟
    const BATCH_SIZE = 50;
    const parsedResults: (PendingTagPage | null)[] = [];
    for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
      const batch = allFiles.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async ({ rel, file }) => {
          try {
            const raw = await this.readFile(rel);
            const m = matter(raw);
            const aiTags = Array.isArray(m.data.ai_tags) ? (m.data.ai_tags as string[]) : [];
            if (aiTags.length === 0) return null;
            const existingTags = Array.isArray(m.data.tags) ? (m.data.tags as string[]) : [];
            const title = typeof m.data.title === 'string' ? m.data.title : file.slice(0, -3);
            return { path: rel, title, aiTags, existingTags };
          } catch {
            return null;
          }
        }),
      );
      parsedResults.push(...batchResults);
    }

    // 第 4 步：过滤 + 写缓存
    const result = parsedResults.filter((p): p is PendingTagPage => p !== null);
    this._pendingTagsCache = result;
    this._pendingTagsCachedAt = Date.now();
    return result;
  }
}

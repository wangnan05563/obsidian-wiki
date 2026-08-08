import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { VaultService } from '../vault/vault-service.js';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';

const execFileAsync = promisify(execFile);

interface SchemaCommit {
  hash: string;
  date: string;
  message: string;
  author: string;
}

interface DiffLine {
  type: 'add' | 'del' | 'context';
  content: string;
  oldLine?: number;
  newLine?: number;
}

// 模块级缓存：key -> { data, expiry }
const SCHEMA_HISTORY_CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟
const cache = new Map<string, { data: { commits: SchemaCommit[]; gitEnabled: boolean }; expiry: number }>();

function getFromCache(key: string): { commits: SchemaCommit[]; gitEnabled: boolean } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setInCache(key: string, data: { commits: SchemaCommit[]; gitEnabled: boolean }): void {
  cache.set(key, { data, expiry: Date.now() + SCHEMA_HISTORY_CACHE_TTL_MS });
}

async function runGit(vaultPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: vaultPath,
      encoding: 'utf8',
      timeout: 5000,
    });
    return stdout;
  } catch {
    return '';
  }
}

// 清除 schema/history 缓存（供外部调用，如 config reload 时）
export function invalidateSchemaHistoryCache(): void {
  cache.clear();
}

// 解析 git diff 输出为 DiffLine 数组，独立为纯函数降低 diff 路由认知复杂度
function parseDiffLines(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/); // NOSONAR: 单次匹配取 @@ 行号，match 返回数组更适合此场景
      if (match) {
        oldLine = Number.parseInt(match[1], 10);
        newLine = Number.parseInt(match[2], 10);
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      lines.push({ type: 'add', content: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      lines.push({ type: 'del', content: line.slice(1), oldLine: oldLine++ });
    } else if (line.startsWith(' ')) {
      lines.push({ type: 'context', content: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }

  return lines;
}

// 只读 GET 路由的统一限流配置（P1-4）：
// 全局默认 60 req/min 兜底写操作（PUT /api/schema），这里覆盖为 300 req/min
// 适用于 schema 内容查询、git 历史与 diff 三个 GET 端点
const READ_RATE_LIMIT = { max: 300, timeWindow: '1 minute' };

export function registerSchemaRoutes(app: FastifyInstance, vault: VaultService, guards: IsolationGuards = createIsolationGuards()) {
  app.get('/api/schema', { config: { rateLimit: READ_RATE_LIMIT } }, async (_request, reply) => {
    try {
      const content = await vault.readFile('SCHEMA.md');
      return reply.send({ content });
    } catch (err: unknown) {
      return reply.code(404).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.put('/api/schema', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { content?: string };
    if (!body || typeof body.content !== 'string') {
      return reply.code(400).send({ error: '请求体须含 content 字段' });
    }
    try {
      const full = path.resolve(vault.getVaultPath(), 'SCHEMA.md');
      await fs.writeFile(full, body.content, 'utf8');
      // 清除缓存，因为 SCHEMA.md 已被修改
      cache.clear();
      return reply.send({ ok: true });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/schema/history', { config: { rateLimit: READ_RATE_LIMIT } }, async (_request, reply) => {
    const vaultPath = vault.getVaultPath();
    const cacheKey = vaultPath;

    // 先查缓存
    const cached = getFromCache(cacheKey);
    if (cached) {
      return reply.send(cached);
    }

    const log = await runGit(vaultPath, [
      'log', '--pretty=format:%H|%ad|%s|%an', '--date=iso', '--', 'SCHEMA.md',
    ]);

    let result: { commits: SchemaCommit[]; gitEnabled: boolean };
    if (log.trim() === '') {
      result = { commits: [], gitEnabled: false };
    } else {
      const commits: SchemaCommit[] = log
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, date, message, author] = line.split('|');
          return { hash, date, message, author };
        });
      result = { commits, gitEnabled: true };
    }

    // 写入缓存
    setInCache(cacheKey, result);
    return reply.send(result);
  });

  app.get('/api/schema/diff', { config: { rateLimit: READ_RATE_LIMIT } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { from?: string; to?: string };
    if (!query.from) {
      return reply.code(400).send({ error: '缺少 from 参数' });
    }
    // 防参数注入：from/to 直接传入 git 命令，必须校验为 commit hash 格式
    if (!/^[0-9a-f]{7,40}$/i.test(query.from)) {
      return reply.code(400).send({ error: 'from 参数须为 commit hash 格式' });
    }
    if (query.to && query.to !== 'HEAD' && !/^[0-9a-f]{7,40}$/i.test(query.to)) {
      return reply.code(400).send({ error: 'to 参数须为 commit hash 格式或 HEAD' });
    }

    const vaultPath = vault.getVaultPath();
    const to = query.to || 'HEAD';
    const diff = await runGit(vaultPath, [
      'diff', '--unified=0', '--no-color', query.from, to, '--', 'SCHEMA.md',
    ]);

    if (!diff.trim()) {
      return reply.send({ lines: [], hasChanges: false });
    }

    const lines = parseDiffLines(diff);
    return reply.send({ lines, hasChanges: lines.length > 0 });
  });
}






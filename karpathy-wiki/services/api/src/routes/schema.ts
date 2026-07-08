import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { VaultService } from '../vault/vault-service.js';

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

export function registerSchemaRoutes(app: FastifyInstance, vault: VaultService) {
  app.get('/api/schema', async (_request, reply) => {
    try {
      const content = await vault.readFile('SCHEMA.md');
      return reply.send({ content });
    } catch (err: unknown) {
      return reply.code(404).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.put('/api/schema', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { content?: string };
    if (!body || typeof body.content !== 'string') {
      return reply.code(400).send({ error: '请求体须含 content 字段' });
    }
    try {
      const full = path.resolve(vault.getVaultPath(), 'SCHEMA.md');
      await fs.writeFile(full, body.content, 'utf8');
      return reply.send({ ok: true });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/api/schema/history', async (_request, reply) => {
    const vaultPath = vault.getVaultPath();
    const log = await runGit(vaultPath, [
      'log', '--pretty=format:%H|%ad|%s|%an', '--date=iso', '--', 'SCHEMA.md',
    ]);

    if (!log.trim()) {
      return reply.send({ commits: [], gitEnabled: false });
    }

    const commits: SchemaCommit[] = log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, date, message, author] = line.split('|');
        return { hash, date, message, author };
      });

    return reply.send({ commits, gitEnabled: true });
  });

  app.get('/api/schema/diff', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { from?: string; to?: string };
    if (!query.from) {
      return reply.code(400).send({ error: '缺少 from 参数' });
    }

    const vaultPath = vault.getVaultPath();
    const to = query.to || 'HEAD';
    const diff = await runGit(vaultPath, [
      'diff', '--unified=0', '--no-color', query.from, to, '--', 'SCHEMA.md',
    ]);

    if (!diff.trim()) {
      return reply.send({ lines: [], hasChanges: false });
    }

    const lines: DiffLine[] = [];
    let oldLine = 0;
    let newLine = 0;

    for (const line of diff.split('\n')) {
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          oldLine = parseInt(match[1], 10);
          newLine = parseInt(match[2], 10);
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        lines.push({ type: 'add', content: line.slice(1), newLine: newLine++ });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        lines.push({ type: 'del', content: line.slice(1), oldLine: oldLine++ });
      } else if (line.startsWith(' ')) {
        lines.push({ type: 'context', content: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
      }
    }

    return reply.send({ lines, hasChanges: lines.length > 0 });
  });
}
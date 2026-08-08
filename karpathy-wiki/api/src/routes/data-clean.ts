import type { FastifyInstance } from 'fastify';
import { VaultService } from '../vault/vault-service.js';
import { scanVault, archiveFiles, fixFrontmatter, mergeDuplicatePages, deleteFiles, precheckVault } from '../data-clean/quality-scanner.js';
import { deduplicatePages } from '../data-clean/dedup-engine.js';
import { compareFiles, isValidVaultPath } from '../data-clean/diff-engine.js';
import { SchedulerManager } from '../data-clean/scheduler-manager.js';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';

let scheduler: SchedulerManager | null = null;

export function registerDataCleanRoute(app: FastifyInstance, vault: VaultService, guards: IsolationGuards = createIsolationGuards()): void {
  if (!scheduler) {
    scheduler = new SchedulerManager(vault.getVaultPath());
    void scheduler.load(); // Fire-and-forget initial load
  }

  app.get('/api/data-clean/pages', async (_req, reply) => {
    try {
      const pages = await scanVault(vault);
      return reply.send(pages);
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/data-clean/deduplicate', { preHandler: guards.requireAdmin }, async (_req, reply) => {
    try {
      const result = await deduplicatePages(vault);
      return reply.send(result);
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 行级差异对比：供前端"查看差异"抽屉调用
  // 为什么独立接口而非嵌入 deduplicate：差异对比是大块返回（含每行内容），
  // 而 deduplicate 只需返回 matches 概要，避免一次返回数 MB 数据拖慢 UI
  app.get('/api/data-clean/diff', async (req, reply) => {
    try {
      const { pathA, pathB } = (req.query as any) ?? {};
      if (!pathA || !pathB) {
        return reply.code(400).send({ error: 'pathA and pathB query params required' });
      }
      if (!isValidVaultPath(pathA) || !isValidVaultPath(pathB)) {
        return reply.code(400).send({ error: 'Invalid path: must match ^[a-zA-Z0-9_\\-\\u4e00-\\u9fa5/]+\\.md$ and contain no ..' });
      }
      const result = await compareFiles(vault, pathA, pathB);
      return reply.send(result);
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/data-clean/archive', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      const body = req.body as any;
      if (!Array.isArray(body?.files)) {
        return reply.code(400).send({ error: 'Invalid request: files array required' });
      }
      const result = await archiveFiles(vault, body.files, body.dry_run ?? true);
      return reply.send(result);
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/data-clean/delete', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      const body = req.body as any;
      if (!Array.isArray(body?.files)) {
        return reply.code(400).send({ error: 'Invalid request: files array required' });
      }
      const result = await deleteFiles(vault, body.files, body.dry_run ?? true);
      return reply.send(result);
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/data-clean/fix-frontmatter', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      const body = req.body as any;
      if (!Array.isArray(body?.paths)) {
        return reply.code(400).send({ error: 'Invalid request: paths array required' });
      }
      const result = await fixFrontmatter(vault, body.paths, body.dry_run ?? true);
      return reply.send(result);
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/data-clean/merge', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      const body = req.body as any;
      if (!body.pageA || !body.pageB) {
        return reply.code(400).send({ error: 'Invalid request: pageA and pageB required' });
      }
      const pair: any = {
        pageA: body.pageA, pageB: body.pageB,
        similarity: body.similarity ?? 0.9,
        matchType: body.matchType ?? 'near-duplicate',
        reason: body.reason ?? 'Merged via API'
      };
      const result = await mergeDuplicatePages(vault, pair, body.archive_kept ?? false, body.dry_run ?? true);
      return reply.send(result);
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/data-clean/precheck', async (_req, reply) => {
    try {
      const result = await precheckVault(vault);
      return reply.send(result);
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Scheduler endpoints ─────────────────────────────────────
  app.get('/api/data-clean/schedules', async (_req, reply) => {
    try {
      if (!scheduler) return reply.code(503).send({ error: 'Scheduler not initialized' });
      await scheduler.load();
      return reply.send(scheduler.getAll());
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/data-clean/schedules', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      if (!scheduler) return reply.code(503).send({ error: 'Scheduler not initialized' });
      const body = req.body as any;
      if (!body.cron) {
        return reply.code(400).send({ error: 'cron expression required' });
      }
      await scheduler.load();
      const result = await scheduler.add({ cron: body.cron, enabled: body.enabled ?? true });
      return reply.send(result);
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/data-clean/schedules/:id', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      if (!scheduler) return reply.code(503).send({ error: 'Scheduler not initialized' });
      const id = (req.params as any).id as string;
      await scheduler.load();
      const result = await scheduler.update(id, req.body as any);
      if (!result) return reply.code(404).send({ error: 'Schedule not found' });
      return reply.send(result);
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/data-clean/schedules/:id', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      if (!scheduler) return reply.code(503).send({ error: 'Scheduler not initialized' });
      const id = (req.params as any).id as string;
      await scheduler.load();
      const ok = await scheduler.remove(id);
      if (!ok) return reply.code(404).send({ error: 'Schedule not found' });
      return reply.send({ ok: true });
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/data-clean/schedules/:id/run', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      if (!scheduler) return reply.code(503).send({ error: 'Scheduler not initialized' });
      const id = (req.params as any).id as string;
      await scheduler.load();
      const result = await scheduler.runScan(id);
      if (!result) return reply.code(404).send({ error: 'Schedule not found or run failed' });
      return reply.send({ ...result, lastRun: new Date().toISOString() });
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
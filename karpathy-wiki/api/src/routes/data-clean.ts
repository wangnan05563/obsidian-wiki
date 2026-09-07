import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../types.js';
import { VaultService } from '../vault/vault-service.js';
import { scanVault, archiveFiles, fixFrontmatter, mergeDuplicatePages, deleteFiles, precheckVault, batchRename, batchDedupPages } from '../data-clean/quality-scanner.js';
import { deduplicatePages } from '../data-clean/dedup-engine.js';
import { analyzeVaultForCleanup } from '../data-clean/ai-analysis-workflow.js';
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
      return void reply.send(pages);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/data-clean/deduplicate', { preHandler: guards.requireAdmin }, async (_req, reply) => {
    try {
      const result = await deduplicatePages(vault);
      return void reply.send(result);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 行级差异对比：供前端"查看差异"抽屉调用
  // 为什么独立接口而非嵌入 deduplicate：差异对比是大块返回（含每行内容），
  // 而 deduplicate 只需返回 matches 概要，避免一次返回数 MB 数据拖慢 UI
  app.get('/api/data-clean/diff', async (req, reply) => {
    try {
      const { pathA, pathB } = (req.query as any) ?? {};
      if (!pathA || !pathB) {
        return void reply.code(400).send({ error: 'pathA and pathB query params required' });
      }
      if (!isValidVaultPath(pathA) || !isValidVaultPath(pathB)) {
        return void reply.code(400).send({ error: String.raw`Invalid path: must match ^[a-zA-Z0-9_\-\u4e00-\u9fa5/]+\.md$ and contain no ..` });
      }
      const result = await compareFiles(vault, pathA, pathB);
      return void reply.send(result);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/data-clean/archive', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      const body = req.body as any;
      if (!Array.isArray(body?.files)) {
        return void reply.code(400).send({ error: 'Invalid request: files array required' });
      }
      const result = await archiveFiles(vault, body.files, body.dry_run ?? true);
      return void reply.send(result);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/data-clean/delete', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      const body = req.body as any;
      if (!Array.isArray(body?.files)) {
        return void reply.code(400).send({ error: 'Invalid request: files array required' });
      }
      const result = await deleteFiles(vault, body.files, body.dry_run ?? true);
      return void reply.send(result);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/data-clean/fix-frontmatter', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      const body = req.body as any;
      if (!Array.isArray(body?.paths)) {
        return void reply.code(400).send({ error: 'Invalid request: paths array required' });
      }
      const result = await fixFrontmatter(vault, body.paths, body.dry_run ?? true);
      return void reply.send(result);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/data-clean/merge', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      const body = req.body as any;
      if (!body.pageA || !body.pageB) {
        return void reply.code(400).send({ error: 'Invalid request: pageA and pageB required' });
      }
      const pair: any = {
        pageA: body.pageA, pageB: body.pageB,
        similarity: body.similarity ?? 0.9,
        matchType: body.matchType ?? 'near-duplicate',
        reason: body.reason ?? 'Merged via API'
      };
      const result = await mergeDuplicatePages(vault, pair, body.archive_kept ?? false, body.dry_run ?? true);
      return void reply.send(result);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/data-clean/precheck', async (_req, reply) => {
    try {
      const result = await precheckVault(vault);
      return void reply.send(result);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── AI 智能清洗分析 ─────────────────────────────────────
  // POST /api/data-clean/ai-analyze：对当前文档集合做 AI 分类（冗余删除 / 重复去重 / 规范重命名）。
  // BYOK：必须用请求体携带用户自有 llmConfig（provider/baseUrl/model/apiKey），
  //   缺 key 或字段不全 → 400 明确指引（不回落服务端共享 key，与 query 管线一致）。
  // requireAuth：分析本身只读、调用用户自有模型；破坏性批量操作另由管理员门控端点执行。
  app.post('/api/data-clean/ai-analyze', { preHandler: guards.requireAuth }, async (req, reply) => {
    try {
      const body = req.body as any;
      const llm = body?.llmConfig;
      const keyOk = !!llm && typeof llm.apiKey === 'string' && llm.apiKey.trim() !== '';
      const fieldsOk =
        !!llm &&
        typeof llm.provider === 'string' && llm.provider.trim() !== '' &&
        typeof llm.baseUrl === 'string' && llm.baseUrl.trim() !== '' &&
        typeof llm.model === 'string' && llm.model.trim() !== '';
      if (!keyOk || !fieldsOk) {
        return void reply.code(400).send({
          error: '请先在「配置 / 我的」中填写完整的 API Key（BYOK），AI 分析需要用户自有模型',
        });
      }
      // 仅用请求体 llmConfig 构造 AppConfig（密钥不落服务端）
      const config = {
        llm: {
          provider: llm.provider,
          baseUrl: llm.baseUrl,
          model: llm.model,
          apiKeyRef: '',
          apiKey: llm.apiKey,
        },
        vaultPath: vault.getVaultPath(),
      } as AppConfig;
      const result = await analyzeVaultForCleanup(vault, config);
      return void reply.send(result);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 批量去重：把重复组非代表文档合并进代表文档（管理员门控，破坏性）
  app.post('/api/data-clean/batch-dedup', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      const body = req.body as any;
      if (!Array.isArray(body?.groups) || body.groups.length === 0) {
        return void reply.code(400).send({ error: 'groups 数组必填（每项 { keep, merge[] }）' });
      }
      const groups = body.groups
        .map((g: any) => ({
          keep: String(g?.keep ?? ''),
          merge: Array.isArray(g?.merge) ? g.merge.map(String) : [],
        }))
        .filter((g: { keep: string; merge: string[] }) => g.keep && g.merge.length > 0);
      const dryRun = body.dry_run ?? false;
      const result = await batchDedupPages(vault, groups, dryRun);
      return void reply.send(result);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 批量重命名：按 { from, to } 原地规范化文件名（管理员门控，破坏性）
  app.post('/api/data-clean/batch-rename', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      const body = req.body as any;
      if (!Array.isArray(body?.renames) || body.renames.length === 0) {
        return void reply.code(400).send({ error: 'renames 数组必填（每项 { from, to }）' });
      }
      const items = body.renames
        .map((r: any) => ({ from: String(r?.from ?? ''), to: String(r?.to ?? '') }))
        .filter((r: { from: string; to: string }) => r.from && r.to);
      const dryRun = body.dry_run ?? false;
      const result = await batchRename(vault, items, dryRun);
      return void reply.send(result);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Scheduler endpoints ─────────────────────────────────────
  app.get('/api/data-clean/schedules', async (_req, reply) => {
    try {
      if (!scheduler) return void reply.code(503).send({ error: 'Scheduler not initialized' });
      await scheduler.load();
      return void reply.send(scheduler.getAll());
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/data-clean/schedules', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      if (!scheduler) return void reply.code(503).send({ error: 'Scheduler not initialized' });
      const body = req.body as any;
      if (!body.cron) {
        return void reply.code(400).send({ error: 'cron expression required' });
      }
      await scheduler.load();
      const result = await scheduler.add({ cron: body.cron, enabled: body.enabled ?? true });
      return void reply.send(result);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/data-clean/schedules/:id', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      if (!scheduler) return void reply.code(503).send({ error: 'Scheduler not initialized' });
      const id = (req.params as any).id as string;
      await scheduler.load();
      const result = await scheduler.update(id, req.body as any);
      if (!result) return void reply.code(404).send({ error: 'Schedule not found' });
      return void reply.send(result);
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/data-clean/schedules/:id', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      if (!scheduler) return void reply.code(503).send({ error: 'Scheduler not initialized' });
      const id = (req.params as any).id as string;
      await scheduler.load();
      const ok = await scheduler.remove(id);
      if (!ok) return void reply.code(404).send({ error: 'Schedule not found' });
      return void reply.send({ ok: true });
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/data-clean/schedules/:id/run', { preHandler: guards.requireAdmin }, async (req, reply) => {
    try {
      if (!scheduler) return void reply.code(503).send({ error: 'Scheduler not initialized' });
      const id = (req.params as any).id as string;
      await scheduler.load();
      const result = await scheduler.runScan(id);
      if (!result) return void reply.code(404).send({ error: 'Schedule not found or run failed' });
      return void reply.send({ ...result, lastRun: new Date().toISOString() });
    } catch (err) {
      return void reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
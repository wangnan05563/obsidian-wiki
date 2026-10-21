import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CleanupRequest,
  CleanupResult,
  CleanupStorageStatus,
  CleanupBlockedResponse,
} from '../types.js';
import type { VaultService } from '../vault/vault-service.js';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';
import { currentActiveState, evaluateCleanupGuard, guardErrorMessage } from '../cleanup-guard.js';

// 系统清理路由。
//   GET  /api/cleanup/status   查询 4 类对象存储状态
//   POST /api/cleanup          执行清理（统一端点，target 分发）
//
// 4 类清理对象：
//   - compile_cache : .harness/compile-cache.json（增量编译缓存，整文件删除）
//   - run_state     : .harness/state/*.json（断点续传状态文件）
//   - run_logs      : .harness/logs/*.log（按 days 清理旧日志）
//   - raw_archive   : vault/raw/ 下内部临时前缀文件（wiki-batch-*/wiki-compile-*/input-*，按 days 清理原始资料）
//
// 安全机制（参考闲鱼项目）：
//   - dry_run 预览模式，true 时仅列出将删除项不实际执行
//   - 路由层不强制二次确认（前端 globalThis.confirm 已实现），后端按请求执行
//   - 单子项失败不影响其他子项（独立 try/except，errors[] 收集）
//   - days 下限保护：max(1, days) 防止误删全表
//   - T02655：真实删除（dry_run=false）前查活跃编译/问答任务，命中直接 409 不执行。
//     拦截口径（拦哪两类、为什么不拦另两类）在 cleanup-guard.ts，status 与 POST 共用，
//     避免「前端置灰规则」与「后端放行规则」漂移。

const DEFAULT_DAYS = 30;
const BYTES_PER_MB = 1024 * 1024;
// 释放空间的上报下限（MB）：真删了文件就不报 0，见下方 result.total_freed_mb 处注释
const MIN_REPORTED_MB = 0.01;

// 移到模块顶层：纯函数无外部依赖，避免每次路由注册重建闭包
function bytesToMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 100) / 100;
}

export function registerCleanupRoute(app: FastifyInstance, vault: VaultService, guards: IsolationGuards = createIsolationGuards()): void {
  const vaultPath = vault.getVaultPath();
  // .harness 与 vault 同级（与 index.ts stateDir 计算一致）
  const harnessDir = path.resolve(vaultPath, '..', '.harness');
  const compileCacheFile = path.join(harnessDir, 'compile-cache.json');
  const stateDir = path.join(harnessDir, 'state');
  const logsDir = path.join(harnessDir, 'logs');
  const rawDir = path.join(vaultPath, 'raw');
  // 审计日志：追加到 .harness/cleanup-audit.log（避免引入数据库依赖）
  const auditLog = path.join(harnessDir, 'cleanup-audit.log');

  // ===== 工具函数 =====

  // 列目录下匹配 pattern 的文件（仅文件，不含子目录）
  async function listFiles(dir: string, pattern: RegExp): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && pattern.test(e.name))
        .map((e) => path.join(dir, e.name));
    } catch {
      return [];
    }
  }

  // 统计目录下文件数 + 总大小（字节）+ 最早 mtime
  async function statDir(dir: string, pattern: RegExp): Promise<{ fileCount: number; sizeBytes: number; oldest: string | null }> {
    const files = await listFiles(dir, pattern);
    let sizeBytes = 0;
    let oldestMs: number | null = null;
    for (const f of files) {
      try {
        const stat = await fs.stat(f);
        sizeBytes += stat.size;
        if (oldestMs === null || stat.mtimeMs < oldestMs) {
          oldestMs = stat.mtimeMs;
        }
      } catch {
        // 单文件 stat 失败跳过
      }
    }
    return {
      fileCount: files.length,
      sizeBytes,
      oldest: oldestMs === null ? null : new Date(oldestMs).toISOString().slice(0, 10),
    };
  }

  // 审计写入：JSONL 追加，失败不阻塞主流程（与闲鱼 _log_cleanup_action 一致）
  async function writeAudit(entry: Record<string, unknown>): Promise<void> {
    try {
      await fs.mkdir(harnessDir, { recursive: true });
      await fs.appendFile(auditLog, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // 审计失败不阻塞清理主流程
    }
  }

  // ===== GET /api/cleanup/status =====

  app.get('/api/cleanup/status', async (_req, reply) => {
    try {
      // 编译缓存
      let compileCacheExists = false;
      let compileCacheSize = 0;
      let compileCacheEntries = 0;
      try {
        const stat = await fs.stat(compileCacheFile);
        compileCacheExists = true;
        compileCacheSize = stat.size;
        const raw = await fs.readFile(compileCacheFile, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        compileCacheEntries = Object.keys(parsed).length;
      } catch {
        // 文件不存在或解析失败
      }

      // 运行状态
      const stateStat = await statDir(stateDir, /\.json$/);
      // 运行日志
      const logsStat = await statDir(logsDir, /\.log$/);
      // 原始资料存档（仅清理内部临时前缀文件，避免误删用户命名的源文件）
      const rawStat = await statDir(rawDir, /^(wiki-batch-|wiki-compile-|input-).*/);

      const status: CleanupStorageStatus = {
        // T02655：活跃任务快照。前端据此逐卡置灰；口径与 POST 守卫同源（cleanup-guard）
        active: currentActiveState(),
        compileCache: {
          exists: compileCacheExists,
          sizeMb: bytesToMb(compileCacheSize),
          entryCount: compileCacheEntries,
        },
        runState: {
          fileCount: stateStat.fileCount,
          sizeMb: bytesToMb(stateStat.sizeBytes),
          oldest: stateStat.oldest,
        },
        runLogs: {
          fileCount: logsStat.fileCount,
          sizeMb: bytesToMb(logsStat.sizeBytes),
          oldest: logsStat.oldest,
        },
        rawArchive: {
          fileCount: rawStat.fileCount,
          sizeMb: bytesToMb(rawStat.sizeBytes),
          oldest: rawStat.oldest,
        },
      };
      return void reply.send(status);
    } catch (err: unknown) {
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ===== POST /api/cleanup =====

  app.post('/api/cleanup', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Partial<CleanupRequest>;
    const target = body.target || 'all';
    // 后端钳制 days 下限，防止 0 或负值导致删除全部
    const days = Math.max(1, typeof body.days === 'number' ? body.days : DEFAULT_DAYS);
    const dryRun = body.dry_run !== false; // 默认预览，强制用户主动关闭

    // T02655 活跃任务硬拦截：仅在真实删除模式下判定。
    // 为什么不拦预览：预览不删任何文件，拦它反而让用户看不到「会删哪些」，
    // 阻碍他做「要不要真删」的判断。
    // 残留窗口（如实记录）：GET status 与本守卫之间、以及本守卫与删除动作之间，
    // 任务仍可能刚起跑（毫秒级窗口）。此前是「整场编译期间都可能误删」，
    // 现在收窄为「恰好在删除窗口内起跑的任务」；彻底闭环需要清理与编译互斥，
    // 已建派生单跟进，不在本单扩大改动面。
    if (!dryRun) {
      const verdict = evaluateCleanupGuard(target);
      if (verdict.blocked.length > 0) {
        const active = currentActiveState();
        const blocked: CleanupBlockedResponse = {
          error: guardErrorMessage(target, verdict),
          code: 'cleanup_blocked_by_active_task',
          target,
          blocked: verdict.blocked,
          reasons: verdict.reasons,
          active,
        };
        // 被拦也必须落审计：这是「用户在有活跃任务时试图真实删除」的唯一留痕
        await writeAudit({
          ts: new Date().toISOString(),
          target,
          days,
          dry_run: false,
          blocked_by_active_task: true,
          blocked: verdict.blocked,
          active,
        });
        return void reply.code(409).send(blocked);
      }
    }

    const result: CleanupResult = {
      target,
      days,
      dry_run: dryRun,
      cleaned: [],
      errors: [],
      count: 0,
    };

    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    let totalFreedBytes = 0;

    // 执行单文件删除（dry_run 时仅追加预览消息）
    async function cleanupFile(file: string, label: string): Promise<void> {
      try {
        const stat = await fs.stat(file);
        if (dryRun) {
          result.cleaned.push(`[预览] 将删除 ${label} (${bytesToMb(stat.size)}MB)`);
        } else {
          await fs.unlink(file);
          totalFreedBytes += stat.size;
          result.cleaned.push(`已删除 ${label} (${bytesToMb(stat.size)}MB)`);
        }
      } catch (err: unknown) {
        result.errors.push(`${label} 清理失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 编译缓存清理
    async function cleanupCompileCache(): Promise<void> {
      try {
        const stat = await fs.stat(compileCacheFile);
        if (dryRun) {
          result.cleaned.push(`[预览] 将删除编译缓存 compile-cache.json (${bytesToMb(stat.size)}MB)`);
        } else {
          await fs.unlink(compileCacheFile);
          totalFreedBytes += stat.size;
          result.cleaned.push('已删除编译缓存 compile-cache.json，下次编译将重新生成');
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        result.errors.push(`编译缓存清理失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 运行状态清理
    async function cleanupRunState(): Promise<void> {
      const files = await listFiles(stateDir, /\.json$/);
      if (files.length === 0) {
        if (dryRun) result.cleaned.push('[预览] 无运行状态文件');
        return;
      }
      for (const f of files) {
        await cleanupFile(f, `运行状态 ${path.basename(f)}`);
      }
    }

    // 运行日志清理（按 days）
    async function cleanupRunLogs(): Promise<void> {
      const files = await listFiles(logsDir, /\.log$/);
      if (files.length === 0) {
        if (dryRun) result.cleaned.push('[预览] 无运行日志文件');
        return;
      }
      for (const f of files) {
        try {
          const stat = await fs.stat(f);
          if (stat.mtimeMs < cutoffMs) {
            if (dryRun) {
              result.cleaned.push(`[预览] 将删除日志 ${path.basename(f)} (${bytesToMb(stat.size)}MB, ${stat.mtime.toISOString().slice(0, 10)})`);
            } else {
              await fs.unlink(f);
              totalFreedBytes += stat.size;
              result.cleaned.push(`已删除日志 ${path.basename(f)} (${bytesToMb(stat.size)}MB)`);
            }
          }
        } catch (err: unknown) {
          result.errors.push(`日志 ${path.basename(f)} 处理失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 原始资料存档清理（按 days）
    async function cleanupRawArchive(): Promise<void> {
      const files = await listFiles(rawDir, /^(wiki-batch-|wiki-compile-|input-).*/);
      if (files.length === 0) {
        if (dryRun) result.cleaned.push('[预览] 无原始资料存档');
        return;
      }
      for (const f of files) {
        try {
          const stat = await fs.stat(f);
          if (stat.mtimeMs < cutoffMs) {
            if (dryRun) {
              result.cleaned.push(`[预览] 将删除存档 ${path.basename(f)} (${bytesToMb(stat.size)}MB, ${stat.mtime.toISOString().slice(0, 10)})`);
            } else {
              await fs.unlink(f);
              totalFreedBytes += stat.size;
              result.cleaned.push(`已删除存档 ${path.basename(f)} (${bytesToMb(stat.size)}MB)`);
            }
          }
        } catch (err: unknown) {
          result.errors.push(`存档 ${path.basename(f)} 处理失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    try {
      // 按目标分发
      const targets = target === 'all'
        ? ['compile_cache', 'run_state', 'run_logs', 'raw_archive']
        : [target];

      for (const t of targets) {
        switch (t) {
          case 'compile_cache':
            await cleanupCompileCache();
            break;
          case 'run_state':
            await cleanupRunState();
            break;
          case 'run_logs':
            await cleanupRunLogs();
            break;
          case 'raw_archive':
            await cleanupRawArchive();
            break;
          default:
            result.errors.push(`未知清理目标: ${t}`);
        }
      }

      result.count = result.cleaned.length;
      // 释放量口径：totalFreedBytes 只在 fs.unlink 成功后累加，所以「条目失败但没删成任何文件」
      // 时它是 0 → 字段缺省，前端不显示「释放」（而不是显示一个 0）。
      // 下限 MIN_REPORTED_MB：真删了几 KB 时 2 位小数会舍入成 0，响应里就会出现「释放 0 MB」，
      // 与「没删东西所以不显示」撞车（T02773 验收：清理量为 0 不显示该片段）。
      if (totalFreedBytes > 0) {
        result.total_freed_mb = Math.max(MIN_REPORTED_MB, bytesToMb(totalFreedBytes));
      }

      // 审计写入（dry_run 模式也记录，便于回溯预览操作）
      await writeAudit({
        ts: new Date().toISOString(),
        target,
        days,
        dry_run: dryRun,
        cleaned_count: result.count,
        error_count: result.errors.length,
        total_freed_mb: result.total_freed_mb ?? 0,
        cleaned_items: result.cleaned.slice(0, 20),
        errors: result.errors.slice(0, 5),
      });

      return void reply.send(result);
    } catch (err: unknown) {
      // 兜底：未预期异常返回 500
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

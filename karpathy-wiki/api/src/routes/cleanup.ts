import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CleanupRequest,
  CleanupResult,
  CleanupStorageStatus,
  CleanupBlockedResponse,
  CleanupRunStateDir,
} from '../types.js';
import type { VaultService } from '../vault/vault-service.js';
import { type IsolationGuards, createIsolationGuards } from '../middleware/auth.js';
import { currentActiveState, evaluateCleanupGuard, guardErrorMessage } from '../cleanup-guard.js';
// T02774：真实清理的独占锁（把「守卫通过 ~ 删除完成」的窗口封成机制上的零）
import { acquireCleanup, type CleanupHandle } from '../cleanup-mutex.js';

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

export function registerCleanupRoute(
  app: FastifyInstance,
  vault: VaultService,
  guards: IsolationGuards = createIsolationGuards(),
  // T02772：run-state 目录清单。生产由 index.ts 传入「规范目录 + 遗留目录」的合并清单；
  // 默认只认「与 vault 同级」这一个目录——fail-safe 取向：调用方漏传时是「少清一处」，
  // 而不是「把用户真实目录算进删除清单」（单测都用临时目录，漏传即只碰临时目录）。
  runStateDirsOverride?: string[],
): void {
  const vaultPath = vault.getVaultPath();
  // .harness 与 vault 同级（与 index.ts stateDir 计算一致）
  const harnessDir = path.resolve(vaultPath, '..', '.harness');
  const compileCacheFile = path.join(harnessDir, 'compile-cache.json');
  const stateDir = path.join(harnessDir, 'state');
  // 运行状态可能散在多个目录：写入侧历史上按进程 CWD 落盘，清理侧历史上只认这里，
  // 两套口径的交集为空时就是本单的原始症状——卡面显示 0 个，磁盘上攒了 100+ 个。
  // 默认只扫本目录（fail-safe）：合并清单由 index.ts 显式传入，
  // 调用方漏传的后果是「少清一处」，而不是把用户真实目录算进删除清单。
  const runStateDirs = runStateDirsOverride ?? [stateDir];
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

  // 单个 run-state 目录的统计（T02772 合并计数 + T02808 目录清单）。
  // 为什么合并计数改为由逐目录结果求和，而不是另写一个合并函数：
  // 「运行状态卡计数 = 高级面板各目录计数之和」这条验收从此是结构上的恒等式，
  // 而不是两条代码路径碰巧算出同一个数——T02772 的缺陷正是「两套口径各算一套」。
  // sizeBytes/oldest 只在本函数内参与合并统计，不进响应体。
  async function statRunStateDir(dir: string): Promise<CleanupRunStateDir & { sizeBytes: number; oldest: string | null }> {
    const s = await statDir(dir, /\.json$/);
    return {
      path: dir,
      fileCount: s.fileCount,
      sizeMb: bytesToMb(s.sizeBytes),
      role: isLegacyStateDir(dir) ? 'legacy' : 'canonical',
      exists: await directoryExists(dir),
      sizeBytes: s.sizeBytes,
      oldest: s.oldest,
    };
  }

  async function directoryExists(dir: string): Promise<boolean> {
    try {
      return (await fs.stat(dir)).isDirectory();
    } catch {
      // 不存在与无权限都按「没有这个位置」处理：统计侧本来就把 readdir 失败当 0 个文件
      return false;
    }
  }

  // 目录标注：遗留目录里的文件必须在结果里一眼看出「它不在规范目录」，
  // 否则用户看到数量凭空变多，只会以为出现了新缺陷（T02772）。
  // 规范目录取清单首项（index.ts 组装时保证 [0] 即写入侧规范目录）。
  const canonicalStateDir = runStateDirs[0];
  function isLegacyStateDir(dir: string): boolean {
    return path.resolve(dir).toLowerCase() !== path.resolve(canonicalStateDir).toLowerCase();
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

      // 运行状态：逐目录统计后合并（T02772 合并计数 + T02808 目录清单随状态返回）。
      // 只报规范目录会显示 0 个，用户据此认为「无需清理」，而真实文件在另一个目录无限增长。
      // 清单顺序与 getRunStateDirs() 一致（首项 = 写入侧规范目录），前端不做重排也不改写路径，
      // 页面显示的路径与后端真正扫的路径因此是同一个字符串。
      const runStateStats = await Promise.all(runStateDirs.map((dir) => statRunStateDir(dir)));
      const runStateDirsResult: CleanupRunStateDir[] = runStateStats.map((s) => ({
        path: s.path,
        fileCount: s.fileCount,
        sizeMb: s.sizeMb,
        role: s.role,
        exists: s.exists,
      }));
      // oldest 是 YYYY-MM-DD 字符串，字典序即时间序，排序取首个即可
      const runStateSizeBytes = runStateStats.reduce((n, s) => n + s.sizeBytes, 0);
      const runStateOldest = runStateStats
        .map((s) => s.oldest)
        .filter((v): v is string => v !== null)
        .sort()[0] ?? null;
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
          fileCount: runStateStats.reduce((n, s) => n + s.fileCount, 0),
          sizeMb: bytesToMb(runStateSizeBytes),
          oldest: runStateOldest,
          dirs: runStateDirsResult,
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
    //
    // T02774 起窗口已闭合（原先这里写的是「毫秒级残留窗口，彻底闭环需清理与编译互斥」）：
    // 守卫判定与取得独占锁在**同一个同步块**内、中间没有任何 await，
    // 而所有会读写被清理对象的起跑点（withCompileLock / 内联问答 / StreamRunManager）
    // 都先 `await awaitCleanupIdle()` 再登记活跃——清理持锁期间不可能有新任务起跑。
    // 单向优先级：已开始的清理先做完，后来的任务排队（等待不拒绝，任务只是晚一点起跑）。
    // 不互锁：清理不会等任务（判到活跃直接 409），任务只等清理，两条等待链不成环。
    let cleanupHandle: CleanupHandle | null = null;
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

      // 紧跟守卫：拿不到锁说明上一次真实清理还在删（本进程同时只允许一个清理）。
      // 这里同样是 409 而非排队——两个清理请求并发意味着用户点了两次「真删」，
      // 让第二个静默排队反而会出现「同一目标被连删两次」的困惑结果。
      const handle = acquireCleanup();
      if (!handle) {
        const active = currentActiveState();
        const reason = '上一次真实清理仍在进行中（同一时刻只允许一次删除），本次已拒绝执行。';
        const blocked: CleanupBlockedResponse = {
          error: reason,
          code: 'cleanup_blocked_by_concurrent_cleanup',
          target,
          blocked: [],
          reasons: [reason],
          active,
        };
        await writeAudit({
          ts: new Date().toISOString(),
          target,
          days,
          dry_run: false,
          blocked_by_concurrent_cleanup: true,
          active,
        });
        return void reply.code(409).send(blocked);
      }
      cleanupHandle = handle;
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

    // 运行状态清理：逐目录收集后再删（T02772）。
    // 为什么要标出来源目录：预览列表是用户决定「要不要真删」的唯一依据，
    // 把遗留目录的文件混在规范目录里报，用户无从知道自己清理的是两处历史产物。
    async function cleanupRunState(): Promise<void> {
      const collected: Array<{ file: string; dir: string }> = [];
      for (const dir of runStateDirs) {
        for (const file of await listFiles(dir, /\.json$/)) {
          collected.push({ file, dir });
        }
      }
      if (collected.length === 0) {
        if (dryRun) result.cleaned.push('[预览] 无运行状态文件');
        return;
      }
      for (const { file, dir } of collected) {
        await cleanupFile(file, `运行状态${isLegacyStateDir(dir) ? '（旧存放位置）' : ''} ${path.basename(file)}`);
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
    } catch (err: unknown) {
      // 兜底：未预期异常返回 500（finally 仍会释放锁，异常路径不得把锁留在持有态）
      return void reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      cleanupHandle?.release();
    }

    // 审计写入（dry_run 模式也记录，便于回溯预览操作）。
    // 位置在 try 之后：deferredTasks() 只有等 release() 放行排队任务之后才是完整计数，
    // 写在 try 里会恒为 0，「完成清理时曾有任务排队等待」这条台账口径就失去意义（T02774 验收）。
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
      // T02774：台账据此区分三种情形——预览（locked=false）、被拦（另一条分支带 blocked_* 标记）、
      // 以及真实删除完成时有多少任务在排队等待。
      cleanup_locked: cleanupHandle !== null,
      cleanup_deferred_tasks: cleanupHandle?.deferredTasks() ?? 0,
      cleanup_held_ms: cleanupHandle?.heldMs() ?? 0,
    });

    return void reply.send(result);
  });
}

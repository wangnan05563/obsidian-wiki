// 「删除面」的单一口径（T02818：窗口外写入入口普查的落点）。
//
// 卡面要回答的问题很具体：POST /api/cleanup 的真实删除会碰哪些文件，而全站有哪些写入方会往
// 那些位置落盘 —— 只要有一个写入方能落进删除窗口，就会出现「刚写完就被删」或「刚删完就被写回」。
// T02774/T02817 把三个**会读被清理对象**的起跑点接上了互斥，但写入方是否都在那三个起跑点里，
// 此前无人能答（因为「哪些文件算被删」这件事散在三处：清理侧的内联正则、写入侧的手写拼接、
// harness-dirs 的文件名）。
//
// 本模块把这些散落的字符串收成一处，并给出 `deletedSurfaceOf()`：给它一个绝对路径，
// 它回答「清理能不能删到它」。入口矩阵（api/test/cleanup-write-surface-matrix.test.ts）
// 用它做**行为**判定，所以判定不会随代码演化而失真——新增写入口时，要么命中某个面并被要求接线，
// 要么被证明落在面外，二者都必须写下来，不存在「没人看过」的第三种结局。
import path from 'node:path';
import {
  AUDIT_LOG_BASENAME,
  COMPILE_CACHE_BASENAME,
  HARNESS_DIR_BASENAME,
  LOGS_DIR_BASENAME,
  STATE_DIR_BASENAME,
} from './harness-dirs.js';

/** vault 内原始资料存档目录的目录名（`vault/raw/`）。 */
export const VAULT_RAW_DIR_BASENAME = 'raw';

/**
 * `vault/raw/` 的绝对路径 —— 清理侧的删除目标与写入侧的存档目标是**同一个函数**。
 * 为什么强调这点：bookmark-ingest 原先自己写 `vaultPath.replace(/[\\/]vault$/, '/raw')`，
 * 它算出来的是 `data/raw`（vault 的**兄弟**目录），而清理与 vault.archiveRaw 认的是
 * `data/vault/raw`。两条拼接不同值时，「写入是否落在删除面内」这个问题根本没有共同对象可判。
 */
export function getVaultRawDir(vaultPath: string): string {
  return path.join(vaultPath, VAULT_RAW_DIR_BASENAME);
}

/**
 * 原始资料存档的文件名前缀白名单：只清内部临时件，用户命名的源文件不在删除面内。
 * 统计（GET /api/cleanup/status）与删除（POST）都必须用它——此前两处各写一份同样的字面量，
 * 改一处就会让「卡面数量」与「真正删掉的集合」分叉。
 */
export const RAW_ARCHIVE_PATTERN = /^(?:wiki-batch-|wiki-compile-|input-)/;

/** 运行状态文件（`.harness/state/*.json`）与运行日志（`.harness/logs/*.log`）的匹配式。 */
export const RUN_STATE_FILE_PATTERN = /\.json$/;
export const RUN_LOG_FILE_PATTERN = /\.log$/;

export type CleanupSurface = 'compile_cache' | 'run_state' | 'run_logs' | 'raw_archive';

function dirNames(absPath: string): { parent: string; grand: string } {
  const parent = path.basename(path.dirname(absPath));
  return { parent, grand: path.basename(path.dirname(path.dirname(absPath))) };
}

/**
 * 这个文件会不会被真实删除删到？返回命中的清理目标，落在所有面外时返回 null。
 *
 * 判定只看「位置 + 文件名」，不看 mtime：`run_logs` 与 `raw_archive` 还额外受 days 窗口保护
 * （routes/cleanup.ts 里删除前必须 stat 判 mtime，这一条由矩阵测试锁源码），
 * 所以这里返回 surface 只表示「位置在面上」，是否真的会被删还取决于时间。
 * 矩阵的用途恰恰在此：写入方若落在面上，就必须解释时间保护够不够、或者接线排队。
 */
export function deletedSurfaceOf(absPath: string): CleanupSurface | null {
  const name = path.basename(absPath);
  const { parent, grand } = dirNames(absPath);

  // 编译缓存：`.harness` 直属下的固定文件名，清理是整文件删除（不带 days 过滤）
  if (name === COMPILE_CACHE_BASENAME && parent === HARNESS_DIR_BASENAME) return 'compile_cache';
  // 运行状态：`.harness/state/*.json`，清理**不带 days 过滤**，无差别删除
  if (parent === STATE_DIR_BASENAME && grand === HARNESS_DIR_BASENAME && RUN_STATE_FILE_PATTERN.test(name)) {
    return 'run_state';
  }
  // 运行日志：`.harness/logs/*.log`，带 days 过滤
  if (parent === LOGS_DIR_BASENAME && grand === HARNESS_DIR_BASENAME && RUN_LOG_FILE_PATTERN.test(name)) {
    return 'run_logs';
  }
  // 原始资料存档：`vault/raw/` 下的内部前缀件，带 days 过滤
  if (parent === VAULT_RAW_DIR_BASENAME && RAW_ARCHIVE_PATTERN.test(name)) return 'raw_archive';
  return null;
}

/**
 * 跨进程协调文件的文件名（T02817 的 `cleanup.lock` 与 `activity/<pid>.json`）。
 * 从 cleanup-cross-process 转引而不是重写：这两个字符串是「协调层写在哪」的唯一权威，
 * 矩阵要判的是「清理会不会把它们删掉」——删掉就等于守卫失明，所以两处必须是同一个字符串。
 */
export {
  ACTIVITY_DIR_BASENAME as COORDINATION_ACTIVITY_DIR_BASENAME,
  CLEANUP_MARKER_BASENAME as COORDINATION_MARKER_BASENAME,
} from '../cleanup-cross-process.js';

/** 审计日志的文件名（清理自己追加的位置，供矩阵断言它不在删除面内）。 */
export const CLEANUP_AUDIT_BASENAME = AUDIT_LOG_BASENAME;

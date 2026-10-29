// T02817：清理与任务的**跨进程**协调层（标记文件）。
//
// 为什么需要这一层：T02774 的清理互斥（cleanup-mutex.ts）与 T02655 的活跃守卫（activity.ts）
// 都把状态放在进程内存里。单实例成立，但桌面端实例与手工起的 dev 实例并存时各持一把锁：
//   - A 进程正在真实删除时，B 进程的编译完全不受约束（B 看到的是自己进程的空闲态）；
//   - 反向同理：B 有编译在跑时，A 的清理守卫读不到它，真实删除照样放行。
// 这不是实现缺陷，是「并发控制放在进程内存里」这条选择的边界，本层把边界收进文件系统。
//
// 两个产物、两种生命周期（都落在**写入锚点** `.harness/` 下，与 compile-cache/logs/state 同根）：
//   - `cleanup.lock`：谁在真删。单文件、`wx` 原子创建 = 天然的跨进程独占原语，抢到才算开始删。
//   - `activity/<pid>.json`：谁在跑任务。**按 pid 分文件**而不是共用一个 JSON——
//     多进程读-改-写同一文件必然丢更新（后写者覆盖前者），分文件后每个进程只写自己那份，
//     无合并竞态，崩溃残留也只是「一个死 pid 的文件」，读取侧按 pid 存活 + 心跳时限过滤掉。
//
// 陈旧判定（崩溃不得变成永久死锁）：写方 pid 不存在、或时间戳超过时限、或内容解析不出来，
// 一律视为陈旧并放行；陈旧标记被清理侧显式忽略/回收时会落一条审计，便于事后区分
// 「被本进程拦」与「被另一进程拦」（T02817 验收口径）。
//
// 失败姿态：所有 fs 错误都按「读不到 = 无对方实例」处理，绝不因标记文件写失败而拒绝本地任务。
// 这一层是**增强**，不是新的一致性依赖——最坏退回 T02774 的进程内语义。
import fs from 'node:fs/promises';
import path from 'node:path';

export const CLEANUP_MARKER_BASENAME = 'cleanup.lock';
export const ACTIVITY_DIR_BASENAME = 'activity';

/** 真删最长合理时长：超过即认为持锁进程已失联（实测真删为秒级，留 10 分钟为极端大盘兜底）。 */
export const DEFAULT_MARKER_MAX_AGE_MS = 10 * 60 * 1000;
/** 活跃登记心跳时限：登记方每半程刷新一次，超过此时限视为进程卡死/已退出。 */
export const DEFAULT_ACTIVITY_TTL_MS = 60 * 1000;

export function cleanupMarkerFileIn(harnessDir: string): string {
  return path.join(harnessDir, CLEANUP_MARKER_BASENAME);
}

export function activityDirIn(harnessDir: string): string {
  return path.join(harnessDir, ACTIVITY_DIR_BASENAME);
}

// ──────────────────────────────────────────────────────────────
// 装配点：协调文件的位置在启动时算一次，读写两侧共用同一份
// （与 run-state / harness-dirs 的「单一口径」同族——两处各算一遍必然漂移）。
// ──────────────────────────────────────────────────────────────

export interface CoordinationPaths {
  /** `.harness/cleanup.lock`；null = 未接上，退回纯进程内语义 */
  markerFile: string | null;
  /** `.harness/activity/`；null = 不向外进程声明本进程活跃 */
  activityDir: string | null;
  /** 实例标识（端口 / 打包形态），仅供人读排查 */
  instance: string;
}

const paths: CoordinationPaths = { markerFile: null, activityDir: null, instance: 'unknown' };

export function setCoordinationPaths(next: Partial<CoordinationPaths>): void {
  Object.assign(paths, next);
}

export function coordinationPaths(): CoordinationPaths {
  return { ...paths };
}

// ──────────────────────────────────────────────────────────────
// A. 清理标记（谁在真删）
// ──────────────────────────────────────────────────────────────

export interface CleanupMarkerInfo {
  pid: number;
  /** 实例标识（端口或打包形态），仅用于人读排查 */
  instance: string;
  /** 本次真删的目标（compile_cache / run_state / ... / all） */
  target: string;
  /** 持锁起点（Date.now()） */
  startedAt: number;
}

export type MarkerState = 'idle' | 'busy' | 'stale';

export interface MarkerRead {
  state: MarkerState;
  marker: CleanupMarkerInfo | null;
  ageMs: number;
  /** state=stale 时的识别口径：pid_dead / too_old / unreadable */
  reason?: string;
}

export interface MarkerReadOptions {
  selfPid?: number;
  now?: number;
  maxAgeMs?: number;
  /** pid 存活探测，默认 process.kill(pid,0)；测试注入 */
  isPidAlive?: (pid: number) => boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM = 进程存在但不属于当前用户；其它（ESRCH）视为不存在
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseMarker(raw: string): CleanupMarkerInfo | null {
  try {
    const o = JSON.parse(raw) as Partial<CleanupMarkerInfo>;
    if (typeof o.pid !== 'number' || typeof o.startedAt !== 'number') return null;
    return { pid: o.pid, instance: String(o.instance ?? 'unknown'), target: String(o.target ?? 'unknown'), startedAt: o.startedAt };
  } catch {
    return null;
  }
}

/** 读取清理标记并给出 busy / stale / idle 判定（纯只读，不删文件）。 */
export async function readCleanupMarker(file: string, opts: MarkerReadOptions = {}): Promise<MarkerRead> {
  const selfPid = opts.selfPid ?? process.pid;
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MARKER_MAX_AGE_MS;
  const alive = opts.isPidAlive ?? pidAlive;

  let marker: CleanupMarkerInfo | null = null;
  try {
    marker = parseMarker(await fs.readFile(file, 'utf8'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'idle', marker: null, ageMs: 0 };
    // 其它读取错误（EBUSY/EPERM 等）按「读不到」处理：宁可放行本地任务
    return { state: 'idle', marker: null, ageMs: 0 };
  }
  if (!marker) return { state: 'stale', marker: null, ageMs: 0, reason: 'unreadable' };

  const ageMs = Math.max(0, now - marker.startedAt);
  // 本进程自己写的标记不算「另一实例」：同进程的互斥由 cleanup-mutex 的内存锁负责
  if (marker.pid === selfPid) return { state: 'idle', marker, ageMs };
  if (!alive(marker.pid)) return { state: 'stale', marker, ageMs, reason: 'pid_dead' };
  if (ageMs > maxAgeMs) return { state: 'stale', marker, ageMs, reason: 'too_old' };
  return { state: 'busy', marker, ageMs };
}

export interface ClaimMarkerOptions extends MarkerReadOptions {
  lockFile: string;
  instance: string;
  target: string;
}

export type ClaimResult =
  | { ok: true; marker: CleanupMarkerInfo; purged?: MarkerRead }
  | { ok: false; blockedBy: MarkerRead };

/**
 * 以原子 `wx` 抢占清理标记。
 * @returns ok=true 表示本进程取得跨进程删除权（须在 finally release）；
 *          ok=false 表示另一实例正在真删，调用方应拒绝本次请求（409）。
 */
export async function claimCleanupMarker(opts: ClaimMarkerOptions): Promise<ClaimResult> {
  const selfPid = opts.selfPid ?? process.pid;
  const marker: CleanupMarkerInfo = { pid: selfPid, instance: opts.instance, target: opts.target, startedAt: Date.now() };
  let purged: MarkerRead | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(path.dirname(opts.lockFile), { recursive: true });
      await fs.writeFile(opts.lockFile, `${JSON.stringify(marker)}\n`, { flag: 'wx' });
      return { ok: true, marker, purged };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // 写不进标记（目录只读等）：退回进程内语义，不因协调层失败而拒绝删除
        return { ok: true, marker, purged };
      }
      const read = await readCleanupMarker(opts.lockFile, opts);
      if (read.state === 'busy') return { ok: false, blockedBy: read };
      // 陈旧或本进程遗留：回收后重试一次；不可写则维持「退回进程内语义」的姿态
      await fs.rm(opts.lockFile, { force: true }).catch(() => undefined);
      purged = read;
    }
  }
  const final = await readCleanupMarker(opts.lockFile, opts);
  return final.state === 'busy' ? { ok: false, blockedBy: final } : { ok: true, marker, purged: final };
}

/** 释放清理标记：只删自己 pid 写的那份，绝不删掉另一实例正在持有的标记。 */
export async function releaseCleanupMarker(file: string, selfPid: number = process.pid): Promise<void> {
  try {
    const marker = parseMarker(await fs.readFile(file, 'utf8'));
    if (marker && marker.pid !== selfPid) return;
    await fs.rm(file, { force: true });
  } catch {
    // 已不存在或读不到：视为已释放
  }
}

// ──────────────────────────────────────────────────────────────
// B. 活跃登记（谁在跑任务）
// ──────────────────────────────────────────────────────────────

export interface ActivityRecord {
  pid: number;
  instance: string;
  compile: number;
  query: number;
  /** 最近一次刷新（心跳）时间 */
  updatedAt: number;
}

export interface ForeignActivityOptions {
  selfPid?: number;
  now?: number;
  ttlMs?: number;
  isPidAlive?: (pid: number) => boolean;
}

function activityFile(dir: string, pid: number): string {
  return path.join(dir, `${pid}.json`);
}

/** 原子写入本进程的活跃快照（tmp + rename，读取侧永不见半截 JSON）。 */
export async function writeActivityRecord(dir: string, rec: ActivityRecord): Promise<void> {
  const file = activityFile(dir, rec.pid);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(rec)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

export async function removeActivityRecord(dir: string, pid: number): Promise<void> {
  await fs.rm(activityFile(dir, pid), { force: true }).catch(() => undefined);
}

interface ForeignActivityContext {
  selfPid: number;
  now: number;
  ttlMs: number;
  alive: (pid: number) => boolean;
}

/** 读取并校验单个 activity 条目；非本进程关注的条目（tmp/自身/陈旧/死进程）返回 null。 */
async function readForeignActivity(
  dir: string,
  name: string,
  ctx: ForeignActivityContext,
): Promise<ActivityRecord | null> {
  if (!name.endsWith('.json') || name.includes('.tmp')) return null;
  const pid = Number(name.slice(0, -'.json'.length));
  if (!Number.isFinite(pid) || pid === ctx.selfPid) return null;
  let rec: ActivityRecord | null = null;
  try {
    rec = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as ActivityRecord;
  } catch {
    return null;
  }
  if (!rec || typeof rec.updatedAt !== 'number') return null;
  if (ctx.now - rec.updatedAt > ctx.ttlMs) return null;
  if (!ctx.alive(pid)) return null;
  return rec;
}

/**
 * 读出**其它进程**声明的活跃任务数（pid 死亡或心跳超时的记录直接忽略）。
 * 与 readCleanupMarker 同口径：读不到就当没有，不阻塞本进程。
 */
export async function readForeignActivities(
  dir: string,
  opts: ForeignActivityOptions = {},
): Promise<{ compile: number; query: number; instances: ActivityRecord[] }> {
  const ctx: ForeignActivityContext = {
    selfPid: opts.selfPid ?? process.pid,
    now: opts.now ?? Date.now(),
    ttlMs: opts.ttlMs ?? DEFAULT_ACTIVITY_TTL_MS,
    alive: opts.isPidAlive ?? pidAlive,
  };

  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { compile: 0, query: 0, instances: [] };
  }

  const instances: ActivityRecord[] = [];
  let compile = 0;
  let query = 0;
  for (const name of names) {
    const rec = await readForeignActivity(dir, name, ctx);
    if (!rec) continue;
    compile += Math.max(0, rec.compile || 0);
    query += Math.max(0, rec.query || 0);
    if ((rec.compile || 0) > 0 || (rec.query || 0) > 0) instances.push(rec);
  }
  return { compile, query, instances };
}

/** 清理标记文件的 basename 与目录形态，供「清理面不得删到协调文件」的结构锁使用。 */
export const COORDINATION_BASENAMES = [CLEANUP_MARKER_BASENAME, `${ACTIVITY_DIR_BASENAME}/`] as const;

// ──────────────────────────────────────────────────────────────
// C. 崩溃残留回收（T02896）
// ------------------------------------------------------------------
// 读取侧早已按「pid 死亡 / 心跳超时 / 不可解析」过滤陈旧条目，功能不会坏；
// 但写侧没有回收通道：进程被强杀时 finally 不执行，它的 <pid>.json 永久留在目录里，
// cleanup.lock 也只会在下一次有人抢标时被顺带 purge。本函数在服务启动时跑一次，
// 把死条目删掉、活条目一根手指都不碰。
// 为什么回收不放清理路由的删除面：这两样是**实时协调**产物，不是可清理的存储占用，
// 删除面接线锁（cleanup-cross-process.test.ts「存放位置与接线锁」）另有人守着。
// ──────────────────────────────────────────────────────────────

export interface CoordinationPruneEntry {
  kind: 'cleanup_lock' | 'activity';
  /** activity 条目对应 pid；cleanup_lock 也有 pid；解析不出来为 null */
  pid: number | null;
  file: string;
  reason: 'pid_dead' | 'too_old' | 'unreadable';
}

export interface PruneCoordinationOptions {
  markerFile: string;
  activityDir: string;
  selfPid?: number;
  now?: number;
  ttlMs?: number;
  maxAgeMs?: number;
  isPidAlive?: (pid: number) => boolean;
  /** 每实际回收一条回调一次；审计落盘由调用方决定（本层不依赖审计实现） */
  onPruned?: (entry: CoordinationPruneEntry) => Promise<void> | void;
}

/**
 * 回收崩溃残留的协调文件：activity/<pid>.json 中 pid 已死或心跳超时（或不可解析）的条目、
 * cleanup.lock 中陈旧标记（同 readCleanupMarker 的 stale 判定）。返回实际删除清单。
 * 并发安全说明：mark 侧（claimCleanupMarker）对陈旧标记同样是「读→删→重试」，本函数
 * 在 rm 前复核文件内容与判定时一致才删——把「读到陈旧、删时已被别人换成新标记」的窗口
 * 压到与 claim 自身的 rm 同量级；activity 条目按 pid 分文件、写方只写自己那份，无此竞态。
 */
interface PruneContext {
  selfPid: number;
  now: number;
  alive: (pid: number) => boolean;
}

/** 陈旧 cleanup.lock：复核内容未被替换后才删；不可读/非陈旧一律不动。 */
async function pruneStaleMarker(
  opts: PruneCoordinationOptions,
  ctx: PruneContext,
): Promise<CoordinationPruneEntry | null> {
  try {
    const rawBefore = await fs.readFile(opts.markerFile, 'utf8');
    const read = await readCleanupMarker(opts.markerFile, {
      selfPid: ctx.selfPid,
      now: ctx.now,
      maxAgeMs: opts.maxAgeMs,
      isPidAlive: ctx.alive,
    });
    const unchanged = (await fs.readFile(opts.markerFile, 'utf8').catch(() => null)) === rawBefore;
    if (read.state !== 'stale' || !unchanged) return null;
    await fs.rm(opts.markerFile, { force: true });
    return {
      kind: 'cleanup_lock',
      pid: read.marker?.pid ?? null,
      file: opts.markerFile,
      reason: (read.reason ?? 'unreadable') as CoordinationPruneEntry['reason'],
    };
  } catch {
    return null;
  }
}

/** activity 文件名 → pid；tmp/自身/不可解析的名字返回 null。 */
function activityPidOf(name: string, selfPid: number): number | null {
  if (!name.endsWith('.json') || name.includes('.tmp')) return null;
  const pid = Number(name.slice(0, -'.json'.length));
  if (!Number.isFinite(pid) || pid === selfPid) return null;
  return pid;
}

/** 单个 activity 条目的陈旧原因；仍活跃时返回 null。 */
async function staleActivityReason(
  file: string,
  pid: number,
  opts: PruneCoordinationOptions,
  ctx: PruneContext,
): Promise<CoordinationPruneEntry['reason'] | null> {
  try {
    const rec = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<ActivityRecord>;
    if (typeof rec.updatedAt !== 'number') return 'unreadable';
    if (ctx.now - rec.updatedAt > (opts.ttlMs ?? DEFAULT_ACTIVITY_TTL_MS)) return 'too_old';
    if (!ctx.alive(pid)) return 'pid_dead';
    return null;
  } catch {
    return 'unreadable';
  }
}

export async function pruneStaleCoordinationFiles(opts: PruneCoordinationOptions): Promise<CoordinationPruneEntry[]> {
  const ctx: PruneContext = {
    selfPid: opts.selfPid ?? process.pid,
    now: opts.now ?? Date.now(),
    alive: opts.isPidAlive ?? pidAlive,
  };
  const removed: CoordinationPruneEntry[] = [];

  // 1) cleanup.lock：复用 readCleanupMarker 的判定（busy / 本进程遗留一律不动）
  const lockEntry = await pruneStaleMarker(opts, ctx);
  if (lockEntry) {
    removed.push(lockEntry);
    await opts.onPruned?.(lockEntry);
  }

  // 2) activity/<pid>.json：与 readForeignActivities 同口径（本进程的那份不动；
  //    .tmp 跳过——写方 tmp+rename 中途删 tmp 会让写方 rename 失败）。
  let names: string[] = [];
  try {
    names = await fs.readdir(opts.activityDir);
  } catch {
    /* 目录还不存在：无残留 */
  }
  for (const name of names) {
    const pid = activityPidOf(name, ctx.selfPid);
    if (pid === null) continue;
    const file = path.join(opts.activityDir, name);
    const reason = await staleActivityReason(file, pid, opts, ctx);
    if (!reason) continue;
    await fs.rm(file, { force: true }).catch(() => undefined);
    const entry: CoordinationPruneEntry = { kind: 'activity', pid, file, reason };
    removed.push(entry);
    await opts.onPruned?.(entry);
  }
  return removed;
}

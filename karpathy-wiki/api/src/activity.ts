// 进程内「活跃任务」计数（T02655：真实删除清理的活跃任务硬拦截）。
//
// 为什么需要这个模块：系统清理（POST /api/cleanup）在真实删除模式下会删
// `.harness/state/*.json`（断点续传状态）与 `vault/raw/` 的原始资料存档，而这两类对象
// 正是**正在运行的编译/问答任务**当下要读写的东西。此前只在二次确认框里写了
// 「建议先确认无活跃编译/问答任务」的纯文案提示，前后端都无任何硬拦截——
// 用户在编译跑到一半时关掉「仅预览」开关点确认，就会把正在写入的运行状态删掉，
// 这次任务直接失败（用户以为代价只是「重跑一次」，实际是「当前任务被打断」）。
//
// 为什么用显式计数而不是别的信号：
//  - `.harness/state/*.json` 里的 status 字段不可用作实时信号——wiki-harness 只在
//    run 结束（done/failed）时落盘，`status:'running'` 全仓从未写入（实测 92 done + 15 failed + 0 running），
//    按文件判活跃会把历史残留的失败任务误判为在跑，也会漏掉刚起跑的任务。
//  - Fastify onRequest/onResponse 钩子对 SSE 长连接不可靠：客户端 abort 时 onResponse
//    不保证触发，计数会泄漏 → 永久 409，比没有拦截更糟。
//  所以由**任务自己**在确定的起止点登记：compile 走 withCompileLock（全站唯一串行入口，
//  所有编译类写入都经它），query 走 StreamRunManager 的 run 终态 + 内联流的 finally。
//
// 口径：只统计「已在执行」的任务；compile 队列里排队的请求不计入（尚未触碰任何文件）。
// release 幂等：重复调用只减一次，防止异常路径下计数变负（负值会永久放行）。
import {
  coordinationPaths,
  readCleanupMarker,
  readForeignActivities,
  removeActivityRecord,
  writeActivityRecord,
  type ActivityRecord,
} from './cleanup-cross-process.js';

// T02931：'tts' 是独立的活跃类别。朗读不改 vault（清理守卫不需要拦它），
// 但一次合成最长数千字、走 Edge WebSocket 流式返回，重启会把它硬切成连接重置，
// 所以只纳入重启判定，不参与清理判定，也不写入跨进程 activity 记录
// （另一实例重启不会打断本实例的朗读，跨进程计数没有意义）。
export type ActivityKind = 'compile' | 'query' | 'tts';

const counts: Record<ActivityKind, number> = { compile: 0, query: 0, tts: 0 };

// ── T02817：把本进程的活跃快照向外进程声明（跨进程可见性）──
// 上面的 counts 只有本进程读得到；另一实例的清理守卫看不到它，于是「B 在编译、A 照样真删」。
// 这里按 pid 写 `.harness/activity/<pid>.json`，读取侧（cleanup-guard）把别人的记录并进判定。
// 心跳刷新而非一次写死：长任务期间持续证明「我还活着」，进程崩溃后记录会被 TTL/pid 判陈旧，
// 不会把清理永久拦死。
let heartbeatTimer: NodeJS.Timeout | null = null;
let writeChain: Promise<void> = Promise.resolve();
const HEARTBEAT_MS = 10_000;

function crossProcessDir(): string | null {
  return coordinationPaths().activityDir;
}

/** 把当前快照落盘（无活跃时删除记录）。串行成一条链，同进程内不会自我交错。 */
export async function flushActivityRecord(): Promise<void> {
  const dir = crossProcessDir();
  if (!dir) return;
  // T02931：记录里只有 compile/query（跨进程可见的两类）；tts 只在本进程重启判定里生效
  const snap = { compile: counts.compile, query: counts.query };
  const rec: ActivityRecord = {
    pid: process.pid,
    instance: coordinationPaths().instance,
    compile: snap.compile,
    query: snap.query,
    updatedAt: Date.now(),
  };
  const dirAtWrite = dir;
  writeChain = writeChain.then(async () => {
    try {
      if (snap.compile + snap.query === 0) await removeActivityRecord(dirAtWrite, rec.pid);
      else await writeActivityRecord(dirAtWrite, rec);
    } catch {
      // 协调层写失败不阻塞任务（最坏退回 T02774 的进程内语义）
    }
  });
  return writeChain;
}

function ensureHeartbeat(): void {
  if (heartbeatTimer || !crossProcessDir()) return;
  // unref：心跳定时器绝不能把进程吊住（测试与 SEA 退出都靠进程自然收尾）
  heartbeatTimer = setInterval(() => {
    void flushActivityRecord();
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

function stopHeartbeatIfIdle(): void {
  if (!heartbeatTimer) return;
  if (counts.compile + counts.query > 0) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/**
 * 起跑点的 Dekker 收尾：先把活跃声明落盘，再读一次清理标记。
 * 返回 false 表示「就在这一瞬，另一实例抢到了删除权」——本函数已收回登记，
 * 调用方必须回到 `await awaitCleanupIdle()` 重新排队。
 *
 * 为什么两步都不可省：只「等标记」→ 本进程起跑与另一进程抢删之间存在毫秒级空档；
 * 只「登记」→ 对方守卫读不到本进程。双方各自「先声明、再读对方」，
 * 在同一个线性化介质（文件）上就至少有一方看得见对方，空档从机制上为零。
 */
export async function confirmActivityStart(release: () => void): Promise<boolean> {
  await flushActivityRecord();
  const { markerFile } = coordinationPaths();
  if (!markerFile) return true;
  const read = await readCleanupMarker(markerFile);
  if (read.state === 'busy') {
    release();
    await flushActivityRecord();
    return false;
  }
  return true;
}

/** 其它进程声明的活跃数（供清理守卫并入判定）。 */
export function foreignActiveActivities(): Promise<{ compile: number; query: number; instances: ActivityRecord[] }> {
  const dir = crossProcessDir();
  if (!dir) return Promise.resolve({ compile: 0, query: 0, instances: [] });
  return readForeignActivities(dir);
}

/** 登记一个活跃任务，返回释放函数（幂等，可安全放进 finally）。 */
export function beginActivity(kind: ActivityKind): () => void {
  counts[kind] += 1;
  ensureHeartbeat();
  void flushActivityRecord();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    counts[kind] = Math.max(0, counts[kind] - 1);
    stopHeartbeatIfIdle();
    void flushActivityRecord();
  };
}

/** 当前各类活跃任务数量（供清理接口返回给前端做置灰判定）。 */
export function activeActivities(): { compile: number; query: number } {
  return { compile: counts.compile, query: counts.query };
}

/** T02931：朗读活跃数。只给重启判定用，不进清理快照与跨进程记录。 */
export function activeTtsCount(): number {
  return counts.tts;
}

export function isActivityBusy(kind: ActivityKind): boolean {
  return counts[kind] > 0;
}

export function hasAnyActiveActivity(): boolean {
  return counts.compile > 0 || counts.query > 0 || counts.tts > 0;
}

/**
 * 仅供测试：把计数清零并返回原值。
 * 生产代码不得调用——活跃状态由任务自身登记/释放，外部重置只会掩盖泄漏。
 */
export function __resetActivitiesForTest(): Record<ActivityKind, number> {
  const prev = { ...counts };
  counts.compile = 0;
  counts.query = 0;
  counts.tts = 0;
  stopHeartbeatIfIdle();
  void flushActivityRecord();
  return prev;
}

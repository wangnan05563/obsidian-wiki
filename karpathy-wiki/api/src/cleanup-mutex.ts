// T02774：真实清理的独占锁（清理与编译/问答互斥）。
//
// 为什么需要一个单独的锁，而不是只靠 T02655 的活跃任务守卫：
// `POST /api/cleanup` 的守卫读的是 activity.ts 的**瞬时快照**，删除动作随后异步进行。
// 「守卫判定通过」与「删除完成」之间隔着若干个 await——正好落在这个窗口里起跑的编译/问答，
// 它的断点续传基准仍会被这次删除抹掉。T02655 把「整场编译期间都可能误删」收窄成
// 「恰好在删除窗口内起跑的任务」，本模块负责把最后这段窗口变成机制上的零。
//
// 两个方向不对称地处理（这是刻意设计，不是遗漏）：
//  - 清理 → 任务：**排队等待**，不拒绝。清理是不可逆操作，已开始就必须做完；
//    后来的任务只是晚一点起跑，没有任何数据损失（单向优先级）。
//  - 任务 → 清理：**硬拦 409**（沿用 T02655 的口径）。已经判定「有任务在跑」就不要开始删除，
//    否则删到一半发现冲突，被删掉的文件无法回滚。
//
// 因此不会互锁：清理只等待「已经登记的任务」结束（由守卫拒绝新删除实现），
// 任务只等待「清理释放」，两条等待链不构成环。
//
// 死锁与泄漏纪律：
//  - acquire 非重入（同时只允许一个清理），拿不到锁返回 null 而不是排队，
//    否则第二个清理会挂在锁上并把整站任务一起拖住。
//  - release 幂等，放进 finally；异常路径不会把锁永久留在持有态
//    （永久持有 = 全站编译/问答从此排队，比没有互斥更糟）。
//  - 放行时机只在「无人持有」时，且清理的守卫与 acquire 之间不得插入 await
//    （见 routes/cleanup.ts 的接线注释）——否则窗口又回来了。
//
// 口径与 activity.ts 一致：清理不登记为 compile/query，不会污染
// `GET /api/cleanup/status` 的 active 读数，前端置灰规则因此不受本模块影响。
//
// T02817 追加跨进程维度：以上全部仍是**本进程**的锁。另一实例（桌面端 + 手工 dev 并存）
// 有自己的 held，两边互不可见。起跑点因此除内存锁外还要看 `cleanup.lock` 标记文件——
// 路径由 index.ts 的 setCoordinationPaths() 在启动时接上；未接上时行为与 T02774 完全一致（纯进程内）。
import { coordinationPaths, readCleanupMarker } from './cleanup-cross-process.js';

export interface CleanupHandle {
  /** 释放锁并放行期间排队的任务；幂等，可安全放进 finally。 */
  release(): void;
  /**
   * 本次清理期间被推迟（排队等待）的任务数。
   * 必须在 release() **之后**读取才完整——排队任务是在释放那一刻才被放行的。
   */
  deferredTasks(): number;
  /** 持有时长（ms），供审计区分「秒级完成」与「长时间持锁」。 */
  heldMs(): number;
}

/** 当前是否有真实清理正在执行（预览不持有锁，故预览不会让任务排队）。 */
let held = 0;

// 等待清理结束的续延。release 时一次性全部放行：清理频率极低（用户手动触发），
// 不做公平队列，避免「任务饿死」与「清理饿死」两套优先级互相拉扯。
const waiters: Array<() => void> = [];

/**
 * 尝试取得清理独占锁。
 * @returns 取得则返回句柄（须在 finally 释放）；已有清理在执行则返回 null（调用方应拒绝本次请求）。
 */
export function acquireCleanup(): CleanupHandle | null {
  if (held > 0) return null;
  held += 1;
  const startedAt = Date.now();
  // 计数挂在句柄闭包上：即使句柄已被释放，调用方事后仍能读到本次清理的完整统计
  const state = { deferred: 0, released: false };

  return {
    release(): void {
      if (state.released) return;
      state.released = true;
      held = Math.max(0, held - 1);
      // 只有在锁确实空了才放行：放行过程中若有新的清理抢到锁，剩余等待者继续挂着
      while (held === 0 && waiters.length > 0) {
        const resolve = waiters.shift() as () => void;
        state.deferred += 1;
        resolve();
      }
    },
    deferredTasks(): number {
      return state.deferred;
    },
    heldMs(): number {
      return Date.now() - startedAt;
    },
  };
}

export function isCleanupInProgress(): boolean {
  return held > 0;
}

/**
 * 任务起跑点调用：清理进行中就等它做完。
 * 循环而非单次判断——被放行后仍可能有新的清理抢先持有锁，
 * 那时本任务必须继续等，否则「清理期间绝不新建任务」这条不变式会出现空档。
 *
 * T02817：等待条件除本进程 held 外，再加上「另一实例的 cleanup.lock 标记仍在有效期」。
 * 未接上标记路径（setCoordinationPaths 没调，或测试环境）时只判 held，语义与 T02774 相同。
 */
export async function awaitCleanupIdle(): Promise<void> {
  for (;;) {
    while (held > 0) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
    const { markerFile } = markerOptions();
    if (!markerFile) return;
    const tickStartedAt = Date.now();
    const read = await readCleanupMarker(markerFile);
    if (read.state !== 'busy') {
      if (pendingWaitMs > 0) {
        foreignWaitCount += 1;
        foreignWaitMs += pendingWaitMs;
        pendingWaitMs = 0;
      }
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, MARKER_POLL_MS));
    pendingWaitMs += Date.now() - tickStartedAt;
  }
}

// 跨进程标记的轮询节奏：真删是秒级操作，250ms 足够细，又不至于把读盘当心跳打。
const MARKER_POLL_MS = 250;

/** 供 awaitCleanupIdle 取路径；未接上（markerFile=null）即完全退回 T02774 的进程内语义。 */
function markerOptions(): { markerFile: string | null } {
  const p = coordinationPaths();
  return { markerFile: p.markerFile };
}

// 等待统计：审计与排查据此区分「本进程排队」与「被另一进程拦住」。
let pendingWaitMs = 0;
let foreignWaitCount = 0;
let foreignWaitMs = 0;

export function getForeignCleanupWaitStats(): { count: number; totalMs: number } {
  return { count: foreignWaitCount, totalMs: foreignWaitMs };
}

/** 仅供测试：清空锁与等待队列并返回原持有数。生产代码不得调用（同 activity.ts）。 */
export function __resetCleanupMutexForTest(): { held: number; waiters: number } {
  const prev = { held, waiters: waiters.length };
  held = 0;
  const pending = waiters.splice(0, waiters.length);
  pending.forEach((resolve) => resolve());
  pendingWaitMs = 0;
  foreignWaitCount = 0;
  foreignWaitMs = 0;
  return prev;
}

// §12.3-5 并发控制：compile 请求串行队列。
// 决策理由：知识库场景 compile 频率低（个人/小团队），串行化最简单且零竞态。
// index.md/log.md 的追加操作非原子，并发会导致行交错乱。
//
// 实现：Promise 链式队列。每个 compile 请求等待前一个完成后才开始，
// 不拒绝请求，按到达顺序串行执行。

import { beginActivity, confirmActivityStart, activeActivities } from './activity.js';
// T02774：清理独占锁。登记活跃之前先等「没有真实清理正在进行」，
// 把 T02655 遗留的「守卫通过 ~ 删除完成」毫秒级窗口从机制上封掉（不是靠时序运气）。
import { awaitCleanupIdle } from './cleanup-mutex.js';

let chain: Promise<unknown> = Promise.resolve();

// T02622：排队中的编译数。activity.ts 只统计「已起跑」的任务（排队请求尚未触碰文件，
// 不该阻塞清理），但重启会把排队中的请求一起丢掉——所以重启守卫需要这个差值。
// 用「已入队未结束」减去「正在执行」而不是单独维护排队计数：后者要在
// 起跑/异常/取消各条路径上成对加减，漏一处就会把重启永久拦死。
let inFlight = 0;

export function queuedCompileCount(): number {
  return Math.max(0, inFlight - activeActivities().compile);
}

// 包装一个 async 任务，使其在前一个任务完成后才执行。
// 返回原任务的 Promise，调用方仍可拿到结果/异常。
export function withCompileLock<T>(task: () => Promise<T>): Promise<T> {
  // T02655：执行期登记「编译类任务活跃」，供 POST /api/cleanup 的真实删除硬拦截判定。
  // 为什么登记在这里：compile / compile/resume / compile/batch / 体检批量修复 / prompts / qq-ingest
  // 全部经 withCompileLock，这里是唯一收口点；登记在路由层会漏掉其中若干入口。
  // 只统计「已开始执行」的任务：排队中的请求尚未触碰任何文件，不应阻塞清理。
  //
  // T02774 的等待放在 beginActivity **之前**（而不是之后）：清理持锁期间本任务既不计入
  // active.compile（否则后来的清理会被自己这类「还没动手」的任务误拦），也不得触碰任何文件。
  // 等待同样发生在 compile 链上，因此「前一个编译 → 清理 → 后一个编译」的串行顺序仍然成立。
  const run = async (): Promise<T> => {
    // T02817：起跑要过「双方各自先声明、再读对方」这道握手。
    // awaitCleanupIdle 已含跨进程标记轮询；confirmActivityStart 再把本进程的活跃声明落盘、
    // 回读标记——若另一实例恰好在这一步抢到删除权，登记会被收回并重新排队。
    for (;;) {
      await awaitCleanupIdle();
      const release = beginActivity('compile');
      if (await confirmActivityStart(release)) {
        try {
          return await task();
        } finally {
          release();
        }
      }
    }
  };
  // chain.then(run, run) 保证 run 在前一个完成后执行；
  // 第二个分支（前一个失败）同样执行，隔离前一个任务的异常，避免级联拒绝
  inFlight += 1;
  const next = chain.then(run, run);
  // 更新 chain 为本次任务的完成态，后续请求将继续排队
  // 计数在下一环扣减而不是调用方 finally：保证「任务已结束」先于「下一个任务起跑」被观测到
  chain = next.then(
    () => { inFlight -= 1; },
    () => { inFlight -= 1; },
  );
  return next;
}

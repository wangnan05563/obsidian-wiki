// §12.3-5 并发控制：compile 请求串行队列。
// 决策理由：知识库场景 compile 频率低（个人/小团队），串行化最简单且零竞态。
// index.md/log.md 的追加操作非原子，并发会导致行交错乱。
//
// 实现：Promise 链式队列。每个 compile 请求等待前一个完成后才开始，
// 不拒绝请求，按到达顺序串行执行。

let chain: Promise<unknown> = Promise.resolve();

// 包装一个 async 任务，使其在前一个任务完成后才执行。
// 返回原任务的 Promise，调用方仍可拿到结果/异常。
export function withCompileLock<T>(task: () => Promise<T>): Promise<T> {
  // chain.then(task) 保证 task 在前一个完成后执行；
  // .catch(() => undefined) 隔离前一个任务的异常，避免级联拒绝
  const next = chain.then(() => task(), () => task());
  // 更新 chain 为本次任务的完成态，后续请求将继续排队
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

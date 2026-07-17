// §6.0.2 per-session Lock：按 question 前 32 字符做 key 串行化。
// 决策理由：同一问题的并发请求（用户重复点击、网络重试、前端多组件触发）
// 会让 LLM 重复调用，浪费 token 与预算，并加剧后端 LLM API 限流风险。
// 按 question 前 32 字符做 key 串行化，同 key 请求排队执行，不同 key 完全独立。
//
// 与 withCompileLock 的区别：
// - withCompileLock 是全局串行（任何 compile 都排队，因 index.md/log.md 写入竞态）
// - withSessionLock 是按 question 分组串行（同问题串行，不同问题并行）
//
// 实现策略：Map<key, Promise>。每个 key 维护一条 Promise 链，
// 新请求通过 .then 排到链尾，任务完成后链尾前进。
// 与 withCompileLock 同构，只是粒度从全局改为按 key。

const locks = new Map<string, Promise<unknown>>();

// 截断长度：32 字符是 SRS §6.0.2 既定值。
// 为什么不直接 hash：保留明文前缀便于调试，且 32 字符已足够区分不同问题。
const KEY_PREFIX_LEN = 32;

// 包装一个 async 任务，使同 key 的任务串行执行。
// 返回原任务的 Promise，调用方仍可拿到结果/异常。
export function withSessionLock<T>(
  question: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = question.slice(0, KEY_PREFIX_LEN);
  const prev = locks.get(key) ?? Promise.resolve();
  // prev.then(task, task) 保证 task 在前一个完成后执行；
  // 第二参数（rejected handler）也指向 task，隔离前一次异常避免级联拒绝。
  const next = prev.then(() => task(), () => task());
  // 更新锁链：本次任务完成后（无论成功失败）链尾前进，后续请求将继续排队。
  // 为什么用 .then(() => undefined, () => undefined)：把结果丢弃为 void，
  // 避免长期持有任务结果引用导致内存泄漏。
  locks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

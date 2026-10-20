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

export type ActivityKind = 'compile' | 'query';

const counts: Record<ActivityKind, number> = { compile: 0, query: 0 };

/** 登记一个活跃任务，返回释放函数（幂等，可安全放进 finally）。 */
export function beginActivity(kind: ActivityKind): () => void {
  counts[kind] += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    counts[kind] = Math.max(0, counts[kind] - 1);
  };
}

/** 当前各类活跃任务数量（供清理接口返回给前端做置灰判定）。 */
export function activeActivities(): Record<ActivityKind, number> {
  return { compile: counts.compile, query: counts.query };
}

export function isActivityBusy(kind: ActivityKind): boolean {
  return counts[kind] > 0;
}

export function hasAnyActiveActivity(): boolean {
  return counts.compile > 0 || counts.query > 0;
}

/**
 * 仅供测试：把计数清零并返回原值。
 * 生产代码不得调用——活跃状态由任务自身登记/释放，外部重置只会掩盖泄漏。
 */
export function __resetActivitiesForTest(): Record<ActivityKind, number> {
  const prev = { ...counts };
  counts.compile = 0;
  counts.query = 0;
  return prev;
}

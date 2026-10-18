// T02462（PRD Q2）：流式回答期间允许排队输入——用户提前打好下一问，
// 当前回答结束后自动发送，避免「输入框被禁用、无法预输入」的断点体验。
// 纯函数便于单测，组件侧用 ref 适配（见 Query.vue 的 chatQueue 适配对象）。

export interface ChatQueue {
  queued: string | null;
}

export type EnqueueDecision = 'sent' | 'queued';

// 在提交时决定「立即发送」还是「排队」：正在生成中则入队，否则立即发送。
export function decideEnqueue(
  queue: ChatQueue,
  isLoading: boolean,
  question: string,
): EnqueueDecision {
  if (isLoading) {
    queue.queued = question;
    return 'queued';
  }
  return 'sent';
}

// 取出并清空排队问题（消费一次）。无排队则返回 null。
export function takeQueued(queue: ChatQueue): string | null {
  const q = queue.queued;
  queue.queued = null;
  return q;
}

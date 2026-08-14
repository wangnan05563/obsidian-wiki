// 会话状态推导（PC 与移动端历史列表共用）
// 优先级：运行中(running) > 异常中断(error) > 已完成未读(unread) > 已完成已读(read) > 闲置(idle)
import type { ConversationRecord } from '../types';
import { useQueryStore } from '../stores/query';

export type SessionStatus = 'running' | 'error' | 'unread' | 'read' | 'idle';

/**
 * 推导单个历史会话的展示状态。
 * - running：该会话的实时缓冲正处于加载/流式输出中（跨 PC/移动端统一的权威信号）。
 * - error：最近一条消息状态为 error 或 interrupted（异常中断 / 用户中止）。
 *   优先读实时缓冲的最后一条消息，保证异常态实时刷新；缓冲缺失时回退到已落盘消息。
 * - unread：会话被标记未读（用户在后台完成更新时未正在查看）。
 * - read：已完成且已读（有消息、非上述状态）——静态淡化图标。
 * - idle：无任何消息（尚未开始问答）——不显示图标。
 *
 * 注：函数内读取的 store 状态（sessions / unread / messages）均为响应式，
 * 在组件模板中调用即可随状态切换实时更新图标。
 */
export function getSessionStatus(conv: ConversationRecord): SessionStatus {
  const store = useQueryStore();

  // 1) 运行中：实时缓冲 isLoading（isSessionStreaming 的权威判定）
  if (store.isSessionStreaming(conv.id)) return 'running';

  // 2) 异常中断：优先取实时缓冲最新消息状态，否则回退已落盘消息
  const buf = store.getSessionBuffer(conv.id);
  const liveMsgs = buf && buf.messages.length ? buf.messages : conv.messages;
  const last = liveMsgs[liveMsgs.length - 1];
  if (last && (last.status === 'error' || last.status === 'interrupted')) return 'error';

  // 3) 已完成未读
  if (conv.unread) return 'unread';

  // 4) 已完成已读（有消息即视为已完成）
  if ((conv.messageCount ?? 0) > 0) return 'read';

  // 5) 闲置（尚未产生任何消息）
  return 'idle';
}

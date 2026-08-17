// §P2 上下文压缩（compaction）：针对大 vault 长会话的 token 预算治理
//
// §背景：DeepSeek Harness 把"上下文压缩"作为一等能力（context compaction），
// 长会话下自动把早期历史压成摘要，避免 token 预算被远端检索/长对话耗尽。
// 本模块把压缩逻辑从 loop 中解耦出来，复用 P0 的事件溯源日志：
//   - 压缩 = 把 [0, 安全边界) 的事件替换为 1 条 compact 事件（summary + archived）
//   - 安全边界 = 最后一个"不含 tool_calls 的 assistant"之后，绝不切断未完成的
//     tool 配对（assistant.tool_calls 与其对应的 tool 事件必须成对进 archived）
//   - 投影 messages() 把 compact 渲染为 system 摘要，archived 完整保留供重放
//
// §零破坏：Compactor 默认不启用（HarnessConfig 不传 compactor 即原样透传）。

import type { SessionEvent, Message, RunContext, SessionLog, Compactor } from '../types.js';
import { eventToMessage } from './session-log.js';

// 触发压缩的事件数阈值（append 后的 events.length > 阈值才考虑压缩）
// 业务侧可通过 HarnessConfig.compactThreshold 覆盖（大 vault 可调小）
export const DEFAULT_COMPACT_THRESHOLD = 30;

// 单条内容截断长度：摘要里每条消息只保留开头，避免摘要本身撑爆上下文
const CLIP_LENGTH = 160;

function clip(s: string): string {
  return s.length > CLIP_LENGTH ? s.slice(0, CLIP_LENGTH) + '…' : s;
}

// 默认压缩器：无 LLM 调用，纯截断拼接出可读摘要
// 为什么不是 LLM 摘要：默认零成本、零延迟；业务侧注入 LlmCompactor 即可获得
// 语义化摘要（把长检索片段压成要点）。
export class SimpleConcatCompactor implements Compactor {
  summarize(messages: Message[], _ctx: RunContext): string {
    const n = messages.length;
    const head = messages
      .slice(0, 3)
      .map((m) => `[${m.role}] ${clip(m.content)}`)
      .join('\n');
    const tailNote = n > 4 ? `\n…以及 ${n - 4} 条更早的消息` : '';
    return `【已压缩的早期上下文 · 共 ${n} 条消息】\n${head}${tailNote}`;
  }
}

// 找安全压缩边界：从后往前定位最后一个"无 tool_calls 的 assistant"事件，
// 返回其索引 + 1（即压缩区间 [0, boundary)）。返回 -1 表示无安全边界。
// 为什么只用 assistant 无 tool_calls 作为锚点：该点之后没有未完成的 tool 配对，
// 整段 [0, boundary) 连同 assistant.tool_calls→tool 配对可一并搬进 archived，
// 不会在投影里留下悬空的 tool_call_id 引用。
export function findSafeBoundary(events: SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'assistant' && !e.tool_calls) {
      return i + 1;
    }
  }
  return -1;
}

// 触发压缩：在每步 LLM 调用前调用。内部判断阈值与安全边界，命中才压缩。
// 幂等可重复：压缩后 events 变短，下次 beforeStep 再判断，直到稳定。
export async function compactLog(
  log: SessionLog,
  compactor: Compactor,
  ctx: RunContext,
  threshold: number = DEFAULT_COMPACT_THRESHOLD,
): Promise<void> {
  const events = log.events;
  if (events.length <= threshold) return;

  const boundary = findSafeBoundary(events);
  if (boundary <= 0) return; // 全程 tool 配对中或无历史，保守不压缩

  const toArchive = events.slice(0, boundary);
  // 投影成 Message[] 再交给 Compactor，Compactor 只关心 LLM 可见语义
  const summary = await compactor.summarize(
    toArchive.map((e) => eventToMessage(e)),
    ctx,
  );
  log.compact(summary, toArchive);
}

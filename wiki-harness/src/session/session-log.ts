// 追加式会话日志：事件溯源（event-sourcing）的单一事实来源实现
//
// §背景：DeepSeek Harness 的核心优势之一是"可见即可重放"的追加事件日志，
// resume / fork / 审计全部派生于不变的事件序列。原 wiki-harness 用 Message[]
// 整存整取，丢失了时序与类型语义，无法支撑 fork / 重放 / 选择性投影。
//
// §本模块职责：
//   - InMemorySessionLog：内存版日志，events 按追加顺序保存，messages() 投影
//     出 LLM 可见历史（user/assistant/tool 映射）。
//   - messagesToEvents：旧版图腾（Message[]）→ 事件序列的迁移函数，供
//     FileStateStore.load 加载历史状态时调用。

import type { Message, SessionEvent, SessionLog, AppendSessionEvent } from '../types.js';

// 内存版会话日志：events 按追加顺序保存，提供 messages() 投影
// 为什么用类而非纯数组：封装不变的追加语义 + 自动补 ts，
// 避免调用方直接操作数组破坏因果顺序。
export class InMemorySessionLog implements SessionLog {
  private _events: SessionEvent[];
  // §P3 计划模式：全局意图锚点（由 Planner 生成），投影时置于最前作为 system 消息。
  // 不进 events：计划是元意图而非对话内容，不应被 compact 压缩；resume 时不重放
  // （计划仅对初始 run 有意义，断点续跑已有上下文，必要性低）。这是有意的简化。
  private _plan?: string;

  constructor(events: SessionEvent[] = []) {
    this._events = [...events];
  }

  get events(): SessionEvent[] {
    return this._events;
  }

  append(event: AppendSessionEvent): SessionEvent {
    const full = { ...event, ts: new Date().toISOString() } as SessionEvent;
    this._events.push(full);
    return full;
  }

  // §P3 注入计划文本；覆盖写（同一 log 只会调用一次，在循环开始前）
  setPlan(plan: string): void {
    this._plan = plan;
  }

  // 按事件顺序投影出 LLM 可见的 Message[]
  // 注意：投影是惰性的、纯函数式的 —— 同一 events 序列永远投影出相同历史，
  // 这正是事件溯源"重放即可重建状态"的不变式。
  // §P3：若有计划，作为开头 system 消息前置（在 compact 摘要之前，计划是全局意图，
  // compact 是历史压缩，二者都是 system 但语义层级不同，多 system 消息 LLM 可接受）。
  messages(): Message[] {
    const projected = this._events.map(eventToMessage);
    return this._plan
      ? [{ role: 'system', content: this._plan }, ...projected]
      : projected;
  }

  // §P2 上下文压缩：把 archived 引用的旧事件从内部移除（按对象身份比对），
  // 再把 1 条 compact 事件置于被压缩区间的原位置（历史开端）。后续 messages()
  // 投影会把 compact 渲染为 system 摘要并排在最前，archived 完整保留在 compact
  // 事件内，保证 resume / 审计可完整还原。
  // 为什么放开端而非末尾：摘要须先于保留段出现，LLM 才能以压缩摘要为上下文基座；
  // 若放末尾则摘要沦为无意义的尾注。对应 DeepSeek 的"压缩早期历史"语义。
  // 为什么用引用比对而非索引：压缩只在内存运行期发生，archived 与 _events 中对象
  // 同一引用；避免与 FileStateStore 加载后的新对象身份混淆。
  compact(summary: string, archived: SessionEvent[]): void {
    const removeSet = new Set(archived);
    const remaining = this._events.filter((e) => !removeSet.has(e));
    this._events = [
      { type: 'compact', summary, archived, ts: new Date().toISOString() },
      ...remaining,
    ];
  }
}

// 单条事件 → Message 投影（导出供 compaction.ts 复用，避免投影逻辑重复）
export function eventToMessage(e: SessionEvent): Message {
  switch (e.type) {
    case 'user':
      return { role: 'user', content: e.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: e.content,
        ...(e.tool_calls ? { tool_calls: e.tool_calls } : {}),
      };
    case 'tool':
      return { role: 'tool', content: e.content, tool_call_id: e.tool_call_id };
    case 'compact':
      return { role: 'system', content: e.summary };
  }
}

// 旧版图腾迁移：Message[] → SessionEvent[]
// 用于加载历史持久化状态（仅含 messages 无 events 的旧文件）。
// ts 留空字符串：历史事件无精确时间戳，迁移后以空串占位，不影响重放语义。
export function messagesToEvents(messages: Message[]): SessionEvent[] {
  return messages.map((m): SessionEvent => {
    switch (m.role) {
      case 'user':
        return { type: 'user', content: m.content, ts: '' };
      case 'assistant':
        return { type: 'assistant', content: m.content, tool_calls: m.tool_calls, ts: '' };
      case 'tool':
        return { type: 'tool', content: m.content, tool_call_id: m.tool_call_id ?? '', ts: '' };
      // system 等未建模角色降级为 user，保证不丢信息
      default:
        return { type: 'user', content: m.content, ts: '' };
    }
  });
}

// 便于测试从既有 Message[] 直接构造日志
export function sessionLogFromMessages(messages: Message[]): InMemorySessionLog {
  return new InMemorySessionLog(messagesToEvents(messages));
}

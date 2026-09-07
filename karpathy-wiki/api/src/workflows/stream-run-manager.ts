// X-2 可恢复流式（resumable streaming）核心：进程内流式运行管理器。
//
// 解决的问题：客户端刷新 / 网络中断 / 切换页面导致 SSE 断开时，原实现把 harness 运行
// 绑死在单次 HTTP 请求上——断开即丢失进行中的昂贵响应（历史出现 143s/282s 长耗时问答），
// 重连只能从头重跑。本管理器把 harness 运行从请求生命周期中解耦：
//   - 一次问答 = 一个 runId 拥有的 detached 运行，所有产出 AnswerChunk 进入缓冲并扇出给订阅者；
//   - 进行中或近期完成的 run，重连客户端可 subscribe 并先回放已缓冲块、再继续直播；
//   - run 完成后保留 TTL，过期回收，避免内存泄漏。
//
// 零破坏纪律：本模块本身不影响任何调用方；是否启用由 query 路由的 enableResumableStream
// 开关控制（默认 false）。关闭时路由走原有内联 SSE，完全不触碰本模块。

import type { AnswerChunk } from '../types.js';
import { withSessionLock } from '../session-lock.js';

// 联网搜索引用结构（与 query.ts 中 webRefs 字段同构）
export interface WebRef {
  title: string;
  url: string;
  snippet: string;
}

// done 事件最终载荷：由 onDone 持久化后回传，并附上 governor / runId
export interface DonePayload {
  runId: string;
  threadId: string;
  sessionId: string;
  messageIndex: number;
  governor: unknown;
  refs: string[];
  webRefs: WebRef[];
}

// 持久化回调上下文：done 块 + 由缓冲文本拼出的完整答案 + 联网引用
export interface DoneContext {
  chunk: AnswerChunk;
  answer: string;
  webRefs: WebRef[];
}

// 订阅者接口：管理器据此把缓冲 / 直播块推给具体 SSE 连接
export interface RunSink {
  onChunk(chunk: AnswerChunk): void;
  onDone(payload: DonePayload): void;
  onError(message: string): void;
  isAborted(): boolean;
  end(): void;
  // 内部：run 结束时由管理器调用以 resolve subscribe 返回的 Promise
  _resolve?: (v: 'live') => void;
}

export interface StartOptions {
  // 产出 AnswerChunk 的异步可迭代工厂（通常为 () => adapter.query(input)）
  producer: () => AsyncIterable<AnswerChunk>;
  // 持久化回调：run 到达 done 时调用一次，返回线程/会话标识供 done 事件回传
  onDone: (ctx: DoneContext) => Promise<{ threadId: string; sessionId: string; messageIndex: number }>;
  // done 事件携带的上下文治理统计（仅首连有意义，重连时透传原值）
  governor: unknown;
  // 同 question 串行锁 key（仅原始启动传入；重连不传，避免重复加锁）
  lockKey?: string;
  // 完成后保留时长（ms）
  ttlMs?: number;
}

interface RunEntry {
  runId: string;
  buffer: Array<{ kind: 'chunk'; chunk: AnswerChunk } | { kind: 'done'; payload: DonePayload } | { kind: 'error'; message: string }>;
  subscribers: Set<RunSink>;
  done: boolean;
  failed: boolean;
  // 提前正常结束（generator 耗尽但无 done chunk）：典型场景为意图澄清中断——
  // 工作流 yield clarify 卡片后 return，本轮本就没有"最终答案"。必须标记终态并
  // 结束订阅者连接，否则 subscribe 的 Promise 永不 resolve → HTTP 响应挂起。
  interrupted: boolean;
  finishedAt: number | null;
  evictTimer: ReturnType<typeof setTimeout> | null;
  ttlMs: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 完成后保留 5 分钟，足够覆盖刷新/短暂断网

class StreamRunManager {
  private readonly runs = new Map<string, RunEntry>();

  /** 启动一个 detached 运行。立即返回，产出在后台扇出给订阅者。 */
  start(runId: string, opts: StartOptions): void {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const entry: RunEntry = {
      runId,
      buffer: [],
      subscribers: new Set(),
      done: false,
      failed: false,
      interrupted: false,
      finishedAt: null,
      evictTimer: null,
      ttlMs,
    };
    this.runs.set(runId, entry);

    const iterate = async (): Promise<void> => {
      for await (const chunk of opts.producer()) {
        if (chunk.done) {
          // 组装完整答案：缓冲文本块拼接
          const answer = entry.buffer
            .filter((b): b is { kind: 'chunk'; chunk: AnswerChunk } => b.kind === 'chunk')
            .map((b) => b.chunk.text ?? '')
            .join('');
          const webRefs = (chunk.webRefs ?? []) as WebRef[];
          let meta: { threadId: string; sessionId: string; messageIndex: number };
          try {
            meta = await opts.onDone({ chunk, answer, webRefs });
          } catch (err) {
            // F1: 持久化失败不得伪装成成功 done。若直接广播带空 threadId/messageIndex 的伪 done，
            // 客户端会 finalize 一个 threadId='' 的消息，下一轮提问因 threadId 为空而新建线程，
            // 静默破坏多轮上下文连续性且本轮问答未落盘。改为走 run 失败路径（广播 error）。
            console.error('[stream-run] onDone failed', err);
            const message = err instanceof Error ? err.message : String(err);
            entry.buffer.push({ kind: 'error', message });
            this.broadcastError(entry, message);
            entry.failed = true;
            this.finishRun(entry);
            return;
          }
          const payload: DonePayload = {
            // F3: done.runId 必须是 harness runId（chunk.runId），供前端 X-1 步骤追踪
            // （QueryTracePanel 据此拉 /api/query/runs/:runId）。manager runId 仅经 open 事件
            // 下发用于重连，不应进入 done，否则恢复模式与非恢复模式的 done.runId 语义冲突。
            runId: chunk.runId ?? runId,
            threadId: meta.threadId,
            sessionId: meta.sessionId,
            messageIndex: meta.messageIndex,
            governor: opts.governor,
            refs: (chunk.refs ?? []).map((r) => (typeof r === "string" ? r : r.path)),
            webRefs,
          };
          entry.buffer.push({ kind: 'done', payload });
          this.broadcastDone(entry, payload);
          entry.done = true;
          this.finishRun(entry);
          return;
        }
        // 普通块：缓冲 + 直播
        entry.buffer.push({ kind: 'chunk', chunk });
        this.broadcastChunk(entry, chunk);
      }
    };

    const runTask = async (): Promise<void> => {
      try {
        await iterate();
        // iterate 正常 resolve 且未走 done/error 分支（二者均已 return）→ producer 自然耗尽。
        // 典型场景：意图澄清中断（yield clarify 后无 done 即结束）。此时没有"最终答案"，
        // 但必须结束订阅者连接并标记终态，否则 subscribe 的 Promise 永不 resolve → HTTP 挂起。
        this.finishInterrupted(entry);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        entry.buffer.push({ kind: 'error', message });
        this.broadcastError(entry, message);
        entry.failed = true;
        this.finishRun(entry);
      }
    };

    // 同 question 串行锁仅对原始启动生效；重连订阅不重新加锁
    if (opts.lockKey) {
      void withSessionLock(opts.lockKey, runTask);
    } else {
      void runTask();
    }
  }

  /**
   * 订阅一个已存在的 run。
   * - not_found：runId 不存在（已过期/从未存在）→ 返回 'finished'（调用方先 has() 判断）
   * - finished：run 已完成/失败 → 回放全部缓冲并 end()
   * - live：run 进行中 → 先回放已缓冲块，注册为直播订阅者，run 结束时 resolve
   */
  subscribe(runId: string, sink: RunSink): Promise<'finished' | 'live'> {
    const entry = this.runs.get(runId);
    if (!entry) {
      sink.end();
      return Promise.resolve('finished');
    }
    // 回放已缓冲块
    for (const item of entry.buffer) {
      if (item.kind === 'chunk') sink.onChunk(item.chunk);
      else if (item.kind === 'done') sink.onDone(item.payload);
      else sink.onError(item.message);
    }
    if (entry.done || entry.failed || entry.interrupted) {
      sink.end();
      return Promise.resolve('finished');
    }
    entry.subscribers.add(sink);
    return new Promise<'live'>((resolve) => {
      sink._resolve = resolve;
    });
  }

  /** 取消订阅（客户端断开时调用，避免持有死连接）。run 继续在后台运行。 */
  unsubscribe(runId: string, sink: RunSink): void {
    const entry = this.runs.get(runId);
    if (entry) {
      entry.subscribers.delete(sink);
      if (sink._resolve) {
        sink._resolve('live');
        sink._resolve = undefined;
      }
    }
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  private broadcastChunk(entry: RunEntry, chunk: AnswerChunk): void {
    for (const s of entry.subscribers) {
      if (!s.isAborted()) {
        try {
          s.onChunk(chunk);
        } catch {
          /* 单个订阅者写入失败不影响其他 */
        }
      }
    }
  }

  private broadcastDone(entry: RunEntry, payload: DonePayload): void {
    for (const s of entry.subscribers) {
      if (!s.isAborted()) {
        try {
          s.onDone(payload);
        } catch {
          /* ignore */
        }
      }
      // 无论是否中断，终端事件后都结束该订阅者连接
      try {
        s.end();
      } catch {
        /* ignore */
      }
      if (s._resolve) {
        s._resolve('live');
        s._resolve = undefined;
      }
    }
    entry.subscribers.clear();
  }

  private broadcastError(entry: RunEntry, message: string): void {
    for (const s of entry.subscribers) {
      if (!s.isAborted()) {
        try {
          s.onError(message);
        } catch {
          /* ignore */
        }
      }
      try {
        s.end();
      } catch {
        /* ignore */
      }
      if (s._resolve) {
        s._resolve('live');
        s._resolve = undefined;
      }
    }
    entry.subscribers.clear();
  }

  // 提前正常结束（无 done/error）：结束订阅者连接并标记终态，不广播任何终端事件——
  // 前端已收到 clarify 卡片（或收到截断的流），由消费端按"流正常结束但无 done"处理。
  // 为什么 resolve('live')：与 broadcastDone/broadcastError 保持一致，subscribe 的
  // Promise 以 'live' resolve（调用方仅关心 Promise 落定，不关心取值）。
  private finishInterrupted(entry: RunEntry): void {
    entry.interrupted = true;
    for (const s of entry.subscribers) {
      try {
        s.end();
      } catch {
        /* ignore */
      }
      if (s._resolve) {
        s._resolve('live');
        s._resolve = undefined;
      }
    }
    entry.subscribers.clear();
    this.finishRun(entry);
  }

  private finishRun(entry: RunEntry): void {
    entry.finishedAt = Date.now();
    if (entry.evictTimer) clearTimeout(entry.evictTimer);
    entry.evictTimer = setTimeout(() => {
      this.runs.delete(entry.runId);
    }, entry.ttlMs);
  }
}

// 单例：整个进程共享一套 run 表
export const streamRunManager = new StreamRunManager();

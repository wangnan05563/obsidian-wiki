// FR-22 用户停止：流式运行管理器终止断言（T01769 测试计划第 2 项）。
// 验证等级要求「命令层全链闭环」：cancel → abort signal 传导 producer → 广播 error → run 终态。
// 隔离纪律：streamRunManager 是进程内单例，各用例用唯一 runId 隔离，不触碰真实数据目录。
//
// T02836 等待口径清点（本文件原有 11 处 `sleep(...)`，逐处判定登记如下）：
//  | 站点                        | 原写法        | 判定                                                          |
//  | countProducer 逐块节奏       | sleep(chunkMs) | 终点不可观测（它本身就是**被测条件**：模拟上游 LLM 出块节奏）→ contractSleep(CHUNK_PACE_MS 等命名常量) |
//  | 内联 producer 逐块节奏       | sleep(10)      | 同上，用同一个命名常量，不再各处裸写                             |
//  | cancel 前「等 run 跑起来」×3 | sleep(20/30)   | 终点可观测（订阅者收到的块数）→ waitProducing(sink, ≥n)          |
//  | cancel 后「等流终止」×2      | sleep(50/60)   | 终点可观测（broadcastError  resolve subscribe 的 Promise）→ await terminal |
//  | 自然跑完「等 done」×2        | sleep(60/120)  | 同上 → await terminal / awaitTerminal(runId)                    |
//  | 退订前 sleep(5)             | sleep(5)       | 纯多余：start 同步把 run 登记进表，subscribe 立刻可用 → 直接删    |
// 结论：本文件**不再有任何「为等某个状态而写的时长」**；剩下的定时只有 producer 的出块节奏，
// 且由本文件自有的命名常量驱动、经 contractSleep 落账（守护用例据此放行）。
import { describe, expect, it } from 'vitest';
import { streamRunManager, type RunSink, type DonePayload } from '../src/workflows/stream-run-manager.js';
import type { AnswerChunk } from '../src/types.js';
import { NO_TIMER_CHAIN, contractSleep, waitForProgress } from './helpers/waitForProgress.js';

// 上游出块节奏（被测条件，不是等待预算）：三个档位分别覆盖「长流可被中途取消」「短流自然跑完」。
const CHUNK_PACE_MS = 10;
const SLOW_PACE_MS = 15;
const FAST_PACE_MS = 5;
const PACE_SOURCE =
  'CHUNK_PACE_MS/SLOW_PACE_MS/FAST_PACE_MS（本文件自有的出块节奏常量）：这是模拟上游 LLM 逐块产出的**被测条件**，不是为等某个终点而设的时长';

/** 记录型 sink：收集推给它的事件，供断言 */
function makeSink(): RunSink & {
  chunks: AnswerChunk[];
  errors: string[];
  dones: DonePayload[];
  ended: boolean;
} {
  const sink = {
    chunks: [] as AnswerChunk[],
    errors: [] as string[],
    dones: [] as DonePayload[],
    ended: false,
    onChunk(c: AnswerChunk) {
      sink.chunks.push(c);
    },
    onDone(p: DonePayload) {
      sink.dones.push(p);
    },
    onError(m: string) {
      sink.errors.push(m);
    },
    isAborted: () => false,
    end() {
      sink.ended = true;
    },
  };
  return sink;
}

/**
 * 等 run 真的在逐块产出（终点可观测：订阅者收到的块数）。
 * subscribe 的 Promise 只在终态事件才落定，所以「跑起来了」只能看块计数，不能靠 await subscribe。
 */
async function waitProducing(sink: ReturnType<typeof makeSink>, minChunks: number): Promise<void> {
  await waitForProgress(
    `run 已在逐块产出（≥${minChunks} 块）`,
    () => sink.chunks.length >= minChunks,
    {
      ...NO_TIMER_CHAIN,
      progress: () => `chunks=${sink.chunks.length} errors=${sink.errors.length} dones=${sink.dones.length}`,
    },
  );
}

/**
 * 等某个仍在进行的 run 走到终态：再订阅一次，让 subscribe 返回的 live Promise 替我们等。
 * 为什么不用轮询 has()：has() 在终态前后都为 true（TTL 内保留），不是终点；
 * live Promise 由 broadcastDone/broadcastError/finishInterrupted 三处终态路径 resolve，正是终止断言的落点。
 */
async function awaitTerminal(runId: string): Promise<void> {
  await streamRunManager.subscribe(runId, makeSink());
}

/** 模拟上游 LLM 流：逐块产出，感知 abort（FR-22 的「逐级终止上游连接」传导点） */
async function* countProducer(
  signal: AbortSignal,
  runId: string,
  opts: { chunkMs: number; total: number; abortMessage: string },
): AsyncIterable<AnswerChunk> {
  for (let i = 0; i < opts.total; i++) {
    if (signal.aborted) throw new Error(opts.abortMessage);
    yield { runId, text: `c${i}` };
    await contractSleep(PACE_SOURCE, opts.chunkMs);
  }
  yield { runId, done: true, refs: [], webRefs: [] };
}

describe('streamRunManager（FR-22 用户停止终止断言）', () => {
  it('cancel 活跃 run：abort 传导 producer，流终止并广播 error，run 进入终态', async () => {
    const controller = new AbortController();
    const runId = 'fr22-cancel-live';
    let abortedSeen = false;
    streamRunManager.start(runId, {
      producer: () => {
        // controller.signal 的 aborted 状态在 producer 每次续块前检查——
        // 这正是 query 路由里 input.signal 传导至 LLM fetch 的等价路径
        return (async function* () {
          for (let i = 0; i < 50; i++) {
            if (controller.signal.aborted) {
              abortedSeen = true;
              throw new Error('已由用户停止');
            }
            yield { runId, text: `c${i}` };
            await contractSleep(PACE_SOURCE, CHUNK_PACE_MS);
          }
        })();
      },
      onDone: async () => ({ threadId: 't', sessionId: 's', messageIndex: 0 }),
      governor: null,
      cancelSignal: controller,
    });

    // 等 run 产出几个块后发起停止：live 订阅的 Promise 不 await，它就是「终止事件」的探针
    const live = makeSink();
    const terminal = streamRunManager.subscribe(runId, live);
    await waitProducing(live, 2);
    expect(streamRunManager.cancel(runId)).toBe(true);
    expect(controller.signal.aborted).toBe(true);

    // producer 感知 abort → 走失败路径 → broadcastError 把 live Promise resolve
    await expect(terminal).resolves.toBe('live');
    expect(abortedSeen).toBe(true);
    expect(streamRunManager.has(runId)).toBe(true); // 终态 run 仍在（TTL 内）

    // 终止后订阅：只能回放 error 缓冲，立即 finished（不再直播）
    const late = makeSink();
    const mode = await streamRunManager.subscribe(runId, late);
    expect(mode).toBe('finished');
    expect(late.errors).toContain('已由用户停止');
    expect(late.dones).toHaveLength(0); // 被终止的 run 永不产出 done
    expect(late.ended).toBe(true);
    // 直播侧同样收到了 error 与连接结束（不只是晚到订阅者才有）
    expect(live.errors).toContain('已由用户停止');
    expect(live.ended).toBe(true);
  });

  it('cancel 幂等：已终止/已完成的 run 再次 cancel 返回 false', async () => {
    const controller = new AbortController();
    const runId = 'fr22-cancel-idempotent';
    streamRunManager.start(runId, {
      producer: () => countProducer(controller.signal, runId, { chunkMs: CHUNK_PACE_MS, total: 50, abortMessage: 'stop' }),
      onDone: async () => ({ threadId: 't', sessionId: 's', messageIndex: 0 }),
      governor: null,
      cancelSignal: controller,
    });
    const live = makeSink();
    const terminal = streamRunManager.subscribe(runId, live);
    await waitProducing(live, 2);
    expect(streamRunManager.cancel(runId)).toBe(true);
    await terminal;
    // 终态后再次取消：幂等返回 false，前端无需区分
    expect(streamRunManager.cancel(runId)).toBe(false);
    // 从未存在的 runId 同样 false
    expect(streamRunManager.cancel('fr22-never-exists')).toBe(false);
  });

  it('cancel 未配置 cancelSignal 的 run：返回 true 但不抛错（防御式）', async () => {
    const runId = 'fr22-cancel-no-signal';
    streamRunManager.start(runId, {
      producer: () => countProducer(new AbortController().signal, runId, { chunkMs: CHUNK_PACE_MS, total: 3, abortMessage: 'x' }),
      onDone: async () => ({ threadId: 't', sessionId: 's', messageIndex: 0 }),
      governor: null,
      // 不传 cancelSignal：cancel 无从 abort，只能标记完成路径自然走完
    });
    const live = makeSink();
    const terminal = streamRunManager.subscribe(runId, live);
    await waitProducing(live, 1); // 此刻最多 1/3 块，run 必然仍在进行 → cancel 为 true 才有意义
    expect(streamRunManager.cancel(runId)).toBe(true);
    // 无 signal 可 abort → producer 自然跑完 → 终态由 done 事件给出
    await expect(terminal).resolves.toBe('live');
    const sink = makeSink();
    const mode = await streamRunManager.subscribe(runId, sink);
    expect(mode).toBe('finished');
    expect(sink.dones).toHaveLength(1);
  });

  it('断线 unsubscribe 不终止 run：run 继续产出直至 done（与 cancel 的语义分界）', async () => {
    const runId = 'fr22-unsubscribe-keeps-running';
    streamRunManager.start(runId, {
      producer: () => countProducer(new AbortController().signal, runId, { chunkMs: SLOW_PACE_MS, total: 4, abortMessage: 'x' }),
      onDone: async () => ({ threadId: 't', sessionId: 's', messageIndex: 0 }),
      governor: null,
    });
    const sub = makeSink();
    // start 同步登记 run，无需先「等一会儿」再订阅
    const disconnected = streamRunManager.subscribe(runId, sub);
    await waitProducing(sub, 2);
    // 模拟客户端断开：只退订
    streamRunManager.unsubscribe(runId, sub);
    await expect(disconnected).resolves.toBe('live');
    expect(sub.dones).toHaveLength(0); // 退订那一刻 run 远未完成（4 块只收到 2 块）

    // run 在后台继续跑到 done —— 用终态事件收口，不再靠「等够 120ms」
    await awaitTerminal(runId);
    expect(streamRunManager.has(runId)).toBe(true);
    const reconnect = makeSink();
    const mode = await streamRunManager.subscribe(runId, reconnect);
    expect(mode).toBe('finished');
    expect(reconnect.dones).toHaveLength(1);
    expect(reconnect.chunks).toHaveLength(4); // 全量回放，不因退订丢块
  });

  it('正常完成后再 cancel：返回 false 且不影响 done 缓冲', async () => {
    const runId = 'fr22-cancel-after-done';
    streamRunManager.start(runId, {
      producer: () => countProducer(new AbortController().signal, runId, { chunkMs: FAST_PACE_MS, total: 2, abortMessage: 'x' }),
      onDone: async () => ({ threadId: 't', sessionId: 's', messageIndex: 0 }),
      governor: null,
      cancelSignal: new AbortController(),
    });
    const sink = makeSink();
    await streamRunManager.subscribe(runId, sink); // 终态事件落定 = 短流已自然跑完
    expect(streamRunManager.cancel(runId)).toBe(false);
    expect(sink.dones).toHaveLength(1);
    expect(sink.errors).toHaveLength(0);
  });
});

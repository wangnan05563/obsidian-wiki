// FR-22 用户停止：流式运行管理器终止断言（T01769 测试计划第 2 项）。
// 验证等级要求「命令层全链闭环」：cancel → abort signal 传导 producer → 广播 error → run 终态。
// 隔离纪律：streamRunManager 是进程内单例，各用例用唯一 runId 隔离，不触碰真实数据目录。
import { describe, expect, it } from 'vitest';
import { streamRunManager, type RunSink, type DonePayload } from '../src/workflows/stream-run-manager.js';
import type { AnswerChunk } from '../src/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** 模拟上游 LLM 流：逐块产出，感知 abort（FR-22 的「逐级终止上游连接」传导点） */
async function* countProducer(
  signal: AbortSignal,
  runId: string,
  opts: { chunkMs: number; total: number; abortMessage: string },
): AsyncIterable<AnswerChunk> {
  for (let i = 0; i < opts.total; i++) {
    if (signal.aborted) throw new Error(opts.abortMessage);
    yield { runId, text: `c${i}` };
    await sleep(opts.chunkMs);
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
            await sleep(10);
          }
        })();
      },
      onDone: async () => ({ threadId: 't', sessionId: 's', messageIndex: 0 }),
      governor: null,
      cancelSignal: controller,
    });

    // 等 run 产出几个块后发起停止
    await sleep(30);
    expect(streamRunManager.cancel(runId)).toBe(true);
    expect(controller.signal.aborted).toBe(true);

    // 等 producer 感知 abort 并走失败路径
    await sleep(50);
    expect(abortedSeen).toBe(true);
    expect(streamRunManager.has(runId)).toBe(true); // 终态 run 仍在（TTL 内）

    // 终止后订阅：只能回放 error 缓冲，立即 finished（不再直播）
    const late = makeSink();
    const mode = await streamRunManager.subscribe(runId, late);
    expect(mode).toBe('finished');
    expect(late.errors).toContain('已由用户停止');
    expect(late.dones).toHaveLength(0); // 被终止的 run 永不产出 done
    expect(late.ended).toBe(true);
  });

  it('cancel 幂等：已终止/已完成的 run 再次 cancel 返回 false', async () => {
    const controller = new AbortController();
    const runId = 'fr22-cancel-idempotent';
    streamRunManager.start(runId, {
      producer: () => countProducer(controller.signal, runId, { chunkMs: 10, total: 50, abortMessage: 'stop' }),
      onDone: async () => ({ threadId: 't', sessionId: 's', messageIndex: 0 }),
      governor: null,
      cancelSignal: controller,
    });
    await sleep(30);
    expect(streamRunManager.cancel(runId)).toBe(true);
    await sleep(50);
    // 终态后再次取消：幂等返回 false，前端无需区分
    expect(streamRunManager.cancel(runId)).toBe(false);
    // 从未存在的 runId 同样 false
    expect(streamRunManager.cancel('fr22-never-exists')).toBe(false);
  });

  it('cancel 未配置 cancelSignal 的 run：返回 true 但不抛错（防御式）', async () => {
    const runId = 'fr22-cancel-no-signal';
    streamRunManager.start(runId, {
      producer: () => countProducer(new AbortController().signal, runId, { chunkMs: 10, total: 3, abortMessage: 'x' }),
      onDone: async () => ({ threadId: 't', sessionId: 's', messageIndex: 0 }),
      governor: null,
      // 不传 cancelSignal：cancel 无从 abort，只能标记完成路径自然走完
    });
    await sleep(20);
    expect(streamRunManager.cancel(runId)).toBe(true);
    await sleep(60);
    const sink = makeSink();
    const mode = await streamRunManager.subscribe(runId, sink);
    expect(mode).toBe('finished');
    // 无 signal 可 abort → producer 自然跑完 → 正常 done
    expect(sink.dones).toHaveLength(1);
  });

  it('断线 unsubscribe 不终止 run：run 继续产出直至 done（与 cancel 的语义分界）', async () => {
    const runId = 'fr22-unsubscribe-keeps-running';
    streamRunManager.start(runId, {
      producer: () => countProducer(new AbortController().signal, runId, { chunkMs: 15, total: 4, abortMessage: 'x' }),
      onDone: async () => ({ threadId: 't', sessionId: 's', messageIndex: 0 }),
      governor: null,
    });
    await sleep(5);
    const sub = makeSink();
    await streamRunManager.subscribe(runId, sub);
    // 模拟客户端断开：只退订
    streamRunManager.unsubscribe(runId, sub);
    await sleep(120);
    // run 仍在且已自然完成（done 缓冲在案），重连可回放全部内容
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
      producer: () => countProducer(new AbortController().signal, runId, { chunkMs: 5, total: 2, abortMessage: 'x' }),
      onDone: async () => ({ threadId: 't', sessionId: 's', messageIndex: 0 }),
      governor: null,
      cancelSignal: new AbortController(),
    });
    await sleep(60);
    expect(streamRunManager.cancel(runId)).toBe(false);
    const sink = makeSink();
    await streamRunManager.subscribe(runId, sink);
    expect(sink.dones).toHaveLength(1);
    expect(sink.errors).toHaveLength(0);
  });
});

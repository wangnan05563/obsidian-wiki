// SSE 解析与分发工具的单元测试（src/utils/sse.ts）。
// 覆盖三层：单事件解析（parseSSEEvent）→ 事件→writer 映射（dispatchQuerySSEEvent，
// 逐 handler 断言源码实际语义与默认值回退）→ 流消费（consumeQuerySSE / consumeQuerySSEResumable /
// consumeSSE），含分块粘包、兜底 finalize、断线重连与异常降级路径。
// 确定性：全部用内存 ReadableStream 构造 Response，不依赖网络与计时器。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseSSEEvent,
  dispatchQuerySSEEvent,
  processQuerySSEEvents,
  consumeQuerySSE,
  consumeQuerySSEResumable,
  consumeSSE,
  type SSEWriter,
} from '../src/utils/sse';
import { ElMessage } from 'element-plus';
import type { Clarification } from '../src/types';

// element-plus 仅被 sse.ts 用于 ElMessage.warning（error 事件），mock 掉避免真实 UI 依赖
vi.mock('element-plus', () => ({
  ElMessage: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// ===== 测试脚手架 =====

/** 构造一个与 query store 缓冲行为同构的 mock writer：
 *  - appendAnswer 累积 streamingAnswer（模拟真实缓冲）
 *  - finalizeAnswer 置 didDone（模拟 done 落地）
 *  - setManagerRunId 记录 runId（重连判定依据）
 *  其余方法为纯记录 spy。
 */
function createWriter() {
  const state = {
    isLoading: false,
    streamingAnswer: '',
    managerRunId: null as string | null,
    threadId: null as string | null,
    didDone: false,
  };
  const writer = {
    appendAnswer: vi.fn((t: string) => {
      state.streamingAnswer += t;
    }),
    setRefs: vi.fn(),
    setFollowups: vi.fn(),
    appendThinking: vi.fn(),
    setProgress: vi.fn(),
    setMultimodal: vi.fn(),
    setImage: vi.fn(),
    setPpt: vi.fn(),
    setThreadId: vi.fn((id: string | null) => {
      state.threadId = id;
    }),
    setRunId: vi.fn(),
    setContextUsage: vi.fn(),
    setManagerRunId: vi.fn((id?: string) => {
      state.managerRunId = id ?? null;
    }),
    finalizeAnswer: vi.fn(() => {
      state.didDone = true;
      state.isLoading = false;
    }),
    handleError: vi.fn(),
    resetForResume: vi.fn(() => {
      state.streamingAnswer = '';
    }),
    setClarification: vi.fn(),
    clearClarification: vi.fn(),
    get isLoading() {
      return state.isLoading;
    },
    get streamingAnswer() {
      return state.streamingAnswer;
    },
    get managerRunId() {
      return state.managerRunId;
    },
    get threadId() {
      return state.threadId;
    },
    get didDone() {
      return state.didDone;
    },
    get clarification(): Clarification | null {
      return null;
    },
  };
  return { writer: writer as unknown as SSEWriter & typeof writer, state };
}

/** 正常结束的 SSE 流 Response（每个 chunk 一帧，可含任意拆分） */
function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

/** 先逐块推送 chunks、推完再以 err 中断的流 Response（模拟网络骤断/主动停止）。
 *  用 pull 拉取式 source：start() 里 enqueue 后立刻 c.error() 会按规范丢弃已入队数据，
 *  必须每读一块、读完后才 error，才能保证"异常前的事件已被消费"。
 */
function erroringResponse(chunks: string[], err: Error): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream({
    pull(c) {
      if (i < chunks.length) {
        c.enqueue(enc.encode(chunks[i++]));
        return;
      }
      c.error(err);
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const DONE_FRAME = 'event: done\ndata: {"sessionId":"s1","messageIndex":2,"threadId":"t1"}\n\n';

// ===== parseSSEEvent =====

describe('parseSSEEvent', () => {
  it('完整事件：提取 event 与 data 字段', () => {
    expect(parseSSEEvent('event: answer\ndata: {"text":"你好"}')).toEqual({
      eventType: 'answer',
      data: '{"text":"你好"}',
    });
  });

  it('data 内含冒号/URL 时原样保留（只切第一个前缀）', () => {
    const raw = '{"url":"http://a:8080/x"}';
    expect(parseSSEEvent(`event: image\ndata: ${raw}`)?.data).toBe(raw);
  });

  it('缺 event 或缺 data 均视为无效事件返回 null', () => {
    expect(parseSSEEvent('event: answer')).toBeNull();
    expect(parseSSEEvent('data: {"text":"x"}')).toBeNull();
    expect(parseSSEEvent('')).toBeNull();
  });

  it('心跳注释行（: ping）无 event 前缀 → null', () => {
    expect(parseSSEEvent(': ping\ndata: keepalive')).toBeNull();
  });

  it('前缀必须严格为 "event: "/"data: "（无空格不被识别）', () => {
    expect(parseSSEEvent('event:answer\ndata:d')).toBeNull();
  });

  it('多行 data 时后到者覆盖前者（源码逐行覆写语义）', () => {
    expect(parseSSEEvent('data: one\ndata: two\nevent: e')).toEqual({ eventType: 'e', data: 'two' });
  });

  it('多余字段行（id/retry）被忽略不影响解析', () => {
    expect(parseSSEEvent('id: 42\nretry: 3000\nevent: done\ndata: {}')).toEqual({
      eventType: 'done',
      data: '{}',
    });
  });
});

// ===== dispatchQuerySSEEvent：逐 handler 语义 =====

describe('dispatchQuerySSEEvent：answer/refs/progress/followups/multimodal', () => {
  let w: ReturnType<typeof createWriter>;
  beforeEach(() => {
    w = createWriter();
  });

  it('answer：透传 text；缺失 text 时追加空串（不 throw）', () => {
    dispatchQuerySSEEvent('answer', '{"text":"A"}', w.writer);
    expect(w.writer.appendAnswer).toHaveBeenLastCalledWith('A');
    dispatchQuerySSEEvent('answer', '{}', w.writer);
    expect(w.writer.appendAnswer).toHaveBeenLastCalledWith('');
  });

  it('refs：缺失字段回退空数组', () => {
    const web = [{ title: 't', url: 'u', snippet: 's' }];
    dispatchQuerySSEEvent('refs', `{"refs":["p.md"],"webRefs":${JSON.stringify(web)}}`, w.writer);
    expect(w.writer.setRefs).toHaveBeenCalledWith(['p.md'], web);
    dispatchQuerySSEEvent('refs', '{}', w.writer);
    expect(w.writer.setRefs).toHaveBeenLastCalledWith([], []);
  });

  it('progress：step 与 count 原样透传（count 可为 undefined）', () => {
    dispatchQuerySSEEvent('progress', '{"step":"检索","count":3}', w.writer);
    expect(w.writer.setProgress).toHaveBeenCalledWith('检索', 3);
    dispatchQuerySSEEvent('progress', '{"step":"生成"}', w.writer);
    expect(w.writer.setProgress).toHaveBeenLastCalledWith('生成', undefined);
  });

  it('followups：缺失回退空数组', () => {
    dispatchQuerySSEEvent('followups', '{"followups":["q1"]}', w.writer);
    expect(w.writer.setFollowups).toHaveBeenCalledWith(['q1']);
    dispatchQuerySSEEvent('followups', '{}', w.writer);
    expect(w.writer.setFollowups).toHaveBeenLastCalledWith([]);
  });

  it('multimodal：content 缺失回退空串，payload 仅含 type/content 两字段', () => {
    dispatchQuerySSEEvent('multimodal', '{"type":"mindmap","content":"graph TD"}', w.writer);
    expect(w.writer.setMultimodal).toHaveBeenCalledWith({ type: 'mindmap', content: 'graph TD' });
    dispatchQuerySSEEvent('multimodal', '{"type":"faq"}', w.writer);
    expect(w.writer.setMultimodal).toHaveBeenLastCalledWith({ type: 'faq', content: '' });
  });
});

describe('dispatchQuerySSEEvent：thinking 的 ts 降级', () => {
  it('后端提供 ts 时原样使用', () => {
    const { writer } = createWriter();
    dispatchQuerySSEEvent(
      'thinking',
      '{"phase":"tool_call","message":"检索中","tool":"grep","args":{"q":"x"},"ts":"2026-01-01T00:00:00.000Z"}',
      writer,
    );
    expect(writer.appendThinking).toHaveBeenCalledWith({
      phase: 'tool_call',
      message: '检索中',
      tool: 'grep',
      args: { q: 'x' },
      ts: '2026-01-01T00:00:00.000Z',
    });
  });

  it('后端未提供 ts（或为空串）时降级为接收时刻的 ISO 时间', () => {
    const { writer } = createWriter();
    const before = Date.now();
    dispatchQuerySSEEvent('thinking', '{"phase":"thinking","message":"规划","ts":""}', writer);
    const step = (writer.appendThinking as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof step.ts).toBe('string');
    expect(Date.parse(step.ts)).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('dispatchQuerySSEEvent：image/ppt/done/open 条件分支', () => {
  it('image：url/alt 缺失回退空串，archivePath 原样（可为 undefined）', () => {
    const { writer } = createWriter();
    dispatchQuerySSEEvent('image', '{}', writer);
    expect(writer.setImage).toHaveBeenCalledWith({ url: '', alt: '', archivePath: undefined });
    dispatchQuerySSEEvent('image', '{"url":"u","alt":"a","archivePath":"z"}', writer);
    expect(writer.setImage).toHaveBeenLastCalledWith({ url: 'u', alt: 'a', archivePath: 'z' });
  });

  it('ppt：三字段均有空串回退', () => {
    const { writer } = createWriter();
    dispatchQuerySSEEvent('ppt', '{}', writer);
    expect(writer.setPpt).toHaveBeenCalledWith({ markdown: '', title: '', archivePath: '' });
  });

  it('done：携带 threadId/runId 时分别记录，并固定调 setContextUsage + finalizeAnswer(3 参)', () => {
    const { writer } = createWriter();
    dispatchQuerySSEEvent(
      'done',
      '{"threadId":"t1","runId":"r9","sessionId":"s1","messageIndex":3,"governor":{"inputTokens":100},"maxTokens":2000}',
      writer,
    );
    expect(writer.setThreadId).toHaveBeenCalledWith('t1');
    expect(writer.setRunId).toHaveBeenCalledWith('r9');
    expect(writer.setContextUsage).toHaveBeenCalledWith({ inputTokens: 100 }, 2000);
    expect(writer.finalizeAnswer).toHaveBeenCalledWith('s1', 3, 't1');
  });

  it('done：无 threadId/runId 时不写线程键（条件守卫），finalizeAnswer 以 3 个 undefined 调用', () => {
    const { writer } = createWriter();
    dispatchQuerySSEEvent('done', '{}', writer);
    expect(writer.setThreadId).not.toHaveBeenCalled();
    expect(writer.setRunId).not.toHaveBeenCalled();
    expect(writer.setContextUsage).toHaveBeenCalledWith(undefined, undefined);
    expect(writer.finalizeAnswer).toHaveBeenCalledWith(undefined, undefined, undefined);
  });

  it('open：有 runId 才写 managerRunId；无 runId 不触碰', () => {
    const { writer } = createWriter();
    dispatchQuerySSEEvent('open', '{"runId":"m1"}', writer);
    expect(writer.setManagerRunId).toHaveBeenCalledWith('m1');
    dispatchQuerySSEEvent('open', '{}', writer);
    expect(writer.setManagerRunId).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchQuerySSEEvent：clarify/error 与容错', () => {
  it('clarify：interpretations 非数组回退 []，recommendedIndex 缺失/null 回退 0，空 threadId 归一为 undefined，并清空 managerRunId', () => {
    const { writer } = createWriter();
    dispatchQuerySSEEvent(
      'clarify',
      '{"id":"c1","round":1,"maxRounds":3,"question":"q?","prompt":"p","interpretations":"bad","threadId":""}',
      writer,
    );
    expect(writer.setClarification).toHaveBeenCalledWith({
      id: 'c1',
      round: 1,
      maxRounds: 3,
      question: 'q?',
      prompt: 'p',
      interpretations: [],
      recommendedIndex: 0,
      threadId: undefined,
    });
    // 关键语义：澄清 = 本轮终点，清掉 managerRunId 防可恢复层误重连
    expect(writer.setManagerRunId).toHaveBeenCalledWith(undefined);
  });

  it('clarify：recommendedIndex 用 ?? 判定——0 保留，缺失才回退 0；threadId 有值时透传', () => {
    const { writer } = createWriter();
    dispatchQuerySSEEvent(
      'clarify',
      '{"id":"c2","recommendedIndex":null,"interpretations":[{"index":0,"label":"A","description":"d"}],"threadId":"t9"}',
      writer,
    );
    const payload = (writer.setClarification as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.recommendedIndex).toBe(0);
    expect(payload.threadId).toBe('t9');
    expect(payload.interpretations).toHaveLength(1);
  });

  it('error：handleError 与 ElMessage.warning 同文案；message 缺失回退「问答出错」', () => {
    const { writer } = createWriter();
    dispatchQuerySSEEvent('error', '{"message":"配额不足"}', writer);
    expect(writer.handleError).toHaveBeenCalledWith('配额不足');
    expect(ElMessage.warning).toHaveBeenCalledWith('配额不足');
    dispatchQuerySSEEvent('error', '{}', writer);
    expect(writer.handleError).toHaveBeenLastCalledWith('问答出错');
    expect(ElMessage.warning).toHaveBeenLastCalledWith('问答出错');
  });

  it('未知事件类型与非 JSON 数据：静默跳过，不 throw 不写缓冲', () => {
    const { writer } = createWriter();
    dispatchQuerySSEEvent('heartbeat', '{}', writer);
    dispatchQuerySSEEvent('answer', 'not-json', writer);
    expect(writer.appendAnswer).not.toHaveBeenCalled();
    expect(writer.handleError).not.toHaveBeenCalled();
  });
});

describe('processQuerySSEEvents：批量分发', () => {
  it('混入不完整/未知事件时仅有效事件被处理', () => {
    const { writer } = createWriter();
    processQuerySSEEvents(
      [
        'event: answer\ndata: {"text":"1"}',
        'garbage-without-prefix',
        'event: unknown-type\ndata: {}',
        'event: answer\ndata: {"text":"2"}',
      ],
      writer,
    );
    expect(writer.appendAnswer).toHaveBeenCalledTimes(2);
    expect(writer.appendAnswer).toHaveBeenNthCalledWith(1, '1');
    expect(writer.appendAnswer).toHaveBeenNthCalledWith(2, '2');
  });
});

// ===== consumeQuerySSE =====

describe('consumeQuerySSE', () => {
  it('无 body 的 Response 直接抛错', async () => {
    const { writer } = createWriter();
    await expect(
      consumeQuerySSE({ ok: true, body: null } as unknown as Response, writer),
    ).rejects.toThrow('Response body is empty');
  });

  it('跨 chunk 拆分的半个事件被缓冲拼接后完整解析', async () => {
    const { writer } = createWriter();
    const resp = sseResponse(['event: an', 'swer\ndata: {"text":"A"}', '\n\n' + DONE_FRAME]);
    await consumeQuerySSE(resp, writer);
    expect(writer.appendAnswer).toHaveBeenCalledWith('A');
    expect(writer.finalizeAnswer).toHaveBeenCalledWith('s1', 2, 't1');
  });

  it('onActivity 每个数据块回调一次（滑动窗口看门狗心跳）', async () => {
    const { writer } = createWriter();
    const onActivity = vi.fn();
    await consumeQuerySSE(sseResponse(['a\n', 'b\n\n', DONE_FRAME]), writer, undefined, onActivity);
    expect(onActivity).toHaveBeenCalledTimes(3);
  });

  it('流尾不完整帧（无空行终止）被丢弃、不处理', async () => {
    const { writer } = createWriter();
    await consumeQuerySSE(sseResponse(['event: answer\ndata: {"text":"X"}\n\n', 'event: answer\ndata: {"text":"Y"}']), writer);
    expect(writer.appendAnswer).toHaveBeenCalledTimes(1);
    expect(writer.appendAnswer).toHaveBeenCalledWith('X');
  });

  it('流结束但未收到 done：isLoading+有内容+无 managerRunId 时兜底 finalizeAnswer()', async () => {
    const { writer, state } = createWriter();
    state.isLoading = true;
    await consumeQuerySSE(sseResponse(['event: answer\ndata: {"text":"半"}\n\n']), writer);
    expect(state.streamingAnswer).toBe('半');
    expect(writer.finalizeAnswer).toHaveBeenCalledTimes(1);
    expect(writer.finalizeAnswer).toHaveBeenCalledWith();
  });

  it('持有 managerRunId 时不做兜底 finalize（交给可恢复层决策）', async () => {
    const { writer, state } = createWriter();
    state.isLoading = true;
    const resp = sseResponse([
      'event: open\ndata: {"runId":"m1"}\n\n',
      'event: answer\ndata: {"text":"半"}\n\n',
    ]);
    await consumeQuerySSE(resp, writer);
    expect(writer.finalizeAnswer).not.toHaveBeenCalled();
  });

  it('isLoading=false 或无部分内容时都不兜底 finalize', async () => {
    const { writer } = createWriter(); // isLoading 默认 false
    await consumeQuerySSE(sseResponse(['event: answer\ndata: {"text":"x"}\n\n']), writer);
    expect(writer.finalizeAnswer).not.toHaveBeenCalled();

    const w2 = createWriter();
    w2.state.isLoading = true; // 有 isLoading 但 streamingAnswer 为空
    await consumeQuerySSE(sseResponse(['event: thinking\ndata: {"phase":"thinking","message":"m"}\n\n']), w2.writer);
    expect(w2.writer.finalizeAnswer).not.toHaveBeenCalled();
  });

  it('AbortError（用户主动停止）被吞掉且不 finalize、不抛出', async () => {
    const { writer, state } = createWriter();
    state.isLoading = true;
    const err = new DOMException('用户停止', 'AbortError');
    const resp = erroringResponse(['event: answer\ndata: {"text":"半"}\n\n'], err);
    await expect(consumeQuerySSE(resp, writer)).resolves.toBeUndefined();
    // 读中断使 try 内兜底逻辑被跳过（catch 直接 return）→ 不 finalize
    expect(writer.finalizeAnswer).not.toHaveBeenCalled();
  });

  it('非 Abort 读取错误原样抛给调用方（由可恢复层决定是否重连）', async () => {
    const { writer } = createWriter();
    const resp = erroringResponse([], new Error('connection reset'));
    await expect(consumeQuerySSE(resp, writer)).rejects.toThrow('connection reset');
  });

  it('signal 已 abort 时走 finally 释放 reader，事件仍被正常处理', async () => {
    const { writer } = createWriter();
    const signal = { aborted: true } as AbortSignal;
    await consumeQuerySSE(sseResponse([DONE_FRAME]), writer, signal);
    expect(writer.finalizeAnswer).toHaveBeenCalledWith('s1', 2, 't1');
  });
});

// ===== consumeQuerySSEResumable =====

describe('consumeQuerySSEResumable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('首连即收到 done：不触发任何重连', async () => {
    const { writer } = createWriter();
    const initialFetch = vi.fn().mockResolvedValue(sseResponse([DONE_FRAME]));
    const resumeFetch = vi.fn();
    await consumeQuerySSEResumable(initialFetch, resumeFetch, writer);
    expect(resumeFetch).not.toHaveBeenCalled();
    expect(initialFetch).toHaveBeenCalledTimes(1);
    expect(writer.didDone).toBe(true);
  });

  it('首连网络异常：兜底 finalize 已收部分并抛出', async () => {
    const { writer, state } = createWriter();
    state.isLoading = true;
    state.streamingAnswer = '旧内容';
    const initialFetch = vi.fn().mockRejectedValue(new Error('dns fail'));
    await expect(
      consumeQuerySSEResumable(initialFetch, () => Promise.resolve(sseResponse([])), writer),
    ).rejects.toThrow('dns fail');
    expect(writer.finalizeAnswer).toHaveBeenCalledTimes(1);
  });

  it('HTTP 非 2xx：错误消息透出响应体 error 字段', async () => {
    const { writer } = createWriter();
    const bad = { ok: false, status: 400, json: async () => ({ error: '未配置 API Key' }) } as unknown as Response;
    await expect(
      consumeQuerySSEResumable(async () => bad, vi.fn(), writer),
    ).rejects.toThrow('HTTP 400: 未配置 API Key');
  });

  it('HTTP 非 2xx：error 缺失/非字符串时回退 detail，均无则仅状态码', async () => {
    const { writer } = createWriter();
    const d = { ok: false, status: 503, json: async () => ({ error: { code: 1 }, detail: '维护中' }) } as unknown as Response;
    await expect(consumeQuerySSEResumable(async () => d, vi.fn(), writer)).rejects.toThrow('HTTP 503: 维护中');

    const n = { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    await expect(consumeQuerySSEResumable(async () => n, vi.fn(), writer)).rejects.toThrow('HTTP 500');
  });

  it('HTTP 非 2xx 且响应体非 JSON：静默降级为仅状态码', async () => {
    const { writer } = createWriter();
    const bad = {
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('not json');
      },
    } as unknown as Response;
    await expect(consumeQuerySSEResumable(async () => bad, vi.fn(), writer)).rejects.toThrow('HTTP 502');
  });

  it('流异常结束（无 done）且持有 managerRunId：resetForResume 后凭 runId+threadId 重连一次并成功', async () => {
    const { writer, state } = createWriter();
    state.isLoading = true;
    state.threadId = 'th1'; // 模拟此前 done/会话已写入线程键
    const first = sseResponse([
      'event: open\ndata: {"runId":"m1"}\n\n',
      'event: answer\ndata: {"text":"半"}\n\n', // 无 done，流终止
    ]);
    const initialFetch = vi.fn().mockResolvedValue(first);
    const resumeFetch = vi.fn().mockResolvedValue(sseResponse([DONE_FRAME]));
    await consumeQuerySSEResumable(initialFetch, resumeFetch, writer);
    expect(writer.resetForResume).toHaveBeenCalledTimes(1);
    expect(resumeFetch).toHaveBeenCalledWith('m1', 'th1');
    expect(writer.didDone).toBe(true);
    // 重连成功走 done 收尾：finalizeAnswer 只由 done 事件触发一次
    expect(writer.finalizeAnswer).toHaveBeenCalledTimes(1);
    expect(writer.finalizeAnswer).toHaveBeenCalledWith('s1', 2, 't1');
  });

  it('重连达上限仍未收到 done：不再抛错，兜底 finalize 后正常返回', async () => {
    const { writer, state } = createWriter();
    state.isLoading = true;
    const openAndAnswer = [
      'event: open\ndata: {"runId":"m1"}\n\n',
      'event: answer\ndata: {"text":"A"}\n\n',
    ];
    const initialFetch = vi.fn().mockResolvedValue(sseResponse(openAndAnswer));
    const resumeFetch = vi.fn().mockResolvedValue(sseResponse(['event: answer\ndata: {"text":"B"}\n\n']));
    await expect(
      consumeQuerySSEResumable(initialFetch, resumeFetch, writer, undefined, undefined, 1),
    ).resolves.toBeUndefined();
    expect(resumeFetch).toHaveBeenCalledTimes(1);
    // 重连后流里有 A? 不——重连流仅 B；两次都没有 done → 最终兜底 finalize 一次
    expect(writer.finalizeAnswer).toHaveBeenCalledTimes(1);
    expect(writer.finalizeAnswer).toHaveBeenCalledWith(); // 无参 = 兜底路径
  });

  it('读取异常 + managerRunId：异常被吸收进重连流程，重连成功后不抛出', async () => {
    const { writer, state } = createWriter();
    state.isLoading = true;
    const boom = new Error('network RST');
    const initialFetch = vi
      .fn()
      .mockResolvedValue(erroringResponse(['event: open\ndata: {"runId":"m9"}\n\n'], boom));
    const resumeFetch = vi.fn().mockResolvedValue(sseResponse([DONE_FRAME]));
    await expect(consumeQuerySSEResumable(initialFetch, resumeFetch, writer)).resolves.toBeUndefined();
    expect(resumeFetch).toHaveBeenCalledWith('m9', null);
    expect(writer.didDone).toBe(true);
  });

  it('读取异常 + 无 managerRunId：不重连，兜底 finalize 后原样抛出', async () => {
    const { writer, state } = createWriter();
    state.isLoading = true;
    const boom = new Error('read fail');
    const initialFetch = vi.fn().mockResolvedValue(erroringResponse(['event: answer\ndata: {"text":"x"}\n\n'], boom));
    const resumeFetch = vi.fn();
    await expect(consumeQuerySSEResumable(initialFetch, resumeFetch, writer)).rejects.toThrow('read fail');
    expect(resumeFetch).not.toHaveBeenCalled();
    expect(writer.finalizeAnswer).toHaveBeenCalledTimes(1);
  });

  it('maxResume=0：即便持有 managerRunId 也只连一次、直接进入兜底收尾', async () => {
    const { writer, state } = createWriter();
    state.isLoading = true;
    const initialFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse(['event: open\ndata: {"runId":"m1"}\n\n', 'event: answer\ndata: {"text":"x"}\n\n']),
      );
    const resumeFetch = vi.fn();
    await consumeQuerySSEResumable(initialFetch, resumeFetch, writer, undefined, undefined, 0);
    expect(resumeFetch).not.toHaveBeenCalled();
    expect(writer.resetForResume).not.toHaveBeenCalled();
    expect(writer.finalizeAnswer).toHaveBeenCalledTimes(1);
  });
});

// ===== consumeSSE（通用流消费） =====

describe('consumeSSE', () => {
  it('逐事件回调 handler(eventType, parsedData)', async () => {
    const handler = vi.fn();
    await consumeSSE(sseResponse(['event: progress\ndata: {"step":"a"}\n\n', DONE_FRAME]), handler);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, 'progress', { step: 'a' });
    expect(handler).toHaveBeenNthCalledWith(2, 'done', {
      sessionId: 's1',
      messageIndex: 2,
      threadId: 't1',
    });
  });

  it('非 JSON data 与不完整帧均被跳过，handler 不收到脏数据', async () => {
    const handler = vi.fn();
    await consumeSSE(
      sseResponse(['event: log\ndata: plain text\n\n', 'event: answer\ndata: {"text":"ok"}\n\n', 'event: tail\ndata: {}']),
      handler,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('answer', { text: 'ok' });
  });

  it('无 body 抛错；signal 已 abort 时走 finally 释放 reader 且不抛出', async () => {
    await expect(consumeSSE({ body: null } as unknown as Response, vi.fn())).rejects.toThrow(
      'Response body is empty',
    );
    const handler = vi.fn();
    await expect(
      consumeSSE(sseResponse([DONE_FRAME]), handler, { aborted: true } as AbortSignal),
    ).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('handler 抛异常被吞掉，不中断后续事件（源码在循环内 try/catch 包裹 handler 调用）', async () => {
    const seen: string[] = [];
    const handler = vi.fn((eventType: string) => {
      seen.push(eventType);
      if (eventType === 'progress') throw new Error('handler boom');
    });
    await consumeSSE(sseResponse(['event: progress\ndata: {}\n\n', DONE_FRAME]), handler);
    expect(seen).toEqual(['progress', 'done']);
  });
});

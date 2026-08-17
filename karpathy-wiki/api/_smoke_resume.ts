// X-2 管理器单元冒烟：验证 "进行中断连 → 重连回放完整响应" 机制（无需真实 LLM）。
import { streamRunManager } from './src/workflows/stream-run-manager.js';
import type { AnswerChunk, RunSink } from './src/workflows/stream-run-manager.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 模拟一个带延时的生产者：两段文本 + 一个 done
async function* fakeProducer(): AsyncIterable<AnswerChunk> {
  await sleep(50);
  yield { text: 'Hello ' };
  await sleep(50);
  yield { text: 'World' };
  await sleep(50);
  yield { done: true, refs: ['a.md'], webRefs: [{ title: 'A', url: 'http://a', snippet: 'x' }] } as AnswerChunk;
}

function makeSink(log: string[], label: string): RunSink & { ended: boolean } {
  const sink: RunSink & { ended: boolean } = {
    ended: false,
    onChunk: (c) => { if (c.text) log.push(`${label}:text:${c.text}`); },
    onDone: (p) => { log.push(`${label}:done:${p.runId}:${p.messageIndex}`); },
    onError: (m) => { log.push(`${label}:error:${m}`); },
    isAborted: () => false,
    end: () => { log.push(`${label}:end`); sink.ended = true; },
  };
  return sink;
}

async function main() {
  const runId = 'test-run-1';
  const events: string[] = [];

  // 启动 run（detached）
  streamRunManager.start(runId, {
    producer: fakeProducer,
    governor: null,
    onDone: async () => ({ threadId: 't1', sessionId: 't1', messageIndex: 7 }),
  });

  // 订阅者 A：连上后收到第一段文本即"断开"（模拟客户端刷新）
  const sinkA = makeSink(events, 'A');
  const pA = streamRunManager.subscribe(runId, sinkA);
  await sleep(70); // 等第一段 "Hello " 产出
  streamRunManager.unsubscribe(runId, sinkA); // 模拟断连（run 继续后台跑）
  console.log('after disconnect, A saw:', events.filter((e) => e.startsWith('A')));

  // 等 run 跑完
  await sleep(200);

  // 订阅者 B：重连，应回放全部缓冲（Hello + World + done）
  const sinkB = makeSink(events, 'B');
  const pB = streamRunManager.subscribe(runId, sinkB);
  await pB; // 阻塞至回放+结束
  console.log('B (resume) saw:', events.filter((e) => e.startsWith('B')));

  const bTexts = events.filter((e) => e.startsWith('B:text'));
  const bDone = events.find((e) => e.startsWith('B:done'));
  const bEnd = events.find((e) => e.startsWith('B:end'));

  const ok = bTexts.length === 2 && bTexts.join('|').includes('Hello ') && bTexts.join('|').includes('World') && !!bDone && !!bEnd;
  console.log(ok ? 'RESUME_OK' : 'RESUME_FAIL', JSON.stringify({ bTexts, bDone, bEnd }));

  // not_found 测试
  const sinkC = makeSink(events, 'C');
  const pC = streamRunManager.subscribe('nope', sinkC);
  await pC;
  console.log('C (not_found) saw:', events.filter((e) => e.startsWith('C')));

  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

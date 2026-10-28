// T03591 编译幂等表单测：去重判定、状态流转、TTL、并发占位与 Key 生成规则。
// 纯内存模块，不依赖 Fastify/vault，覆盖「同一内容只能有一个执行者」这一核心不变量。
import { describe, it, expect } from 'vitest';
import {
  CompileIdempotency,
  IDEMPOTENCY_TTL_MS,
  fileContentKey,
  textContentKey,
  rawPathKey,
  batchContentKey,
} from '../src/compile-idempotency.js';

describe('CompileIdempotency', () => {
  it('首次 begin 获得执行权，同内容再次 begin 返回 running 与快照', () => {
    const reg = new CompileIdempotency();
    const first = reg.begin('k1');
    expect(first.kind).toBe('started');

    const second = reg.begin('k1');
    expect(second.kind).toBe('running');
    if (second.kind === 'running') {
      expect(second.snapshot.state).toBe('running');
    }
  });

  it('touch 后去重请求能看到当前步骤与消息', () => {
    const reg = new CompileIdempotency();
    reg.begin('k2');
    reg.touch('k2', { step: 'generate_page', message: '正在生成第 3 个页面' });

    const dup = reg.begin('k2');
    expect(dup.kind).toBe('running');
    if (dup.kind === 'running') {
      expect(dup.snapshot.step).toBe('generate_page');
      expect(dup.snapshot.message).toBe('正在生成第 3 个页面');
    }
  });

  it('finish(done) 后再次 begin 允许重新执行（成功任务由 CompileCache 短路）', () => {
    const reg = new CompileIdempotency();
    const first = reg.begin('k3');
    if (first.kind !== 'started') throw new Error('unreachable');
    reg.finish('k3', first.token, { status: 'done', message: '编译完成' });

    expect(reg.peek('k3')?.state).toBe('done');
    expect(reg.peek('k3')?.message).toBe('编译完成');
    expect(reg.begin('k3').kind).toBe('started');
  });

  it('finish(failed) 后允许重试（这正是重试入口的语义）', () => {
    const reg = new CompileIdempotency();
    const first = reg.begin('k4');
    if (first.kind !== 'started') throw new Error('unreachable');
    reg.finish('k4', first.token, { status: 'failed', message: 'LLM 429' });

    expect(reg.peek('k4')?.state).toBe('failed');
    expect(reg.begin('k4').kind).toBe('started');
  });

  it('过期任务用旧 token 收口不会覆盖新任务的进行中状态', () => {
    let now = 1_000;
    const reg = new CompileIdempotency(1_000, () => now);
    const stale = reg.begin('k5');
    if (stale.kind !== 'started') throw new Error('unreachable');

    now += 1_001; // 超过 TTL：旧条目失效
    const fresh = reg.begin('k5');
    expect(fresh.kind).toBe('started');

    reg.finish('k5', stale.token, { status: 'failed' });
    expect(reg.peek('k5')?.state).toBe('running');
  });

  it('进行中条目超过 TTL 后不再拦截新请求（避免一次崩溃永久挡住同内容）', () => {
    let now = 0;
    const reg = new CompileIdempotency(500, () => now);
    reg.begin('k6');
    now = 499;
    expect(reg.begin('k6').kind).toBe('running');
    now = 501;
    expect(reg.begin('k6').kind).toBe('started');
  });

  it('默认 TTL 为 30 分钟', () => {
    expect(IDEMPOTENCY_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('同一 tick 内并发 begin 只有一个拿到执行权', () => {
    const reg = new CompileIdempotency();
    const results = Array.from({ length: 10 }, () => reg.begin('same'));
    expect(results.filter((r) => r.kind === 'started')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'running')).toHaveLength(9);
  });

  it('并发请求（Promise.all）只真正执行一次', async () => {
    const reg = new CompileIdempotency();
    let executions = 0;
    // 确定性门槛：任务函数在第一个 await 前同步执行完毕，begin 全部发生在 release 之前
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tasks = Array.from({ length: 5 }, async () => {
      const begun = reg.begin('race');
      if (begun.kind !== 'started') return;
      executions += 1;
      await gate;
      reg.finish('race', begun.token, { status: 'done' });
    });
    release();
    await Promise.all(tasks);
    expect(executions).toBe(1);
  });
});

describe('幂等 Key 生成规则', () => {
  it('文件按字节哈希：内容相同则 key 相同，内容不同则不同', () => {
    expect(fileContentKey(Buffer.from('abc'))).toBe(fileContentKey(Buffer.from('abc')));
    expect(fileContentKey(Buffer.from('abc'))).not.toBe(fileContentKey(Buffer.from('abd')));
    expect(fileContentKey(Buffer.from('abc'))).toHaveLength(32);
  });

  it('文本 key 区分 type：同样的正文按 url 与 text 编译是两件事', () => {
    expect(textContentKey('url', 'x')).not.toBe(textContentKey('text', 'x'));
    expect(textContentKey('text', 'x')).toBe(textContentKey('text', 'x'));
  });

  it('重试按 rawPath 去重：同一存档路径相同，不同路径不同', () => {
    expect(rawPathKey('raw/a.md')).toBe(rawPathKey('raw/a.md'));
    expect(rawPathKey('raw/a.md')).not.toBe(rawPathKey('raw/b.md'));
  });

  it('批量 key 与文件选择顺序无关', () => {
    const a = fileContentKey(Buffer.from('A'));
    const b = fileContentKey(Buffer.from('B'));
    expect(batchContentKey([a, b])).toBe(batchContentKey([b, a]));
    expect(batchContentKey([a])).not.toBe(batchContentKey([a, b]));
  });
});

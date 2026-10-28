import crypto from 'node:crypto';

// T03591 编译幂等：按「内容指纹」去重进行中的编译请求。
//
// 语义（接口口径见 docs/dev/compile-retry-idempotency.md）：
// - running：同一内容正在编译 → 不新建任务，路由回放当前进度快照
// - done：已成功编译 → 由 CompileCache 回放原结果；本表只记标记
// - failed：允许重置后重新执行（这正是「重试」入口）
//
// 为什么放内存而非磁盘：幂等要挡住的是「并发/连续重复提交」。
// 进程重启后，成功任务由 CompileCache（内容哈希 → rawPath）继续回放；
// 失败任务本就该允许重跑。落盘反而要处理陈旧 running 记录，风险更高。
// 为什么单线程也谈并发：Map 的检查与占位在同一个同步 tick 内完成，
// 期间没有 await，Node 事件循环不会在中间插入另一个请求的检查。

// 进行中条目超过该时长视为「早已僵死」：不再拦截新请求（否则一次崩溃会永久挡住同内容编译）。
export const IDEMPOTENCY_TTL_MS = 30 * 60 * 1000;

export interface IdempotencySnapshot {
  state: 'running' | 'done' | 'failed';
  startedAt: number;
  // 最近一次进度事件（running 时回放给去重请求方）
  step?: string;
  message?: string;
  runId?: string;
}

export type BeginResult =
  | { kind: 'started'; token: number }
  | { kind: 'running'; snapshot: IdempotencySnapshot };

export class CompileIdempotency {
  private readonly entries = new Map<string, IdempotencySnapshot>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number = IDEMPOTENCY_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  // 占位：返回 started 表示本次请求获得执行权；running 表示同内容已在编译中。
  // done/failed 都允许重新执行（成功的会被 CompileCache 短路成缓存命中）。
  begin(key: string): BeginResult {
    const entry = this.read(key);
    if (entry?.state === 'running') {
      return { kind: 'running', snapshot: entry };
    }
    const token = this.now();
    this.entries.set(key, { state: 'running', startedAt: token });
    return { kind: 'started', token };
  }

  // 进度同步：让后来的去重请求能看到「当前在哪一步」，而不是只有一句「正在编译」。
  touch(key: string, progress: { step?: string; message?: string; runId?: string }): void {
    const entry = this.entries.get(key);
    if (!entry || entry.state !== 'running') return;
    if (progress.step !== undefined) entry.step = progress.step;
    if (progress.message !== undefined) entry.message = progress.message;
    if (progress.runId !== undefined) entry.runId = progress.runId;
  }

  // 收口：只有「本次占位仍然有效」时才写终态，避免过期重入的旧任务覆盖新任务状态。
  finish(key: string, token: number, outcome: { status: 'done' | 'failed'; message?: string; runId?: string }): void {
    const entry = this.entries.get(key);
    if (!entry || entry.state !== 'running' || entry.startedAt !== token) return;
    this.entries.set(key, {
      state: outcome.status,
      startedAt: entry.startedAt,
      step: entry.step,
      message: outcome.message ?? entry.message,
      runId: outcome.runId ?? entry.runId,
    });
  }

  peek(key: string): IdempotencySnapshot | undefined {
    return this.read(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private read(key: string): IdempotencySnapshot | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.startedAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}

// 幂等 Key 生成规则（写进接口文档，改动需同步 docs/dev/compile-retry-idempotency.md）：
//   单文件：sha256(上传字节)            取前 32 位十六进制
//   文本/URL：sha256(type + '\0' + 内容) 取前 32 位
//   重试：sha256('retry' + '\0' + rawPath) 取前 32 位（rawPath 即存档文件的唯一标识）
//   批量：对每个文件的 key 升序排序后再 sha256 取前 32 位（与选择顺序无关）
// 为什么取前 32 位：与 CompileCache（16 位）同思路，碰撞概率可忽略且便于日志比对。
const KEY_LENGTH = 32;

export function fileContentKey(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, KEY_LENGTH);
}

export function textContentKey(type: string, content: string): string {
  return crypto.createHash('sha256').update(`${type}\u0000${content}`, 'utf8').digest('hex').slice(0, KEY_LENGTH);
}

// 重试按 rawPath 去重：路由层不读 vault，拿不到正文；
// 而 raw/<name> 本身就是「当前存档的那份内容」的唯一标识（同名覆盖写）。
export function rawPathKey(rawPath: string): string {
  return textContentKey('retry', rawPath);
}

export function batchContentKey(fileKeys: string[]): string {
  return crypto
    .createHash('sha256')
    .update([...fileKeys].sort().join('\u0000'), 'utf8')
    .digest('hex')
    .slice(0, KEY_LENGTH);
}

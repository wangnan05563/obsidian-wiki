// T02466（PRD R-F2 / H2）体检批量修复作业管理器。
//
// 解决的问题：原实现把批量修复绑死在单次 SSE 请求上——关页/刷新即断，且断开后
// 后端只是「不再推送」，任务状态完全丢失：用户回来既看不到进度，也不知道哪些已修完，
// 只能整批重跑（重复调用 LLM、重复写 vault）。同时确认弹窗只有「可能耗时较长」一句话，
// 无法预判成本。
//
// 设计（沿用 stream-run-manager 的「运行与请求生命周期解耦」思路，不重写流式机制）：
//   - 一次批量修复 = 一个 jobId 拥有的后台作业，事件带单调序号写入环形缓冲并扇出给订阅者；
//   - 每个问题结束后把快照落盘（jobsDir/<jobId>.json），刷新页面/重启进程都能恢复；
//   - 暂停 = 当前问题跑完后停止并释放编译锁；继续 = 从 nextIndex 起把剩余问题重新入队；
//     取消 = 当前问题跑完后终止，已完成项保留（不做「回滚」承诺）；
//   - 真实耗时样本持久化在 jobsDir/stats.json，供启动前量化估算（明确标注为估算）。
//
// vault 写入纪律不变：整批仍包在 withCompileLock 内串行，与 compile 互斥。

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withCompileLock } from '../compile-queue.js';
import type { EngineAdapter, FixInput } from '../types.js';

// 作业状态。暂停请求不单独建状态：用 pauseRequested 标记，当前问题跑完落 paused。
export type BatchFixStatus = 'running' | 'paused' | 'canceled' | 'completed';

export interface BatchFixEvent {
  seq: number;
  event: string;
  data: unknown;
}

export interface BatchFixFailedItem {
  issueKey: string;
  message: string;
}

// 单个待修复项：稳定 key（前端生成，如 orphan:foo.md）+ 修复入参
export interface BatchFixItem {
  issueKey: string;
  input: FixInput;
}

// 快照 = 落盘内容 = 对外可见的作业状态
export interface BatchFixSnapshot {
  jobId: string;
  status: BatchFixStatus;
  total: number;
  doneCount: number;
  successCount: number;
  failCount: number;
  currentIssueKey: string;
  pauseRequested: boolean;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  avgMsPerIssue: number;
  doneKeys: string[];
  failed: BatchFixFailedItem[];
  items: BatchFixItem[];
  // 下一个待处理下标：恢复运行时从该位置继续（之前的项已修完或已判失败）
  nextIndex: number;
}

// 订阅端（由路由用 createSSESender 适配）
export interface BatchFixSink {
  onEvent(event: string, data: unknown, seq: number): void;
  isAborted(): boolean;
  end(): void;
}

export interface EstimateResult {
  count: number;
  llmCalls: number;
  avgMsPerIssue: number;
  samples: number;
  estimatedMs: number;
  estimatedMinutes: number;
  basis: 'measured' | 'default';
}

interface DurationStats {
  samples: number;
  totalMs: number;
  avgMs: number;
}

interface JobEntry {
  snapshot: BatchFixSnapshot;
  buffer: BatchFixEvent[];
  seq: number;
  subscribers: Set<BatchFixSink>;
  stopRequested: boolean;
  stopKind: 'pause' | 'cancel';
}

// 环形缓冲上限：597 项 × 多步事件量很大，只保留尾部用于断线重连回放；
// 完整状态以快照（doneKeys/failed/nextIndex）为准，不依赖缓冲。
const MAX_BUFFER_EVENTS = 400;
// 快照文件保留期：超过即回收，避免 .harness 目录无限增长
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 无历史样本时的单题耗时兜底值（响应里以 basis='default' 显式标注）
const FALLBACK_AVG_MS = 45_000;

function emptyStats(): DurationStats {
  return { samples: 0, totalMs: 0, avgMs: FALLBACK_AVG_MS };
}

function isTerminal(status: BatchFixStatus): boolean {
  return status === 'canceled' || status === 'completed';
}

export class BatchFixJobManager {
  private readonly jobsDir: string;
  private readonly statsFile: string;
  private readonly adapter: EngineAdapter;
  private readonly jobs = new Map<string, JobEntry>();
  // 串行落盘：同一 job 的并发写入互相覆盖，排队保证后写生效
  private writeChain: Promise<void> = Promise.resolve();

  constructor(jobsDir: string, adapter: EngineAdapter) {
    this.jobsDir = jobsDir;
    this.statsFile = path.join(jobsDir, 'stats.json');
    this.adapter = adapter;
  }

  /** 启动一次批量修复：立即返回快照，实际执行在后台排队（withCompileLock 与 compile 互斥）。 */
  async start(items: BatchFixItem[]): Promise<BatchFixSnapshot> {
    const now = Date.now();
    const snapshot: BatchFixSnapshot = {
      jobId: randomUUID(),
      status: 'running',
      total: items.length,
      doneCount: 0,
      successCount: 0,
      failCount: 0,
      currentIssueKey: '',
      pauseRequested: false,
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      avgMsPerIssue: (await this.readStats()).avgMs,
      doneKeys: [],
      failed: [],
      items,
      nextIndex: 0,
    };
    const entry: JobEntry = {
      snapshot,
      buffer: [],
      seq: 0,
      subscribers: new Set(),
      stopRequested: false,
      stopKind: 'pause',
    };
    this.jobs.set(snapshot.jobId, entry);
    await this.pruneOldSnapshots();
    this.emit(entry, 'batch_start', { jobId: snapshot.jobId, totalIssues: snapshot.total });
    await this.persist(entry);
    void this.runLoop(entry).catch(() => undefined);
    return snapshot;
  }

  /**
   * 继续一个 paused/canceled 作业：从 nextIndex 起把剩余问题重新入队。
   * canceled 也允许继续——取消后反悔是常见路径，且已完成项本就不受影响。
   */
  async resume(jobId: string): Promise<BatchFixSnapshot | null> {
    const entry = await this.ensureLoaded(jobId);
    if (!entry) return null;
    const snap = entry.snapshot;
    if (snap.status === 'running' || snap.nextIndex >= snap.total) {
      if (snap.nextIndex >= snap.total && snap.status !== 'completed') snap.status = 'completed';
      await this.persist(entry);
      return snap;
    }
    snap.status = 'running';
    snap.pauseRequested = false;
    snap.startedAt = Date.now() - snap.elapsedMs;
    entry.stopRequested = false;
    this.emit(entry, 'batch_resume', {
      jobId,
      resumeFrom: snap.nextIndex,
      remaining: snap.total - snap.nextIndex,
    });
    await this.persist(entry);
    void this.runLoop(entry).catch(() => undefined);
    return snap;
  }

  /** 暂停：当前问题跑完后停下。FixInput 无 signal，无法中断进行中的 LLM 调用，故如实标注「等待当前项完成」。 */
  async pause(jobId: string): Promise<BatchFixSnapshot | null> {
    return this.requestStop(jobId, 'pause');
  }

  /** 取消：语义同暂停，但落 canceled 态；已完成项保留。 */
  async cancel(jobId: string): Promise<BatchFixSnapshot | null> {
    return this.requestStop(jobId, 'cancel');
  }

  /** 内存中的作业快照（不读盘）。 */
  get(jobId: string): BatchFixSnapshot | null {
    return this.jobs.get(jobId)?.snapshot ?? null;
  }

  /** 取快照：内存优先，回落磁盘（进程重启后仍可查）。 */
  async getSnapshot(jobId: string): Promise<BatchFixSnapshot | null> {
    const entry = await this.ensureLoaded(jobId);
    return entry?.snapshot ?? null;
  }

  /** 最近一次作业（供页面刷新/重进时恢复进度面板）。 */
  async latest(): Promise<BatchFixSnapshot | null> {
    const inMemory = [...this.jobs.values()].sort(
      (a, b) => b.snapshot.updatedAt - a.snapshot.updatedAt,
    )[0];
    if (inMemory) return inMemory.snapshot;
    const files = await this.listSnapshotFiles();
    const newest = files[0];
    if (!newest) return null;
    const loaded = await this.ensureLoaded(newest.jobId);
    return loaded?.snapshot ?? null;
  }

  /** 启动前量化估算：问题数 / LLM 调用次数 / 预计耗时（历史均值，估算非承诺）。 */
  async estimate(count: number): Promise<EstimateResult> {
    const stats = await this.readStats();
    const estimatedMs = Math.round(stats.avgMs * count);
    return {
      count,
      llmCalls: count,
      avgMsPerIssue: stats.avgMs,
      samples: stats.samples,
      estimatedMs,
      estimatedMinutes: Math.max(1, Math.round(estimatedMs / 60000)),
      basis: stats.samples > 0 ? 'measured' : 'default',
    };
  }

  /** 记录一次真实耗时（单个修复与批量修复共用），供下一次估算使用。 */
  async recordDuration(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const stats = await this.readStats();
    const samples = stats.samples + 1;
    const totalMs = stats.totalMs + ms;
    const next: DurationStats = { samples, totalMs, avgMs: Math.round(totalMs / samples) };
    try {
      await fs.mkdir(this.jobsDir, { recursive: true });
      await fs.writeFile(this.statsFile, JSON.stringify(next), 'utf8');
    } catch {
      // 统计写失败不影响业务，仅失去更准的估算
    }
  }

  /**
   * 订阅作业事件：先回放缓冲中 seq >= fromSeq 的事件，再挂为直播。
   * 作业已终态则回放后立即 end()，runLoop 结束时也会主动关闭订阅者。
   */
  subscribe(jobId: string, sink: BatchFixSink, fromSeq = 0): void {
    const entry = this.jobs.get(jobId);
    if (!entry) {
      sink.end();
      return;
    }
    for (const item of entry.buffer) {
      if (item.seq < fromSeq) continue;
      try {
        sink.onEvent(item.event, item.data, item.seq);
      } catch {
        return;
      }
    }
    if (isTerminal(entry.snapshot.status)) {
      sink.end();
      return;
    }
    entry.subscribers.add(sink);
  }

  /** 断开连接只退订，作业继续在后台跑（这正是「关页不静默中断」的语义）。 */
  unsubscribe(jobId: string, sink: BatchFixSink): void {
    this.jobs.get(jobId)?.subscribers.delete(sink);
  }

  private async requestStop(jobId: string, kind: 'pause' | 'cancel'): Promise<BatchFixSnapshot | null> {
    const entry = await this.ensureLoaded(jobId);
    if (!entry) return null;
    if (entry.snapshot.status !== 'running') return entry.snapshot;
    entry.stopRequested = true;
    entry.stopKind = kind;
    entry.snapshot.pauseRequested = true;
    this.emit(entry, 'batch_stop_requested', { jobId, kind });
    await this.persist(entry);
    return entry.snapshot;
  }

  private async runLoop(entry: JobEntry): Promise<void> {
    const snap = entry.snapshot;
    await withCompileLock(async () => {
      for (let i = snap.nextIndex; i < snap.items.length; i++) {
        if (entry.stopRequested) break;
        const item = snap.items[i];
        snap.currentIssueKey = item.issueKey;
        this.emit(entry, 'issue_start', {
          issueKey: item.issueKey,
          issueIndex: i,
          totalIssues: snap.total,
        });
        await this.fixOne(entry, item, i);
        snap.nextIndex = i + 1;
        snap.doneCount = snap.nextIndex;
        snap.elapsedMs = Date.now() - snap.startedAt;
        snap.currentIssueKey = '';
        await this.persist(entry);
        if (entry.stopRequested) break;
      }
    });
    this.finalize(entry);
    await this.persist(entry);
    this.closeSubscribers(entry);
  }

  // 收尾：按请求落 paused / canceled / completed 终态并广播对应事件
  private finalize(entry: JobEntry): void {
    const snap = entry.snapshot;
    snap.currentIssueKey = '';
    snap.pauseRequested = false;
    snap.elapsedMs = Date.now() - snap.startedAt;
    if (entry.stopRequested) {
      snap.status = entry.stopKind === 'cancel' ? 'canceled' : 'paused';
      const verb = snap.status === 'canceled' ? '已取消' : '已暂停';
      this.emit(entry, 'batch_stopped', {
        jobId: snap.jobId,
        status: snap.status,
        nextIndex: snap.nextIndex,
        remaining: snap.total - snap.nextIndex,
        message: `${verb}：已处理 ${snap.doneCount}/${snap.total}，已完成项保留`,
      });
      return;
    }
    snap.status = snap.nextIndex >= snap.total ? 'completed' : snap.status;
    if (snap.status === 'completed') {
      this.emit(entry, 'batch_done', {
        jobId: snap.jobId,
        step: 'done',
        status: 'done',
        totalIssues: snap.total,
        successCount: snap.successCount,
        failCount: snap.failCount,
        message: `批量修复完成：成功 ${snap.successCount}/${snap.total}，失败 ${snap.failCount}`,
      });
    }
  }

  // 修复单个问题：把 adapter.healthCheckFix 的事件包装为带定位信息的批量事件
  private async fixOne(entry: JobEntry, item: BatchFixItem, issueIndex: number): Promise<void> {
    const snap = entry.snapshot;
    const startedAt = Date.now();
    let succeeded = false;
    let errorMessage = '';
    let gotDoneEvent = false;
    try {
      for await (const ev of this.adapter.healthCheckFix(item.input)) {
        const wrapped = {
          ...ev,
          issueIndex,
          totalIssues: snap.total,
          issueKey: item.issueKey,
          issueDone: ev.step === 'done',
        };
        if (ev.step === 'done') {
          gotDoneEvent = true;
          succeeded = ev.status === 'done';
          errorMessage = succeeded ? '' : ev.message || '修复失败';
          this.emit(entry, succeeded ? 'issue_done' : 'issue_error', wrapped);
        } else {
          this.emit(entry, ev.step === 'fixed' ? 'fixed' : 'progress', wrapped);
        }
      }
    } catch (err: unknown) {
      succeeded = false;
      gotDoneEvent = true;
      errorMessage = err instanceof Error ? err.message : String(err);
      this.emit(entry, 'issue_error', {
        step: 'done',
        status: 'error',
        message: errorMessage,
        issueIndex,
        totalIssues: snap.total,
        issueKey: item.issueKey,
        issueDone: true,
      });
    }
    const ms = Date.now() - startedAt;
    if (!gotDoneEvent) errorMessage = '修复流提前结束（未收到完成事件）';
    if (succeeded) {
      snap.successCount++;
      snap.doneKeys.push(item.issueKey);
      await this.recordDuration(ms);
      snap.avgMsPerIssue = (await this.readStats()).avgMs;
    } else {
      snap.failCount++;
      snap.failed.push({ issueKey: item.issueKey, message: errorMessage });
    }
  }

  private emit(entry: JobEntry, event: string, data: unknown): void {
    entry.seq += 1;
    const item: BatchFixEvent = { seq: entry.seq, event, data };
    entry.buffer.push(item);
    if (entry.buffer.length > MAX_BUFFER_EVENTS) {
      entry.buffer.splice(0, entry.buffer.length - MAX_BUFFER_EVENTS);
    }
    for (const sink of entry.subscribers) {
      if (sink.isAborted()) {
        entry.subscribers.delete(sink);
        continue;
      }
      try {
        sink.onEvent(event, data, item.seq);
      } catch {
        entry.subscribers.delete(sink);
      }
    }
  }

  private closeSubscribers(entry: JobEntry): void {
    for (const sink of entry.subscribers) {
      try {
        sink.end();
      } catch {
        /* 流已销毁 */
      }
    }
    entry.subscribers.clear();
  }

  private async persist(entry: JobEntry): Promise<void> {
    entry.snapshot.updatedAt = Date.now();
    const filePath = path.join(this.jobsDir, `${entry.snapshot.jobId}.json`);
    const payload = JSON.stringify(entry.snapshot);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await fs.mkdir(this.jobsDir, { recursive: true });
        await fs.writeFile(filePath, payload, 'utf8');
      } catch {
        // 落盘失败仅失去「重启后恢复」能力，不影响本次修复
      }
    });
    await this.writeChain;
  }

  // 内存没有则从磁盘装载。重启前 running 的作业实际已中断：归一为 paused，由用户显式继续。
  private async ensureLoaded(jobId: string): Promise<JobEntry | null> {
    const existing = this.jobs.get(jobId);
    if (existing) return existing;
    try {
      const raw = await fs.readFile(path.join(this.jobsDir, `${jobId}.json`), 'utf8');
      const snapshot = JSON.parse(raw) as BatchFixSnapshot;
      if (snapshot.status === 'running') {
        snapshot.status = 'paused';
        snapshot.pauseRequested = false;
      }
      const entry: JobEntry = {
        snapshot,
        buffer: [],
        seq: 0,
        subscribers: new Set(),
        stopRequested: false,
        stopKind: 'pause',
      };
      this.jobs.set(jobId, entry);
      return entry;
    } catch {
      return null;
    }
  }

  private async listSnapshotFiles(): Promise<Array<{ jobId: string; file: string; mtimeMs: number }>> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.jobsDir);
    } catch {
      return [];
    }
    const out: Array<{ jobId: string; file: string; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'stats.json') continue;
      const file = path.join(this.jobsDir, name);
      try {
        const stat = await fs.stat(file);
        out.push({ jobId: name.replace(/\.json$/, ''), file, mtimeMs: stat.mtimeMs });
      } catch {
        /* 忽略无法访问的文件 */
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  private async pruneOldSnapshots(): Promise<void> {
    const files = await this.listSnapshotFiles();
    const now = Date.now();
    for (const f of files) {
      if (now - f.mtimeMs <= SNAPSHOT_TTL_MS) continue;
      try {
        await fs.rm(f.file, { force: true });
        this.jobs.delete(f.jobId);
      } catch {
        /* 删除失败下次再试 */
      }
    }
  }

  private async readStats(): Promise<DurationStats> {
    try {
      const raw = await fs.readFile(this.statsFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DurationStats>;
      if (typeof parsed.avgMs === 'number' && parsed.avgMs > 0) {
        return {
          samples: parsed.samples ?? 0,
          totalMs: parsed.totalMs ?? 0,
          avgMs: Math.round(parsed.avgMs),
        };
      }
    } catch {
      /* 首次运行尚无统计文件 */
    }
    return emptyStats();
  }
}

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
// T02922 成功口径裁决：流程跑完 ≠ 问题消解。每项流程成功后再做一次定点复检
// （adapter.recheckIssueResolved，确定性、零 LLM），未消解判 ineffective 单独计数，
// 不进 doneKeys；耗时样本改为「跑了 LLM 流程的项都计入」（成功/未消解/失败都消耗真实时间，
// 否则无效项不计样本会让估算越跑越乐观）。
//
// T02924 估算口径裁决：llmCalls 表示「预计模型往返次数」= count × 每项实测 harness step 数，
// 不再按 1 项 = 1 次写死（T02605 实测 3 项 17 步）。每个终端事件带 harnessSteps/tokens，
// 统计落 stats.json；兜底默认值来自同一次真实实测（115s / 5.7 步 / 17.2k tokens 每项）。
// 样本 <5 标 measured-low（页面提示仅供参考），≥5 标 measured；估算同时给出 ±1σ 区间。
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
  // 已消解数：流程成功且定点复检确认问题消失（doneKeys 与之一一对应）
  successCount: number;
  failCount: number;
  // T02922：流程跑完但定点复检未确认消解的项（与失败区分——LLM 没报错，只是问题还在）
  ineffectiveCount: number;
  ineffective: BatchFixFailedItem[];
  currentIssueKey: string;
  pauseRequested: boolean;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  avgMsPerIssue: number;
  // T02924：每项平均模型往返次数（实测样本不足时取标定默认值），页面据此显示实测口径
  avgStepsPerIssue: number;
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
  // T02924：预计模型往返次数 = count × 每项实测/默认 harness step 数（不是 1 项 1 次）
  llmCalls: number;
  avgStepsPerIssue: number;
  avgMsPerIssue: number;
  avgTokensPerIssue: number;
  // 预计 token 消耗 = count × 每项实测/默认 token 数
  tokens: number;
  samples: number;
  estimatedMs: number;
  estimatedMinMs: number;
  estimatedMaxMs: number;
  estimatedMinutes: number;
  // default = 无样本（用实测标定的兜底值）；measured-low = 1~4 个样本（仅供参考）；measured = ≥5
  basis: 'default' | 'measured-low' | 'measured';
}

interface DurationStats {
  samples: number;
  totalMs: number;
  avgMs: number;
  // 方差与极值：估算误差区间用（样本 ≥2 取 ±1σ）
  sumSqMs: number;
  minMs: number;
  maxMs: number;
  // 模型往返/token 只在终端事件带 usage 时累计，分母是带该字段的样本数（不是总样本数）
  stepSamples: number;
  totalSteps: number;
  avgSteps: number;
  tokenSamples: number;
  totalTokens: number;
  avgTokens: number;
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
// T02924：兜底默认值来自 T02605 真实 LLM 实测（3 项：均值 115,350ms/项、17 个 harness step、
// 51,602 tokens），取整后写入常量。旧值 45s / 1 次调用分别低估 2.6 倍 / 5.7 倍。
const FALLBACK_AVG_MS = 115_000;
const FALLBACK_STEPS_PER_ISSUE = 5.7;
const FALLBACK_TOKENS_PER_ISSUE = 17_200;
// 样本量阈值：<5 视为「样本不足，仅供参考」；≥5 判 measured
const MEASURED_SAMPLE_THRESHOLD = 5;
// 单样本无法量方差，用 ±50% 显式表达不确定性（明示规则，不是统计结论）
const SINGLE_SAMPLE_SPREAD = 0.5;

function emptyStats(): DurationStats {
  return {
    samples: 0,
    totalMs: 0,
    avgMs: FALLBACK_AVG_MS,
    sumSqMs: 0,
    minMs: 0,
    maxMs: 0,
    stepSamples: 0,
    totalSteps: 0,
    avgSteps: FALLBACK_STEPS_PER_ISSUE,
    tokenSamples: 0,
    totalTokens: 0,
    avgTokens: FALLBACK_TOKENS_PER_ISSUE,
  };
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
  // T02888：进程启动时的过期快照回收，公开成 Promise 供测试确定性等待
  readonly startupPrune: Promise<void>;

  constructor(jobsDir: string, adapter: EngineAdapter) {
    this.jobsDir = jobsDir;
    this.statsFile = path.join(jobsDir, 'stats.json');
    this.adapter = adapter;
    // T02888：快照回收原来只在下一次批量修复起跑时发生——用过一次就不再用的用户，
    // 终态快照会一直留在盘上，而清理页四类目标都不扫 batch-fix（看不到也删不掉）。
    // 快照是「断点续传/恢复」语义（与 run-state 同族），不并入清理删除面，
    // 改由管理器自己在启动时按同一 TTL 回收，不依赖用户再次使用该功能。
    this.startupPrune = this.pruneOldSnapshots().catch(() => undefined);
  }

  /** 启动一次批量修复：立即返回快照，实际执行在后台排队（withCompileLock 与 compile 互斥）。 */
  async start(items: BatchFixItem[]): Promise<BatchFixSnapshot> {
    const now = Date.now();
    const stats = await this.readStats();
    const snapshot: BatchFixSnapshot = {
      jobId: randomUUID(),
      status: 'running',
      total: items.length,
      doneCount: 0,
      successCount: 0,
      failCount: 0,
      ineffectiveCount: 0,
      ineffective: [],
      currentIssueKey: '',
      pauseRequested: false,
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      avgMsPerIssue: stats.avgMs,
      avgStepsPerIssue: Math.round(stats.avgSteps * 10) / 10,
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

  /**
   * 启动前量化估算（估算非承诺）：问题数 / 模型往返次数 / token / 耗时区间。
   * 口径见文件头 T02924：llmCalls = count × 每项实测 step 数；无样本时用实测标定的兜底值。
   */
  async estimate(count: number): Promise<EstimateResult> {
    const stats = await this.readStats();
    const mean = stats.avgMs;
    // 误差区间：样本 ≥2 且有二阶矩时用总体标准差 ±1σ；单样本与旧格式样本（无 sumSqMs）
    // 无法量方差，用固定 ±50% 明示不确定性，而不是报一个宽度为 0 的假精确区间
    const sigma =
      stats.samples >= 2 && stats.sumSqMs > 0
        ? Math.sqrt(Math.max(0, stats.sumSqMs / stats.samples - mean * mean))
        : mean * SINGLE_SAMPLE_SPREAD;
    const estimatedMs = Math.round(mean * count);
    const basis: EstimateResult['basis'] =
      stats.samples === 0
        ? 'default'
        : stats.samples < MEASURED_SAMPLE_THRESHOLD
          ? 'measured-low'
          : 'measured';
    return {
      count,
      llmCalls: Math.max(count, Math.round(count * stats.avgSteps)),
      avgStepsPerIssue: Math.round(stats.avgSteps * 10) / 10,
      avgMsPerIssue: mean,
      avgTokensPerIssue: Math.round(stats.avgTokens),
      tokens: Math.round(stats.avgTokens * count),
      samples: stats.samples,
      estimatedMs,
      estimatedMinMs: Math.max(0, Math.round((mean - sigma) * count)),
      estimatedMaxMs: Math.round((mean + sigma) * count),
      estimatedMinutes: Math.max(1, Math.round(estimatedMs / 60000)),
      basis,
    };
  }

  /**
   * 记录一次真实耗时（单个修复与批量修复共用），供下一次估算使用。
   * T02924：同时累计 harness step 数与 token；带 usage 的样本单独计分母，
   * 避免旧调用（只有耗时）把平均 step 数拉低。
   * 口径（T02922 裁决）：只要 LLM 流程跑过就记样本，成功/未消解/失败一视同仁——
   * 失败项同样消耗真实时间与调用，排除它们会让估算越跑越乐观。
   */
  async recordDuration(ms: number, usage: { steps?: number; tokens?: number } = {}): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const steps = Number.isFinite(usage.steps) && (usage.steps as number) > 0 ? Math.round(usage.steps as number) : 0;
    const tokens =
      Number.isFinite(usage.tokens) && (usage.tokens as number) > 0 ? Math.round(usage.tokens as number) : 0;
    // 与快照共用落盘队列：stats.json 是「读-改-写」，并发写会互相吞样本；
    // 原子 rename 另保证 readStats 不会读到半截 JSON（读到即样本清零，ETA 会莫名退回兜底值）。
    this.writeChain = this.writeChain.then(async () => {
      try {
        const stats = await this.readStats();
        const samples = stats.samples + 1;
        const totalMs = stats.totalMs + ms;
        const stepSamples = stats.stepSamples + (steps > 0 ? 1 : 0);
        const tokenSamples = stats.tokenSamples + (tokens > 0 ? 1 : 0);
        const next: DurationStats = {
          samples,
          totalMs,
          avgMs: Math.round(totalMs / samples),
          sumSqMs: stats.sumSqMs + ms * ms,
          minMs: samples === 1 ? ms : Math.min(stats.minMs || ms, ms),
          maxMs: samples === 1 ? ms : Math.max(stats.maxMs || ms, ms),
          stepSamples,
          totalSteps: stats.totalSteps + steps,
          avgSteps: stepSamples > 0 ? (stats.totalSteps + steps) / stepSamples : FALLBACK_STEPS_PER_ISSUE,
          tokenSamples,
          totalTokens: stats.totalTokens + tokens,
          avgTokens: tokenSamples > 0 ? (stats.totalTokens + tokens) / tokenSamples : FALLBACK_TOKENS_PER_ISSUE,
        };
        await this.writeAtomic(this.statsFile, JSON.stringify(next));
      } catch {
        // 统计写失败不影响业务，仅失去更准的估算
      }
    });
    await this.writeChain;
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
      // T02922：文案区分「已处理」与「已消解」——进度条 100% 只代表处理完，
      // 消解数才回答「问题还在不在」
      this.emit(entry, 'batch_done', {
        jobId: snap.jobId,
        step: 'done',
        status: 'done',
        totalIssues: snap.total,
        successCount: snap.successCount,
        failCount: snap.failCount,
        ineffectiveCount: snap.ineffectiveCount,
        message: `批量修复完成：已处理 ${snap.doneCount}/${snap.total}，消解 ${snap.successCount}，未消解 ${snap.ineffectiveCount}，失败 ${snap.failCount}`,
      });
    }
  }

  // 修复单个问题：把 adapter.healthCheckFix 的事件包装为带定位信息的批量事件。
  // T02922：流程成功的终态事件延后到定点复检之后——先裁定「消解/未消解」，
  // 再发 issue_done / issue_ineffective，保证「全部打绿」只代表问题真的消解了。
  private async fixOne(entry: JobEntry, item: BatchFixItem, issueIndex: number): Promise<void> {
    const snap = entry.snapshot;
    const startedAt = Date.now();
    let succeeded = false;
    let errorMessage = '';
    let doneMessage = '';
    let gotDoneEvent = false;
    // T02924：终端事件带出的实测往返步数/token（缺省 0 → 不计入 step/token 均值）
    let harnessSteps = 0;
    let tokens = 0;
    try {
      for await (const ev of this.adapter.healthCheckFix(item.input)) {
        if (ev.data?.harnessSteps !== undefined) harnessSteps = ev.data.harnessSteps;
        if (ev.data?.tokens !== undefined) tokens = ev.data.tokens;
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
          if (succeeded) doneMessage = ev.message;
          else {
            errorMessage = ev.message || '修复失败';
            this.emit(entry, 'issue_error', wrapped);
          }
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
        harnessSteps,
        tokens,
      });
    }
    // 下限钳 1ms：recordDuration 拒绝 <=0，而瞬时完成的桩流程 Date.now() 差可能为 0
    const ms = Math.max(1, Date.now() - startedAt);
    if (!gotDoneEvent) errorMessage = '修复流提前结束（未收到完成事件）';
    if (succeeded) {
      // 定点复检：确定性检查（零 LLM），裁定问题是否真的消解。
      // adapter 未实现复检时按消解降级（保持流程成功语义）；复检自身异常按未消解如实上报。
      let resolved = true;
      let recheckNote = '';
      try {
        resolved = (await this.adapter.recheckIssueResolved?.(item.input)) ?? true;
      } catch (err: unknown) {
        resolved = false;
        recheckNote = `复检失败: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (resolved) {
        snap.successCount++;
        snap.doneKeys.push(item.issueKey);
        this.emit(entry, 'issue_done', {
          step: 'done',
          status: 'done',
          message: doneMessage || '已修复',
          issueIndex,
          totalIssues: snap.total,
          issueKey: item.issueKey,
          issueDone: true,
          harnessSteps,
          tokens,
        });
      } else {
        snap.ineffectiveCount++;
        snap.ineffective.push({ issueKey: item.issueKey, message: recheckNote || '流程完成但问题未消解' });
        this.emit(entry, 'issue_ineffective', {
          step: 'done',
          status: 'done',
          message: recheckNote || '流程完成但问题未消解（已处理，需复核）',
          issueIndex,
          totalIssues: snap.total,
          issueKey: item.issueKey,
          issueDone: true,
          harnessSteps,
          tokens,
        });
      }
    } else {
      snap.failCount++;
      snap.failed.push({ issueKey: item.issueKey, message: errorMessage });
    }
    // 耗时样本口径：只要 LLM 流程跑过就计入（成功/未消解/失败都消耗真实时间），
    // 否则无效项白跑 LLM 却不计样本，估算会越跑越乐观。T02924：同时累计 step/token 样本。
    await this.recordDuration(ms, { steps: harnessSteps, tokens });
    const stats = await this.readStats();
    snap.avgMsPerIssue = stats.avgMs;
    snap.avgStepsPerIssue = Math.round(stats.avgSteps * 10) / 10;
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

  /**
   * 等待排队中的落盘全部完成。
   * 内存快照会先于磁盘可见（runLoop 里先改状态再 await persist），外部要「读文件」的调用方
   * （重启恢复、单测、优雅退出）必须先 flush，否则会读到上一份完整快照——本方法就是这个门。
   */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * 原子落盘：先写同目录临时文件再 rename。
   * T02478 P0 回归发现的缺陷：原先直接 fs.writeFile 就地截断重写，读取侧
   * （ensureLoaded / 单测直读快照文件）有概率拿到半截 JSON → JSON.parse 抛错，
   * 恢复链路会把「本可恢复的作业」误判为「快照不存在」，P0 H2「断线恢复」失真。
   * 临时文件名带 pid 且不以 .json 结尾，因此不会被 listSnapshotFiles 当成快照收进来。
   */
  private async writeAtomic(filePath: string, payload: string): Promise<void> {
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.mkdir(this.jobsDir, { recursive: true });
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, filePath);
  }

  private async persist(entry: JobEntry): Promise<void> {
    entry.snapshot.updatedAt = Date.now();
    const filePath = path.join(this.jobsDir, `${entry.snapshot.jobId}.json`);
    const payload = JSON.stringify(entry.snapshot);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.writeAtomic(filePath, payload);
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
      // 旧快照（T02922 之前落盘）没有这两个字段，补齐避免前端读到 undefined
      snapshot.ineffectiveCount ??= 0;
      snapshot.ineffective ??= [];
      // T02924：同理补齐 step 均值，旧作业面板不显示 undefined
      snapshot.avgStepsPerIssue ??= 0;
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

  // 公开给测试与启动路径（T02888）：按 TTL 回收过期快照与残留临时文件。
  async pruneOldSnapshots(): Promise<void> {
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
    // 原子写留下的临时文件（rename 前进程被杀才会残留）：同样按 TTL 回收，
    // 它们不参与 listSnapshotFiles（名字不以 .json 结尾），留着只会越攒越多。
    try {
      const names = await fs.readdir(this.jobsDir);
      for (const name of names) {
        if (!name.includes('.tmp')) continue;
        const file = path.join(this.jobsDir, name);
        try {
          const stat = await fs.stat(file);
          if (now - stat.mtimeMs <= SNAPSHOT_TTL_MS) continue;
          await fs.rm(file, { force: true });
        } catch {
          /* 忽略无法访问或已被 rename 的文件 */
        }
      }
    } catch {
      /* 目录尚不存在 */
    }
  }

  private async readStats(): Promise<DurationStats> {
    try {
      const raw = await fs.readFile(this.statsFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DurationStats>;
      if (typeof parsed.avgMs === 'number' && parsed.avgMs > 0) {
        const samples = parsed.samples ?? 0;
        const avgMs = Math.round(parsed.avgMs);
        // 兼容 T02924 之前的旧文件（只有 samples/totalMs/avgMs）：新维度回落标定默认值，
        // 旧样本没有 step/token，不参与它们的均值（分母为 0 → 用兜底值）。
        return {
          samples,
          totalMs: parsed.totalMs ?? avgMs * samples,
          avgMs,
          sumSqMs: parsed.sumSqMs ?? 0,
          minMs: parsed.minMs ?? avgMs,
          maxMs: parsed.maxMs ?? avgMs,
          stepSamples: parsed.stepSamples ?? 0,
          totalSteps: parsed.totalSteps ?? 0,
          avgSteps:
            typeof parsed.avgSteps === 'number' && parsed.avgSteps > 0
              ? parsed.avgSteps
              : FALLBACK_STEPS_PER_ISSUE,
          tokenSamples: parsed.tokenSamples ?? 0,
          totalTokens: parsed.totalTokens ?? 0,
          avgTokens:
            typeof parsed.avgTokens === 'number' && parsed.avgTokens > 0
              ? parsed.avgTokens
              : FALLBACK_TOKENS_PER_ISSUE,
        };
      }
    } catch {
      /* 首次运行尚无统计文件 */
    }
    return emptyStats();
  }
}

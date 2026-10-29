import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { FixProgressEvent, BatchFixProgressEvent, BatchDoneEvent, BatchFixJobSnapshot, BatchFixFailedItem } from '../types';

// 修复日志上限：597 项批量会产出上千条事件，无上限时长时间停留在本页会持续吃内存。
// 保留尾部即可满足「看最近在做什么」，完整结果以作业快照（doneKeys/failed）为准。
const MAX_FIX_LOGS = 300;

type BatchEventPayload = Partial<BatchFixProgressEvent> & Partial<BatchDoneEvent> & Record<string, unknown>;

function eventText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

// 体检中心 store：持久化批量修复作业与单个修复状态。
// 为什么需要 store：Health.vue 组件卸载后本地 ref 销毁，切回页面进度条丢失。
// T02466 起批量修复改为后端作业（jobId），本 store 是作业状态的前端镜像：
//   - 事件流只用于「直播刷新」，快照（/batch/current、/batch/:jobId）才是恢复口径；
//   - 因此组件卸载/刷新后重进页面，可以先 GET 快照再续订事件，进度不丢。
function batchOutcomeMessage(ev: BatchEventPayload, resolved: boolean, ineffective: boolean): string {
  if (ev.message != null) return String(ev.message);
  if (resolved) return '已修复';
  if (ineffective) return '未消解';
  return '修复失败';
}

export const useHealthStore = defineStore('health', () => {
  // 单个修复状态：fixingKey 标记当前正在修复的问题 key（格式：orphan:path 或 broken:key）
  const fixingKey = ref<string>('');

  // 批量修复作业快照（null 表示当前无作业）
  const job = ref<BatchFixJobSnapshot | null>(null);
  // 已完成 key 集合：由快照初始化 + 事件流增量维护，列表项据此高亮
  const batchDoneKeys = ref<Set<string>>(new Set());
  const batchFailed = ref<BatchFixFailedItem[]>([]);
  // T02922：流程跑完但复检未确认消解的项（与失败区分，列表项显示「未消解」）
  const batchIneffective = ref<BatchFixFailedItem[]>([]);

  // 修复进度日志（时间线展示，单个修复与批量修复共用）
  const fixLogs = ref<FixProgressEvent[]>([]);

  const batchFixing = computed(() => job.value?.status === 'running');
  const batchTotal = computed(() => job.value?.total ?? 0);
  const batchCurrent = computed(() => (job.value ? Math.min(job.value.doneCount + 1, job.value.total) : 0));
  const batchSuccessCount = computed(() => job.value?.successCount ?? 0);
  const batchFailCount = computed(() => job.value?.failCount ?? 0);
  // 未消解数：快照优先，事件流未回填快照时按本地列表长度兜底
  const batchIneffectiveCount = computed(() => job.value?.ineffectiveCount ?? batchIneffective.value.length);
  const batchElapsedMs = computed(() => {
    if (!job.value) return 0;
    // 运行中的耗时按「快照落盘时刻 + 之后经过的墙钟时间」外推，避免面板停在旧数字
    const base = job.value.elapsedMs;
    if (job.value.status !== 'running') return base;
    return base + Math.max(0, Date.now() - job.value.updatedAt);
  });
  const batchRemaining = computed(() => (job.value ? Math.max(0, job.value.total - job.value.doneCount) : 0));
  const batchEtaMs = computed(() => batchRemaining.value * (job.value?.avgMsPerIssue ?? 0));
  const batchProgress = computed(() => {
    if (!job.value || job.value.total === 0) return 0;
    return Math.round((job.value.doneCount / job.value.total) * 100);
  });

  // 是否禁用所有修复按钮：单个修复进行中 或 批量作业进行中
  const anyFixing = computed(() => fixingKey.value !== '' || batchFixing.value);

  // 用后端快照校准本地镜像（启动、恢复、终态后都调用）
  function applySnapshot(snapshot: BatchFixJobSnapshot | null) {
    job.value = snapshot;
    if (!snapshot) {
      batchDoneKeys.value = new Set();
      batchFailed.value = [];
      batchIneffective.value = [];
      return;
    }
    batchDoneKeys.value = new Set(snapshot.doneKeys);
    batchFailed.value = [...snapshot.failed];
    batchIneffective.value = [...(snapshot.ineffective ?? [])];
  }

  function clearJob() {
    job.value = null;
    batchDoneKeys.value = new Set();
    batchFailed.value = [];
    batchIneffective.value = [];
  }

  // 开始单个修复
  function startSingleFix(key: string) {
    fixingKey.value = key;
    fixLogs.value = [];
  }
  function endSingleFix() {
    fixingKey.value = '';
  }

  function pushFixLog(log: FixProgressEvent) {
    fixLogs.value.push(log);
    if (fixLogs.value.length > MAX_FIX_LOGS) {
      fixLogs.value.splice(0, fixLogs.value.length - MAX_FIX_LOGS);
    }
  }

  function clearLogs() {
    fixLogs.value = [];
  }

  // 处理批量作业 SSE 事件：只更新镜像状态，不含 UI 副作用（ElMessage 等由组件负责）
  function handleBatchEvent(
    eventType: string,
    parsed: BatchFixProgressEvent | BatchDoneEvent | Record<string, unknown>,
  ): void {
    const handler = BATCH_EVENT_HANDLERS[eventType];
    if (handler) handler(parsed as BatchEventPayload, eventType);
  }

  function startBatchJob(ev: BatchEventPayload): void {
    const total = Number(ev.totalIssues ?? 0);
    job.value = {
      jobId: eventText(ev.jobId),
      status: 'running',
      total,
      doneCount: 0,
      successCount: 0,
      failCount: 0,
      ineffectiveCount: 0,
      ineffective: [],
      currentIssueKey: '',
      pauseRequested: false,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      elapsedMs: 0,
      avgMsPerIssue: job.value?.avgMsPerIssue ?? 0,
      avgStepsPerIssue: job.value?.avgStepsPerIssue ?? 0,
      doneKeys: [],
      failed: [],
      nextIndex: 0,
    };
    batchDoneKeys.value = new Set();
    batchFailed.value = [];
    batchIneffective.value = [];
    fixLogs.value = [];
  }

  function resumeBatchJob(ev: BatchEventPayload): void {
    if (job.value) {
      job.value.status = 'running';
      job.value.pauseRequested = false;
    }
    pushFixLog({
      step: 'resume',
      status: 'running',
      message: `继续修复：从第 ${Number(ev.resumeFrom ?? 0) + 1} 项开始，剩余 ${Number(ev.remaining ?? 0)} 项`,
    });
  }

  function requestBatchStop(ev: BatchEventPayload): void {
    if (job.value) job.value.pauseRequested = true;
    pushFixLog({
      step: 'pause',
      status: 'running',
      message: ev.kind === 'cancel' ? '已请求取消：等待当前问题完成后停止' : '已请求暂停：等待当前问题完成后停下',
    });
  }

  function markIssueStart(ev: BatchEventPayload): void {
    if (job.value) job.value.currentIssueKey = eventText(ev.issueKey);
    pushFixLog({
      step: 'scan',
      status: 'running',
      message: `[${Number(ev.issueIndex ?? 0) + 1}/${Number(ev.totalIssues ?? 0)}] 开始处理 ${eventText(ev.issueKey)}`,
    });
  }

  function pushBatchProgress(ev: BatchEventPayload): void {
    pushFixLog({
      step: String(ev.step ?? 'progress'),
      status: (ev.status as FixProgressEvent['status']) ?? 'running',
      message: `[${Number(ev.issueIndex ?? 0) + 1}/${Number(ev.totalIssues ?? 0)}] ${ev.message ?? ''}`,
      tool: ev.tool,
      data: ev.data,
    });
  }

  function batchOutcomeStatus(resolved: boolean, ineffective: boolean): FixProgressEvent['status'] {
    if (resolved) return 'done';
    if (ineffective) return 'running';
    return 'error';
  }

  function finishIssue(ev: BatchEventPayload, eventType: string): void {
    const key = eventText(ev.issueKey);
    const resolved = eventType === 'issue_done';
    const ineffective = eventType === 'issue_ineffective';
    if (job.value) {
      job.value.doneCount = Math.min(job.value.doneCount + 1, job.value.total);
      job.value.currentIssueKey = '';
      if (resolved) job.value.successCount++;
      else if (ineffective) {
        job.value.ineffectiveCount++;
        const item: BatchFixFailedItem = { issueKey: key, message: ev.message || '流程完成但问题未消解' };
        batchIneffective.value.push(item);
        job.value.ineffective = [...batchIneffective.value];
      } else {
        job.value.failCount++;
        const item: BatchFixFailedItem = { issueKey: key, message: ev.message || '修复失败' };
        batchFailed.value.push(item);
        job.value.failed = [...batchFailed.value];
      }
      job.value.updatedAt = Date.now();
    }
    // doneKeys 语义与后端快照一致：只记「确认消解」的项（失败/未消解分别进 failed/ineffective）。
    // 若把其它项也计入，快照校准（GET /batch/:jobId）后高亮会莫名消失。
    if (resolved && key) batchDoneKeys.value.add(key);
    pushFixLog({
      step: 'done',
      status: batchOutcomeStatus(resolved, ineffective),
      message: `[${Number(ev.issueIndex ?? 0) + 1}/${Number(ev.totalIssues ?? 0)}] ${batchOutcomeMessage(ev, resolved, ineffective)}`,
      tool: ev.tool,
      data: ev.data,
    });
  }

  function completeBatchJob(ev: BatchEventPayload): void {
    if (job.value) {
      job.value.status = 'completed';
      job.value.pauseRequested = false;
      job.value.currentIssueKey = '';
      job.value.updatedAt = Date.now();
    }
    pushFixLog({ step: 'done', status: 'done', message: ev.message ?? '批量修复完成' });
  }

  function stopBatchJob(ev: BatchEventPayload): void {
    if (job.value) {
      // batch_stopped 载荷里的 status 是作业态（paused|canceled），
      // 与事件基类的 status（running|done|error）不同名同义，故按字符串判定
      job.value.status = String(ev.status) === 'canceled' ? 'canceled' : 'paused';
      job.value.pauseRequested = false;
      job.value.currentIssueKey = '';
      job.value.nextIndex = Number(ev.nextIndex ?? job.value.nextIndex);
      job.value.updatedAt = Date.now();
    }
    pushFixLog({ step: 'pause', status: 'done', message: ev.message ?? '批量修复已停止' });
  }

  function pushBatchError(ev: BatchEventPayload): void {
    pushFixLog({ step: 'done', status: 'error', message: ev.message ? String(ev.message) : '批量修复出错' });
  }

  const BATCH_EVENT_HANDLERS: Record<string, (ev: BatchEventPayload, eventType: string) => void> = {
    batch_start: startBatchJob,
    batch_resume: resumeBatchJob,
    batch_stop_requested: requestBatchStop,
    issue_start: markIssueStart,
    progress: pushBatchProgress,
    fixed: pushBatchProgress,
    issue_done: finishIssue,
    issue_error: finishIssue,
    issue_ineffective: finishIssue,
    batch_done: completeBatchJob,
    batch_stopped: stopBatchJob,
    error: pushBatchError,
  };

  return {
    fixingKey,
    fixLogs,
    job,
    batchDoneKeys,
    batchFailed,
    batchIneffective,
    batchFixing,
    batchTotal,
    batchCurrent,
    batchSuccessCount,
    batchFailCount,
    batchIneffectiveCount,
    batchElapsedMs,
    batchRemaining,
    batchEtaMs,
    batchProgress,
    anyFixing,
    applySnapshot,
    clearJob,
    startSingleFix,
    endSingleFix,
    pushFixLog,
    clearLogs,
    handleBatchEvent,
  };
});

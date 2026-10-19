<script setup lang="ts">
// 体检中心（T02466 / PRD M6 6.1 R-F1 + R-F2）
// ------------------------------------------------------------------
// 本轮改造解决两件事：
//   R-F1 列表治理：597 项逐行渲染、无搜索、无折叠、无多选，且把「不能自动修复」的
//     过期页与可修复项混在同一个报警数里。现改为统一行模型（utils/healthList）+
//     每类 Top-N 折叠/分页 + 关键字搜索 + 按目录聚合 + 跨类多选汇总。
//   R-F2 批量修复作业化：原先 POST 一条 SSE 跑完整批，刷新即失联、无法暂停取消、
//     确认框只有「可能耗时较长」。现改为后端 jobId 作业 + 快照恢复 + 事件订阅 +
//     暂停/继续/取消 + 启动前量化估算（问题数 / LLM 调用次数 / 预计耗时，标注估算依据）。
// 列表建模与选择计算全部走纯函数，行渲染收敛到 HealthIssueList，本文件只做编排。
import { API_BASE, apiFetch } from '../utils/apiBase';
import { ref, reactive, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { ElMessage } from 'element-plus';
import {
  Warning,
  CircleCheck,
  MagicStick,
  RefreshRight,
  Lightning,
  Check,
  VideoPause,
  VideoPlay,
  CircleClose,
} from '@element-plus/icons-vue';
import IconActionButton from '../components/IconActionButton.vue';
import AppModal from '../components/AppModal.vue';
import HealthIssueList from '../components/HealthIssueList.vue';
import type {
  HealthReport,
  FixRequest,
  FixProgressEvent,
  BatchFixJobSnapshot,
  BatchFixEstimate,
  BatchFixProgressEvent,
  BatchDoneEvent,
} from '../types';
import { apiErrorMessage } from '../utils/apiError';
import { useHealthStore } from '../stores/health';
import {
  buildIssueRows,
  filterRows,
  rowsOfKind,
  groupRowsByDir,
  takeVisible,
  splitByActionable,
  buildFixPayloadFromSelection,
  selectionBreakdown,
  formatDuration,
  formatElapsed,
} from '../utils/healthList';
import type { IssueKind, IssueRow } from '../utils/healthList';

// 默认折叠条数与「加载更多」步长：首屏每类只渲染 20 条，展开后每次再补 200 条，
// 避免 597 行一次性进 DOM（原实现卡顿的根因）。
const TOP_N = 20;
const PAGE_STEP = 200;
const SHOW_ALL = Number.MAX_SAFE_INTEGER;
// 订阅时跳过历史回放：恢复口径是快照（GET /fix/batch/:jobId），事件流只做增量刷新。
// 回放已计入快照的事件会让 doneCount 重复累加。
const REPLAY_NONE = Number.MAX_SAFE_INTEGER;

// 订阅句柄放在模块级：切换菜单会卸载本组件，但作业仍在后台跑。
// 重进页面若再订阅一次，同一批事件会被计数两遍，故用模块级句柄去重。
let jobSubscription: { jobId: string; controller: AbortController } | null = null;

const healthStore = useHealthStore();
const {
  fixingKey,
  fixLogs,
  job,
  batchDoneKeys,
  batchFailed,
  batchFixing,
  batchTotal,
  batchCurrent,
  batchSuccessCount,
  batchFailCount,
  batchElapsedMs,
  batchEtaMs,
  batchRemaining,
  batchProgress,
  anyFixing,
} = storeToRefs(healthStore);

// report 与列表交互态为组件本地状态：体检报告每次进入页面需刷新
const report = ref<HealthReport | null>(null);
const loading = ref(false);
const keyword = ref('');
const groupByDir = ref(false);
const selected = ref<Set<string>>(new Set());
// 每类问题各自的可见上限（折叠 / 加载更多 / 全部）
const limits = reactive<Record<IssueKind, number>>({
  orphan: TOP_N,
  broken: TOP_N,
  stale: TOP_N,
  knowledge_stale: TOP_N,
});

// ===== 列表建模 =====

const allRows = computed<IssueRow[]>(() => (report.value ? buildIssueRows(report.value) : []));
const searchRows = computed(() => filterRows(allRows.value, keyword.value));
const split = computed(() => splitByActionable(allRows.value));
const totalIssues = computed(() => split.value.total);
const fixableTotal = computed(() => split.value.autoFixable);
const healthStatus = computed<'healthy' | 'warning'>(() =>
  totalIssues.value === 0 ? 'healthy' : 'warning',
);

// 行在批量作业里的状态：失败覆盖成功（同一 key 重试失败后不应仍显示「已处理」）
const jobStates = computed<Record<string, 'done' | 'failed'>>(() => {
  const out: Record<string, 'done' | 'failed'> = {};
  for (const key of batchDoneKeys.value) out[key] = 'done';
  for (const f of batchFailed.value) out[f.issueKey] = 'failed';
  return out;
});

interface SectionMeta {
  kind: IssueKind;
  title: string;
  icon: string;
  iconClass: string;
  desc: string;
  emptyText: string;
  reviewAction?: boolean;
}

// 4 类问题共用一套渲染与交互（原实现每类手写一段模板，改一处漏三处）
const SECTIONS: SectionMeta[] = [
  {
    kind: 'orphan',
    title: '孤立页面',
    icon: '◈',
    iconClass: 'icon-orphan',
    desc: '没有任何页面通过 [[链接]] 指向它们 · 可自动补回链',
    emptyText: '▸ 无孤立页面',
  },
  {
    kind: 'broken',
    title: '断开链接',
    icon: '⟶',
    iconClass: 'icon-broken',
    desc: '指向不存在页面的 [[链接]] · 可自动创建目标页或改写链接',
    emptyText: '▸ 无断链',
  },
  {
    kind: 'stale',
    title: '过期页面',
    icon: '⏱',
    iconClass: 'icon-stale',
    desc: '长时间未更新的页面（默认 30 天）· 需人工判断，不参与批量修复',
    emptyText: '▸ 无过期页面',
  },
  {
    kind: 'knowledge_stale',
    title: '知识时效复核',
    icon: '◉',
    iconClass: 'icon-review',
    desc: 'knowledge_class=dated 且超过知识时效阈值的页面，复核后追加 reviewed_at 恢复为时效正常',
    emptyText: '▸ 无知识时效过期页面',
    reviewAction: true,
  },
];

interface DirGroup {
  dir: string;
  visible: IssueRow[];
  hiddenCount: number;
}

interface SectionView {
  meta: SectionMeta;
  count: number;
  fixableCount: number;
  groups: DirGroup[] | null;
  visible: IssueRow[];
  hiddenCount: number;
  allSelected: boolean;
}

// 目录聚合下按「每个目录 Top-N」折叠：597 项聚成目录视图后渲染量仍可控
function buildGroups(rows: IssueRow[], limit: number): { groups: DirGroup[]; visible: IssueRow[]; hidden: number } {
  const groups = groupRowsByDir(rows).map((g) => {
    const slice = takeVisible(g.rows, limit, false);
    return { dir: g.dir, visible: slice.visible, hiddenCount: slice.hiddenCount };
  });
  const visible = groups.reduce<IssueRow[]>((acc, g) => acc.concat(g.visible), []);
  const hidden = groups.reduce((acc, g) => acc + g.hiddenCount, 0);
  return { groups, visible, hidden };
}

const sectionViews = computed<SectionView[]>(() =>
  SECTIONS.map((meta) => {
    const rows = rowsOfKind(searchRows.value, meta.kind);
    const limit = limits[meta.kind];
    const fixableCount = rows.filter((r) => r.fixable).length;
    let visible: IssueRow[] = [];
    let hiddenCount = 0;
    let groups: DirGroup[] | null = null;
    if (groupByDir.value) {
      const built = buildGroups(rows, limit);
      groups = built.groups;
      visible = built.visible;
      hiddenCount = built.hidden;
    } else {
      const slice = takeVisible(rows, limit, false);
      visible = slice.visible;
      hiddenCount = slice.hiddenCount;
    }
    const selectedFixable = rows.filter((r) => r.fixable && selected.value.has(r.key)).length;
    return {
      meta,
      count: rows.length,
      fixableCount,
      groups,
      visible,
      hiddenCount,
      allSelected: fixableCount > 0 && selectedFixable === fixableCount,
    };
  }),
);

// ===== 选择与折叠 =====

function toggleRow(key: string): void {
  const next = new Set(selected.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selected.value = next;
}

function toggleKind(kind: IssueKind, checked: boolean): void {
  const next = new Set(selected.value);
  for (const row of rowsOfKind(searchRows.value, kind)) {
    if (!row.fixable) continue;
    if (checked) next.add(row.key);
    else next.delete(row.key);
  }
  selected.value = next;
}

function selectAllFixable(): void {
  selected.value = new Set(allRows.value.filter((r) => r.fixable).map((r) => r.key));
}

function clearSelection(): void {
  selected.value = new Set();
}

const selectionSummary = computed(() => selectionBreakdown(allRows.value, selected.value));

function expandKind(kind: IssueKind): void {
  limits[kind] = SHOW_ALL;
}

function loadMore(kind: IssueKind): void {
  limits[kind] += PAGE_STEP;
}

function collapseKind(kind: IssueKind): void {
  limits[kind] = TOP_N;
}

function isExpanded(kind: IssueKind): boolean {
  return limits[kind] === SHOW_ALL;
}

// ===== 启动前量化估算 + 确认 =====

const estimateVisible = ref(false);
const estimateLoading = ref(false);
const estimate = ref<BatchFixEstimate | null>(null);
const pendingPayload = ref<{ items: FixRequest[]; issueKeys: string[] } | null>(null);
const starting = ref(false);

const estimateBasisText = computed(() => {
  const e = estimate.value;
  if (!e) return '';
  if (e.basis === 'measured') {
    return `估算依据：最近 ${e.samples} 次实测均值 ${formatDuration(e.avgMsPerIssue)}/项`;
  }
  return '估算依据：尚无实测样本，按默认单题耗时估算';
});

async function openEstimate(sel: Set<string>): Promise<void> {
  if (anyFixing.value) return;
  const payload = buildFixPayloadFromSelection(allRows.value, sel);
  if (payload.items.length === 0) {
    ElMessage.info('当前范围没有可自动修复的问题');
    return;
  }
  pendingPayload.value = payload;
  estimate.value = null;
  estimateVisible.value = true;
  estimateLoading.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/health-check/fix/batch/estimate?count=${payload.items.length}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    estimate.value = (await res.json()) as BatchFixEstimate;
  } catch (err) {
    ElMessage.error(apiErrorMessage('估算失败', err));
    estimateVisible.value = false;
  } finally {
    estimateLoading.value = false;
  }
}

function batchAll(): void {
  selectAllFixable();
  void openEstimate(selected.value);
}

async function confirmStartBatch(): Promise<void> {
  const payload = pendingPayload.value;
  if (!payload || starting.value) return;
  starting.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/health-check/fix/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const accepted = (await res.json()) as { jobId: string; total: number };
    estimateVisible.value = false;
    clearSelection();
    ElMessage.success(`批量修复作业已启动（共 ${accepted.total} 项），可以离开本页`);
    await refreshSnapshot(accepted.jobId);
    void subscribeJob(accepted.jobId);
  } catch (err) {
    ElMessage.error(apiErrorMessage('批量修复启动失败', err));
  } finally {
    starting.value = false;
    pendingPayload.value = null;
  }
}

// ===== 作业快照 + 事件订阅 =====

async function readSnapshot(url: string): Promise<BatchFixJobSnapshot | null> {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as BatchFixJobSnapshot | null;
}

async function refreshSnapshot(jobId: string): Promise<void> {
  try {
    healthStore.applySnapshot(await readSnapshot(`${API_BASE}/health-check/fix/batch/${jobId}`));
  } catch (err) {
    ElMessage.error(apiErrorMessage('作业状态读取失败', err));
  }
}

// 页面刷新/重进后恢复进度：快照是唯一恢复口径，事件流只做增量刷新
async function restoreJob(): Promise<void> {
  try {
    const snapshot = await readSnapshot(`${API_BASE}/health-check/fix/batch/current`);
    if (!snapshot) return;
    healthStore.applySnapshot(snapshot);
    if (snapshot.status === 'running') void subscribeJob(snapshot.jobId);
  } catch {
    // 恢复失败不影响体检本身
  }
}

async function subscribeJob(jobId: string): Promise<void> {
  if (jobSubscription?.jobId === jobId) return;
  jobSubscription?.controller.abort();
  const controller = new AbortController();
  jobSubscription = { jobId, controller };
  try {
    const res = await apiFetch(
      `${API_BASE}/health-check/fix/batch/${jobId}/events?fromSeq=${REPLAY_NONE}`,
      { signal: controller.signal },
    );
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await streamJobEvents(res.body);
  } catch (err) {
    if (!controller.signal.aborted) ElMessage.error(apiErrorMessage('作业事件订阅失败', err));
  } finally {
    const replaced = jobSubscription?.jobId !== jobId;
    if (!replaced && !controller.signal.aborted) {
      jobSubscription = null;
      // 流结束（作业终态或服务端关闭）→ 用快照校准，消除事件窗口的计数漂移
      await refreshSnapshot(jobId);
    }
  }
}

// 从 SSE 事件块解析 event/data 字段，返回 null 表示无效事件
function parseSSEEvent(evt: string): { eventType: string; data: string } | null {
  let eventType = '';
  let data = '';
  for (const line of evt.split('\n')) {
    if (line.startsWith('event: ')) eventType = line.slice(7);
    if (line.startsWith('data: ')) data = line.slice(6);
  }
  if (!eventType || !data) return null;
  return { eventType, data };
}

async function streamJobEvents(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const evt of events) {
      const parsed = parseSSEEvent(evt);
      if (!parsed) continue;
      let data: unknown = null;
      try {
        data = JSON.parse(parsed.data);
      } catch {
        continue;
      }
      healthStore.handleBatchEvent(
        parsed.eventType,
        data as BatchFixProgressEvent | BatchDoneEvent | Record<string, unknown>,
      );
      if (parsed.eventType === 'batch_done' || parsed.eventType === 'batch_stopped') {
        ElMessage.success((data as { message?: string })?.message || '批量修复已停止');
      }
    }
  }
}

async function controlJob(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  const current = job.value;
  if (!current) return;
  const jobId = current.jobId;
  try {
    const res = await apiFetch(`${API_BASE}/health-check/fix/batch/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    healthStore.applySnapshot((await res.json()) as BatchFixJobSnapshot);
    if (action === 'pause') ElMessage.info('已请求暂停：当前问题完成后停下');
    if (action === 'cancel') ElMessage.warning('已请求取消：当前问题完成后停止，已完成项保留');
    if (action === 'resume') void subscribeJob(jobId);
  } catch (err) {
    ElMessage.error(apiErrorMessage('作业控制失败', err));
  }
}

function dismissJob(): void {
  healthStore.clearJob();
  healthStore.clearLogs();
}

function retryFailed(): void {
  void openEstimate(new Set(batchFailed.value.map((f) => f.issueKey)));
}

const jobStatusText = computed(() => {
  const current = job.value;
  if (!current) return '';
  if (current.status === 'running') return current.pauseRequested ? '停止请求已受理' : '修复中';
  if (current.status === 'paused') return '已暂停';
  if (current.status === 'canceled') return '已取消';
  return '已完成';
});

// ===== 体检与单个修复 =====

// 执行体检。选择集按最新报告裁剪：上一轮已修掉的问题不再出现在本次报告里，
// 若不清理，「批量修复选中」会把已不存在的问题再次提交给 LLM。
async function runCheck(): Promise<void> {
  loading.value = true;
  report.value = null;
  try {
    const res = await apiFetch(`${API_BASE}/health-check`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    report.value = (await res.json()) as HealthReport;
    const liveKeys = new Set(allRows.value.map((r) => r.key));
    selected.value = new Set([...selected.value].filter((k) => liveKeys.has(k)));
  } catch (err) {
    ElMessage.error(apiErrorMessage('体检失败', err));
  } finally {
    loading.value = false;
  }
}

// FR-18 AC-18-4：一键复核全部知识时效过期页面（确定性 frontmatter 写，不走 LLM/SSE）
const reviewing = ref(false);
async function reviewKnowledgeStale(): Promise<void> {
  const items = report.value?.knowledgeStale ?? [];
  if (items.length === 0 || reviewing.value) return;
  reviewing.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/health-check/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: items }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    ElMessage.success((result as { message?: string })?.message || `已复核 ${items.length} 个页面`);
    await runCheck();
  } catch (err) {
    ElMessage.error(apiErrorMessage('复核失败', err));
  } finally {
    reviewing.value = false;
  }
}

// 单个修复：仍走 SSE（一次 LLM 调用，无需后台作业）
async function fixIssue(row: IssueRow): Promise<void> {
  if (row.fixTarget === undefined) return;
  healthStore.startSingleFix(row.key);
  const payload: FixRequest = {
    issueType: row.kind === 'orphan' ? 'orphan' : 'broken_link',
    target: row.fixTarget,
  };
  try {
    const res = await apiFetch(`${API_BASE}/health-check/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await streamSingleFix(res.body);
  } catch (err) {
    ElMessage.error(apiErrorMessage('修复请求失败', err));
  } finally {
    healthStore.endSingleFix();
  }
}

async function streamSingleFix(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const evt of events) {
      const parsed = parseSSEEvent(evt);
      if (!parsed) continue;
      await handleFixEvent(parsed.eventType, parsed.data);
    }
  }
}

async function handleFixEvent(eventType: string, data: string): Promise<void> {
  let parsed: FixProgressEvent;
  try {
    parsed = JSON.parse(data) as FixProgressEvent;
  } catch {
    return;
  }
  if (eventType === 'progress' || eventType === 'fixed') {
    healthStore.pushFixLog(parsed);
    return;
  }
  if (eventType === 'done') {
    healthStore.pushFixLog(parsed);
    if (parsed.status === 'done') {
      ElMessage.success('修复完成');
      await runCheck();
    } else {
      ElMessage.error(parsed.message || '修复失败');
    }
    return;
  }
  if (eventType === 'error') {
    ElMessage.error(parsed.message || '修复出错');
  }
}

onMounted(() => {
  void runCheck();
  void restoreJob();
});
</script>

<template>
  <div class="health-page">
    <div class="glass-card health-card">
      <!-- 不对称装饰块：旋转品红渐变 -->
      <div class="card-deco"></div>

      <div class="health-head">
        <div class="head-text">
          <h2 class="head-title grad-text">体检中心</h2>
          <p class="head-tip">检测孤立页面、断链与过期内容</p>
        </div>
        <div class="head-actions">
          <el-button
            v-if="report && fixableTotal > 0 && !batchFixing"
            size="small"
            class="neon-btn batch-btn"
            :icon="MagicStick"
            data-tip="批量修复全部 - 对报告中所有可自动修复的问题启动后台作业（先显示量化估算）"
            :disabled="anyFixing"
            @click="batchAll"
          >
            批量修复全部（{{ fixableTotal }}）
          </el-button>
          <IconActionButton
            name="重新体检"
            desc="重新扫描孤立页面、断链与过期内容"
            :icon="RefreshRight"
            size="small"
            class="neon-btn"
            :loading="loading"
            :disabled="anyFixing"
            @click="runCheck"
          />
        </div>
      </div>

      <!-- 体检结果摘要：状态徽章 + 总数拆分「可自动修复 / 需人工判断」（H5） -->
      <div v-if="report" class="summary-bar">
        <div class="summary-item" :class="healthStatus">
          <el-icon v-if="healthStatus === 'healthy'"><CircleCheck /></el-icon>
          <el-icon v-else><Warning /></el-icon>
          <span class="summary-text">
            {{
              healthStatus === 'healthy'
                ? '系统状态良好'
                : `发现 ${totalIssues} 个问题 · 需要处理`
            }}
          </span>
        </div>
        <span v-if="totalIssues > 0" class="summary-split">
          可自动修复 {{ split.autoFixable }} · 需人工判断 {{ split.manualReview }}
        </span>
      </div>

      <!-- 批量修复作业面板：由后端作业快照驱动，刷新/切页后仍可恢复 -->
      <div v-if="job" class="job-panel" :class="`is-${job.status}`">
        <div class="job-head">
          <span class="job-title">// 批量修复作业</span>
          <span class="job-status" :class="`st-${job.status}`">{{ jobStatusText }}</span>
          <span v-if="job.currentIssueKey" class="job-current">正在处理 {{ job.currentIssueKey }}</span>
          <span v-else class="job-current"></span>
          <el-button
            v-if="job.status !== 'running'"
            size="small"
            text
            class="job-close-btn"
            data-tip="关闭面板 - 仅从界面移除，作业记录仍保留在服务端"
            @click="dismissJob"
          >
            关闭
          </el-button>
        </div>

        <el-progress
          :percentage="batchProgress"
          :stroke-width="10"
          :status="
            job.status === 'completed' ? 'success' : job.status === 'canceled' ? 'exception' : undefined
          "
          :striped="job.status === 'running'"
          :striped-flow="job.status === 'running'"
        />

        <div class="job-stats">
          <span class="job-stat">第 {{ batchCurrent }} / {{ batchTotal }} 个</span>
          <span class="job-stat ok">成功 {{ batchSuccessCount }}</span>
          <span class="job-stat fail">失败 {{ batchFailCount }}</span>
          <span class="job-stat">已用时 {{ formatElapsed(batchElapsedMs) }}</span>
          <span v-if="job.status === 'running' && batchEtaMs > 0" class="job-stat">
            预计剩余 {{ formatDuration(batchEtaMs) }}
          </span>
          <span v-if="job.status === 'paused' || job.status === 'canceled'" class="job-stat">
            剩余 {{ batchRemaining }} 项未处理
          </span>
        </div>

        <div class="job-actions">
          <el-button
            v-if="job.status === 'running' && !job.pauseRequested"
            size="small"
            class="neon-btn"
            :icon="VideoPause"
            data-tip="暂停 - 当前问题完成后停下，已完成项保留"
            @click="controlJob('pause')"
          >
            暂停
          </el-button>
          <el-button
            v-if="job.status === 'paused' || job.status === 'canceled'"
            size="small"
            class="neon-btn"
            :icon="VideoPlay"
            data-tip="继续 - 从下一个未处理问题继续，不重跑已完成项"
            :disabled="anyFixing"
            @click="controlJob('resume')"
          >
            继续（剩余 {{ batchRemaining }}）
          </el-button>
          <el-button
            v-if="job.status === 'running'"
            size="small"
            class="neon-btn batch-btn"
            :icon="CircleClose"
            data-tip="取消 - 当前问题完成后终止，已完成项不回滚"
            @click="controlJob('cancel')"
          >
            取消
          </el-button>
          <el-button
            v-if="batchFailed.length > 0 && job.status !== 'running'"
            size="small"
            class="neon-btn"
            :icon="RefreshRight"
            data-tip="重试失败项 - 只把上次失败的问题重新提交为新作业"
            :disabled="anyFixing"
            @click="retryFailed"
          >
            重试失败项（{{ batchFailed.length }}）
          </el-button>
        </div>

        <div v-if="batchFailed.length > 0" class="job-failed">
          <div v-for="f in batchFailed" :key="f.issueKey" class="failed-item">
            <code>{{ f.issueKey }}</code>
            <span class="failed-msg">{{ f.message }}</span>
          </div>
        </div>
      </div>

      <!-- 加载中：骨架屏模拟体检报告的布局结构 -->
      <div v-if="loading" class="health-loading">
        <p class="loading-text">// 扫描中…</p>
        <el-skeleton :rows="1" animated class="health-skeleton-summary" />
        <div class="health-skeleton-body">
          <el-skeleton :rows="2" animated class="health-skeleton-section" />
          <el-skeleton :rows="2" animated class="health-skeleton-section" />
          <el-skeleton :rows="2" animated class="health-skeleton-section" />
        </div>
      </div>

      <template v-else-if="report">
        <!-- 列表工具条：搜索 + 目录聚合 + 全选/清空 -->
        <div class="list-toolbar">
          <el-input
            v-model="keyword"
            size="small"
            class="search-input"
            placeholder="搜索路径或断链目标"
            clearable
            data-tip="搜索 - 按路径或断链目标筛选问题列表"
          />
          <el-checkbox v-model="groupByDir" size="small" data-tip="按目录聚合 - 把同一目录的问题归组显示">
            按目录聚合
          </el-checkbox>
          <span v-if="keyword" class="search-hint">
            筛选后 {{ searchRows.length }} / {{ allRows.length }}
          </span>
          <div class="toolbar-spacer"></div>
          <el-button
            size="small"
            text
            class="tool-btn"
            data-tip="全选可修复 - 选中当前所有可自动修复的问题"
            @click="selectAllFixable"
          >
            全选可修复
          </el-button>
          <el-button
            v-if="selectionSummary.total > 0"
            size="small"
            text
            class="tool-btn"
            data-tip="清空选择"
            @click="clearSelection"
          >
            清空
          </el-button>
        </div>

        <!-- 跨 section 选中汇总条（H1）：修复前先看得到选中数与类型构成 -->
        <div v-if="selectionSummary.total > 0" class="selection-bar">
          <span class="selection-text">
            已选 {{ selectionSummary.total }} 项（孤立 {{ selectionSummary.orphan }} · 断链
            {{ selectionSummary.broken }}）
          </span>
          <el-button
            size="small"
            class="neon-btn batch-btn"
            :icon="MagicStick"
            data-tip="批量修复选中 - 显示量化估算后确认，作业在后台执行"
            :disabled="anyFixing"
            @click="openEstimate(selected)"
          >
            批量修复选中
          </el-button>
        </div>

        <!-- 体检详情：4 类问题共用同一套 sectionView 渲染 -->
        <div class="health-body">
          <div v-for="sec in sectionViews" :key="sec.meta.kind" class="issue-section hover-glow">
            <div class="section-head">
              <span class="section-icon" :class="sec.meta.iconClass">{{ sec.meta.icon }}</span>
              <span class="section-title">{{ sec.meta.title }}</span>
              <span class="section-count" :class="{ 'has-issue': sec.count > 0 }">{{ sec.count }}</span>
              <el-checkbox
                v-if="sec.fixableCount > 0"
                class="section-select-all"
                :model-value="sec.allSelected"
                size="small"
                :disabled="anyFixing"
                :data-tip="`全选本类 - 选中当前筛选结果中 ${sec.fixableCount} 个可自动修复项`"
                @change="(v: boolean) => toggleKind(sec.meta.kind, v)"
              >
                全选本类
              </el-checkbox>
              <el-button
                v-if="sec.meta.reviewAction && sec.count > 0"
                size="small"
                class="neon-btn batch-section-btn"
                :icon="Check"
                data-tip="一键复核 - 为 dated 页面追加 reviewed_at，确定性写入，不走 LLM"
                :loading="reviewing"
                :disabled="anyFixing || reviewing"
                @click="reviewKnowledgeStale"
              >
                一键复核
              </el-button>
            </div>
            <div class="section-desc">{{ sec.meta.desc }}</div>

            <div v-if="sec.count > 0" class="section-list">
              <template v-if="sec.groups">
                <div v-for="g in sec.groups" :key="g.dir" class="dir-group">
                  <div class="dir-head">
                    <code>{{ g.dir }}</code>
                    <span class="dir-count">
                      {{ g.visible.length }}
                      <template v-if="g.hiddenCount > 0"> · 还有 {{ g.hiddenCount }}</template>
                    </span>
                  </div>
                  <HealthIssueList
                    :rows="g.visible"
                    :selected="selected"
                    :fixing-key="fixingKey"
                    :any-fixing="anyFixing"
                    :job-states="jobStates"
                    @toggle="toggleRow"
                    @fix="fixIssue"
                  />
                </div>
              </template>
              <HealthIssueList
                v-else
                :rows="sec.visible"
                :selected="selected"
                :fixing-key="fixingKey"
                :any-fixing="anyFixing"
                :job-states="jobStates"
                @toggle="toggleRow"
                @fix="fixIssue"
              />

              <div v-if="sec.hiddenCount > 0" class="list-more">
                <el-button size="small" text class="tool-btn" @click="loadMore(sec.meta.kind)">
                  还有 {{ sec.hiddenCount }} 条未显示，加载更多
                </el-button>
                <el-button size="small" text class="tool-btn" @click="expandKind(sec.meta.kind)">
                  展开全部
                </el-button>
              </div>
              <div v-else-if="isExpanded(sec.meta.kind) && sec.count > TOP_N" class="list-more">
                <el-button size="small" text class="tool-btn" @click="collapseKind(sec.meta.kind)">
                  收起
                </el-button>
              </div>
            </div>
            <div v-else class="no-issue">{{ sec.meta.emptyText }}</div>
          </div>

          <!-- 修复进度日志（单个修复 + 批量作业共用时间线） -->
          <div v-if="fixLogs.length > 0" class="fix-log-section">
            <div class="section-head">
              <el-icon class="section-icon icon-fix"><Lightning /></el-icon>
              <span class="section-title">修复进度</span>
              <el-button
                size="small"
                text
                class="clear-logs-btn"
                data-tip="清空修复进度日志"
                @click="healthStore.clearLogs()"
              >
                清除日志
              </el-button>
            </div>
            <div class="fix-log-list">
              <div v-for="(log, idx) in fixLogs" :key="idx" class="fix-log-item" :class="log.status">
                <span class="log-step">{{ log.step }}</span>
                <span class="log-message">{{ log.message }}</span>
                <span v-if="log.tool" class="log-tool">{{ log.tool }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 启动前量化确认（H2）：问题数 / LLM 调用次数 / 预计耗时，并标明估算依据 -->
    <AppModal v-model="estimateVisible" title="批量修复确认" width="520px">
      <div v-loading="estimateLoading" class="estimate-body">
        <p class="estimate-tip">以下数值为估算（非承诺）。作业在后台串行执行，可随时暂停或取消。</p>
        <div class="estimate-grid">
          <div class="estimate-item">
            <span class="estimate-num">{{ pendingPayload?.items.length ?? '—' }}</span>
            <span class="estimate-label">待修复问题</span>
          </div>
          <div class="estimate-item">
            <span class="estimate-num">{{ estimate?.llmCalls ?? '—' }}</span>
            <span class="estimate-label">LLM 调用次数</span>
          </div>
          <div class="estimate-item">
            <span class="estimate-num">{{ estimate ? formatDuration(estimate.estimatedMs) : '—' }}</span>
            <span class="estimate-label">预计耗时</span>
          </div>
        </div>
        <p v-if="estimate" class="estimate-basis">
          {{ estimateBasisText }}。每个问题需读写 vault，作业全程持有编译锁，期间编译任务会排队；暂停与取消在「当前问题完成后」生效。
        </p>
        <p v-if="job && job.status === 'paused'" class="estimate-basis">
          注意：另有已暂停作业剩余 {{ batchRemaining }} 项，启动新作业不会自动续跑它。
        </p>
      </div>
      <template #footer>
        <el-button size="small" @click="estimateVisible = false">取消</el-button>
        <el-button
          size="small"
          type="primary"
          :loading="starting"
          :disabled="!estimate || anyFixing"
          @click="confirmStartBatch"
        >
          开始修复
        </el-button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.health-page {
  display: flex;
  flex-direction: column;
}

.health-card {
  position: relative;
  padding: 24px 28px;
  overflow: hidden;
}

/* 不对称装饰块：旋转品红渐变 */
.card-deco {
  position: absolute;
  top: -50px;
  right: -30px;
  width: 200px;
  height: 200px;
  background: var(--grad-fire);
  filter: blur(55px);
  opacity: 0.3;
  transform: rotate(20deg);
  border-radius: 50%;
  pointer-events: none;
  z-index: 0;
}

.health-head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.head-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

/* 批量修复按钮：品红渐变突出，区别于普通青蓝 neon-btn */
.batch-btn {
  border-color: var(--accent-pink-a50) !important;
  color: var(--neon-magenta) !important;
}

.batch-btn:hover:not(.is-disabled) {
  border-color: var(--neon-magenta) !important;
  box-shadow: 0 0 16px var(--accent-pink-a40) !important;
}

/* section 内的"一键复核"按钮：靠右，避免与 section-count 拥挤 */
.batch-section-btn {
  margin-left: auto;
}

.head-text {
  flex: 1;
}

.head-title {
  margin: 0 0 2px;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 12px;
}

.neon-btn {
  background: var(--bg-glass) !important;
  border: 1px solid var(--accent-purple-a40) !important;
  color: var(--text-bright) !important;
  font-family: var(--font-mono) !important;
  letter-spacing: 0.05em;
  transition: all 0.3s ease !important;
}

.neon-btn:hover:not(.is-disabled) {
  border-color: var(--neon-cyan) !important;
  box-shadow: var(--glow-cyan) !important;
  color: var(--neon-cyan) !important;
}

/* 摘要徽章：健康=青蓝渐变，警告=品红渐变 */
.summary-bar {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 24px;
}

.summary-item {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 22px;
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.05em;
  border: 1px solid;
}

.summary-item.healthy {
  background: linear-gradient(135deg, var(--accent-cyan-a20), var(--accent-cyan-a05));
  border-color: var(--accent-cyan-a50);
  color: var(--neon-cyan);
  box-shadow: 0 0 20px var(--accent-cyan-a30);
}

.summary-item.warning {
  background: linear-gradient(135deg, var(--accent-pink-a20), var(--accent-pink-a05));
  border-color: var(--accent-pink-a50);
  color: var(--neon-magenta);
  box-shadow: 0 0 20px var(--accent-pink-a30);
}

/* H5：可自动修复 / 需人工判断拆分，混合计数不再误导 */
.summary-split {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
}

/* ===== 列表工具条 / 选中汇总条 ===== */
.list-toolbar {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.search-input {
  width: 260px;
}

.search-hint {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-cyan);
}

.toolbar-spacer {
  flex: 1;
}

.tool-btn {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft) !important;
}

.tool-btn:hover {
  color: var(--neon-cyan) !important;
}

.selection-bar {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  padding: 10px 16px;
  background: var(--accent-cyan-a10);
  border: 1px solid var(--accent-cyan-a30);
  border-radius: var(--radius-input);
}

.selection-text {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--neon-cyan);
}

/* ===== 作业面板 ===== */
.job-panel {
  position: relative;
  z-index: 1;
  margin-bottom: 20px;
  padding: 14px 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-pink-a30);
  border-radius: var(--radius-card);
}

.job-panel.is-paused,
.job-panel.is-canceled {
  border-color: var(--accent-purple-a40);
}

.job-panel.is-completed {
  border-color: var(--accent-cyan-a40);
}

.job-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.job-title {
  color: var(--neon-magenta);
  letter-spacing: 0.08em;
  flex-shrink: 0;
}

.job-status {
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--accent-purple-a40);
  color: var(--text-bright);
  flex-shrink: 0;
}

.job-status.st-running {
  border-color: var(--accent-pink-a50);
  color: var(--neon-magenta);
}

.job-status.st-completed {
  border-color: var(--accent-cyan-a50);
  color: var(--neon-cyan);
}

.job-current {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
}

.job-close-btn {
  font-size: 11px;
  color: var(--text-dim) !important;
}

.job-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 10px 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-base);
}

.job-stat.ok {
  color: var(--neon-cyan);
}

.job-stat.fail {
  color: var(--neon-magenta);
}

.job-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.job-failed {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--accent-pink-a30);
}

.failed-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
}

.failed-item code {
  color: var(--neon-magenta);
  flex-shrink: 0;
}

.failed-msg {
  color: var(--text-soft);
}

/* ===== 加载 / 骨架 ===== */
.health-loading {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 60px 0;
  color: var(--text-soft);
}

.loading-text {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--neon-cyan);
  letter-spacing: 0.1em;
}

.health-skeleton-summary {
  width: 60%;
  margin: 0 auto 20px;
}

.health-skeleton-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.health-skeleton-section {
  padding: 14px 18px;
  border-radius: var(--radius-card);
}

/* ===== 问题区 ===== */
.health-body {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.issue-section {
  padding: 18px 22px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
  transition: all 0.3s ease;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.section-icon {
  font-size: 18px;
  flex-shrink: 0;
  font-family: var(--font-mono);
}

.icon-orphan { color: var(--neon-magenta); text-shadow: 0 0 8px var(--neon-magenta); }
.icon-broken { color: var(--neon-purple); text-shadow: 0 0 8px var(--neon-purple); }
.icon-stale { color: var(--neon-cyan); text-shadow: 0 0 8px var(--neon-cyan); }
.icon-fix { color: var(--neon-lime); text-shadow: 0 0 8px var(--neon-lime); }
.icon-review { color: var(--neon-magenta); text-shadow: 0 0 8px var(--neon-magenta); }

.section-title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.03em;
  flex: 1;
}

.section-select-all {
  height: auto;
  margin-left: auto;
}

.section-count {
  padding: 2px 14px;
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  background: var(--accent-cyan-a15);
  border: 1px solid var(--accent-cyan-a40);
  color: var(--neon-cyan);
}

.section-count.has-issue {
  background: var(--accent-pink-a15);
  border-color: var(--accent-pink-a50);
  color: var(--neon-magenta);
  box-shadow: 0 0 12px var(--accent-pink-a40);
}

.section-desc {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 12px;
  letter-spacing: 0.02em;
}

.section-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dir-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dir-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
}

.dir-head code {
  color: var(--neon-purple);
}

.list-more {
  display: flex;
  gap: 6px;
  padding-left: 4px;
}

.no-issue {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--neon-lime);
  padding: 8px 0;
  letter-spacing: 0.03em;
}

/* ===== 估算弹窗 ===== */
.estimate-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.estimate-tip,
.estimate-basis {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
  line-height: 1.6;
}

.estimate-grid {
  display: flex;
  gap: 16px;
}

.estimate-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 8px;
  background: var(--accent-purple-a08);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-input);
}

.estimate-num {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 900;
  color: var(--text-bright);
}

.estimate-label {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
}

/* ===== 修复日志 ===== */
.fix-log-section {
  padding: 18px 22px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-lime-a25, rgba(193, 255, 62, 0.25));
  border-radius: var(--radius-card);
}

.fix-log-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fix-log-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  background: var(--accent-lime-a08, rgba(193, 255, 62, 0.08));
  border: 1px solid var(--accent-lime-a20, rgba(193, 255, 62, 0.2));
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.fix-log-item.error {
  background: var(--accent-pink-a12);
  border-color: var(--accent-pink-a35);
}

.fix-log-item.done {
  background: var(--accent-cyan-a10);
  border-color: var(--accent-cyan-a35);
}

.log-step {
  padding: 2px 10px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  font-weight: 700;
  font-size: 11px;
  flex-shrink: 0;
  color: var(--text-bright);
}

.log-message {
  flex: 1;
  color: var(--text-base);
}

.log-tool {
  padding: 2px 8px;
  background: var(--accent-cyan-a10);
  border: 1px solid var(--accent-cyan-a25);
  border-radius: 6px;
  color: var(--neon-cyan);
  font-size: 11px;
  flex-shrink: 0;
}

.clear-logs-btn {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim) !important;
}

.clear-logs-btn:hover {
  color: var(--neon-magenta) !important;
}
</style>

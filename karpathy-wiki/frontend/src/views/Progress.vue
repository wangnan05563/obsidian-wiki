<script setup lang="ts">
import { onMounted, onBeforeUnmount, computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Loading, Check, Close } from '@element-plus/icons-vue';
import { useCompileStore } from '../stores/compile';
import { consumeSSE } from '../utils/sse';
import BatchProgressBar from '../components/BatchProgressBar.vue';
import type { IngestPayload, TimelineItem, RunSummary } from '../types';

// 使用函数类型写法替代类型字面量（S6598）
const emit = defineEmits<(e: 'restart') => void>();

const store = useCompileStore();
let abortController: AbortController | null = null;

const logDialogVisible = ref(false);
const viewingRunId = ref<string>('');

const STEP_LABEL: Record<string, string> = {
  archive: '存档原始资料',
  read_schema: '读取 SCHEMA',
  extract: '提取要点',
  generate_page: '生成页面',
  update_index: '更新索引',
  update_log: '记录日志',
  finalize: '收尾'
};

const robotMood = computed<string>(() => {
  if (store.errorMessage) return 'sad';
  if (store.isDone) return 'happy';
  return 'thinking';
});

const showRunsList = computed(() => !store.isCompiling && !store.isDone && !store.errorMessage && !store.isCancelled);

async function startCompile(payload: IngestPayload) {
  const isFormData = payload instanceof FormData;
  abortController = new AbortController();
  try {
    // 批量模式调用 /api/compile/batch，单文件模式调用 /api/compile
    const endpoint = store.isBatchMode ? '/api/compile/batch' : '/api/compile';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: isFormData ? {} : { 'Content-Type': 'application/json' },
      body: isFormData ? payload : JSON.stringify(payload),
      signal: abortController.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    await consumeCompileSSE(response);
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // 中止时仅复位 isCompiling，不污染 errorMessage：
      // 用户切走/切回是正常导航操作，不应显示为错误
      store.abortCompile();
      return;
    }
    store.handleEvent('error', { message: (err as Error).message });
    ElMessage.error('编译请求失败：' + (err as Error).message);
  } finally {
    abortController = null;
  }
}

async function startResume(runId: string) {
  store.reset();
  // 直接修改：compile store 未暴露 startCompile action，此字段是简单状态
  store.isCompiling = true;
  abortController = new AbortController();
  try {
    const response = await fetch(`/api/compile/resume/${runId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortController.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    await consumeCompileSSE(response);
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      store.abortCompile();
      return;
    }
    store.handleEvent('error', { message: (err as Error).message });
    ElMessage.error('恢复失败：' + (err as Error).message);
  } finally {
    abortController = null;
  }
}

// SSE 流消费委托给 utils/sse.ts 的通用 consumeSSE，降低本函数认知复杂度（S3776）
// compile store 使用 handleEvent 统一入口分发事件
function handleSSE(eventType: string, parsed: any) {
  store.handleEvent(eventType, parsed);
}

async function consumeCompileSSE(response: Response) {
  await consumeSSE(response, handleSSE);
}

// 用户主动取消编译：触发 abortController 中止 SSE 流，并通过 store.cancelCompile 标记取消态
// 为什么不在 BatchProgressBar 内部直接 abort：abortController 是 Progress.vue 的局部变量，
//   子组件无法访问；通过 emit 事件委托父组件处理是 Vue 单向数据流的惯用模式
function handleBatchCancel() {
  abortController?.abort();
  store.cancelCompile();
  ElMessage.info('已取消批量编译');
}

onMounted(() => {
  // 批量模式优先检测 pendingBatchPayload，否则检测单文件 pendingPayload
  // 守卫逻辑（注意是 isCompiling 而非 !isCompiling）：
  //   - 首次从 Ingest 切入：prepareBatchCompile/prepareCompile 已设置 isCompiling=true 表示"应该开始编译"，
  //     此时 isCompiling=true → 触发 startCompile 发起 SSE 请求
  //   - 编译进行中切走再切回：onBeforeUnmount 已调用 abortCompile 复位 isCompiling=false，
  //     此时 isCompiling=false → 跳过 startCompile，避免重复触发导致 SSE 流重置（批量编译会从头开始重复编译）
  //   - 编译完成/出错/取消后切回：isDone/errorMessage/isCancelled 任一为真 → 跳过
  // 之前用 !isCompiling 是逻辑反向 bug：首次进入时 isCompiling=true 导致 !isCompiling=false，
  //   startCompile 永远不会被调用，页面卡在"正在编译… 0/0 0%"
  if (store.isBatchMode && store.pendingBatchPayload && !store.isDone && store.isCompiling && !store.isCancelled) {
    startCompile(store.pendingBatchPayload);
  } else if (store.pendingPayload && !store.isDone && store.isCompiling && !store.isCancelled) {
    startCompile(store.pendingPayload);
  } else {
    store.loadRuns();
  }
});

async function openLogDialog(run: RunSummary) {
  viewingRunId.value = run.runId;
  logDialogVisible.value = true;
  await store.loadLog(run.runId);
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function runStatusType(status: string): 'success' | 'danger' | 'warning' {
  if (status === 'done') return 'success';
  if (status === 'failed') return 'danger';
  return 'warning';
}

function runStatusLabel(status: string): string {
  if (status === 'done') return '完成';
  if (status === 'failed') return '失败';
  return '运行中';
}

onBeforeUnmount(() => {
  abortController?.abort();
  // 通知 store 编译已中止：让 isCompiling 复位，避免切回时 onMounted 误判为"正在编译"
  // 而跳过 startCompile 重入，导致进度条卡死
  store.abortCompile();
});

function handleRestart() {
  store.reset();
  emit('restart');
}

function stepLabelOf(item: TimelineItem): string {
  return STEP_LABEL[item.step] ?? item.step;
}

function dotTypeOf(item: TimelineItem): 'primary' | 'success' | 'danger' {
  if (item.status === 'done') return 'success';
  if (item.status === 'error') return 'danger';
  return 'primary';
}
</script>

<template>
  <div class="progress-page">
    <div class="glass-card progress-card fade-up">
      <div class="card-deco"></div>
      <!-- 不对称头部：机器人 + 状态文字 -->
      <div class="progress-head">
<div class="head-text">
          <span class="head-tag">// COMPILE ENGINE</span>
          <h2 class="head-title">
            <span v-if="store.isCompiling" class="grad-text">机器人正在编译…</span>
            <span v-else-if="store.isDone" class="grad-text">编译完成</span>
            <span v-else-if="store.errorMessage">出错了</span>
            <span v-else>准备就绪</span>
          </h2>
          <p class="head-tip">
            <template v-if="robotMood === 'thinking'">小提示：编译过程是流式的，可实时查看每一步</template>
            <template v-else-if="robotMood === 'happy'">
              共生成 {{ store.generatedPages.length }} 个页面
            </template>
            <template v-else>{{ store.errorMessage }}</template>
          </p>
        </div>
      </div>

      <!-- 批量编译模式：按文件分组渲染 -->
      <div v-if="store.isBatchMode" class="batch-view">
        <!-- 实时进度条组件：显示已完成/总数/百分比，支持取消与状态持久化 -->
        <BatchProgressBar @cancel="handleBatchCancel" />

        <!-- 拒绝列表：扫描文件夹时不符白名单的文件 -->
        <div v-if="store.batchRejected.length > 0" class="batch-rejected">
          <div class="rejected-title">已跳过 {{ store.batchRejected.length }} 个不符白名单的文件：</div>
          <ul class="rejected-list">
            <li v-for="(r, idx) in store.batchRejected" :key="idx" class="rejected-item">
              <code>{{ r.name }}</code>
              <span class="rejected-reason">{{ r.reason }}</span>
            </li>
          </ul>
        </div>

        <!-- 分组卡片列表 -->
        <div v-if="store.batchGroups.length > 0" class="batch-groups">
          <div
            v-for="group in store.batchGroups"
            :key="group.fileIndex"
            class="batch-group"
            :class="group.status"
          >
            <div class="batch-group-head">
              <span class="batch-group-idx">#{{ group.fileIndex + 1 }}</span>
              <span class="batch-group-name">{{ group.fileName || '待处理' }}</span>
              <span class="batch-group-status" :class="group.status">
                <el-icon v-if="group.status === 'running'" class="spin-icon"><Loading /></el-icon>
                <el-icon v-else-if="group.status === 'done'"><Check /></el-icon>
                <el-icon v-else-if="group.status === 'error'"><Close /></el-icon>
                <span>{{ group.status }}</span>
              </span>
            </div>
            <!-- 分组内时间线（折叠态：仅显示最近一条；展开态：完整列表） -->
            <div v-if="group.timeline.length > 0" class="batch-group-timeline">
              <div
                v-for="(item, idx) in group.timeline"
                :key="idx"
                class="batch-tl-item"
              >
                <span class="batch-tl-step">{{ stepLabelOf(item) }}</span>
                <span class="batch-tl-msg">{{ item.message }}</span>
                <code v-if="item.page" class="batch-tl-page">{{ item.page.title }}</code>
              </div>
            </div>
            <!-- 错误信息 -->
            <div v-if="group.errorMessage" class="batch-group-error">
              {{ group.errorMessage }}
            </div>
            <!-- 生成页面列表 -->
            <div v-if="group.pages.length > 0" class="batch-group-pages">
              <span class="pages-label">生成页面：</span>
              <code v-for="p in group.pages" :key="p.path" class="batch-page-code">{{ p.title }}</code>
            </div>
          </div>
        </div>
      </div>

      <!-- 单文件模式时间线 -->
      <el-timeline v-else-if="store.timeline.length > 0" class="timeline">
        <el-timeline-item
          v-for="(item, idx) in store.timeline"
          :key="idx"
          :type="dotTypeOf(item)"
          :hollow="item.status === 'running'"
          size="large"
        >
          <div class="tl-row">
            <div class="tl-head">
              <span class="tl-step">{{ stepLabelOf(item) }}</span>
              <span class="tl-status" :class="item.status">
                <el-icon v-if="item.status === 'running'" class="spin-icon"><Loading /></el-icon>
                <el-icon v-else-if="item.status === 'done'"><Check /></el-icon>
                <el-icon v-else><Close /></el-icon>
                <span>{{ item.status }}</span>
              </span>
            </div>
      <div class="tl-message">{{ item.message }}</div>
      <div v-if="item.page" class="tl-page">
              <span class="page-icon">◈</span> {{ item.page.title }}
              <code>{{ item.page.path }}</code>
            </div>
          </div>
        </el-timeline-item>
      </el-timeline>

      <div v-else class="empty-progress">
        <span class="empty-dots">● ● ●</span>
        <p>等待编译开始…</p>
      </div>

      <!-- 缓存命中提示 -->
      <div v-if="store.isDone && store.result?.cached" class="cache-hit-banner">
        <span class="cache-icon">⚡</span>
        <span class="cache-text">内容已编译过（缓存命中），已跳过本次编译</span>
      </div>
      <div v-if="store.isDone && store.result" class="done-section">
        <div class="result-card">
          <div class="result-title">本次编译结果</div>
      <div v-if="store.doneMessage" class="done-message">{{ store.doneMessage }}</div>
          <ul v-if="store.result.pages.length > 0" class="result-list">
            <li v-for="p in store.result.pages" :key="p">
              <code>{{ p }}</code>
            </li>
          </ul>
          <div class="result-meta">
            索引更新：<strong>{{ store.result.indexUpdated ? '是' : '否' }}</strong>
          </div>
        </div>
      <div class="restart-bar">
          <el-button type="primary" size="large" @click="handleRestart">
            再投一篇
          </el-button>
        </div>
      </div>
      <!-- 批量编译完成区块：进度条组件已显示统计，这里仅保留操作按钮 -->
      <div v-else-if="store.isBatchMode && store.isDone" class="done-section">
        <div v-if="store.doneMessage" class="done-message">{{ store.doneMessage }}</div>
        <div class="restart-bar">
          <el-button type="primary" size="large" @click="handleRestart">
            再投一批
          </el-button>
        </div>
      </div>
      <!-- 批量编译取消态：提供"再投一批"按钮让用户重新开始 -->
      <div v-else-if="store.isBatchMode && store.isCancelled" class="done-section">
        <div class="restart-bar">
          <el-button type="primary" size="large" @click="handleRestart">
            再投一批
          </el-button>
        </div>
      </div>
      <div v-else-if="store.errorMessage" class="restart-bar">
        <el-button type="primary" size="large" @click="handleRestart">
          重新投递
        </el-button>
      </div>

      <!-- 历史编译任务列表 -->
      <div v-if="showRunsList" class="runs-section">
        <div class="runs-head">
          <h3 class="runs-title">
            <span class="title-bracket">[</span> 历史编译任务 <span class="title-bracket">]</span>
          </h3>
          <el-button size="small" :loading="store.loadingRuns" @click="store.loadRuns()">刷新</el-button>
        </div>
      <div v-if="store.loadingRuns" class="section-loading">LOADING...</div>
      <div v-else-if="store.runs.length === 0" class="runs-empty">暂无历史任务</div>
      <div v-else class="runs-list">
          <div v-for="run in store.runs" :key="run.runId" class="run-item hover-glow">
            <div class="run-info" @click="openLogDialog(run)">
              <span class="run-id">{{ run.runId.slice(0, 8) }}</span>
              <el-tag :type="runStatusType(run.status)" size="small">{{ runStatusLabel(run.status) }}</el-tag>
              <span class="run-meta">步骤 {{ run.step }} · {{ run.tokenUsed }} tokens</span>
            </div>
      <div class="run-actions">
              <span class="run-time">{{ formatTime(run.startedAt) }}</span>
              <el-button
                v-if="run.status === 'failed'"
                size="small"
                type="primary"
                @click.stop="startResume(run.runId)"
              >
                恢复
              </el-button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 日志查看 Dialog -->
    <el-dialog v-model="logDialogVisible" title="编译运行日志" width="700px" class="log-dialog">
      <div v-if="store.loadingLog" class="section-loading">LOADING...</div>
      <div v-else-if="store.logEntries.length === 0" class="runs-empty">暂无日志</div>
      <div v-else class="log-list">
        <div v-for="(entry, idx) in store.logEntries" :key="idx" class="log-line" :class="entry.event">
          <span class="log-ts">{{ formatTime(entry.ts) }}</span>
          <span class="log-step">step {{ entry.step }}</span>
          <span v-if="entry.tool" class="log-tool">{{ entry.tool }}</span>
          <span v-if="entry.tokenUsed != null" class="log-token">{{ entry.tokenUsed }}t</span>
          <span class="log-msg">{{ entry.message }}</span>
          <span v-if="entry.error" class="log-err">{{ entry.error }}</span>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.progress-page {
  display: flex;
  flex-direction: column;
}

.progress-card {
  padding: 32px 36px;
  position: relative;
  overflow: hidden;
}

.card-deco {
  position: absolute;
  top: -50px;
  left: -50px;
  width: 240px;
  height: 240px;
  background: var(--grad-cool);
  opacity: 0.08;
  transform: rotate(-15deg);
  border-radius: 40px;
  pointer-events: none;
}

/* 不对称头部 */
.progress-head {
  display: flex;
  align-items: center;
  gap: 24px;
  margin-bottom: 24px;
  position: relative;
  z-index: 1;
}

.head-text {
  flex: 1;
}

.head-tag {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-cyan);
  letter-spacing: 2px;
  display: block;
  margin-bottom: 6px;
}

.head-title {
  margin: 0 0 2px;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  color: var(--text-bright);
  letter-spacing: 1px;
}

.head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 12px;
}

.timeline {
  padding-left: 4px;
  margin-top: 12px;
  position: relative;
  z-index: 1;
}

.tl-row {
  padding-bottom: 6px;
}

.tl-head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.tl-step {
  font-weight: 700;
  color: var(--text-bright);
  font-family: var(--font-body);
  font-size: 14px;
}

.tl-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 3px 12px;
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  letter-spacing: 1px;
  text-transform: uppercase;
}

.tl-status.done {
  background: var(--accent-cyan-a15, rgba(0, 245, 255, 0.15));
  color: var(--neon-cyan);
  border: 1px solid var(--accent-cyan-a40, rgba(0, 245, 255, 0.4));
}

.tl-status.error {
  background: var(--accent-pink-a15, rgba(255, 0, 110, 0.15));
  color: var(--neon-magenta);
  border: 1px solid var(--accent-pink-a40, rgba(255, 0, 110, 0.4));
}

.tl-status.running {
  background: var(--accent-pink-a15, rgba(255, 62, 201, 0.15));
  color: var(--neon-pink);
  border: 1px solid var(--accent-pink-a40, rgba(255, 62, 201, 0.4));
}

.tl-message {
  margin-top: 6px;
  color: var(--text-soft);
  font-size: 13px;
}

.tl-page {
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-base);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.page-icon {
  color: var(--neon-cyan);
}

.tl-page code {
  padding: 3px 10px;
  background: var(--accent-purple-a15, rgba(176, 38, 255, 0.15));
  border: 1px solid var(--accent-purple-a30, rgba(176, 38, 255, 0.3));
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--neon-purple);
}

.empty-progress {
  text-align: center;
  color: var(--text-dim);
  padding: 48px 0;
  font-family: var(--font-mono);
}

.empty-dots {
  display: block;
  color: var(--neon-purple);
  letter-spacing: 8px;
  font-size: 20px;
  margin-bottom: 12px;
  animation: neon-pulse 1.5s ease-in-out infinite;
}

.done-section {
  margin-top: 28px;
}

.result-card {
  padding: 20px 24px;
  background: var(--accent-cyan-a05, rgba(0, 245, 255, 0.05));
  border: 1px solid var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  border-radius: var(--radius-card);
  position: relative;
  overflow: hidden;
}

.result-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: var(--grad-cool);
}

.result-title {
  font-family: var(--font-display);
  font-weight: 700;
  margin-bottom: 12px;
  color: var(--neon-cyan);
  letter-spacing: 1px;
  font-size: 14px;
}

.result-list {
  list-style: none;
  padding: 0;
  margin: 0 0 12px;
}

.result-list li {
  padding: 6px 0;
  font-size: 13px;
}

.result-list code {
  padding: 4px 12px;
  background: var(--accent-purple-a15, rgba(176, 38, 255, 0.15));
  border: 1px solid var(--accent-purple-a30, rgba(176, 38, 255, 0.3));
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--neon-purple);
}

.result-meta {
  font-size: 13px;
  color: var(--text-soft);
}

.result-meta strong {
  color: var(--neon-magenta);
}

.restart-bar {
  margin-top: 24px;
  display: flex;
  justify-content: center;
}

/* 缓存命中提示 */
.cache-hit-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 20px;
  padding: 14px 22px;
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  border-radius: var(--radius-card);
  font-size: 14px;
  color: var(--neon-cyan);
}

.cache-icon {
  font-size: 22px;
  text-shadow: var(--glow-cyan);
}

/* 历史任务列表 */
.runs-section {
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid var(--accent-purple-a15, rgba(176, 38, 255, 0.15));
  position: relative;
  z-index: 1;
}

.runs-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.runs-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 1px;
}

.title-bracket {
  color: var(--neon-magenta);
  font-weight: 400;
}

.runs-empty {
  text-align: center;
  color: var(--text-dim);
  padding: 32px 0;
  font-size: 13px;
  font-family: var(--font-mono);
}

.runs-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.run-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 18px;
  background: var(--accent-purple-a05, rgba(176, 38, 255, 0.05));
  border: 1px solid var(--accent-purple-a15, rgba(176, 38, 255, 0.15));
  border-radius: var(--radius-card);
  cursor: pointer;
  transition: all 0.3s ease;
}

.run-item:hover {
  background: var(--accent-purple-a12, rgba(176, 38, 255, 0.12));
  border-color: var(--neon-purple);
}

.run-info {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  cursor: pointer;
  flex: 1;
}

.run-id {
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--neon-cyan);
}

.run-meta {
  color: var(--text-soft);
  font-size: 12px;
  font-family: var(--font-mono);
}

.run-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.run-time {
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}

/* 日志 */
.log-list {
  max-height: 500px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 12px;
}

.log-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--accent-purple-a08, rgba(176, 38, 255, 0.08));
}

.log-line.error {
  color: var(--neon-magenta);
}

.log-line.done {
  color: var(--neon-cyan);
}

.log-ts {
  color: var(--text-dim);
  flex-shrink: 0;
}

.log-step {
  color: var(--neon-purple);
  flex-shrink: 0;
  font-weight: 600;
}

.log-tool {
  padding: 1px 8px;
  background: var(--accent-purple-a15, rgba(176, 38, 255, 0.15));
  border-radius: 4px;
  flex-shrink: 0;
  color: var(--neon-purple);
}

.log-token {
  color: var(--text-soft);
  flex-shrink: 0;
}

.log-msg {
  flex: 1;
  color: var(--text-base);
}

.log-err {
  color: var(--neon-magenta);
  flex-shrink: 0;
}

.done-message {
  font-size: 13px;
  color: var(--text-base);
  margin-bottom: 10px;
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 8px;
}

.section-loading {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 24px 0;
  text-align: center;
  letter-spacing: 2px;
}

/* ===== 批量编译模式样式 ===== */
.batch-view {
  margin-top: 16px;
  position: relative;
  z-index: 1;
}

.batch-rejected {
  margin-bottom: 16px;
  padding: 12px 16px;
  background: var(--accent-pink-a06, rgba(255, 0, 110, 0.06));
  border: 1px solid var(--accent-pink-a25, rgba(255, 0, 110, 0.25));
  border-radius: var(--radius-card);
}

.rejected-title {
  font-size: 13px;
  color: var(--neon-magenta);
  margin-bottom: 8px;
  font-weight: 600;
}

.rejected-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rejected-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.rejected-item code {
  padding: 2px 8px;
  background: var(--accent-purple-a12, rgba(176, 38, 255, 0.12));
  border-radius: 4px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--neon-purple);
}

.rejected-reason {
  color: var(--text-dim);
  font-size: 11px;
}

.batch-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.batch-group {
  padding: 14px 18px;
  background: var(--accent-purple-a04, rgba(176, 38, 255, 0.04));
  border: 1px solid var(--accent-purple-a15, rgba(176, 38, 255, 0.15));
  border-radius: var(--radius-card);
  transition: border-color 0.3s ease;
}

.batch-group.running {
  border-color: var(--neon-pink);
}

.batch-group.done {
  border-color: var(--accent-cyan-a35, rgba(0, 245, 255, 0.35));
}

.batch-group.error {
  border-color: var(--accent-pink-a40, rgba(255, 0, 110, 0.4));
  background: var(--accent-pink-a05, rgba(255, 0, 110, 0.05));
}

.batch-group-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.batch-group-idx {
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--neon-cyan);
  font-size: 12px;
}

.batch-group-name {
  flex: 1;
  font-size: 13px;
  color: var(--text-bright);
  font-family: var(--font-mono);
  word-break: break-all;
}

.batch-group-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  text-transform: uppercase;
}

.batch-group-status.running {
  background: var(--accent-pink-a15, rgba(255, 62, 201, 0.15));
  color: var(--neon-pink);
}

.batch-group-status.done {
  background: var(--accent-cyan-a15, rgba(0, 245, 255, 0.15));
  color: var(--neon-cyan);
}

.batch-group-status.error {
  background: var(--accent-pink-a15, rgba(255, 0, 110, 0.15));
  color: var(--neon-magenta);
}

.batch-group-timeline {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-left: 2px solid var(--accent-purple-a15, rgba(176, 38, 255, 0.15));
  padding-left: 10px;
}

.batch-tl-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  color: var(--text-soft);
}

.batch-tl-step {
  flex-shrink: 0;
  font-family: var(--font-mono);
  color: var(--neon-purple);
  font-weight: 600;
}

.batch-tl-msg {
  flex: 1;
}

.batch-tl-page {
  padding: 1px 6px;
  background: var(--accent-cyan-a10, rgba(0, 245, 255, 0.1));
  border-radius: 3px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--neon-cyan);
}

.batch-group-error {
  margin-top: 8px;
  padding: 8px 12px;
  background: var(--accent-pink-a08, rgba(255, 0, 110, 0.08));
  border-radius: 6px;
  color: var(--neon-magenta);
  font-size: 12px;
}

.batch-group-pages {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.pages-label {
  font-size: 12px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.batch-page-code {
  padding: 2px 8px;
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
  border: 1px solid var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  border-radius: 4px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--neon-cyan);
}
</style>

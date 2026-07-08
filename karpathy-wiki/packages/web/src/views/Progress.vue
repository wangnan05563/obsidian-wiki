<script setup lang="ts">
import { onMounted, onBeforeUnmount, computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Loading, Check, Close } from '@element-plus/icons-vue';
import RobotAvatar from '../components/RobotAvatar.vue';
import { useCompileStore } from '../stores/compile';
import type { IngestPayload, TimelineItem, RunSummary } from '../types';

const emit = defineEmits<{
  (e: 'restart'): void;
}>();

const store = useCompileStore();
let abortController: AbortController | null = null;

// §12.3-8 日志查看 dialog
const logDialogVisible = ref(false);
const viewingRunId = ref<string>('');

// 步骤中文名映射，与后端 step 标识对齐
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

// §11.2 是否展示历史任务列表（空闲态时展示）
const showRunsList = computed(() => !store.isCompiling && !store.isDone && !store.errorMessage);

// SSE 流式解析：按 \n\n 切分事件块，每块内再按行解析 event/data
async function startCompile(payload: IngestPayload) {
  const isFormData = payload instanceof FormData;
  abortController = new AbortController();
  try {
    const response = await fetch('/api/compile', {
      method: 'POST',
      headers: isFormData ? {} : { 'Content-Type': 'application/json' },
      body: isFormData ? payload : JSON.stringify(payload),
      signal: abortController.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    await consumeSSE(response);
  } catch (err) {
    // 用户主动取消（abort）不算错误
    if ((err as Error).name === 'AbortError') return;
    store.handleEvent('error', { message: (err as Error).message });
    ElMessage.error('编译请求失败：' + (err as Error).message);
  } finally {
    abortController = null;
  }
}

// §11.2 断点续传：从失败的 run 恢复编译
async function startResume(runId: string) {
  store.reset();
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

    await consumeSSE(response);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    store.handleEvent('error', { message: (err as Error).message });
    ElMessage.error('恢复失败：' + (err as Error).message);
  } finally {
    abortController = null;
  }
}

// 通用 SSE 消费：解析 event/data 并分发到 store
async function consumeSSE(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 协议：事件以空行（\n\n）分隔
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const evt of events) {
      const lines = evt.split('\n');
      let eventType = '';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) eventType = line.slice(7);
        if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (eventType && data) {
        try {
          store.handleEvent(eventType, JSON.parse(data));
        } catch {
          // 后端偶发非 JSON 数据时跳过这一条，避免整条流崩溃
        }
      }
    }
  }
}

onMounted(() => {
  // 进入进度页立即发起请求；payload 由 Ingest 页预先存入 store
  if (store.pendingPayload && !store.isDone) {
    void startCompile(store.pendingPayload);
  } else {
    // §11.2 空闲态加载历史任务列表
    void store.loadRuns();
  }
});

// §12.3-8 打开日志查看 dialog
async function openLogDialog(run: RunSummary) {
  viewingRunId.value = run.runId;
  logDialogVisible.value = true;
  await store.loadLog(run.runId);
}

// 格式化时间戳为可读格式
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

// run 状态对应的标签类型
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
  // 离开页面时中断未完成的请求，避免内存泄漏
  abortController?.abort();
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
    <div class="glass-card progress-card">
      <div class="progress-head">
        <RobotAvatar :size="96" :floating="store.isCompiling" />
        <div class="head-text">
          <h2 class="head-title">
            <template v-if="store.isCompiling">机器人正在编译…</template>
            <template v-else-if="store.isDone">编译完成 🎉</template>
            <template v-else-if="store.errorMessage">出错了 :(</template>
            <template v-else>准备就绪</template>
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

      <el-timeline v-if="store.timeline.length > 0" class="timeline">
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
              📄 {{ item.page.title }}
              <code>{{ item.page.path }}</code>
            </div>
          </div>
        </el-timeline-item>
      </el-timeline>

      <div v-else class="empty-progress">
        <p>等待编译开始…</p>
      </div>

      <!-- §11.2 缓存命中提示 -->
      <div v-if="store.isDone && store.result?.cached" class="cache-hit-banner">
        <span class="cache-icon">⚡</span>
        <span class="cache-text">内容已编译过（缓存命中），已跳过本次编译</span>
      </div>

      <div v-if="store.isDone && store.result" class="done-section">
        <div class="result-card glass-card">
          <div class="result-title">📦 本次编译结果</div>
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

      <div v-else-if="store.errorMessage" class="restart-bar">
        <el-button type="primary" size="large" @click="handleRestart">
          重新投递
        </el-button>
      </div>

      <!-- §11.2 历史编译任务列表（空闲态展示） -->
      <div v-if="showRunsList" class="runs-section">
        <div class="runs-head">
          <h3 class="runs-title">📜 历史编译任务</h3>
          <el-button size="small" :loading="store.loadingRuns" @click="store.loadRuns()">刷新</el-button>
        </div>
        <div v-if="store.loadingRuns" class="section-loading">加载中…</div>
        <div v-else-if="store.runs.length === 0" class="runs-empty">暂无历史任务</div>
        <div v-else class="runs-list">
          <div v-for="run in store.runs" :key="run.runId" class="run-item">
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

    <!-- §12.3-8 日志查看 Dialog -->
    <el-dialog v-model="logDialogVisible" title="编译运行日志" width="700px" class="log-dialog">
      <div v-if="store.loadingLog" class="section-loading">加载中…</div>
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
  padding: 28px 32px;
}

.progress-head {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 20px;
}

.head-title {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text);
}

.head-tip {
  margin: 0;
  color: var(--color-text-soft);
  font-size: 13px;
}

.timeline {
  padding-left: 4px;
  margin-top: 8px;
}

.tl-row {
  padding-bottom: 4px;
}

.tl-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.tl-step {
  font-weight: 600;
  color: var(--color-text);
}

.tl-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 12px;
  background: var(--color-cyan);
  color: var(--color-text);
}

.tl-status.done {
  background: var(--color-success);
  color: #fff;
}

.tl-status.error {
  background: var(--color-error);
  color: #fff;
}

.tl-status.running {
  background: var(--color-yellow);
  color: var(--color-text);
}

.tl-message {
  margin-top: 4px;
  color: var(--color-text-soft);
  font-size: 13px;
}

.tl-page {
  margin-top: 6px;
  font-size: 13px;
  color: var(--color-text);
}

.tl-page code {
  margin-left: 6px;
  padding: 2px 8px;
  background: var(--color-pink);
  border-radius: 8px;
  font-size: 12px;
}

.empty-progress {
  text-align: center;
  color: var(--color-text-soft);
  padding: 40px 0;
}

.done-section {
  margin-top: 24px;
}

.result-card {
  padding: 18px 22px;
  background: rgba(255, 241, 184, 0.45);
}

.result-title {
  font-weight: 700;
  margin-bottom: 10px;
  color: var(--color-text);
}

.result-list {
  list-style: none;
  padding: 0;
  margin: 0 0 10px;
}

.result-list li {
  padding: 4px 0;
  font-size: 13px;
}

.result-list code {
  padding: 3px 10px;
  background: var(--color-pink);
  border-radius: 8px;
  font-size: 12px;
}

.result-meta {
  font-size: 13px;
  color: var(--color-text-soft);
}

.restart-bar {
  margin-top: 20px;
  display: flex;
  justify-content: center;
}

/* §11.2 缓存命中提示 */
.cache-hit-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  padding: 12px 20px;
  background: var(--color-cyan);
  border-radius: var(--radius-card);
  font-size: 14px;
  color: var(--color-text);
}

.cache-icon {
  font-size: 20px;
}

/* §11.2 历史任务列表 */
.runs-section {
  margin-top: 28px;
  padding-top: 20px;
  border-top: 1px solid rgba(74, 59, 71, 0.1);
}

.runs-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.runs-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text);
}

.runs-empty {
  text-align: center;
  color: var(--color-text-soft);
  padding: 30px 0;
  font-size: 13px;
}

.runs-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.run-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  background: rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-card);
  cursor: pointer;
  transition: background 0.2s ease;
}

.run-item:hover {
  background: rgba(255, 255, 255, 0.8);
}

.run-info {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  cursor: pointer;
  flex: 1;
}

.run-id {
  font-family: 'Courier New', monospace;
  font-weight: 600;
  color: var(--color-text);
}

.run-meta {
  color: var(--color-text-soft);
  font-size: 12px;
}

.run-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.run-time {
  font-size: 12px;
  color: var(--color-text-soft);
}

/* §12.3-8 日志 dialog */
.log-list {
  max-height: 500px;
  overflow-y: auto;
  font-family: 'Courier New', monospace;
  font-size: 12px;
}

.log-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid rgba(74, 59, 71, 0.05);
}

.log-line.error {
  color: var(--color-error);
}

.log-line.done {
  color: var(--color-success);
}

.log-ts {
  color: var(--color-text-soft);
  flex-shrink: 0;
}

.log-step {
  color: var(--color-primary-deep);
  flex-shrink: 0;
  font-weight: 600;
}

.log-tool {
  padding: 1px 6px;
  background: var(--color-pink);
  border-radius: 4px;
  flex-shrink: 0;
}

.log-token {
  color: var(--color-text-soft);
  flex-shrink: 0;
}

.log-msg {
  flex: 1;
  color: var(--color-text);
}

.log-err {
  color: var(--color-error);
  flex-shrink: 0;
}

.done-message {
  font-size: 13px;
  color: var(--color-text);
  margin-bottom: 8px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.5);
  border-radius: 8px;
}
</style>

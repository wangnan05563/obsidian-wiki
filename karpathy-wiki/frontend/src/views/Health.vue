<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Warning, CircleCheck, Tools, MagicStick } from '@element-plus/icons-vue';
import type { HealthReport, FixRequest, FixProgressEvent, BatchFixRequest, BatchFixProgressEvent, BatchDoneEvent } from '../types';
import { apiErrorMessage } from '../utils/apiError';
import { useHealthStore } from '../stores/health';

// 批量修复范围类型（S4323：提取联合类型为别名，collectBatchItems/scopeLabel/batchFix 共用）
type FixScope = 'all' | 'orphan' | 'broken';

const healthStore = useHealthStore();
// 修复状态从 store 获取：组件卸载后 store 保留状态，切回页面可恢复进度条与日志
const {
  fixingKey,
  fixLogs,
  batchFixing,
  batchTotal,
  batchCurrent,
  batchDoneKeys,
  batchProgress,
  anyFixing,
} = storeToRefs(healthStore);

// report 与 loading 为组件本地状态：体检报告每次进入页面需刷新，无需跨视图保留
const report = ref<HealthReport | null>(null);
const loading = ref(false);

// 三类问题的计数
const orphanCount = computed(() => report.value?.orphans.length ?? 0);
const brokenCount = computed(() => report.value?.brokenLinks.length ?? 0);
const staleCount = computed(() => report.value?.stale.length ?? 0);
const totalIssues = computed(() => orphanCount.value + brokenCount.value + staleCount.value);

// 体检结果状态：无问题为健康，有问题为需关注
const healthStatus = computed<'healthy' | 'warning'>(() =>
  totalIssues.value === 0 ? 'healthy' : 'warning',
);

// 执行体检
async function runCheck() {
  loading.value = true;
  report.value = null;
  try {
    const res = await fetch('/api/health-check', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    report.value = await res.json();
  } catch (err) {
    ElMessage.error(apiErrorMessage('体检失败', err));
  } finally {
    loading.value = false;
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

// 处理修复进度事件，提取出来以降低 fixIssue 的认知复杂度
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
      // 修复后重新体检刷新报告
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

// 一键修复单个问题。SSE 流式接收修复进度。
// issueType 区分断链/孤立，target 为 {from,to} 或字符串路径。
async function fixIssue(issueType: 'broken_link' | 'orphan', target: { from: string; to: string } | string, key: string) {
  healthStore.startSingleFix(key);
  const payload: FixRequest = { issueType, target };

  try {
    const res = await fetch('/api/health-check/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
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
  } catch (err) {
    ElMessage.error(apiErrorMessage('修复请求失败', err));
  } finally {
    healthStore.endSingleFix();
  }
}

// 构造批量修复请求体：把 orphan/broken 问题列表转为 FixRequest[] + issueKeys[]
// 为什么前端生成 issueKey：列表项 key 已用 `${issueType}:${target}` 格式，复用保持一致
function buildBatchItems(
  issueType: 'broken_link' | 'orphan',
  targets: Array<{ from: string; to: string } | string>,
): { items: FixRequest[]; issueKeys: string[] } {
  const items: FixRequest[] = [];
  const issueKeys: string[] = [];
  for (const target of targets) {
    items.push({ issueType, target });
    // orphan 的 target 是字符串路径，broken 的 target 是 {from,to}
    if (issueType === 'orphan') {
      issueKeys.push(`orphan:${target as string}`);
    } else {
      const ft = target as { from: string; to: string };
      issueKeys.push(`broken:${ft.from}->${ft.to}`);
    }
  }
  return { items, issueKeys };
}

// 按范围收集待修复问题，返回 { items, issueKeys } 或 null（无可修复项）
// 为什么独立函数：降低 batchFix 主函数认知复杂度（S3776）
function collectBatchItems(
  scope: 'all' | 'orphan' | 'broken',
  report: HealthReport,
): { items: FixRequest[]; issueKeys: string[] } | null {
  const allItems: FixRequest[] = [];
  const allKeys: string[] = [];
  if (scope === 'all' || scope === 'orphan') {
    const { items, issueKeys } = buildBatchItems('orphan', report.orphans);
    allItems.push(...items);
    allKeys.push(...issueKeys);
  }
  if (scope === 'all' || scope === 'broken') {
    const { items, issueKeys } = buildBatchItems('broken_link', report.brokenLinks);
    allItems.push(...items);
    allKeys.push(...issueKeys);
  }
  if (allItems.length === 0) return null;
  return { items: allItems, issueKeys: allKeys };
}

// 范围文案映射：S3358 避免嵌套三元，独立函数返回
function scopeLabel(scope: FixScope): string {
  if (scope === 'all') return '全部';
  if (scope === 'orphan') return '孤立页面';
  return '断开链接';
}

// 消费批量修复 SSE 流，解析事件并委托 store action 处理
// 为什么独立函数：降低 batchFix 主函数认知复杂度（S3776）
async function streamBatchFixEvents(body: ReadableStream<Uint8Array>): Promise<void> {
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
      // 事件状态更新委托给 store action，组件不直接操作 store 状态
      healthStore.handleBatchEvent(parsed.eventType, data as BatchFixProgressEvent | BatchDoneEvent);
    }
  }
}

// 批量修复入口：支持 'all'（全部）/ 'orphan'（仅孤立）/ 'broken'（仅断链）
// 为什么需要二次确认：批量修复会调用 LLM 多次，耗时较长且消耗 token，需用户明确确认
async function batchFix(scope: FixScope) {
  if (!report.value || anyFixing.value) return;

  const collected = collectBatchItems(scope, report.value);
  if (!collected) {
    ElMessage.info('当前范围无可修复的问题');
    return;
  }

  // 二次确认
  const scopeText = scopeLabel(scope);
  try {
    await ElMessageBox.confirm(
      `将串行修复 ${collected.items.length} 个${scopeText}问题，可能耗时较长（每个问题调用一次 LLM）。是否继续？`,
      '批量修复确认',
      { confirmButtonText: '开始修复', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    // 用户取消
    return;
  }

  // 初始化批量修复状态到 store：切走页面后 store 保留状态，切回可恢复进度条
  healthStore.startBatchFix(collected.items.length);

  const payload: BatchFixRequest = { items: collected.items, issueKeys: collected.issueKeys };

  try {
    const res = await fetch('/api/health-check/fix/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    await streamBatchFixEvents(res.body);

    ElMessage.success(`批量修复完成：${batchDoneKeys.value.size}/${batchTotal.value} 个问题已处理`);
    // 批量修复后重新体检刷新报告（后端缓存已在 healthCheckFix finally 中失效）
    await runCheck();
  } catch (err) {
    ElMessage.error(apiErrorMessage('批量修复失败', err));
  } finally {
    healthStore.endBatchFix();
  }
}

onMounted(() => {
  // 批量修复进行中时不重新体检：避免 loading 状态干扰进度条显示
  // SSE fetch 在组件卸载后仍后台执行并更新 store，切回时进度条从 store 恢复
  if (healthStore.batchFixing) return;
  runCheck();
});
</script>

<template>
  <div class="health-page">
    <div class="glass-card health-card">
      <!-- 不对称装饰块：旋转品红渐变 -->
      <div class="card-deco"></div>

      <div class="health-head">
        <div class="head-text">
          <span class="head-tag">// SYSTEM DIAGNOSTIC</span>
          <h2 class="head-title grad-text">知识库体检</h2>
          <p class="head-tip">检测孤立页面、断链与过期内容</p>
        </div>
        <div class="head-actions">
          <!-- 批量修复全部：仅当有可修复问题（orphan+broken>0）且非修复中时显示 -->
          <el-button
            v-if="report && (orphanCount + brokenCount) > 0 && !batchFixing"
            size="small"
            class="neon-btn batch-btn"
            :icon="MagicStick"
            :disabled="anyFixing"
            @click="batchFix('all')"
          >
            批量修复全部
          </el-button>
          <el-button size="small" class="neon-btn" :loading="loading" :disabled="anyFixing" @click="runCheck">重新体检</el-button>
        </div>
      </div>

      <!-- 体检结果摘要：霓虹状态徽章 -->
      <div v-if="report" class="summary-bar">
        <div class="summary-item" :class="healthStatus">
          <el-icon v-if="healthStatus === 'healthy'"><CircleCheck /></el-icon>
          <el-icon v-else><Warning /></el-icon>
          <span class="summary-text">
            {{ healthStatus === 'healthy' ? '系统状态良好 · ALL CLEAR' : `发现 ${totalIssues} 个问题 · NEEDS ATTENTION` }}
          </span>
        </div>
      </div>

      <!-- 批量修复进度条：执行中显示 -->
      <div v-if="batchFixing" class="batch-progress-bar">
        <div class="batch-progress-head">
          <span class="batch-progress-label">// 批量修复中</span>
          <span class="batch-progress-count">{{ batchDoneKeys.size }} / {{ batchTotal }}</span>
        </div>
        <el-progress
          :percentage="batchProgress"
          :stroke-width="10"
          :format="() => `当前第 ${batchCurrent} / ${batchTotal} 个`"
          striped
          striped-flow
        />
      </div>

      <!-- 加载中 -->
      <div v-if="loading" class="health-loading">
<p class="loading-text">// 扫描中…</p>
      </div>

      <!-- 体检详情 -->
      <div v-else-if="report" class="health-body">
        <!-- 孤立页面 -->
        <div class="issue-section hover-glow">
          <div class="section-head">
            <span class="section-icon icon-orphan">◈</span>
            <span class="section-title">孤立页面</span>
            <span class="section-count" :class="{ 'has-issue': orphanCount > 0 }">
              {{ orphanCount }}
            </span>
            <!-- 修复本类：仅当该类有问题且非修复中时显示 -->
            <el-button
              v-if="orphanCount > 0 && !batchFixing"
              size="small"
              class="neon-btn batch-section-btn"
              :icon="MagicStick"
              :disabled="anyFixing"
              @click="batchFix('orphan')"
            >
              修复本类
            </el-button>
          </div>
      <div class="section-desc">没有任何页面通过 [[链接]] 指向它们</div>
      <div v-if="orphanCount > 0" class="issue-list">
            <div
              v-for="p in report.orphans"
              :key="p"
              class="issue-item"
              :class="{ 'issue-done': batchDoneKeys.has(`orphan:${p}`) }"
            >
              <code>{{ p }}</code>
              <el-button
                size="small"
                class="neon-btn"
                :loading="fixingKey === `orphan:${p}`"
                :disabled="anyFixing"
                :icon="Tools"
                @click="fixIssue('orphan', p, `orphan:${p}`)"
              >
                修复
              </el-button>
            </div>
          </div>
      <div v-else class="no-issue">▸ 无孤立页面</div>
        </div>

        <!-- 断链 -->
        <div class="issue-section hover-glow">
          <div class="section-head">
            <span class="section-icon icon-broken">⟶</span>
            <span class="section-title">断开链接</span>
            <span class="section-count" :class="{ 'has-issue': brokenCount > 0 }">
              {{ brokenCount }}
            </span>
            <!-- 修复本类：仅当该类有问题且非修复中时显示 -->
            <el-button
              v-if="brokenCount > 0 && !batchFixing"
              size="small"
              class="neon-btn batch-section-btn"
              :icon="MagicStick"
              :disabled="anyFixing"
              @click="batchFix('broken')"
            >
              修复本类
            </el-button>
          </div>
      <div class="section-desc">指向不存在页面的 [[链接]]</div>
      <div v-if="brokenCount > 0" class="issue-list">
            <div
              v-for="(b, idx) in report.brokenLinks"
              :key="idx"
              class="issue-item broken"
              :class="{ 'issue-done': batchDoneKeys.has(`broken:${b.from}->${b.to}`) }"
            >
              <code>{{ b.from }}</code>
              <span class="arrow">⟶</span>
              <code class="broken-target">[[{{ b.to }}]]</code>
              <el-button
                size="small"
                class="neon-btn"
                :loading="fixingKey === `broken:${idx}`"
                :disabled="anyFixing"
                :icon="Tools"
                @click="fixIssue('broken_link', b, `broken:${idx}`)"
              >
                修复
              </el-button>
            </div>
          </div>
      <div v-else class="no-issue">▸ 无断链</div>
        </div>

        <!-- 过期页面 -->
        <div class="issue-section hover-glow">
          <div class="section-head">
            <span class="section-icon icon-stale">⏱</span>
            <span class="section-title">过期页面</span>
            <span class="section-count" :class="{ 'has-issue': staleCount > 0 }">
              {{ staleCount }}
            </span>
          </div>
      <div class="section-desc">长时间未更新的页面（默认 30 天）</div>
      <div v-if="staleCount > 0" class="issue-list">
            <div v-for="p in report.stale" :key="p" class="issue-item">
              <code>{{ p }}</code>
            </div>
          </div>
      <div v-else class="no-issue">▸ 无过期页面</div>
        </div>

        <!-- 修复进度日志 -->
        <div v-if="fixLogs.length > 0" class="fix-log-section">
          <div class="section-head">
            <span class="section-icon icon-fix">⚡</span>
            <span class="section-title">修复进度</span>
          </div>
      <div class="fix-log-list">
            <div
              v-for="(log, idx) in fixLogs"
              :key="idx"
              class="fix-log-item"
              :class="log.status"
            >
              <span class="log-step">{{ log.step }}</span>
              <span class="log-message">{{ log.message }}</span>
              <span v-if="log.tool" class="log-tool">{{ log.tool }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
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

/* section 内的"修复本类"按钮：小型化，避免与 section-count 拥挤 */
.batch-section-btn {
  margin-left: auto;
}

/* 批量修复进度条容器 */
.batch-progress-bar {
  position: relative;
  z-index: 1;
  margin-bottom: 20px;
  padding: 14px 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-pink-a30);
  border-radius: var(--radius-card);
}

.batch-progress-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.batch-progress-label {
  color: var(--neon-magenta);
  letter-spacing: 0.08em;
}

.batch-progress-count {
  color: var(--text-bright);
  font-weight: 700;
}

/* 已完成问题项：青色高亮边框 + 半透明背景，与未完成项区分 */
.issue-item.issue-done {
  background: var(--accent-cyan-a10);
  border-color: var(--accent-cyan-a40);
}

.issue-item.issue-done code {
  opacity: 0.7;
}

.head-text {
  flex: 1;
}

.head-tag {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--neon-cyan);
  text-transform: uppercase;
  margin-bottom: 2px;
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

/* 不同问题类型用不同霓虹色 */
.icon-orphan { color: var(--neon-magenta); text-shadow: 0 0 8px var(--neon-magenta); }
.icon-broken { color: var(--neon-purple); text-shadow: 0 0 8px var(--neon-purple); }
.icon-stale { color: var(--neon-cyan); text-shadow: 0 0 8px var(--neon-cyan); }
.icon-fix { color: var(--neon-lime); text-shadow: 0 0 8px var(--neon-lime); }

.section-title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.03em;
  flex: 1;
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

.issue-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.issue-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  background: var(--accent-purple-a08);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-input);
  font-size: 13px;
  transition: all 0.25s ease;
}

.issue-item:hover {
  background: var(--accent-purple-a15);
  border-color: var(--accent-purple-a40);
  transform: translateX(4px);
}

.issue-item code {
  padding: 3px 10px;
  background: var(--accent-cyan-a10);
  border: 1px solid var(--accent-cyan-a25);
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--neon-cyan);
}

.issue-item.broken .arrow {
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.broken-target {
  color: var(--neon-magenta) !important;
  border-color: var(--accent-pink-a40) !important;
  background: var(--accent-pink-a10) !important;
  font-weight: 600;
}

.no-issue {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--neon-lime);
  padding: 8px 0;
  letter-spacing: 0.03em;
}

.fix-log-section {
  padding: 18px 22px;
  background: var(--bg-scene);
  border: 1px solid rgba(193, 255, 62, 0.25);
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
  background: rgba(193, 255, 62, 0.08);
  border: 1px solid rgba(193, 255, 62, 0.2);
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
</style>

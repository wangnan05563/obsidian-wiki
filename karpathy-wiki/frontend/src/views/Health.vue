<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { Warning, CircleCheck, Tools } from '@element-plus/icons-vue';
import type { HealthReport, FixRequest, FixProgressEvent } from '../types';
import { apiErrorMessage } from '../utils/apiError';

const report = ref<HealthReport | null>(null);
const loading = ref(false);

// 修复状态：fixing 标记当前正在修复的问题 key（格式：orphan:path 或 broken:idx）
const fixingKey = ref<string>('');
// 修复进度日志（时间线展示）
const fixLogs = ref<FixProgressEvent[]>([]);

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
    fixLogs.value.push(parsed);
    return;
  }
  if (eventType === 'done') {
    fixLogs.value.push(parsed);
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
  fixingKey.value = key;
  fixLogs.value = [];
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
    fixingKey.value = '';
  }
}

onMounted(() => {
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
        <el-button size="small" class="neon-btn" :loading="loading" @click="runCheck">重新体检</el-button>
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
          </div>
      <div class="section-desc">没有任何页面通过 [[链接]] 指向它们</div>
      <div v-if="orphanCount > 0" class="issue-list">
            <div v-for="p in report.orphans" :key="p" class="issue-item">
              <code>{{ p }}</code>
              <el-button
                size="small"
                class="neon-btn"
                :loading="fixingKey === `orphan:${p}`"
                :disabled="fixingKey !== ''"
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
          </div>
      <div class="section-desc">指向不存在页面的 [[链接]]</div>
      <div v-if="brokenCount > 0" class="issue-list">
            <div v-for="(b, idx) in report.brokenLinks" :key="idx" class="issue-item broken">
              <code>{{ b.from }}</code>
              <span class="arrow">⟶</span>
              <code class="broken-target">[[{{ b.to }}]]</code>
              <el-button
                size="small"
                class="neon-btn"
                :loading="fixingKey === `broken:${idx}`"
                :disabled="fixingKey !== ''"
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

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { Warning, CircleCheck, Loading } from '@element-plus/icons-vue';
import RobotAvatar from '../components/RobotAvatar.vue';
import type { HealthReport } from '../types';

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
    ElMessage.error('体检失败：' + (err as Error).message);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  runCheck();
});
</script>

<template>
  <div class="health-page">
    <div class="glass-card health-card">
      <div class="health-head">
        <RobotAvatar :size="56" :floating="loading" />
        <div class="head-text">
          <h2 class="head-title">知识库体检</h2>
          <p class="head-tip">检测孤立页面、断链与过期内容</p>
        </div>
        <el-button size="small" :loading="loading" @click="runCheck">重新体检</el-button>
      </div>

      <!-- 体检结果摘要 -->
      <div v-if="report" class="summary-bar">
        <div class="summary-item" :class="healthStatus">
          <el-icon v-if="healthStatus === 'healthy'"><CircleCheck /></el-icon>
          <el-icon v-else><Warning /></el-icon>
          <span class="summary-text">
            {{ healthStatus === 'healthy' ? '知识库状态良好' : `发现 ${totalIssues} 个问题` }}
          </span>
        </div>
      </div>

      <!-- 加载中 -->
      <div v-if="loading" class="health-loading">
        <RobotAvatar :size="100" :floating="true" />
        <p>正在体检中…</p>
      </div>

      <!-- 体检详情 -->
      <div v-else-if="report" class="health-body">
        <!-- 孤立页面 -->
        <div class="issue-section">
          <div class="section-head">
            <span class="section-icon">🏝️</span>
            <span class="section-title">孤立页面</span>
            <span class="section-count" :class="{ 'has-issue': orphanCount > 0 }">
              {{ orphanCount }}
            </span>
          </div>
          <div class="section-desc">没有任何页面通过 [[链接]] 指向它们</div>
          <div v-if="orphanCount > 0" class="issue-list">
            <div v-for="p in report.orphans" :key="p" class="issue-item">
              <code>{{ p }}</code>
            </div>
          </div>
          <div v-else class="no-issue">无孤立页面</div>
        </div>

        <!-- 断链 -->
        <div class="issue-section">
          <div class="section-head">
            <span class="section-icon">🔗</span>
            <span class="section-title">断开链接</span>
            <span class="section-count" :class="{ 'has-issue': brokenCount > 0 }">
              {{ brokenCount }}
            </span>
          </div>
          <div class="section-desc">指向不存在页面的 [[链接]]</div>
          <div v-if="brokenCount > 0" class="issue-list">
            <div v-for="(b, idx) in report.brokenLinks" :key="idx" class="issue-item broken">
              <code>{{ b.from }}</code>
              <span class="arrow">→</span>
              <code class="broken-target">[[{{ b.to }}]]</code>
            </div>
          </div>
          <div v-else class="no-issue">无断链</div>
        </div>

        <!-- 过期页面 -->
        <div class="issue-section">
          <div class="section-head">
            <span class="section-icon">⏰</span>
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
          <div v-else class="no-issue">无过期页面</div>
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
  padding: 24px 28px;
}

.health-head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.head-text {
  flex: 1;
}

.head-title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
}

.head-tip {
  margin: 0;
  color: var(--color-text-soft);
  font-size: 13px;
}

.summary-bar {
  margin-bottom: 24px;
}

.summary-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border-radius: 16px;
  font-size: 15px;
  font-weight: 600;
}

.summary-item.healthy {
  background: var(--color-cyan);
  color: var(--color-text);
}

.summary-item.warning {
  background: var(--color-yellow);
  color: var(--color-text);
}

.health-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 60px 0;
  color: var(--color-text-soft);
}

.health-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.issue-section {
  padding: 18px 22px;
  background: rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-card);
}

.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.section-icon {
  font-size: 20px;
}

.section-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text);
}

.section-count {
  padding: 2px 12px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 700;
  background: var(--color-cyan);
  color: var(--color-text);
}

.section-count.has-issue {
  background: var(--color-error);
  color: #fff;
}

.section-desc {
  font-size: 12px;
  color: var(--color-text-soft);
  margin-bottom: 12px;
}

.issue-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.issue-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--color-pink);
  border-radius: 10px;
  font-size: 13px;
}

.issue-item code {
  padding: 2px 8px;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 6px;
  font-size: 12px;
  font-family: 'Courier New', monospace;
}

.issue-item.broken .arrow {
  color: var(--color-text-soft);
}

.broken-target {
  color: var(--color-error) !important;
  font-weight: 600;
}

.no-issue {
  font-size: 13px;
  color: var(--color-text-soft);
  padding: 8px 0;
}
</style>

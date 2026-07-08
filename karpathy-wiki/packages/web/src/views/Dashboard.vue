<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import RobotAvatar from '../components/RobotAvatar.vue';
import type { StatsData } from '../types';

// 定义 emit：快捷入口跳转
const emit = defineEmits<{
  (e: 'navigate', view: 'ingest' | 'browse' | 'query' | 'health'): void;
}>();

const stats = ref<StatsData | null>(null);
const loading = ref(false);
const initializing = ref(false);

// 目录中文名映射
const DIR_LABELS: Record<string, string> = {
  entities: '实体',
  concepts: '概念',
  comparisons: '对比',
  queries: '问答',
};

// 是否有内容
const hasContent = computed(() => (stats.value?.totalPages ?? 0) > 0);

// 加载统计数据
async function loadStats() {
  loading.value = true;
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    stats.value = await res.json();
  } catch (err) {
    ElMessage.error('加载统计失败：' + (err as Error).message);
  } finally {
    loading.value = false;
  }
}

// §6.9 演示模式：初始化 Vault 目录结构
// 调用 POST /api/vault/init 创建标准目录（entities/concepts/comparisons/queries）
async function initVault() {
  initializing.value = true;
  try {
    const res = await fetch('/api/vault/init', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    ElMessage.success('知识库已初始化，开始投递资料吧');
    await loadStats();
  } catch (err) {
    ElMessage.error('初始化失败：' + (err as Error).message);
  } finally {
    initializing.value = false;
  }
}

onMounted(() => {
  loadStats();
});
</script>

<template>
  <div class="dashboard-page">
    <!-- 欢迎区 -->
    <div class="glass-card welcome-card">
      <div class="welcome-left">
        <RobotAvatar :size="100" :floating="true" />
        <div class="welcome-text">
          <h2 class="welcome-title">欢迎使用 Karpathy AI 知识库</h2>
          <p class="welcome-tip">
            投递资料自动编译为结构化 Wiki 页面，基于页面内容智能问答
          </p>
        </div>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-row">
      <div class="glass-card stat-card">
        <div class="stat-icon">📄</div>
        <div class="stat-num">{{ stats?.totalPages ?? 0 }}</div>
        <div class="stat-label">总页面数</div>
      </div>
      <div class="glass-card stat-card">
        <div class="stat-icon">🔗</div>
        <div class="stat-num">{{ stats?.totalLinks ?? 0 }}</div>
        <div class="stat-label">双向链接</div>
      </div>
      <div class="glass-card stat-card">
        <div class="stat-icon">📚</div>
        <div class="stat-num">{{ stats?.dirCounts?.entities ?? 0 }}</div>
        <div class="stat-label">实体页</div>
      </div>
      <div class="glass-card stat-card">
        <div class="stat-icon">💡</div>
        <div class="stat-num">{{ stats?.dirCounts?.concepts ?? 0 }}</div>
        <div class="stat-label">概念页</div>
      </div>
    </div>

    <!-- 目录分布与快捷入口 -->
    <div class="bottom-row">
      <!-- 目录分布 -->
      <div class="glass-card section-card">
        <h3 class="section-title">目录分布</h3>
        <div v-if="stats" class="dir-list">
          <div v-for="(count, dir) in stats.dirCounts" :key="dir" class="dir-item">
            <span class="dir-label">{{ DIR_LABELS[dir] || dir }}</span>
            <div class="dir-bar-bg">
              <div
                class="dir-bar-fill"
                :style="{ width: Math.min(100, count * 10) + '%' }"
              ></div>
            </div>
            <span class="dir-count">{{ count }}</span>
          </div>
        </div>
        <div v-else class="section-loading">加载中…</div>
      </div>

      <!-- 快捷入口 -->
      <div class="glass-card section-card">
        <h3 class="section-title">快捷入口</h3>
        <div class="shortcut-grid">
          <div class="shortcut-item" @click="emit('navigate', 'ingest')">
            <span class="shortcut-icon">📥</span>
            <span class="shortcut-label">投递资料</span>
          </div>
          <div class="shortcut-item" @click="emit('navigate', 'browse')">
            <span class="shortcut-icon">📂</span>
            <span class="shortcut-label">浏览知识库</span>
          </div>
          <div class="shortcut-item" @click="emit('navigate', 'query')">
            <span class="shortcut-icon">💬</span>
            <span class="shortcut-label">智能问答</span>
          </div>
          <div class="shortcut-item" @click="emit('navigate', 'health')">
            <span class="shortcut-icon">🩺</span>
            <span class="shortcut-label">知识库体检</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 最近操作日志 -->
    <div v-if="stats?.recentLog" class="glass-card section-card">
      <h3 class="section-title">最近操作</h3>
      <pre class="recent-log">{{ stats.recentLog }}</pre>
    </div>

    <!-- 空状态引导 -->
    <div v-if="!hasContent && !loading" class="glass-card empty-guide">
      <RobotAvatar :size="80" />
      <p class="guide-text">知识库还是空的，先初始化目录结构，再投递第一份资料</p>
      <div class="guide-actions">
        <el-button type="primary" :loading="initializing" @click="initVault">初始化知识库</el-button>
        <el-button @click="emit('navigate', 'ingest')">立即投递</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.welcome-card {
  padding: 28px 32px;
}

.welcome-left {
  display: flex;
  align-items: center;
  gap: 20px;
}

.welcome-title {
  margin: 0 0 8px;
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text);
}

.welcome-tip {
  margin: 0;
  color: var(--color-text-soft);
  font-size: 14px;
  line-height: 1.6;
}

.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.stat-card {
  padding: 20px;
  text-align: center;
}

.stat-icon {
  font-size: 28px;
  margin-bottom: 8px;
}

.stat-num {
  font-size: 28px;
  font-weight: 700;
  color: var(--color-primary-deep);
  line-height: 1;
  margin-bottom: 4px;
}

.stat-label {
  font-size: 13px;
  color: var(--color-text-soft);
}

.bottom-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.section-card {
  padding: 22px 26px;
}

.section-title {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text);
}

.section-loading {
  color: var(--color-text-soft);
  font-size: 13px;
  padding: 20px 0;
  text-align: center;
}

.dir-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dir-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dir-label {
  width: 60px;
  font-size: 13px;
  color: var(--color-text);
  flex-shrink: 0;
}

.dir-bar-bg {
  flex: 1;
  height: 10px;
  background: rgba(255, 255, 255, 0.5);
  border-radius: 5px;
  overflow: hidden;
}

.dir-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--color-pink), var(--color-primary));
  border-radius: 5px;
  transition: width 0.3s ease;
}

.dir-count {
  width: 30px;
  text-align: right;
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text);
}

.shortcut-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.shortcut-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 8px;
  background: rgba(255, 255, 255, 0.4);
  border-radius: var(--radius-card);
  cursor: pointer;
  transition: all 0.2s ease;
}

.shortcut-item:hover {
  background: var(--color-pink);
  transform: translateY(-2px);
}

.shortcut-icon {
  font-size: 28px;
}

.shortcut-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}

.recent-log {
  margin: 0;
  padding: 14px 18px;
  background: rgba(74, 59, 71, 0.06);
  border-radius: 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-soft);
  font-family: 'Courier New', monospace;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.empty-guide {
  padding: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  text-align: center;
}

.guide-text {
  margin: 0;
  color: var(--color-text-soft);
  font-size: 14px;
}

.guide-actions {
  display: flex;
  gap: 12px;
}
</style>

<script setup lang="ts">
import { API_BASE, apiFetch } from '../utils/apiBase';
import { ref, onMounted, computed, markRaw } from 'vue';
import { ElMessage } from 'element-plus';
import { Aim, Connection, CaretTop, Star, Clock } from '@element-plus/icons-vue';
import NavIcons from '../components/NavIcons.vue';
import type { StatsData, RunSummary } from '../types';
import { useCompileStore } from '../stores/compile';

// 使用函数类型写法替代类型字面量（S6598）
const emit = defineEmits<(e: 'navigate', view: 'ingest' | 'browse' | 'query' | 'health' | 'progress' | 'graph' | 'help') => void>();

const stats = ref<StatsData | null>(null);
const loading = ref(false);
const initializing = ref(false);

// FR-14-3 运行历史：复用 compile store 的 runs 数据
const compileStore = useCompileStore();
const recentRuns = computed(() => compileStore.runs.slice(0, 8));
const runsLoading = ref(false);

const DIR_LABELS: Record<string, string> = {
  entities: '实体',
  concepts: '概念',
  comparisons: '对比',
  queries: '问答',
};

const STATUS_LABELS: Record<RunSummary['status'], string> = {
  done: '成功',
  failed: '失败',
  running: '运行中',
};

const hasContent = computed(() => (stats.value?.totalPages ?? 0) > 0);

async function loadStats() {
  loading.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/stats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    stats.value = await res.json();
  } catch (err) {
    ElMessage.error('加载统计失败：' + (err as Error).message);
  } finally {
    loading.value = false;
  }
}

// FR-14-3 加载运行历史（复用 compile store）
async function loadRuns() {
  runsLoading.value = true;
  try {
    await compileStore.loadRuns();
  } catch (err) {
    ElMessage.error('加载运行历史失败：' + (err as Error).message);
  } finally {
    runsLoading.value = false;
  }
}

async function initVault() {
  initializing.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/vault/init`, { method: 'POST' });
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

// 相对时间格式化：将 ISO 时间戳转为 "3 分钟前" 等友好展示
// 为什么不引入第三方库：Dashboard 是轻量级首页，零依赖原则
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return iso.slice(0, 10);
}

onMounted(() => {
  loadStats();
  loadRuns();
});
</script>

<template>
  <div class="dashboard-page">
    <!-- 不对称英雄区：左侧机器人 + 右侧标题，破格倾斜 -->
    <div class="glass-card welcome-card fade-up">
      <div class="welcome-right">
        <h2 class="welcome-title grad-text">Karpathy AI 知识库</h2>
        <p class="welcome-tip">
          投递资料自动编译为结构化 Wiki 页面，基于页面内容智能问答
        </p>
        <div class="welcome-stats" v-if="stats">
          <span class="ws-item"><strong>{{ stats.totalPages }}</strong> 页面</span>
          <span class="ws-dot"></span>
          <span class="ws-item"><strong>{{ stats.totalLinks }}</strong> 链接</span>
        </div>
      </div>
    </div>

    <!-- 统计卡片：不对称网格 + 3D 悬停 -->
    <div class="stats-row">
      <div
        v-for="(card, idx) in [
          { icon: markRaw(Aim), num: stats?.totalPages ?? 0, label: '总页面数', grad: 'grad-fire' },
          { icon: markRaw(Connection), num: stats?.totalLinks ?? 0, label: '双向链接', grad: 'grad-cool' },
          { icon: markRaw(CaretTop), num: stats?.dirCounts?.entities ?? 0, label: '实体页', grad: 'grad-neon' },
          { icon: markRaw(Star), num: stats?.dirCounts?.concepts ?? 0, label: '概念页', grad: 'grad-aurora' },
        ]"
        :key="idx"
        class="glass-card stat-card hover-3d fade-up"
        :style="{ animationDelay: (idx * 0.1) + 's' }"
      >
        <div class="stat-icon" :class="card.grad"><el-icon><component :is="card.icon" /></el-icon></div>
      <div class="stat-num grad-text">{{ card.num }}</div>
      <div class="stat-label">{{ card.label }}</div>
      </div>
    </div>

    <!-- 不对称底部：目录分布偏左 + 快捷入口偏右 -->
    <div class="bottom-row">
      <div class="glass-card section-card hover-glow fade-up" style="animation-delay: 0.3s">
        <h3 class="section-title">
          <span class="title-bracket">[</span> 目录分布 <span class="title-bracket">]</span>
        </h3>
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
      <div v-else class="section-loading">LOADING...</div>
      </div>
      <div class="glass-card section-card hover-glow fade-up" style="animation-delay: 0.4s">
        <h3 class="section-title">
          <span class="title-bracket">[</span> 快捷入口 <span class="title-bracket">]</span>
        </h3>
        <div class="shortcut-grid">
          <div
            v-for="(sc, idx) in [
              { icon: 'browse', label: '知识浏览', view: 'browse' },
              { icon: 'query', label: '知识问答', view: 'query' },
              { icon: 'graph', label: '知识图谱', view: 'graph' },
              { icon: 'help', label: '帮助文档', view: 'help' },
            ]"
            :key="idx"
            class="shortcut-item hover-3d"
            @click="emit('navigate', sc.view as 'browse' | 'query' | 'graph' | 'help')"
          >
            <span class="shortcut-icon"><NavIcons :name="sc.icon" :size="28" /></span>
            <span class="shortcut-label">{{ sc.label }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 最近操作日志 -->
    <div v-if="stats?.recentLog" class="glass-card section-card fade-up">
      <h3 class="section-title">
        <span class="title-bracket">[</span> 最近操作 <span class="title-bracket">]</span>
      </h3>
      <pre class="recent-log">{{ stats.recentLog }}</pre>
    </div>

    <!-- FR-14-3 运行历史：Dashboard 可视化列表 -->
    <div v-if="recentRuns.length > 0" class="glass-card section-card fade-up">
      <h3 class="section-title">
        <span class="title-bracket">[</span> 运行历史 <span class="title-bracket">]</span>
      </h3>
      <div class="run-list">
        <div
          v-for="run in recentRuns"
          :key="run.runId"
          class="run-item"
          @click="emit('navigate', 'progress')"
        >
          <span class="run-status-badge" :class="'status-' + run.status">
            {{ STATUS_LABELS[run.status] }}
          </span>
          <span class="run-id" :title="run.runId">{{ run.runId.slice(0, 8) }}</span>
          <span class="run-stats">
            <span class="run-stat"><el-icon><Clock /></el-icon>{{ run.step }} 步</span>
            <span class="run-stat">{{ run.tokenUsed }} tokens</span>
          </span>
          <span class="run-time">{{ timeAgo(run.startedAt) }}</span>
        </div>
      </div>
      <div v-if="compileStore.runs.length > 8" class="run-more">
        <el-button text size="small" data-tip="查看全部编译历史记录" @click="emit('navigate', 'progress')">
          查看全部 {{ compileStore.runs.length }} 条记录
        </el-button>
      </div>
    </div>

    <!-- 历史为空时不展示（仅当已加载且知识库有内容时） -->
    <div v-else-if="hasContent && !runsLoading" class="glass-card section-card fade-up">
      <h3 class="section-title">
        <span class="title-bracket">[</span> 运行历史 <span class="title-bracket">]</span>
      </h3>
      <p class="run-empty">暂无运行记录，投递资料开始编译后将会在此显示</p>
    </div>

    <!-- 空状态引导 -->
    <div v-if="!hasContent && !loading" class="glass-card empty-guide fade-up">
      <p class="guide-text">知识库还是空的，先初始化目录结构，再投递第一份资料</p>
      <div class="guide-actions">
        <el-button type="primary" data-tip="初始化 vault 目录结构与基础配置" :loading="initializing" @click="initVault">初始化知识库</el-button>
        <el-button data-tip="前往投递页，开始投递第一份资料" @click="emit('navigate', 'ingest')">立即投递</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard-page {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* 英雄区：不对称布局，左侧机器人偏小，右侧文字偏大 */
.welcome-card {
  padding: 16px 32px;
  position: relative;
  overflow: hidden;
}

/* 破格背景：倾斜渐变块 */
.welcome-bg {
  position: absolute;
  top: -60px;
  right: -60px;
  width: 320px;
  height: 320px;
  background: var(--grad-aurora);
  opacity: 0.12;
  transform: rotate(-15deg);
  border-radius: 48px;
  pointer-events: none;
}


.welcome-right {
  display: inline-block;
  vertical-align: middle;
  max-width: 560px;
}

.welcome-tag {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-cyan);
  letter-spacing: 2px;
  display: block;
  margin-bottom: 8px;
}

.welcome-title {
  margin: 0 0 6px;
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 900;
  letter-spacing: 1px;
  line-height: 1.1;
}


.welcome-tip {
  margin: 0 0 16px;
  color: var(--text-soft);
  font-size: 15px;
  line-height: 1.7;
}

.welcome-stats {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--text-soft);
  font-family: var(--font-mono);
}

.welcome-stats strong {
  color: var(--neon-magenta);
}

/* 统计卡片：4 列网格 */
.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 18px;
}

.stat-card {
  padding: 24px 20px;
  text-align: center;
  cursor: pointer;
}

.stat-icon {
  font-size: 24px;
  margin-bottom: 12px;
  display: inline-block;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.stat-icon.grad-fire { background: var(--grad-fire); }
.stat-icon.grad-cool { background: var(--grad-cool); }
.stat-icon.grad-neon { background: var(--grad-neon); }
.stat-icon.grad-aurora { background: var(--grad-aurora); }

.stat-num {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 900;
  line-height: 1;
  margin-bottom: 6px;
}

.stat-label {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-soft);
  letter-spacing: 2px;
  text-transform: uppercase;
}

/* 底部行：不对称 6:4 比例 */
.bottom-row {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 24px;
}

.section-card {
  padding: 24px 28px;
}

.section-title {
  margin: 0 0 18px;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 1px;
}

.title-bracket {
  color: var(--neon-magenta);
  font-weight: 400;
}

.section-loading {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 20px 0;
  text-align: center;
  letter-spacing: 2px;
}

.dir-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dir-item {
  display: flex;
  align-items: center;
  gap: 14px;
}

.dir-label {
  width: 60px;
  font-size: 13px;
  color: var(--text-base);
  flex-shrink: 0;
  font-weight: 600;
}

.dir-bar-bg {
  flex: 1;
  height: 8px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--accent-purple-a15, rgba(176, 38, 255, 0.15));
}

/* 流光进度条 */
.dir-bar-fill {
  height: 100%;
  background: var(--grad-fire);
  background-size: 40px 100%;
  border-radius: 4px;
  transition: width 0.5s cubic-bezier(0.23, 1, 0.32, 1);
  box-shadow: 0 0 12px var(--accent-pink-a50, rgba(255, 0, 110, 0.5));
  animation: flow 1.5s linear infinite;
}

.dir-count {
  width: 36px;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 700;
  color: var(--neon-cyan);
}

/* 快捷入口网格 */
.shortcut-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.shortcut-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 22px 12px;
  background: var(--accent-purple-a06, rgba(176, 38, 255, 0.06));
  border: 1px solid var(--accent-purple-a15, rgba(176, 38, 255, 0.15));
  border-radius: var(--radius-card);
  cursor: pointer;
  transition: all 0.3s ease;
}

.shortcut-item:hover {
  background: var(--accent-purple-a12, rgba(176, 38, 255, 0.12));
  border-color: var(--neon-purple);
}

.shortcut-icon {
  font-size: 28px;
  color: var(--neon-cyan);
  text-shadow: var(--glow-cyan);
  font-family: var(--font-display);
}

.shortcut-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-base);
  letter-spacing: 0.5px;
}

.recent-log {
  margin: 0;
  padding: 16px 20px;
  /* 使用主题场景背景变量，确保深浅主题下都有合适对比度 */
  background: var(--bg-scene);
  border: 1px solid var(--accent-cyan-a15);
  border-radius: 14px;
  font-size: 12px;
  line-height: 1.7;
  /* 使用 text-base 提升日志文字辨识度 */
  color: var(--text-base);
  font-family: var(--font-mono);
  max-height: 220px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.empty-guide {
  padding: 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  text-align: center;
}

.guide-text {
  margin: 0;
  color: var(--text-soft);
  font-size: 15px;
}

.guide-actions {
  display: flex;
  gap: 14px;
}

/* FR-14-3 运行历史列表样式 */
.run-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.run-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--accent-purple-a06, rgba(176, 38, 255, 0.06));
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.2s ease;
}

.run-item:hover {
  background: var(--accent-purple-a12, rgba(176, 38, 255, 0.12));
  border-color: var(--accent-purple-a20, rgba(176, 38, 255, 0.2));
}

.run-status-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  letter-spacing: 0.5px;
}

.status-done {
  color: #22c55e;
  background: rgba(34, 197, 94, 0.1);
}

.status-failed {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.status-running {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.1);
  animation: pulse 1.5s ease-in-out infinite;
}

.run-id {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
  flex-shrink: 0;
}

.run-stats {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1;
}

.run-stat {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 4px;
}

.run-stat .el-icon {
  font-size: 13px;
}

.run-time {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
  white-space: nowrap;
}

.run-more {
  margin-top: 12px;
  text-align: center;
}

.run-empty {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
  text-align: center;
  padding: 16px 0;
}

@media (max-width: 900px) {
  .stats-row { grid-template-columns: repeat(2, 1fr); }
  .bottom-row { grid-template-columns: 1fr; }
  .welcome-left, .welcome-right { display: block; margin: 0 0 16px; }
}
</style>

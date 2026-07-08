<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import RobotAvatar from '../components/RobotAvatar.vue';
import type { StatsData } from '../types';

const emit = defineEmits<{
  (e: 'navigate', view: 'ingest' | 'browse' | 'query' | 'health'): void;
}>();

const stats = ref<StatsData | null>(null);
const loading = ref(false);
const initializing = ref(false);

const DIR_LABELS: Record<string, string> = {
  entities: '实体',
  concepts: '概念',
  comparisons: '对比',
  queries: '问答',
};

const hasContent = computed(() => (stats.value?.totalPages ?? 0) > 0);

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
    <!-- 不对称英雄区：左侧机器人 + 右侧标题，破格倾斜 -->
    <div class="glass-card welcome-card fade-up">
      <div class="welcome-bg"></div>
      <div class="welcome-left">
        <RobotAvatar :size="110" :floating="true" />
      </div>
      <div class="welcome-right">
        <span class="welcome-tag">// KNOWLEDGE ENGINE</span>
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
          { icon: '◈', num: stats?.totalPages ?? 0, label: '总页面数', grad: 'grad-fire' },
          { icon: '⬡', num: stats?.totalLinks ?? 0, label: '双向链接', grad: 'grad-cool' },
          { icon: '▲', num: stats?.dirCounts?.entities ?? 0, label: '实体页', grad: 'grad-neon' },
          { icon: '✦', num: stats?.dirCounts?.concepts ?? 0, label: '概念页', grad: 'grad-aurora' },
        ]"
        :key="idx"
        class="glass-card stat-card hover-3d fade-up"
        :style="{ animationDelay: (idx * 0.1) + 's' }"
      >
        <div class="stat-icon" :class="card.grad">{{ card.icon }}</div>
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
              { icon: '↓', label: '投递资料', view: 'ingest' },
              { icon: '◎', label: '浏览知识库', view: 'browse' },
              { icon: '✧', label: '智能问答', view: 'query' },
              { icon: '◎', label: '知识库体检', view: 'health' },
            ]"
            :key="idx"
            class="shortcut-item hover-3d"
            @click="emit('navigate', sc.view as 'ingest' | 'browse' | 'query' | 'health')"
          >
            <span class="shortcut-icon">{{ sc.icon }}</span>
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

    <!-- 空状态引导 -->
    <div v-if="!hasContent && !loading" class="glass-card empty-guide fade-up">
      <RobotAvatar :size="90" />
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
  gap: 24px;
}

/* 英雄区：不对称布局，左侧机器人偏小，右侧文字偏大 */
.welcome-card {
  padding: 36px 40px;
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

.welcome-left {
  display: inline-block;
  vertical-align: middle;
  margin-right: 32px;
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
  margin: 0 0 12px;
  font-family: var(--font-display);
  font-size: 36px;
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
  font-size: 18px;
  font-weight: 700;
}

.ws-dot {
  width: 4px;
  height: 4px;
  background: var(--neon-purple);
  border-radius: 50%;
  box-shadow: var(--glow-purple);
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
  font-size: 32px;
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
  font-size: 36px;
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
  border: 1px solid rgba(176, 38, 255, 0.15);
}

/* 流光进度条 */
.dir-bar-fill {
  height: 100%;
  background: var(--grad-fire);
  background-size: 40px 100%;
  border-radius: 4px;
  transition: width 0.5s cubic-bezier(0.23, 1, 0.32, 1);
  box-shadow: 0 0 12px rgba(255, 0, 110, 0.5);
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
  background: rgba(176, 38, 255, 0.06);
  border: 1px solid rgba(176, 38, 255, 0.15);
  border-radius: var(--radius-card);
  cursor: pointer;
  transition: all 0.3s ease;
}

.shortcut-item:hover {
  background: rgba(176, 38, 255, 0.12);
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
  background: rgba(5, 0, 16, 0.6);
  border: 1px solid rgba(0, 245, 255, 0.15);
  border-radius: 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-soft);
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

@media (max-width: 900px) {
  .stats-row { grid-template-columns: repeat(2, 1fr); }
  .bottom-row { grid-template-columns: 1fr; }
  .welcome-left, .welcome-right { display: block; margin: 0 0 16px; }
}
</style>

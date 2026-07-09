<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import RobotAvatar from './components/RobotAvatar.vue';
import ThemeSwitcher from './components/ThemeSwitcher.vue';
import Dashboard from './views/Dashboard.vue';
import Ingest from './views/Ingest.vue';
import Progress from './views/Progress.vue';
import Browse from './views/Browse.vue';
import Query from './views/Query.vue';
import Graph from './views/Graph.vue';
import Health from './views/Health.vue';
import Config from './views/Config.vue';
import { useCompileStore } from './stores/compile';

type ViewName = 'dashboard' | 'ingest' | 'progress' | 'browse' | 'query' | 'graph' | 'health' | 'config';

const store = useCompileStore();
const currentView = ref<ViewName>('dashboard');

// 滚动视差：监听滚动位置，通过 CSS 变量驱动背景层位移
const scrollY = ref(0);
function handleScroll() {
  // 使用 rAF 节流，避免高频触发导致掉帧
  scrollY.value = window.scrollY;
}

function go(view: ViewName) {
  currentView.value = view;
}

function handleNavigate(view: 'ingest' | 'browse' | 'query' | 'health') {
  currentView.value = view;
}

onMounted(() => {
  window.addEventListener('scroll', handleScroll, { passive: true });
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', handleScroll);
});
</script>

<template>
  <!-- 视差背景层：4 层叠加，通过 scrollY 驱动不同速率位移 -->
  <div class="bg-layer base" :style="{ transform: `translateY(${scrollY * 0.15}px)` }"></div>
  <div class="bg-layer grid" :style="{ transform: `translateY(${scrollY * 0.08}px)` }"></div>
  <div class="bg-layer noise"></div>
  <div class="bg-layer orbs parallax" :style="{ transform: `translateY(${scrollY * 0.25}px)` }"></div>

  <div class="app-shell">
    <!-- 不对称导航：左侧 Logo + 右侧标签，破格倾斜装饰 -->
    <header class="nav glass-card">
      <div class="nav-deco"></div>
      <div class="nav-left" @click="go('dashboard')">
        <RobotAvatar :size="46" />
        <div class="nav-title-wrap">
          <span class="title grad-text">AI 知识库</span>
          <span class="subtitle">KARPATHY WIKI</span>
        </div>
      </div>
      <nav class="nav-tabs">
        <button
          v-for="tab in [
            { key: 'dashboard', label: '仪表盘' },
            { key: 'ingest', label: '投递资料' },
            { key: 'progress', label: '编译进度' },
            { key: 'browse', label: '知识浏览' },
            { key: 'query', label: '知识问答' },
            { key: 'graph', label: '图谱' },
            { key: 'health', label: '体检' },
            { key: 'config', label: '配置' },
          ]"
          :key="tab.key"
          class="tab-btn hover-glow"
          :class="{
            active: currentView === tab.key,
            disabled: tab.key === 'progress' && !store.isCompiling && !store.isDone
          }"
          :disabled="tab.key === 'progress' && !store.isCompiling && !store.isDone"
          @click="go(tab.key as ViewName)"
        >
          <span class="tab-label">{{ tab.label }}</span>
        </button>
      </nav>
    </header>

    <main class="content">
      <Dashboard v-if="currentView === 'dashboard'" @navigate="handleNavigate" />
      <Ingest v-else-if="currentView === 'ingest'" @start="go('progress')" />
      <Progress v-else-if="currentView === 'progress'" @restart="go('ingest')" />
      <Browse v-else-if="currentView === 'browse'" />
      <Query v-else-if="currentView === 'query'" />
      <Graph v-else-if="currentView === 'graph'" />
      <Health v-else-if="currentView === 'health'" />
      <Config v-else-if="currentView === 'config'" />
    </main>

    <footer class="footer">
      <span class="footer-line"></span>
      <span class="footer-text">POWERED BY KARPATHY AI · 知识库垂直切片</span>
      <span class="footer-line"></span>
    </footer>
  </div>

  <!-- 主题切换器：浮动按钮，右下角 -->
  <ThemeSwitcher />
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 24px;
  gap: 24px;
  max-width: 1280px;
  margin: 0 auto;
  position: relative;
}

/* 导航：不对称布局，左侧 Logo 偏大，右侧标签紧凑 */
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 28px;
  position: relative;
  overflow: hidden;
}

/* 破格装饰：右下角倾斜渐变块 */
.nav-deco {
  position: absolute;
  top: -20px;
  right: -20px;
  width: 180px;
  height: 180px;
  background: var(--grad-fire);
  opacity: 0.08;
  transform: rotate(25deg);
  border-radius: 32px;
  pointer-events: none;
}

.nav-left {
  display: flex;
  align-items: center;
  gap: 14px;
  cursor: pointer;
  z-index: 1;
  transition: transform 0.3s ease;
}

.nav-left:hover {
  transform: translateX(4px);
}

.nav-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 1px;
  line-height: 1;
}

.subtitle {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--neon-cyan);
  letter-spacing: 3px;
  opacity: 0.8;
}

.nav-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  z-index: 1;
}

.tab-btn {
  position: relative;
  border: none;
  background: transparent;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-body);
  color: var(--text-soft);
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.23, 1, 0.32, 1);
  letter-spacing: 0.5px;
  overflow: hidden;
}

.tab-btn:hover:not(.disabled) {
  color: var(--neon-cyan);
  background: rgba(0, 245, 255, 0.08);
  transform: translateY(-2px);
  text-shadow: 0 0 12px rgba(0, 245, 255, 0.6);
}

/* 激活态：渐变背景 + 发光 */
.tab-btn.active {
  background: var(--grad-fire);
  color: #fff;
  box-shadow: 0 4px 20px rgba(255, 0, 110, 0.4);
  text-shadow: 0 0 8px rgba(255, 255, 255, 0.5);
}

.tab-btn.active::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
  transform: translateX(-100%);
  animation: shimmer 3s infinite;
}

@keyframes shimmer {
  100% { transform: translateX(100%); }
}

.tab-btn.disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.content {
  flex: 1;
  position: relative;
  z-index: 1;
}

/* 页脚：赛博风分割线 */
.footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 0;
}

.footer-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--neon-purple), transparent);
}

.footer-text {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
  letter-spacing: 2px;
  white-space: nowrap;
}

/* 响应式：窄屏导航堆叠 */
@media (max-width: 900px) {
  .nav {
    flex-direction: column;
    gap: 12px;
    align-items: stretch;
  }
  .nav-tabs {
    justify-content: center;
  }
}
</style>

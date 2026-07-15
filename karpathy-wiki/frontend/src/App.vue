<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import RobotAvatar from './components/RobotAvatar.vue';
import FloatingChat from './components/FloatingChat.vue';
import Dashboard from './views/Dashboard.vue';
import Ingest from './views/Ingest.vue';
import Progress from './views/Progress.vue';
import Browse from './views/Browse.vue';
import Query from './views/Query.vue';
import Graph from './views/Graph.vue';
import Health from './views/Health.vue';
import Config from './views/Config.vue';
import Tunnel from './views/Tunnel.vue';
import Cleanup from './views/Cleanup.vue';
import { useCompileStore } from './stores/compile';

type ViewName = 'dashboard' | 'ingest' | 'progress' | 'browse' | 'query' | 'graph' | 'health' | 'config' | 'tunnel' | 'cleanup';

const store = useCompileStore();
const currentView = ref<ViewName>('dashboard');

// 导航栏折叠状态：折叠后隐藏 tabs，释放垂直空间放大问答框
// 持久化到 localStorage，刷新页面后保留用户偏好
const navCollapsed = ref(localStorage.getItem('navCollapsed') === 'true');
function toggleNav() {
  navCollapsed.value = !navCollapsed.value;
  localStorage.setItem('navCollapsed', String(navCollapsed.value));
}

// 监听滚动事件，更新 scrollY 变量驱动 CSS 视差效果
const scrollY = ref(0);
function handleScroll() {
  // 直接读取 scrollY，passive 模式下性能足够
  scrollY.value = window.scrollY;
}

function go(view: ViewName) {
  currentView.value = view;
}

function handleNavigate(view: 'ingest' | 'browse' | 'query' | 'health') {
  currentView.value = view;
}

// 监听 RefsList 派发的 karpathy:jump-vault 事件，切换到 browse 视图
// 由 Browse.vue 自行读取 sessionStorage.karpathy:jumpPath 完成文件定位
function handleJumpVault() {
  currentView.value = 'browse';
}

onMounted(() => {
  window.addEventListener('scroll', handleScroll, { passive: true });
  globalThis.addEventListener('karpathy:jump-vault', handleJumpVault);
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', handleScroll);
  globalThis.removeEventListener('karpathy:jump-vault', handleJumpVault);
});
</script>

<template>
  <div class="app-root">
  <!-- 背景视差层：4 层叠加，通过 scrollY 实现视差滚动 -->
  <div class="bg-layer base" :style="{ transform: `translateY(${scrollY * 0.15}px)` }"></div>
  <div class="bg-layer grid" :style="{ transform: `translateY(${scrollY * 0.08}px)` }"></div>
  <div class="bg-layer noise"></div>
  <div class="bg-layer orbs parallax" :style="{ transform: `translateY(${scrollY * 0.25}px)` }"></div>

  <div class="app-shell">
    <!-- 导航栏：左侧 Logo + 标题，右侧标签页切换。完全折叠时整个 nav 隐藏（释放全部垂直空间） -->
    <Transition name="nav-collapse">
      <header v-if="!navCollapsed" class="nav glass-card">
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
              { key: 'tunnel', label: '内网穿透' },
              { key: 'cleanup', label: '系统清理' },
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
        <!-- 折叠按钮：固定在导航栏右侧，点击后整个 nav 隐藏 -->
        <button class="nav-toggle" @click="toggleNav" title="收起菜单">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M6 15l6-6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </header>
    </Transition>
    <!-- 浮动展开按钮：nav 折叠后浮在顶部居中，纯圆形按钮，不占用布局空间 -->
    <Transition name="fab-fade">
      <button
        v-if="navCollapsed"
        class="nav-toggle-fab"
        @click="toggleNav"
        title="展开菜单"
        aria-label="展开菜单"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </Transition>

    <main class="content">
      <Dashboard v-if="currentView === 'dashboard'" @navigate="handleNavigate" />
      <Ingest v-else-if="currentView === 'ingest'" @start="go('progress')" />
      <Progress v-else-if="currentView === 'progress'" @restart="go('ingest')" />
      <Browse v-else-if="currentView === 'browse'" />
      <Query v-else-if="currentView === 'query'" />
      <Graph v-else-if="currentView === 'graph'" />
      <Health v-else-if="currentView === 'health'" />
      <Config v-else-if="currentView === 'config'" />
      <Tunnel v-else-if="currentView === 'tunnel'" />
      <Cleanup v-else-if="currentView === 'cleanup'" />
    </main>

    <footer class="footer">
      <span class="footer-line"></span>
      <span class="footer-text">POWERED BY KARPATHY AI · 知识库引擎</span>
      <span class="footer-line"></span>
    </footer>
  </div>

  <!-- 全局悬浮问答入口：在所有页面都显示，Query 页面时位置调整到左下角避免遮挡输入区 -->
  <FloatingChat :in-query-page="currentView === 'query'" />
  </div>

</template>

<style scoped>
.app-shell {
  /* 100vh 固定高度让 flex 子项能精确分配空间；overflow 由 .content 内部各页面自行管理
     不在 app-shell 层 overflow:hidden，否则其他页面（Browse/Config 等）超出内容无法滚动 */
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
  gap: 14px;
  max-width: 1440px;
  margin: 0 auto;
  position: relative;
}

/* 导航栏：水平布局，左侧 Logo 与右侧标签页 */
/* 折叠态已用 v-if 完全移除，无需 .collapsed 样式 */
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 28px;
  position: relative;
  overflow: hidden;
  transition: padding 0.3s ease;
  flex-shrink: 0;
  gap: 16px;
}

/* 折叠按钮：固定在导航栏右侧，折叠时图标旋转 180 度 */
.nav-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--accent-purple-a30);
  background: var(--bg-glass);
  color: var(--text-soft);
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: all 0.3s ease;
  flex-shrink: 0;
  z-index: 1;
}

.nav-toggle:hover {
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
  box-shadow: var(--glow-cyan);
}

.nav-toggle svg {
  transition: transform 0.3s ease;
}

/* 浮动展开按钮：导航栏完全隐藏后，浮在页面顶部居中位置的小圆按钮
   使用 absolute 定位脱离文档流，悬停时上浮 + 发光 */
.nav-toggle-fab {
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--accent-purple-a30);
  background: var(--bg-card-solid);
  color: var(--text-soft);
  border-radius: 50%;
  cursor: pointer;
  transition: all 0.3s ease;
  z-index: 100;
  backdrop-filter: var(--blur);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}

.nav-toggle-fab:hover {
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
  transform: translateX(-50%) translateY(-2px);
  box-shadow: var(--glow-cyan);
}

/* 导航栏折叠/展开过渡：高度 + 透明度，max-height 给到足够大值保证完整过渡 */
.nav-collapse-enter-active,
.nav-collapse-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
  overflow: hidden;
}

.nav-collapse-enter-from,
.nav-collapse-leave-to {
  opacity: 0;
  transform: translateY(-12px);
}

/* 浮动按钮淡入淡出 */
.fab-fade-enter-active,
.fab-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.fab-fade-enter-from,
.fab-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
}

/* 导航栏右上角装饰块：增加视觉层次 */
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
  /* flex-shrink: 0 防止 nav-tabs 数量多时把 logo + 标题挤到边缘 */
  flex-shrink: 0;
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

/* 激活态标签：渐变背景 + 光晕 */
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
  /* min-height: 0 是关键：让 .content 收缩到 app-shell 的剩余空间
     否则会被内部组件的内容撑大，导致 app-shell 高度溢出 */
  min-height: 0;
  /* overflow-y: auto 让非 Query 页面（Browse/Config/Graph 等）超出视口时能滚动
     Query 页面内部 .chat-body 自行管理滚动，不会被影响 */
  overflow-y: auto;
  position: relative;
  z-index: 1;
}

/* 底部页脚样式 */
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

/* 响应式：移动端导航栏垂直排列 */
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

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

// 悬浮窗口模式：Rust 端在 webview 创建后通过 webview.eval() 注入
// window.__FLOATING_MODE__ = true 标记悬浮窗口。
// 为什么用 window 属性而非 URL query/hash 或 localStorage：
//   - Tauri 2.x WebView2 在 Windows 上同源 webview 共享 localStorage，会污染主窗口。
//   - URL query/hash 在某些 WebView2 版本下未保留到 window.location。
//   - window 属性是 webview JS context 内的局部变量，完全隔离。
function detectFloatingMode(): boolean {
  if (typeof window === 'undefined') return false;
  // 1. 优先检测 webview.eval() 注入的标志（最可靠）
  if ((window as any).__FLOATING_MODE__ === true) return true;
  // 2. 兜底检测 query 参数
  if (window.location.search.includes('floating=1')) return true;
  // 3. 最后兜底检测 hash
  if (window.location.hash === '#floating') return true;
  return false;
}
const isFloatingMode = ref(detectFloatingMode());

// 悬浮模式下给 html 和 body 同时加 class，让全局 CSS 覆盖两者的背景为透明
// 为什么同时覆盖 html：body 透明后，html 元素的默认背景在 WebView2 下可能显示为深色，
// 仅覆盖 body 不够，必须显式覆盖 html 才能完全透明。
function applyFloatingMode(floating: boolean) {
  const root = document.documentElement;
  const body = document.body;
  if (floating) {
    root.classList.add('floating-active');
    body.classList.add('floating-active');
  } else {
    root.classList.remove('floating-active');
    body.classList.remove('floating-active');
  }
}

function handleHashChange() {
  isFloatingMode.value = detectFloatingMode();
  applyFloatingMode(isFloatingMode.value);
}

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

onMounted(() => {
  window.addEventListener('scroll', handleScroll, { passive: true });
  window.addEventListener('hashchange', handleHashChange);
  // 初始化时应用一次悬浮模式
  applyFloatingMode(isFloatingMode.value);
  // 兜底：webview.eval() 是异步的，__FLOATING_MODE__ 可能晚于 setup 注入
  // 延迟一帧后再次检测，确保悬浮模式正确识别
  requestAnimationFrame(() => {
    const recheck = detectFloatingMode();
    if (recheck !== isFloatingMode.value) {
      isFloatingMode.value = recheck;
      applyFloatingMode(recheck);
    }
  });
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', handleScroll);
  window.removeEventListener('hashchange', handleHashChange);
});
</script>

<template>
  <!-- 悬浮模式：仅渲染 FloatingChat，脱离浏览器在桌面悬浮 -->
  <div v-if="isFloatingMode" class="floating-mode">
    <FloatingChat :in-query-page="true" />
  </div>
  <!-- 正常模式：完整应用 -->
  <div v-else class="app-root">
  <!-- 背景视差层：4 层叠加，通过 scrollY 实现视差滚动 -->
  <div class="bg-layer base" :style="{ transform: `translateY(${scrollY * 0.15}px)` }"></div>
  <div class="bg-layer grid" :style="{ transform: `translateY(${scrollY * 0.08}px)` }"></div>
  <div class="bg-layer noise"></div>
  <div class="bg-layer orbs parallax" :style="{ transform: `translateY(${scrollY * 0.25}px)` }"></div>

  <div class="app-shell">
    <!-- 导航栏：左侧 Logo + 标题，右侧标签页切换。支持向上折叠释放空间 -->
    <header class="nav glass-card" :class="{ collapsed: navCollapsed }">
      <div class="nav-deco"></div>
      <div class="nav-left" @click="go('dashboard')">
        <RobotAvatar :size="46" />
        <div class="nav-title-wrap">
          <span class="title grad-text">AI 知识库</span>
          <span class="subtitle">KARPATHY WIKI</span>
        </div>
      </div>
      <nav class="nav-tabs" v-show="!navCollapsed">
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
      <!-- 折叠/展开按钮：折叠后释放垂直空间放大问答框 -->
      <button class="nav-toggle" @click="toggleNav" :title="navCollapsed ? '展开菜单' : '收起菜单'">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
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
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 24px;
  gap: 24px;
  max-width: 1280px;
  margin: 0 auto;
  position: relative;
}

/* 导航栏：水平布局，左侧 Logo 与右侧标签页 */
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 28px;
  position: relative;
  overflow: hidden;
  transition: padding 0.3s ease;
}

/* 折叠状态：减小 padding 释放垂直空间 */
.nav.collapsed {
  padding: 8px 28px;
}

.nav.collapsed .nav-title-wrap {
  display: none;
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

.nav.collapsed .nav-toggle svg {
  transform: rotate(180deg);
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

/* ========== 悬浮窗口模式（Tauri 桌面悬浮窗口）========== */
/* 悬浮窗口模式：透明背景，无边距，让 FloatingChat 占满整个窗口 */
/* 为什么覆盖 body/html 背景：style.css 的 body { background: var(--bg-void) }
   会让透明 Tauri 窗口显示为深色矩形（看起来像黑屏），需强制透明 */
.floating-mode {
  position: fixed;
  inset: 0;
  background: transparent;
  margin: 0;
  padding: 0;
  overflow: hidden;
}

/* 悬浮模式下覆盖全局 html 和 body 背景，让 Tauri 透明窗口真正透明 */
/* 为什么同时覆盖 html：body 透明后，html 元素的默认背景在 WebView2 下可能显示为深色线框 */
:global(html.floating-active),
:global(html.floating-active body) {
  background: transparent !important;
}

/* 悬浮模式下 FloatingChat 按钮居中放大 */
.floating-mode :deep(.float-btn) {
  position: relative;
  bottom: auto;
  right: auto;
  left: auto;
  width: 56px;
  height: 56px;
  margin: 8px;
  border-radius: 50%;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

/* 悬浮模式下展开的问答面板占满剩余空间 */
.floating-mode :deep(.floating-panel) {
  position: relative;
  bottom: auto;
  right: auto;
  left: auto;
  width: calc(100vw - 16px);
  max-width: 400px;
  max-height: calc(100vh - 80px);
  margin: 8px;
}
</style>

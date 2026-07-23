<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import RobotAvatar from './components/RobotAvatar.vue';
import NavIcons from './components/NavIcons.vue';
import FloatingChat from './components/FloatingChat.vue';
import ThemeSwitcher from './components/ThemeSwitcher.vue';
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
import About from './views/About.vue';
import Help from './views/Help.vue';
import Login from './views/Login.vue';
import Users from './views/Users.vue';
import { useCompileStore } from './stores/compile';
import { useAuthStore } from './stores/auth';
import { usePermission } from './composables/usePermission';
import { STORAGE_KEYS } from './constants/storageKeys';
import type { AuthPermission } from './types';

type ViewName = 'dashboard' | 'ingest' | 'progress' | 'browse' | 'query' | 'graph' | 'health' | 'config' | 'tunnel' | 'cleanup' | 'about' | 'help' | 'users';

const store = useCompileStore();
const authStore = useAuthStore();
const { isLoggedIn, isAdmin, canView, filterVisibleMenus } = usePermission();
const currentView = ref<ViewName>('dashboard');

// 菜单项配置：key 对应 ViewName，icon 对应 NavIcons 组件 name，label 为显示文字
// 抽取为常量避免 template 中两处（展开/折叠）重复硬编码
// 新增 users 菜单：仅管理员可见（通过 filterVisibleMenus 过滤）
const menuItems: Array<{ key: ViewName; icon: string; label: string; permission: AuthPermission }> = [
  { key: 'dashboard', icon: 'dashboard', label: '仪表盘', permission: 'dashboard' },
  { key: 'ingest', icon: 'ingest', label: '投递资料', permission: 'ingest' },
  { key: 'progress', icon: 'progress', label: '编译进度', permission: 'progress' },
  { key: 'browse', icon: 'browse', label: '知识浏览', permission: 'browse' },
  { key: 'query', icon: 'query', label: '知识问答', permission: 'query' },
  { key: 'graph', icon: 'graph', label: '图谱', permission: 'graph' },
  { key: 'health', icon: 'health', label: '体检', permission: 'health' },
  { key: 'config', icon: 'config', label: '配置', permission: 'config' },
  { key: 'tunnel', icon: 'tunnel', label: '内网穿透', permission: 'tunnel' },
  { key: 'cleanup', icon: 'cleanup', label: '系统清理', permission: 'cleanup' },
  { key: 'users', icon: 'about', label: '用户管理', permission: 'users' },
  { key: 'help', icon: 'help', label: '帮助文档', permission: 'help' },
  { key: 'about', icon: 'about', label: '关于', permission: 'about' },
];

// 基于权限过滤后的可见菜单（响应式）
// 为什么 computed：权限变更（登录/登出/角色切换）时自动更新
const visibleMenuItems = computed(() => {
  return filterVisibleMenus(menuItems);
});

// 导航栏折叠状态：折叠后隐藏 tabs，释放垂直空间放大问答框
// 持久化到 localStorage，刷新页面后保留用户偏好
const navCollapsed = ref(localStorage.getItem(STORAGE_KEYS.NAV_COLLAPSED) === 'true');
function toggleNav() {
  navCollapsed.value = !navCollapsed.value;
  localStorage.setItem(STORAGE_KEYS.NAV_COLLAPSED, String(navCollapsed.value));
}

// 监听滚动事件，更新 scrollY 变量驱动 CSS 视差效果
const scrollY = ref(0);
function handleScroll() {
  // 直接读取 scrollY，passive 模式下性能足够
  scrollY.value = window.scrollY;
}

// 视图切换守卫：检查当前用户是否有权限访问目标视图
// 为什么需要：直接修改 currentView 不经过权限校验，会被绕过
function go(view: ViewName) {
  // 未登录时不可切换视图（应停留在登录页）
  if (!isLoggedIn.value) return;
  // 查找菜单项获取对应权限点
  const menuItem = menuItems.find((m) => m.key === view);
  if (!menuItem) {
    // 未在菜单中的视图（如 dashboard 默认视图），允许访问
    currentView.value = view;
    return;
  }
  // 权限校验：无权限时不切换
  if (!canView(menuItem.permission)) {
    console.warn(`[auth] 无权限访问视图: ${view}`);
    return;
  }
  currentView.value = view;
}

function handleNavigate(view: 'ingest' | 'browse' | 'query' | 'health') {
  go(view);
}

// 监听 RefsList 派发的 karpathy:jump-vault 事件，切换到 browse 视图
// 由 Browse.vue 自行读取 sessionStorage.karpathy:jumpPath 完成文件定位
function handleJumpVault() {
  go('browse');
}

// 监听 About.vue 派发的 karpathy:navigate 事件，切换到指定视图
// 为什么用自定义事件而非 props：About 是路由终端组件，避免层层传递
function handleNavigateEvent(e: Event) {
  const detail = (e as CustomEvent<string>).detail;
  if (detail === 'help' || detail === 'about' || detail === 'users') {
    go(detail as ViewName);
  }
}

// 登出
async function handleLogout() {
  await authStore.logout();
  currentView.value = 'dashboard';
}

onMounted(() => {
  window.addEventListener('scroll', handleScroll, { passive: true });
  globalThis.addEventListener('karpathy:jump-vault', handleJumpVault);
  globalThis.addEventListener('karpathy:navigate', handleNavigateEvent as EventListener);
  // 启动时恢复会话：从 localStorage 读取 token，向后端验证
  // 为什么 fire-and-forget：恢复过程不阻断 UI 渲染，恢复完成后响应式更新
  authStore.restoreSession().then((ok) => {
    if (ok) {
      // 恢复成功后，根据权限选择默认视图
      // 为什么默认 dashboard：管理员有 dashboard 权限；普通用户/游客无 dashboard 权限会跳转到首个可见视图
      if (canView('dashboard')) {
        currentView.value = 'dashboard';
      } else if (visibleMenuItems.value.length > 0) {
        currentView.value = visibleMenuItems.value[0].key;
      }
    }
  });
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', handleScroll);
  globalThis.removeEventListener('karpathy:jump-vault', handleJumpVault);
  globalThis.removeEventListener('karpathy:navigate', handleNavigateEvent as EventListener);
});
</script>

<template>
  <div class="app-root">
  <!-- 背景视差层：4 层叠加，通过 scrollY 实现视差滚动 -->
  <div class="bg-layer base" :style="{ transform: `translateY(${scrollY * 0.15}px)` }"></div>
  <div class="bg-layer grid" :style="{ transform: `translateY(${scrollY * 0.08}px)` }"></div>
  <div class="bg-layer noise"></div>
  <div class="bg-layer orbs parallax" :style="{ transform: `translateY(${scrollY * 0.25}px)` }"></div>

  <!-- 未登录守卫：仅显示登录页，隐藏主导航与内容区
       为什么 v-if 而非 router：本项目为单视图 SPA，用 v-if 守卫更简洁且避免引入 vue-router -->
  <Login v-if="!isLoggedIn" />

  <!-- 已登录后才渲染主应用壳 -->
  <div v-else class="app-shell">
    <!-- 导航栏：左侧 Logo + 标题，右侧标签页切换 -->
    <!-- 折叠模式：nav 不再隐藏，改为细条状显示一行图标 + CSS tooltip -->
    <Transition name="nav-collapse" mode="out-in">
      <header v-if="!navCollapsed" key="expanded" class="nav glass-card">
        <div class="nav-deco"></div>
        <div class="nav-left" @click="go('dashboard')">
          <RobotAvatar :size="46" />
          <div class="nav-title-wrap">
            <span class="title grad-text">AI 知识库</span>
            <span class="subtitle">KARPATHY WIKI</span>
          </div>
        </div>
        <nav class="nav-tabs" aria-label="主导航">
          <button
            v-for="tab in visibleMenuItems"
            :key="tab.key"
            class="tab-btn hover-glow"
            :class="{
              active: currentView === tab.key,
              disabled: tab.key === 'progress' && !store.isCompiling && !store.isDone
            }"
            :disabled="tab.key === 'progress' && !store.isCompiling && !store.isDone"
            @click="go(tab.key)"
          >
            <NavIcons :name="tab.icon" :size="16" class="tab-icon" />
            <span class="tab-label">{{ tab.label }}</span>
          </button>
        </nav>
        <div class="nav-user">
          <span class="nav-user-name" :title="authStore.user?.username">{{ authStore.user?.username }}</span>
          <span class="nav-user-role" :class="`role-${authStore.user?.role}`">{{ authStore.user?.role }}</span>
          <button class="nav-logout" title="登出" @click="handleLogout">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        <button class="nav-toggle" @click="toggleNav" title="收起菜单">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M6 15l6-6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </header>
      <!-- 折叠态：一行图标条，hover 显示 tooltip 菜单名 -->
      <header v-else key="collapsed" class="nav-collapsed glass-card">
        <div class="nav-collapsed-left" @click="go('dashboard')" title="返回首页">
          <RobotAvatar :size="32" />
        </div>
        <nav class="nav-icons-bar" aria-label="折叠态主导航">
          <button
            v-for="tab in visibleMenuItems"
            :key="tab.key"
            class="icon-btn"
            :class="{
              active: currentView === tab.key,
              disabled: tab.key === 'progress' && !store.isCompiling && !store.isDone
            }"
            :disabled="tab.key === 'progress' && !store.isCompiling && !store.isDone"
            @click="go(tab.key)"
            :aria-label="tab.label"
          >
            <NavIcons :name="tab.icon" :size="22" />
            <span class="icon-tooltip">{{ tab.label }}</span>
          </button>
        </nav>
        <button class="nav-logout-collapsed" title="登出" @click="handleLogout">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="nav-toggle" @click="toggleNav" title="展开菜单">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </header>
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
      <Users v-else-if="currentView === 'users'" />
      <Help v-else-if="currentView === 'help'" />
      <About v-else-if="currentView === 'about'" />
    </main>

    <footer class="footer">
      <span class="footer-line"></span>
      <span class="footer-text">POWERED BY KARPATHY AI · 知识库引擎</span>
      <span class="footer-line"></span>
    </footer>
  </div>

  <!-- 全局悬浮问答入口：仅在已登录后显示，避免游客在登录页就看到悬浮按钮 -->
  <FloatingChat v-if="isLoggedIn" :in-query-page="currentView === 'query'" />
  <!-- 全局悬浮主题切换器：所有页面右下角可用，降低用户寻找配置入口的门槛 -->
  <ThemeSwitcher />
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

/* ============================================================
 * 用户信息区：用户名 + 角色徽章 + 登出按钮
 * 为什么独立区块：登出是高频操作，与导航 tab 分离避免误点
 * ============================================================ */
.nav-user {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-left: 1px solid var(--accent-purple-a30);
  margin-left: 8px;
  flex-shrink: 0;
  z-index: 1;
}

.nav-user-name {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 角色徽章：三种角色用语义色区分（管理员红、用户青、游客灰） */
.nav-user-role {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
}

.nav-user-role.role-admin {
  background: var(--accent-magenta-a20);
  color: var(--neon-magenta);
  border: 1px solid var(--accent-magenta-a30);
}

.nav-user-role.role-user {
  background: var(--accent-cyan-a08);
  color: var(--neon-cyan);
  border: 1px solid var(--accent-cyan-a30);
}

.nav-user-role.role-guest {
  background: var(--accent-purple-a10);
  color: var(--text-soft);
  border: 1px solid var(--accent-purple-a30);
}

.nav-logout,
.nav-logout-collapsed {
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
}

.nav-logout:hover,
.nav-logout-collapsed:hover {
  border-color: var(--neon-magenta);
  color: var(--neon-magenta);
  box-shadow: 0 0 12px rgba(255, 0, 110, 0.3);
}

.nav-logout-collapsed {
  width: 32px;
  height: 32px;
}

.nav-toggle:hover {
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
  box-shadow: var(--glow-cyan);
}

.nav-toggle svg {
  transition: transform 0.3s ease;
}

/* 展开态 tab 内图标：与文字水平排列，颜色跟随主题霓虹青 */
.tab-icon {
  color: var(--neon-cyan);
  opacity: 0.85;
}

.tab-btn:hover:not(.disabled) .tab-icon,
.tab-btn.active .tab-icon {
  opacity: 1;
}

/* ============================================================
 * 折叠态导航条：细条状，一行图标 + tooltip
 * ============================================================ */
.nav-collapsed {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  gap: 12px;
  flex-shrink: 0;
  position: relative;
  overflow: visible;
}

.nav-collapsed::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--neon-purple), var(--neon-cyan), transparent);
  opacity: 0.7;
}

.nav-collapsed-left {
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  transition: transform 0.3s ease;
}

.nav-collapsed-left:hover {
  transform: scale(1.08);
}

/* 图标条：一行排列，自动横向滚动防溢出 */
.nav-icons-bar {
  display: flex;
  gap: 4px;
  flex: 1;
  justify-content: center;
  overflow-x: auto;
  scrollbar-width: none;
}

.nav-icons-bar::-webkit-scrollbar {
  display: none;
}

/* 单个图标按钮：圆形/方形，hover 发光，active 高亮 */
.icon-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: none;
  background: transparent;
  color: var(--text-soft);
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.23, 1, 0.32, 1);
  flex-shrink: 0;
}

.icon-btn:hover:not(.disabled) {
  color: var(--neon-cyan);
  background: var(--accent-cyan-a08);
  transform: translateY(-2px);
}

.icon-btn.active {
  color: var(--neon-magenta);
  background: var(--grad-fire);
  box-shadow: 0 4px 16px rgba(255, 0, 110, 0.4);
}

/* active 图标用白色突出 */
.icon-btn.active :deep(.nav-icon) {
  color: #fff;
  filter: drop-shadow(0 0 6px #fff);
}

.icon-btn.disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* CSS Tooltip：hover 时从下方弹出菜单名，纯 CSS 无依赖 */
.icon-tooltip {
  position: absolute;
  bottom: -32px;
  left: 50%;
  transform: translateX(-50%) translateY(-4px);
  padding: 4px 10px;
  background: var(--bg-card-solid);
  color: var(--text-bright);
  font-size: 11px;
  font-weight: 600;
  font-family: var(--font-body);
  border-radius: 6px;
  border: 1px solid var(--accent-purple-a30);
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s ease, transform 0.2s ease;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.icon-btn:hover:not(.disabled) .icon-tooltip {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

/* 导航栏折叠/展开过渡：透明度 + 位移，out-in 模式确保切换流畅 */
.nav-collapse-enter-active,
.nav-collapse-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.nav-collapse-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}

.nav-collapse-leave-to {
  opacity: 0;
  transform: translateY(-8px);
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
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-body);
  color: var(--text-soft);
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.23, 1, 0.32, 1);
  letter-spacing: 0.5px;
  overflow: hidden;
  /* 图标 + 文字水平排列 */
  display: inline-flex;
  align-items: center;
  gap: 6px;
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

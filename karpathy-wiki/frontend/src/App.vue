<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import RobotAvatar from './components/RobotAvatar.vue';
import NavIcons from './components/NavIcons.vue';
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
import About from './views/About.vue';
import Help from './views/Help.vue';
import Login from './views/Login.vue';
import Register from './views/Register.vue';
import Users from './views/Users.vue';
import Skill from './views/Skill.vue';
import DataClean from './views/DataClean.vue';
import { useCompileStore } from './stores/compile';
import { useAuthStore } from './stores/auth';
import { usePermission } from './composables/usePermission';
import { STORAGE_KEYS } from './constants/storageKeys';
import type { AuthPermission } from './types';
import MobileShell from './components/mobile/MobileShell.vue';
import { useIsMobile } from './composables/useIsMobile';

type ViewName = 'dashboard' | 'ingest' | 'progress' | 'browse' | 'query' | 'graph' | 'health' | 'config' | 'tunnel' | 'cleanup' | 'about' | 'help' | 'users' | 'skill' | 'dataclean';

const store = useCompileStore();
const authStore = useAuthStore();
const { isLoggedIn, isAdmin, canView, filterVisibleMenus } = usePermission();
const currentView = ref<ViewName>('dashboard');

// 移动端判定：满足断点（<768px）时整页渲染 MobileShell，桌面端布局保持不变
// 为什么在 App 根：单 SPA 无 vue-router，用 isMobile 决定顶层渲染分支
const { isMobile } = useIsMobile();

// 未登录时的认证界面模式：login / register 互切
// 注册成功后 authStore 自动写入 token + user，isLoggedIn 变 true，自动进入主应用
const authMode = ref<'login' | 'register'>('login');

// 菜单项配置：key 对应 ViewName，icon 对应 NavIcons 组件 name，label 为显示文
// 抽取为常量避template 中两处（展开/折叠）重复硬编码
// 新增 users 菜单：仅管理员可见（通过 filterVisibleMenus 过滤
const menuItems: Array<{ key: ViewName; icon: string; label: string; permission: AuthPermission }> = [
  { key: 'dashboard', icon: 'dashboard', label: '仪表盘', permission: 'dashboard' },
  { key: 'ingest', icon: 'ingest', label: '投递资料', permission: 'ingest' },
  { key: 'progress', icon: 'progress', label: '编译进度', permission: 'progress' },
  { key: 'browse', icon: 'browse', label: '知识浏览', permission: 'browse' },
  { key: 'query', icon: 'query', label: '知识问答', permission: 'query' },
  { key: 'graph', icon: 'graph', label: '图谱', permission: 'graph' },
  { key: 'health', icon: 'health', label: '体检', permission: 'health' },
  // 配置菜单向所有登录用户开放：其中的「朗读设置」「界面主题」为个人偏好（按用户隔离、本地存储），
  // 所有用户都可查看/修改；SCHEMA/系统配置/AI 服务/工具/MCP/Prompt 等敏感配置在 Config.vue 内
  // 通过 isAdmin 二次拦截，仅管理员可见可改。菜单可见性用全员都有的 'dashboard' 权限承载。
  { key: 'config', icon: 'config', label: '配置', permission: 'dashboard' },
  { key: 'tunnel', icon: 'tunnel', label: '内网穿透', permission: 'tunnel' },
  { key: 'cleanup', icon: 'cleanup', label: '系统清理', permission: 'cleanup' },
  { key: 'users', icon: 'about', label: '用户管理', permission: 'users' },
  { key: 'skill', icon: 'config', label: '技能管理', permission: 'skill' },
  { key: 'help', icon: 'help', label: '帮助文档', permission: 'help' },
  { key: 'dataclean', icon: 'cleanup', label: '数据清洗', permission: 'cleanup' },
  { key: 'about', icon: 'about', label: '关于', permission: 'about' },
];

// 基于权限过滤后的可见菜单（响应式
// 为什computed：权限变更（登录/登出/角色切换）时自动更新
const visibleMenuItems = computed(() => {
  return filterVisibleMenus(menuItems);
});

// 导航栏折叠状态：折叠后隐tabs，释放垂直空间放大问答框
// 持久化到 localStorage，刷新页面后保留用户偏好
const navCollapsed = ref(localStorage.getItem(STORAGE_KEYS.NAV_COLLAPSED) === 'true');
function toggleNav() {
  navCollapsed.value = !navCollapsed.value;
  localStorage.setItem(STORAGE_KEYS.NAV_COLLAPSED, String(navCollapsed.value));
}

// 监听滚动事件，更scrollY 变量驱动 CSS 视差效果
const scrollY = ref(0);
function handleScroll() {
  // 直接读取 scrollY，passive 模式下性能足够
  scrollY.value = window.scrollY;
}

// 视图切换守卫：检查当前用户是否有权限访问目标视图
// 为什么需要：直接修改 currentView 不经过权限校验，会被绕过
function go(view: ViewName) {
  // 未登录时不可切换视图（应停留在登录页
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
    console.warn(`[auth] 无权限访问视 ${view}`);
    return;
  }
  currentView.value = view;
}

function handleNavigate(view: 'ingest' | 'browse' | 'query' | 'health' | 'progress' | 'graph' | 'help') {
  go(view);
}

// 监听 RefsList 派发karpathy:jump-vault 事件，切换到 browse 视图
// Browse.vue 自行读取 sessionStorage.karpathy:jumpPath 完成文件定位
function handleJumpVault() {
  go('browse');
}

// 监听 About.vue / Ingest.vue 派发karpathy:navigate 事件，切换到指定视图
// 为什么用自定义事件而非 props：About 是路由终端组件，避免层层传递；
// Ingest.vue 抽取完成后跳Browse 草稿审核也复用此通道
function handleNavigateEvent(e: Event) {
  const detail = (e as CustomEvent<string>).detail;
  if (detail === 'help' || detail === 'about' || detail === 'users' || detail === 'browse') {
    go(detail as ViewName);
  }
}

// 登出
async function handleLogout() {
  await authStore.logout();
  currentView.value = 'dashboard';
  // 回到登录态默认展示登录页（而非注册页）
  authMode.value = 'login';
}

onMounted(() => {
  window.addEventListener('scroll', handleScroll, { passive: true });
  globalThis.addEventListener('karpathy:jump-vault', handleJumpVault);
  globalThis.addEventListener('karpathy:navigate', handleNavigateEvent as EventListener);
  // 启动时恢复会话：localStorage 读取 token，向后端验证
  // 为什fire-and-forget：恢复过程不阻断 UI 渲染，恢复完成后响应式更
  authStore.restoreSession().then((ok) => {
    if (ok) {
      // §优化方案3：恢复成功后预加载编译持久化状态
      // 为什么在 App.vue 而非仅 Progress.vue：编译进度按钮的 disabled 条件依赖 store.isDone，
      //   若不预加载，刷新页面后 store.isDone=false 导致按钮 disabled，用户无法点击进入
      //   Progress.vue 触发 loadPersistedState，形成死锁。预加载让按钮 disabled 反映 localStorage 实际状态
      // 幂等性：loadPersistedState 是纯赋值操作，Progress.vue onMounted 再调用一次是 no-op
      store.loadPersistedState();
      // 恢复成功后，根据权限选择默认视图
      // 为什么默dashboard：管理员dashboard 权限；普通用游客dashboard 权限会跳转到首个可见视图
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
  <MobileShell v-if="isMobile" />
  <div v-else class="app-root">
  <!-- 背景视差层：4 层叠加，通过 scrollY 实现视差滚动 -->
  <div class="bg-layer base" :style="{ transform: `translateY(${scrollY * 0.15}px)` }"></div>
  <div class="bg-layer grid" :style="{ transform: `translateY(${scrollY * 0.08}px)` }"></div>
  <div class="bg-layer noise"></div>
  <div class="bg-layer orbs parallax" :style="{ transform: `translateY(${scrollY * 0.25}px)` }"></div>

  <!-- 未登录守卫：仅显示登录/注册页，隐藏主导航与内容区
       为什v-if 而非 router：本项目为单视图 SPA，用 v-if 守卫更简洁且避免引入 vue-router -->
  <Login
    v-if="!isLoggedIn && authMode === 'login'"
    @switch-to-register="authMode = 'register'"
  />
  <Register
    v-else-if="!isLoggedIn"
    @switch-to-login="authMode = 'login'"
  />

  <!-- 已登录后才渲染主应用-->
  <!-- 为什么改为 row 布局：导航挪到左侧形成侧边栏，content 占据剩余水平空间，垂直视野最大化 -->
  <div v-else class="app-shell">
    <!-- 左侧导航栏：可折叠侧边栏，垂直排列 Logo/菜单/用户区 -->
    <!-- 折叠模式：侧栏窄至 64px 仅显图标 + CSS tooltip，展开 220px 显示完整菜单 -->
    <Transition name="nav-collapse" mode="out-in">
      <aside v-if="!navCollapsed" key="expanded" class="nav glass-card">
        <div class="nav-deco"></div>
        <!-- 顶部 Logo 区：点击回首页 -->
        <div class="nav-left" @click="go('dashboard')">
          <RobotAvatar :size="40" />
          <div class="nav-title-wrap">
            <span class="title grad-text">AI 知识库</span>
            <span class="subtitle">KARPATHY WIKI</span>
          </div>
        </div>
        <!-- 中部菜单列表：垂直排列，整行可点击 -->
        <nav class="nav-tabs" aria-label="主导航">
          <button
            v-for="tab in visibleMenuItems"
            :key="tab.key"
            class="tab-btn hover-glow"
            :class="{
              active: currentView === tab.key,
              disabled: tab.key === 'progress' && !store.isCompiling && !store.isDone && !store.errorMessage && !store.isCancelled
            }"
            :disabled="tab.key === 'progress' && !store.isCompiling && !store.isDone && !store.errorMessage && !store.isCancelled"
            @click="go(tab.key)"
          >
            <NavIcons :name="tab.icon" :size="18" class="tab-icon" />
            <span class="tab-label">{{ tab.label }}</span>
          </button>
        </nav>
        <!-- 底部用户区 + 登出 + 折叠按钮：固定在侧栏底端 -->
        <div class="nav-bottom">
          <div class="nav-user">
            <span class="nav-user-name" :title="authStore.user?.username">{{ authStore.user?.username }}</span>
            <span class="nav-user-role" :class="`role-${authStore.user?.role}`">{{ authStore.user?.role }}</span>
          </div>
          <div class="nav-bottom-actions">
            <button class="nav-logout" title="登出" @click="handleLogout">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="nav-toggle" @click="toggleNav" title="收起菜单">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      </aside>
      <!-- 折叠态：窄侧栏仅显图标，hover 显示 tooltip 菜单名 -->
      <aside v-else key="collapsed" class="nav-collapsed glass-card">
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
              disabled: tab.key === 'progress' && !store.isCompiling && !store.isDone && !store.errorMessage && !store.isCancelled
            }"
            :disabled="tab.key === 'progress' && !store.isCompiling && !store.isDone && !store.errorMessage && !store.isCancelled"
            @click="go(tab.key)"
            :aria-label="tab.label"
          >
            <NavIcons :name="tab.icon" :size="22" />
            <span class="icon-tooltip">{{ tab.label }}</span>
          </button>
        </nav>
        <div class="nav-collapsed-bottom">
          <button class="nav-logout-collapsed" title="登出" @click="handleLogout">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="nav-toggle" @click="toggleNav" title="展开菜单">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </aside>
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
      <Skill v-else-if="currentView === 'skill'" />
      <DataClean v-else-if="currentView === 'dataclean'" />

      <Help v-else-if="currentView === 'help'" />
      <About v-else-if="currentView === 'about'" />
    </main>
  </div>

  <!-- 全局悬浮问答入口：仅在已登录后且不在 Query 页面时显示
       为什么排除 Query 页：Query 页本身即问答界面，悬浮按钮重复入口且遮挡视野 -->
  <FloatingChat v-if="isLoggedIn && currentView !== 'query'" :in-query-page="false" />
  <!-- v3.1 移除全局悬浮主题切换器：右下角 52×52 按钮 + 展开面板会遮挡聊天区视野，
       主题切换入口移至 Config 页面（保留原 embedded 模式能力，但不挂在全局） -->
  </div>

</template>

<style scoped>
/* ============================================================
 * 整体布局：左侧侧边栏 + 右侧内容区
 * 为什么 row 而非 column：将导航挪到左侧形成侧边栏，
 *   content 占据剩余水平空间，垂直视野最大化（去除原顶部导航 + 页脚占用）
 * ============================================================ */
.app-shell {
  height: 100vh;
  display: flex;
  flex-direction: row;
  padding: 14px;
  gap: 14px;
  max-width: 1600px;
  margin: 0 auto;
  position: relative;
}

/* ============================================================
 * 侧边栏（展开态）：垂直布局，顶部 Logo / 中部菜单 / 底部用户区
 * ============================================================ */
.nav {
  display: flex;
  flex-direction: column;
  width: 220px;
  flex-shrink: 0;
  padding: 16px 12px;
  position: relative;
  overflow: hidden;
  transition: width 0.3s ease, padding 0.3s ease;
  gap: 12px;
}

.nav-deco {
  position: absolute;
  top: -30px;
  right: -30px;
  width: 160px;
  height: 160px;
  background: var(--grad-fire);
  opacity: 0.08;
  transform: rotate(25deg);
  border-radius: 32px;
  pointer-events: none;
}

/* Logo 区：水平排列头像与标题，点击回首页 */
.nav-left {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  z-index: 1;
  transition: transform 0.3s ease;
  flex-shrink: 0;
  padding: 4px 6px;
}

.nav-left:hover {
  transform: translateX(2px);
}

.nav-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.5px;
  line-height: 1.1;
}

.subtitle {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--neon-cyan);
  letter-spacing: 2px;
  opacity: 0.8;
}

/* 菜单列表：垂直排列，整行可点击，自动纵向滚动 */
.nav-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  z-index: 1;
  /* 隐藏滚动条保留滚动能力：侧栏空间宝贵 */
  scrollbar-width: thin;
  scrollbar-color: var(--accent-purple-a30) transparent;
  padding-right: 2px;
}

.nav-tabs::-webkit-scrollbar {
  width: 4px;
}

.nav-tabs::-webkit-scrollbar-thumb {
  background: var(--accent-purple-a30);
  border-radius: 2px;
}

/* 单个菜单项：整行布局，左对齐图标 + 文字 */
.tab-btn {
  position: relative;
  border: none;
  background: transparent;
  padding: 9px 12px;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-body);
  color: var(--text-soft);
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.23, 1, 0.32, 1);
  letter-spacing: 0.3px;
  overflow: hidden;
  /* 图标 + 文字水平排列，整行占满 */
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  flex-shrink: 0;
}

.tab-btn:hover:not(.disabled) {
  color: var(--neon-cyan);
  background: rgba(0, 245, 255, 0.08);
  transform: translateX(2px);
  text-shadow: 0 0 12px rgba(0, 245, 255, 0.6);
}

/* 激活态：渐变背景 + 左侧光条强调 */
.tab-btn.active {
  background: var(--grad-fire);
  color: #fff;
  box-shadow: 0 4px 20px rgba(255, 0, 110, 0.4);
  text-shadow: 0 0 8px rgba(255, 255, 255, 0.5);
}

.tab-btn.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10%;
  bottom: 10%;
  width: 3px;
  background: #fff;
  border-radius: 0 2px 2px 0;
  box-shadow: 0 0 8px #fff;
}

.tab-btn.disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* 展开态菜单图标：与文字水平排列，颜色跟随主题霓虹 */
.tab-icon {
  color: var(--neon-cyan);
  opacity: 0.85;
  flex-shrink: 0;
}

.tab-btn:hover:not(.disabled) .tab-icon,
.tab-btn.active .tab-icon {
  opacity: 1;
}

.tab-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ============================================================
 * 底部用户区 + 操作按钮组：固定在侧栏底部
 * ============================================================ */
.nav-bottom {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 6px 4px;
  border-top: 1px solid var(--accent-purple-a30);
  flex-shrink: 0;
  z-index: 1;
}

.nav-user {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.nav-user-name {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 角色徽章：三种角色用语义色区分 */
.nav-user-role {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 8px;
  letter-spacing: 0.5px;
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

.nav-bottom-actions {
  display: flex;
  gap: 6px;
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

.nav-logout {
  flex: 1;
}

.nav-logout:hover,
.nav-logout-collapsed:hover {
  border-color: var(--neon-magenta);
  color: var(--neon-magenta);
  box-shadow: 0 0 12px rgba(255, 0, 110, 0.3);
}

/* 折叠按钮：图标随状态旋转（左侧展开→右箭头/折叠→左箭头） */
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
}

.nav-toggle:hover {
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
  box-shadow: var(--glow-cyan);
}

.nav-toggle svg {
  transition: transform 0.3s ease;
}

/* ============================================================
 * 侧边栏（折叠态）：窄至 64px 仅显图标，hover 显示 tooltip
 * ============================================================ */
.nav-collapsed {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 64px;
  flex-shrink: 0;
  padding: 14px 8px;
  gap: 10px;
  position: relative;
  overflow: visible;
}

.nav-collapsed::before {
  content: '';
  position: absolute;
  top: 0; left: 0; bottom: 0;
  width: 1px;
  background: linear-gradient(180deg, transparent, var(--neon-purple), var(--neon-cyan), transparent);
  opacity: 0.7;
}

.nav-collapsed-left {
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.3s ease;
}

.nav-collapsed-left:hover {
  transform: scale(1.08);
}

/* 图标列表：垂直排列，自动纵向滚动 */
.nav-icons-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  overflow-y: auto;
  overflow-x: visible;
  scrollbar-width: none;
  align-items: center;
  padding: 4px 0;
}

.nav-icons-bar::-webkit-scrollbar {
  display: none;
}

/* 单个图标按钮：圆方形，hover 发光，active 高亮 */
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
  transform: translateX(2px);
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

/* CSS Tooltip：折叠态 hover 时从右侧弹出菜单名，纯 CSS 无依赖 */
.icon-tooltip {
  position: absolute;
  left: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%) translateX(-4px);
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
  transform: translateY(-50%) translateX(0);
}

.nav-collapsed-bottom {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--accent-purple-a30);
  flex-shrink: 0;
  align-items: center;
}

/* 导航栏折叠/展开过渡：透明 + 水平位移 */
.nav-collapse-enter-active,
.nav-collapse-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.nav-collapse-enter-from {
  opacity: 0;
  transform: translateX(-12px);
}

.nav-collapse-leave-to {
  opacity: 0;
  transform: translateX(-12px);
}

/* ============================================================
 * 主内容区：占据剩余水平空间，垂直滚动由内部各页面自行管理
 * ============================================================ */
.content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  position: relative;
  z-index: 1;
}

/* ============================================================
 * 响应式：窄屏降级为顶部水平条（保留原有 .nav / .nav-collapsed 类名兼容测试）
 * ============================================================ */
@media (max-width: 900px) {
  .app-shell {
    flex-direction: column;
    padding: 10px;
    gap: 10px;
  }

  .nav {
    width: 100%;
    flex-direction: column;
    padding: 10px 12px;
  }

  .nav-tabs {
    flex-direction: row;
    flex-wrap: wrap;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .tab-btn {
    width: auto;
  }

  .nav-collapsed {
    width: 100%;
    flex-direction: row;
    flex-wrap: wrap;
  }

  .nav-icons-bar {
    flex-direction: row;
    flex-wrap: wrap;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .nav-collapsed-bottom {
    flex-direction: row;
    border-top: none;
    border-left: 1px solid var(--accent-purple-a30);
    padding-top: 0;
    padding-left: 8px;
  }

  .nav-collapsed::before {
    top: 0; left: 0; right: 0; bottom: auto;
    width: auto;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--neon-purple), var(--neon-cyan), transparent);
  }
}
</style>

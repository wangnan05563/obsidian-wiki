<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
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
import MobileShell from './components/mobile/MobileShell.vue';
import { useIsMobile } from './composables/useIsMobile';
import { useHashView } from './composables/useHashView';
import GuideOverlay from './components/GuideOverlay.vue';
import GuideButton from './components/GuideButton.vue';
import ForceChangePassword from './components/ForceChangePassword.vue';
import { useGuideStore } from './stores/guide';
import { menuItems, menuGroupDefs, groupMenuItems, type ViewName } from './config/menu';

const store = useCompileStore();
const authStore = useAuthStore();
const { isLoggedIn, isAdmin, canView, filterVisibleMenus } = usePermission();
const guideStore = useGuideStore();
const currentView = ref<ViewName>('dashboard');

// 移动端判定：满足断点（<768px）时整页渲染 MobileShell，桌面端布局保持不变
// 为什么在 App 根：单 SPA 无 vue-router，用 isMobile 决定顶层渲染分支
const { isMobile } = useIsMobile();

// 未登录时的认证界面模式：login / register 互切
// 注册成功后 authStore 自动写入 token + user，isLoggedIn 变 true，自动进入主应用
const authMode = ref<'login' | 'register'>('login');

// 菜单项配置已移至 config/menu.ts（T02449：分组 + 清理类相邻 + 可单测），此处仅导入

// 基于权限过滤后的可见菜单（响应式）
// 为什computed：权限变更（登录/登出/角色切换）时自动更新
const visibleMenuItems = computed(() => {
  return filterVisibleMenus(menuItems);
});

// T02449（PRD N1）：按 知识/生产/运维/系统 四组渲染（组内频率序，清理类相邻）
// 先经 filterVisibleMenus 权限过滤再分组：无权限的组整体消失，不会留空分组标题
const groupedMenus = computed(() => groupMenuItems(filterVisibleMenus(menuItems), menuGroupDefs));

// T02449（PRD N2）：菜单溢出感知——容器装不下时显示「↓ 还有 N 项」提示，点击平滑下滚
// 为什么需要：实测 1440x900 视口仅容纳 9/15 项，尾部项（页面质量清洗等）需滚动才能点到，
// 且未滚动时直接点击会失败（元素不在可视交互区）；提示条 + 渐隐让「还有更多」可见可达
const navTabsEl = ref<HTMLElement | null>(null);
const menuOverflow = ref(false);
const hiddenCount = ref(0);
function updateMenuOverflow() {
  const el = navTabsEl.value;
  if (!el) return;
  const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
  menuOverflow.value = remaining > 8;
  if (menuOverflow.value) {
    const viewBottom = el.scrollTop + el.clientHeight;
    let hidden = 0;
    el.querySelectorAll('.tab-btn').forEach((btn) => {
      const b = btn as HTMLElement;
      if (b.offsetTop + b.offsetHeight > viewBottom + 2) hidden++;
    });
    hiddenCount.value = hidden;
  }
}
function scrollMenuDown() {
  const el = navTabsEl.value;
  if (el) el.scrollBy({ top: el.clientHeight * 0.8, behavior: 'smooth' });
}

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
    syncHash(view);
    return;
  }
  // 权限校验：无权限时不切换
  if (!canView(menuItem.permission)) {
    console.warn(`[auth] 无权限访问视 ${view}`);
    return;
  }
  currentView.value = view;
  // T02394 hash 路由：权限通过后同步 URL（pushState 产生可回退条目）
  syncHash(view);
  // T00864 用户引导：首次进入该视图时自动弹出引导（已引导过的视图不再触发）
  // 为什么在权限通过后调用：避免无权限用户被引导到其无权访问的功能
  // 该函数同步返回 boolean（是否启动了引导），此处无需 void 丢弃，与 onMounted 内的调用方式一致
  guideStore.maybeStartFirstTime(view);
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
  // T02455：白名单由 4 项扩为全部菜单 key（复用 hash 路由的 validViewKeys 集合），
  // 使帮助文档等任意来源均可经 karpathy:navigate 直达任意视图（如「配置中心 → AI 服务」按钮）
  if (typeof detail === 'string' && validViewKeys.has(detail)) {
    go(detail as ViewName);
  }
}

// 登出
async function handleLogout() {
  await authStore.logout();
  currentView.value = 'dashboard';
  syncHash('dashboard');
  // 回到登录态默认展示登录页（而非注册页）
  authMode.value = 'login';
}

// 会话失效（后端重启 / token 过期等）：apiFetch 在受保护接口返回 401 且本次携带了
// token 时广播此事件。此处统一跳转到登录页，避免停留在失效会话中持续 401 刷屏。
function handleAuthExpired() {
  if (authStore.isLoggedIn) {
    authStore.logout();
    authMode.value = 'login';
  }
}

onMounted(() => {
  window.addEventListener('scroll', handleScroll, { passive: true });
  globalThis.addEventListener('karpathy:jump-vault', handleJumpVault);
  globalThis.addEventListener('karpathy:navigate', handleNavigateEvent as EventListener);
  globalThis.addEventListener('karpathy:auth-expired', handleAuthExpired);
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
      // T00864 用户引导：登录/恢复后触发当前默认视图的首次引导（非同一次会话去重）
      // 为什么放 restoreSession 成功分支：只有已登录会话才需要引导，未登录不弹
      // 用 maybeStartFirstTime 统一管理：未引导过才弹，并自动登记 seen，避免重复
      if (currentView.value) {
        guideStore.maybeStartFirstTime(currentView.value);
      }
      // T02394：会话恢复后应用深链 hash（非法/越权则归一化到上面选定的默认视图）
      applyHashView();
    }
  });
});

// T02449（N2）：溢出感知生命周期——菜单变化（登录/权限切换）与窗口尺寸变化时重算
onMounted(() => {
  updateMenuOverflow();
  window.addEventListener('resize', updateMenuOverflow);
});
watch(groupedMenus, async () => {
  await nextTick();
  updateMenuOverflow();
});

// T02394 hash 路由（PRD N4 / 技术方案 D1）：currentView ↔ URL hash 双向同步
// 放在既有 onMounted 之后注册：保证 hash 初始化在会话恢复（restoreSession）之后执行
// 守卫：已登录 + 有视图权限 + 非移动端（MobileShell 自有 tab 态，不参与 hash 联动）
const validViewKeys = new Set<string>(menuItems.map((m) => m.key));
const { syncHash, applyHashView } = useHashView(currentView, {
  isValid: (v) => validViewKeys.has(v),
  guard: (v) => {
    if (isMobile.value) return false;
    if (!isLoggedIn.value) return false;
    const item = menuItems.find((m) => m.key === v);
    return item ? canView(item.permission) : false;
  },
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', handleScroll);
  window.removeEventListener('resize', updateMenuOverflow);
  globalThis.removeEventListener('karpathy:jump-vault', handleJumpVault);
  globalThis.removeEventListener('karpathy:navigate', handleNavigateEvent as EventListener);
  globalThis.removeEventListener('karpathy:auth-expired', handleAuthExpired);
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
      <aside v-if="!navCollapsed" key="expanded" class="nav glass-card" aria-label="主导航侧边栏">
        <div class="nav-deco"></div>
        <!-- 顶部 Logo 区：点击回首页 -->
        <div class="nav-left" @click="go('dashboard')">
          <RobotAvatar :size="40" />
          <div class="nav-title-wrap">
            <span class="title grad-text">AI 知识库</span>
            <span class="subtitle">KARPATHY WIKI</span>
          </div>
        </div>
        <!-- 中部菜单列表：四组（知识/生产/运维/系统）垂直排列，整行可点击；T02449 N1 -->
        <nav class="nav-tabs" ref="navTabsEl" aria-label="主导航" @scroll="updateMenuOverflow">
          <template v-for="grp in groupedMenus" :key="grp.key">
            <div class="nav-group-label">{{ grp.label }}</div>
            <button
              v-for="tab in grp.items"
              :key="tab.key"
              class="tab-btn hover-glow"
              :class="{ active: currentView === tab.key }"
              :aria-current="currentView === tab.key ? 'page' : undefined"
              :data-guide="tab.key"
              @click="go(tab.key)"
            >
              <NavIcons :name="tab.icon" :size="18" class="tab-icon" />
              <span class="tab-label">{{ tab.label }}</span>
            </button>
          </template>
        </nav>
        <!-- T02449（N2）：溢出提示条——菜单装不下时出现，点击平滑下滚；无溢出时隐藏 -->
        <button
          v-if="menuOverflow"
          type="button"
          class="nav-scroll-hint"
          title="查看其余菜单"
          @click="scrollMenuDown"
        >
          ↓ 还有 {{ hiddenCount }} 项
        </button>
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
      <aside v-else key="collapsed" class="nav-collapsed glass-card" aria-label="折叠导航侧边栏">
        <div class="nav-collapsed-left" @click="go('dashboard')" title="返回首页">
          <RobotAvatar :size="32" />
        </div>
        <nav class="nav-icons-bar" aria-label="折叠态主导航">
          <button
            v-for="tab in visibleMenuItems"
            :key="tab.key"
            class="icon-btn"
            :class="{ active: currentView === tab.key }"
            :aria-current="currentView === tab.key ? 'page' : undefined"
            :data-guide="tab.key"
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
  <!-- T00864 用户引导：遮罩 + 常驻入口按钮，仅桌面子布局（移动端走 MobileShell） -->
  <template v-if="isLoggedIn && !isMobile">
    <GuideOverlay />
    <!-- T00887 新手指引入口默认隐藏，仅在帮助文档页展示：避免常驻按钮干扰其他视图操作 -->
    <GuideButton v-if="currentView === 'help'" :view="currentView" />
  </template>
  </div>

  <!-- T02453（PRD A1）：首登强制改密对话框。根级渲染覆盖移动/桌面两端；
       生产环境 login/me 返回 mustChangePassword=true 时挂载，改密成功后由 store 清除标记自动卸载 -->
  <ForceChangePassword v-if="authStore.user?.mustChangePassword" @changed="authStore.clearMustChangePassword" />
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
  /* min-height:0 必须显式声明：flex 子项默认 min-height:auto 不允许收缩到内容高度以下，
     菜单项多时（15 项）列表会溢出 aside，尾部菜单项滑入 .nav-bottom（用户区/登出）下方，
     视口较矮时点击「用户管理」等尾部项会穿透点到「登出」按钮（实测 1258x566 视口 100% 复现） */
  min-height: 0;
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

/* T02449（N1）：分组标题——弱化存在感，仅作视觉分隔 */
.nav-group-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: var(--text-soft);
  opacity: 0.55;
  padding: 10px 12px 2px;
  user-select: none;
}

.nav-tabs .nav-group-label:first-child {
  padding-top: 2px;
}

/* T02449（N2）：溢出提示条——点击平滑下滚；渐变模拟底部渐隐，提示「下面还有」 */
.nav-scroll-hint {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  font-family: inherit;
  color: var(--text-soft);
  padding: 5px 8px;
  cursor: pointer;
  border: none;
  border-radius: var(--radius-btn);
  background: linear-gradient(to bottom, rgba(125, 125, 145, 0.02), rgba(125, 125, 145, 0.16));
  z-index: 1;
  user-select: none;
  transition: color 0.2s ease;
}

.nav-scroll-hint:hover {
  color: var(--neon-cyan);
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

/* 激活态：渐变背景 + 左侧光条强调
   T01630：前景色改用 --menu-active-fg（默认 #fff），浅色/马卡龙等浅底主题可覆盖为深色，
   避免「白字/白图标压在浅色渐变上」或「图标色与背景同色系」导致的不可见问题。
   背景改用 --menu-active-bg（默认等于 --grad-fire）：白字压不住霓虹渐变的主题（creative/product/
   portfolio/dark）单独给一档更深的激活渐变，而不改动 --grad-fire 的其他消费点。 */
.tab-btn.active {
  background: var(--menu-active-bg, var(--grad-fire));
  color: var(--menu-active-fg, #fff);
  box-shadow: 0 4px 20px rgba(255, 0, 110, 0.4);
}

.tab-btn.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10%;
  bottom: 10%;
  width: 3px;
  background: var(--menu-active-fg, #fff);
  border-radius: 0 2px 2px 0;
  box-shadow: 0 0 8px var(--menu-active-fg, #fff);
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

.tab-btn:hover:not(.disabled) .tab-icon {
  opacity: 1;
}

/* T01630：选中态图标不再沿用 --neon-cyan（商务浅白主题下该值与激活背景同为品牌蓝 → 图标隐形），
   改为继承按钮前景色 --menu-active-fg，与菜单文字始终同色，任何主题下都保持可读。 */
.tab-btn.active .tab-icon {
  color: inherit;
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

/* T01630：折叠态同样改用 --menu-active-fg，图标色随主题前景走，不再硬编码白色 */
.icon-btn.active {
  color: var(--menu-active-fg, #fff);
  background: var(--menu-active-bg, var(--grad-fire));
  box-shadow: 0 4px 16px rgba(255, 0, 110, 0.4);
}

.icon-btn.active :deep(.nav-icon) {
  color: inherit;
  filter: drop-shadow(0 0 6px var(--menu-active-fg, #fff));
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
 *
 * T02916 平板口径：实测 769-900 区间原实现把 15 项菜单 + 分组标题折成 3 行，
 * 顶部 chrome 吃掉约 200px（780px 高的视口里占 26%），而内容区本身并不溢出。
 * 所以这一档要解决的是「chrome 高度」而不是「横向溢出」：
 * 菜单改为单行横向滚动、分组标题与溢出提示条隐藏、用户区并入同一行。
 * ============================================================ */
@media (max-width: 900px) {
  .app-shell {
    flex-direction: column;
    padding: 10px;
    gap: 10px;
  }

  .nav {
    width: 100%;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
  }

  .nav-left {
    flex: 0 0 auto;
    padding-right: 0;
  }

  .nav-left .subtitle {
    display: none;
  }

  .nav-tabs {
    flex: 1 1 auto;
    min-width: 0;
    flex-direction: row;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
  }

  /* 单行横滚时分组标题只会占宽不占义，提示条也与横滚冲突（T02449 的 N1/N2 属侧栏形态） */
  .nav-group-label,
  .nav-scroll-hint {
    display: none;
  }

  .tab-btn {
    width: auto;
    flex-shrink: 0;
  }

  .tab-label {
    white-space: nowrap;
  }

  .nav-bottom {
    flex: 0 0 auto;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 0 0 0 10px;
    border-top: none;
    border-left: 1px solid var(--accent-purple-a30);
  }

  .nav-user {
    flex-wrap: nowrap;
  }

  .nav-collapsed {
    width: 100%;
    flex-direction: row;
    flex-wrap: nowrap;
  }

  .nav-icons-bar {
    flex: 1 1 auto;
    min-width: 0;
    flex-direction: row;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .nav-collapsed-bottom {
    flex: 0 0 auto;
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

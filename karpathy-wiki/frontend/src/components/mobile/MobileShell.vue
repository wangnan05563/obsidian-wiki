<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useAuthStore } from '../../stores/auth';
import { useQueryStore } from '../../stores/query';
import { useConversationsStore } from '../../stores/conversations';
import MobileLogin from './MobileLogin.vue';
import MobileMe from './MobileMe.vue';
import MobileQuery from './MobileQuery.vue';
import MobileBrowse from './MobileBrowse.vue';
import MobileIngest from './MobileIngest.vue';
import MobileListen from './MobileListen.vue';
import { useMobileTheme } from '../../composables/useMobileTheme';
import { MOBILE_TABS } from '../../config/mobileTabs';
// T02914 功能入口：桌面低频页（技能/清理类）本期不重做移动视图，直接全宽挂载桌面组件。
import Skill from '../../views/Skill.vue';
import Cleanup from '../../views/Cleanup.vue';
import DataClean from '../../views/DataClean.vue';

// 移动端外壳：底部 5 Tab 导航 + 登录门 + 内容切换（SRS FR-MOB-NAV）。
// 完全复用桌面端 stores/services，不引入 vue-router（与项目单 SPA 约定一致）。
// 视觉：苹果风毛玻璃（aurora 模糊源 + 统一 --mg-* token），见 style.css 的 .mg-* 工具类。
const authStore = useAuthStore();
const queryStore = useQueryStore();
const conversationsStore = useConversationsStore();
// 主题切换（毛玻璃 / 浅白）：模块级单例，与 MobileMe 切换控件共享
const { theme } = useMobileTheme();

// 移动端多账户隔离（对齐桌面 Query.vue:136 的 watch）：登录态（账户 id）变化时，
// 必须先作废上一账户的会话作用域并清空内存问答，否则会跨用户泄漏：
//   1) useQueryStore 是模块级单例，不清理则下一用户仍看到上一用户的 messages 历史；
//   2) currentThreadId 残留会导致下一用户的问题复用上一用户的 threadId 发给后端，
//      后端据 threadId 注入上一用户的本地记忆上下文 -> 跨用户会话串台（记忆/答案互串）。
// 触发覆盖三种场景：登录( null->A )、登出( A->null )、切换账户( A->B )。
watch(
  () => authStore.user?.id,
  async (newId, oldId) => {
    if (newId === oldId) return;
    // 1) 清空内存问答（messages + currentThreadId），阻断历史可见与 threadId 串台
    queryStore.reset();
    // 2) 作废会话作用域（currentConversationId / scopedOwnerId），按新 ownerId 隔离 IndexedDB 历史
    conversationsStore.resetSession();
    // 3) 以新身份重新按 ownerId 隔离加载本地会话（未登录返回空，安全）
    try {
      await conversationsStore.loadConversations();
    } catch {
      /* IndexedDB 不可用时静默降级，仅内存态 */
    }
  },
);

type TabKey = (typeof MOBILE_TABS)[number]['key'];

const tabs = MOBILE_TABS;

const activeTab = ref<TabKey>('query');

// T02914：「我的 → 功能入口」打开的桌面页。打开时主区域整体切换为该桌面视图，
// 点任意 Tab 或返回按钮即关闭回原 Tab——5 Tab 布局不动。
type FeatureKey = 'skill' | 'cleanup' | 'dataclean';
const featureView = ref<FeatureKey | null>(null);
const featureComps: Record<FeatureKey, unknown> = { skill: Skill, cleanup: Cleanup, dataclean: DataClean };
const featureTitles: Record<FeatureKey, string> = {
  skill: '技能管理',
  cleanup: '缓存与日志清理',
  dataclean: '页面质量清洗',
};
function onTab(key: TabKey) {
  featureView.value = null;
  activeTab.value = key;
}

// 从「知识问答」页点击 vault 引用跳转（RefsList 派发 karpathy:jump-vault）。
// 空串表示无跳转；'__search__:' 前缀表示按 query 搜索，否则按 path 打开详情。
const vaultJump = ref<string>('');
function onVaultJump(e: Event) {
  const detail = (e as CustomEvent).detail;
  if (typeof detail === 'string' && detail) {
    vaultJump.value = detail;
  } else if (detail && typeof detail.path === 'string' && detail.path) {
    vaultJump.value = detail.path;
  } else if (detail && typeof detail.query === 'string' && detail.query) {
    vaultJump.value = '__search__:' + detail.query;
  } else {
    return;
  }
  activeTab.value = 'browse';
}
onMounted(() => window.addEventListener('karpathy:jump-vault', onVaultJump));
onBeforeUnmount(() => window.removeEventListener('karpathy:jump-vault', onVaultJump));

// 各 Tab 内联 SVG 图标（独立于桌面 NavIcons，避免缺失图标名）
const icons: Record<TabKey, string> = {
  query: 'M4 5h16v11H8l-4 4V5z',
  browse: 'M5 4h9a2 2 0 0 1 2 2v14l-5.5-3.5L7 20V6a2 2 0 0 0-2-2z M14 4h5a0 0 0 0 1 0 0v16',
  listen: 'M4 14v-2a8 8 0 0 1 16 0v2 M4 14h3v6H4z M17 14h3v6h-3z',
  ingest: 'M12 16V4 M7 9l5-5 5 5 M5 20h14',
  me: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 20a8 8 0 0 1 16 0',
};
</script>

<template>
  <!-- 登录门：未登录时全屏登录/注册，登录成功后自动进入 Tab 主界面 -->
  <MobileLogin v-if="!authStore.isLoggedIn" />

  <div v-else class="mobile-root" :class="{ 'theme-light': theme === 'light' }">
    <!-- 毛玻璃模糊源层（仅毛玻璃主题显示；浅白主题由 mobile-light.css 隐藏）-->
    <div class="mg-aurora" aria-hidden="true"></div>
    <!-- 内容区：按激活 Tab 渲染对应移动视图（各页自带浅色顶栏） -->
    <!-- 聆听页用 v-show 常驻挂载：切走 Tab 时组件不卸载，<audio> 继续后台播放、
         队列/进度等本地状态不丢失（播放中切页保持播放状态）。其余 Tab 仍用 v-if。 -->
    <main class="mobile-content">
      <!-- T02914：功能入口打开时整体替换为桌面视图（含返回条），原 Tab 视图不销毁状态 -->
      <section v-if="featureView" class="mobile-feature">
        <div class="mf-topbar">
          <button class="mf-back" type="button" aria-label="返回" @click="featureView = null">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            返回
          </button>
          <span class="mf-title">{{ featureTitles[featureView] }}</span>
        </div>
        <div class="mf-body">
          <component :is="featureComps[featureView]" />
        </div>
      </section>
      <template v-else>
        <MobileQuery v-if="activeTab === 'query'" @open-me="activeTab = 'me'" />
        <!-- T02720：窄屏空态的「下一步」= 切到能解决它的 Tab（知识库为空 → 去「投递」），
             与 MobileQuery 的 open-me 同一先例，不引入 vue-router。 -->
        <MobileBrowse v-else-if="activeTab === 'browse'" :jump-path="vaultJump" @open-ingest="activeTab = 'ingest'" />
        <MobileIngest v-else-if="activeTab === 'ingest'" />
        <MobileMe v-else-if="activeTab === 'me'" @open-feature="featureView = $event" />
      </template>
      <MobileListen v-show="activeTab === 'listen' && !featureView" :visible="activeTab === 'listen' && !featureView" @open-ingest="onTab('ingest')" />
    </main>

    <!-- 底部 Tab 导航栏（固定，含安全区适配，浅色描边） -->
    <nav class="mobile-tabbar" aria-label="移动端主导航">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-item"
        :class="{ active: activeTab === tab.key }"
        :aria-label="tab.label"
        :aria-current="activeTab === tab.key ? 'page' : undefined"
        @click="onTab(tab.key)"
      >
        <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path :d="icons[tab.key]" />
        </svg>
        <span class="tab-label">{{ tab.label }}</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.mobile-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  min-height: 100vh;
  /* 毛玻璃主题：透明底，露出 .mg-aurora 光晕层；浅白主题由 --m-* 覆盖为白底 */
  background: var(--m-bg, transparent);
  color: var(--m-text, #f3eaff);
  font-family: var(--m-font);
  overflow: hidden;
}

.mobile-content {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  /* 毛玻璃主题：整片内容区磨砂，露出 aurora 彩光；浅白主题 --m-blur:none 自动失效 */
  backdrop-filter: var(--m-blur);
  -webkit-backdrop-filter: var(--m-blur);
  /* 预留底部 Tab 栏 + 系统导航安全区 */
  padding-bottom: calc(56px + env(safe-area-inset-bottom, 0));
}

/* T02914：功能入口承载的桌面视图（全宽挂载 + 返回条） */
.mobile-feature {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--m-surface, #ffffff);
  border-radius: 12px;
  overflow: hidden;
}

.mf-topbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: var(--m-border-subtle, 1px solid #ededed);
  background: var(--m-surface, #ffffff);
  position: sticky;
  top: 0;
  z-index: 2;
}

.mf-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--m-primary, #1554d1);
  font-size: 14px;
  font-weight: 600;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-family: var(--m-font);
  -webkit-tap-highlight-color: transparent;
}

.mf-back:active {
  background: var(--m-border, #ececee);
}

.mf-back svg {
  width: 18px;
  height: 18px;
}

.mf-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--m-text, #111111);
}

/* 桌面组件自带内边距，这里只负责撑满可滚动区域 */
.mf-body {
  flex: 1;
  min-height: 0;
}

.mobile-tabbar {
  flex-shrink: 0;
  display: flex;
  height: 56px;
  padding-bottom: env(safe-area-inset-bottom, 0);
  /* 毛玻璃主题：半透磨砂 + 高光顶边；浅白主题由 --m-* 覆盖为白底 */
  background: var(--m-surface, #ffffff);
  border-top: var(--m-border-subtle, 1px solid #ededed);
  backdrop-filter: var(--m-blur);
  -webkit-backdrop-filter: var(--m-blur);
  box-shadow: var(--m-highlight-soft);
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
}

.tab-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border: none;
  background: transparent;
  color: var(--m-text-3, #9aa0a6);
  cursor: pointer;
  font-family: var(--m-font);
  -webkit-tap-highlight-color: transparent;
}

.tab-item:active {
  color: var(--m-text-2, #777777);
}

.tab-item.active {
  color: var(--m-primary, #1554d1);
}

.tab-icon {
  width: 22px;
  height: 22px;
}

.tab-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
</style>

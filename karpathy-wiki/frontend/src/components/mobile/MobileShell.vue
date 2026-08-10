<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useAuthStore } from '../../stores/auth';
import MobileLogin from './MobileLogin.vue';
import MobileMe from './MobileMe.vue';
import MobileQuery from './MobileQuery.vue';
import MobileBrowse from './MobileBrowse.vue';
import MobileIngest from './MobileIngest.vue';
import MobileListen from './MobileListen.vue';
import MobilePlaceholder from './MobilePlaceholder.vue';

// 移动端外壳：底部 5 Tab 导航 + 登录门 + 内容切换（SRS FR-MOB-NAV）。
// 完全复用桌面端 stores/services，不引入 vue-router（与项目单 SPA 约定一致）。
const authStore = useAuthStore();

type TabKey = 'query' | 'browse' | 'listen' | 'ingest' | 'me';

const tabs: { key: TabKey; label: string; icon: string }[] = [
  { key: 'query', label: '问答', icon: 'query' },
  { key: 'browse', label: '浏览', icon: 'browse' },
  { key: 'listen', label: '聆听', icon: 'listen' },
  { key: 'ingest', label: '投递', icon: 'ingest' },
  { key: 'me', label: '我的', icon: 'me' },
];

const activeTab = ref<TabKey>('query');

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

const titleMap: Record<TabKey, string> = {
  query: '知识问答',
  browse: '知识浏览',
  listen: '聆听',
  ingest: '投递采集',
  me: '我的',
};

const placeholderDesc: Record<Exclude<TabKey, 'me'>, string> = {
  query: '随时向知识库提问，查看流式回答与引用来源',
  browse: '浏览与搜索已入库的笔记、文章与引用片段',
  listen: '通勤、散步时聆听知识库内容（TTS 播客模式）',
  ingest: '随手拍纸质笔记或粘贴网页链接，快速入库',
};

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

  <div v-else class="mobile-root">
    <!-- 顶部标题栏 -->
    <header class="mobile-header">
      <span class="mobile-title">{{ titleMap[activeTab] }}</span>
    </header>

    <!-- 内容区：按激活 Tab 渲染对应移动视图 -->
    <main class="mobile-content">
      <MobileQuery v-if="activeTab === 'query'" />
      <MobileBrowse v-else-if="activeTab === 'browse'" :jump-path="vaultJump" />
      <MobileIngest v-else-if="activeTab === 'ingest'" />
      <MobileListen v-else-if="activeTab === 'listen'" />
      <MobilePlaceholder
        v-else-if="activeTab !== 'me'"
        :tab="activeTab"
        :label="titleMap[activeTab]"
        :desc="placeholderDesc[activeTab]"
      />
      <MobileMe v-else />
    </main>

    <!-- 底部 Tab 导航栏（固定，含安全区适配） -->
    <nav class="mobile-tabbar" aria-label="移动端主导航">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-item"
        :class="{ active: activeTab === tab.key }"
        :aria-label="tab.label"
        :aria-current="activeTab === tab.key ? 'page' : undefined"
        @click="activeTab = tab.key"
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
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  min-height: 100vh;
  background: var(--bg-void);
  color: var(--text-bright);
  font-family: var(--font-body);
  overflow: hidden;
}

.mobile-header {
  flex-shrink: 0;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-top: env(safe-area-inset-top, 0);
  background: rgba(5, 0, 16, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--accent-purple-a30);
  position: relative;
  z-index: 5;
}

.mobile-title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 1px;
  background: var(--grad-aurora);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.mobile-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: calc(64px + env(safe-area-inset-bottom, 0));
}

.mobile-tabbar {
  flex-shrink: 0;
  display: flex;
  height: 56px;
  padding-bottom: env(safe-area-inset-bottom, 0);
  background: rgba(5, 0, 16, 0.92);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid var(--accent-purple-a30);
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
  color: var(--text-soft);
  cursor: pointer;
  transition: color 0.25s ease, transform 0.2s ease;
  font-family: var(--font-body);
}

.tab-item:active {
  transform: scale(0.92);
}

.tab-item.active {
  color: var(--neon-cyan);
}

.tab-item.active .tab-icon {
  filter: drop-shadow(0 0 6px rgba(0, 245, 255, 0.6));
}

.tab-icon {
  width: 22px;
  height: 22px;
}

.tab-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
}
</style>

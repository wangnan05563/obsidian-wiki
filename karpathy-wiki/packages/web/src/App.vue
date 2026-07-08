<script setup lang="ts">
import { ref } from 'vue';
import RobotAvatar from './components/RobotAvatar.vue';
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
// Dashboard 作为默认首页，提供全局概览与快捷入口
const currentView = ref<ViewName>('dashboard');

function go(view: ViewName) {
  currentView.value = view;
}

// Dashboard 快捷入口跳转
function handleNavigate(view: 'ingest' | 'browse' | 'query' | 'health') {
  currentView.value = view;
}
</script>

<template>
  <div class="app-shell">
    <header class="nav glass-card">
      <div class="nav-left" @click="go('dashboard')">
        <RobotAvatar :size="44" />
        <span class="title">AI 知识库</span>
        <span class="subtitle">Karpathy Wiki</span>
      </div>
      <nav class="nav-tabs">
        <button
          class="tab-btn"
          :class="{ active: currentView === 'dashboard' }"
          @click="go('dashboard')"
        >
          仪表盘
        </button>
        <button
          class="tab-btn"
          :class="{ active: currentView === 'ingest' }"
          @click="go('ingest')"
        >
          投递资料
        </button>
        <button
          class="tab-btn"
          :class="{ active: currentView === 'progress', disabled: !store.isCompiling && !store.isDone }"
          :disabled="!store.isCompiling && !store.isDone"
          @click="go('progress')"
        >
          编译进度
        </button>
        <button
          class="tab-btn"
          :class="{ active: currentView === 'browse' }"
          @click="go('browse')"
        >
          知识浏览
        </button>
        <button
          class="tab-btn"
          :class="{ active: currentView === 'query' }"
          @click="go('query')"
        >
          知识问答
        </button>
        <button
          class="tab-btn"
          :class="{ active: currentView === 'graph' }"
          @click="go('graph')"
        >
          图谱
        </button>
        <button
          class="tab-btn"
          :class="{ active: currentView === 'health' }"
          @click="go('health')"
        >
          体检
        </button>
        <button
          class="tab-btn"
          :class="{ active: currentView === 'config' }"
          @click="go('config')"
        >
          配置
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
      <span>powered by Karpathy AI · 知识库垂直切片</span>
    </footer>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 20px;
  gap: 20px;
  max-width: 1100px;
  margin: 0 auto;
}

.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 22px;
}

.nav-left {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}

.title {
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
}

.subtitle {
  font-size: 12px;
  color: var(--color-text-soft);
  padding: 2px 10px;
  background: var(--color-cyan);
  border-radius: 10px;
}

.nav-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tab-btn {
  border: none;
  background: transparent;
  padding: 8px 14px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-soft);
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: all 0.2s ease;
  font-family: inherit;
}

.tab-btn:hover:not(.disabled) {
  background: var(--color-pink);
  color: var(--color-text);
}

.tab-btn.active {
  background: var(--color-primary);
  color: #fff;
}

.tab-btn.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.content {
  flex: 1;
}

.footer {
  text-align: center;
  color: var(--color-text-soft);
  font-size: 12px;
  padding: 12px;
}
</style>

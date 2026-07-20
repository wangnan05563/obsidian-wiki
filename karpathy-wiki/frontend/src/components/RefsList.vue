<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Reference } from '../types';

// F-3.8 参考文章列表（仿豆包「搜索 N 个关键词，参考 N 篇资料」）
// 设计要点（SRS F-3.8）：
//   1. 顶部横条：「参考 N 篇资料」+ 折叠箭头
//   2. 默认展开前 3 条，超过的折叠为「展开更多」
//   3. vault / web 来源徽章视觉区分（vault=青色 VAULT / web=蓝色 WEB）
//   4. 引用编号 [1][2][3] 显示在卡片左侧
//   5. vault 来源点击跳转知识库浏览页；web 来源新窗口打开 URL（noopener+noreferrer 防 tab nabbing）
//   6. ref 为空 → 整个区块隐藏（v-if）
const props = defineProps<{ refs: Reference[] }>();

const expanded = ref(true);
// F-3.8 默认展开前 3 条，超过的折叠为「展开更多」按钮
const COLLAPSE_THRESHOLD = 3;
const showAll = ref(false);

// F-3.8 折叠整个区块时重置 showAll，避免下次展开仍停留在「全部展示」状态
// 为什么不保留 showAll：用户主动折叠表示重新审视，应回到默认前 3 条视图
function toggleExpanded() {
  expanded.value = !expanded.value;
  if (!expanded.value) {
    showAll.value = false;
  }
}

const visibleRefs = computed(() => {
  if (showAll.value) return props.refs;
  return props.refs.slice(0, COLLAPSE_THRESHOLD);
});
const hiddenCount = computed(() => Math.max(0, props.refs.length - COLLAPSE_THRESHOLD));

// 统计 vault / web 来源数，用于徽章展示
const vaultCount = computed(() => props.refs.filter(r => r.source === 'vault').length);
const webCount = computed(() => props.refs.filter(r => r.source === 'web').length);

// 项目未引入 vue-router（使用 ref 切换 currentView 的轻量架构）
// 通过 CustomEvent + sessionStorage 跨组件传递跳转目标：
//   - RefsList 仅负责派发 karpathy:jump-vault 事件并暂存目标路径
//   - App.vue 监听该事件并切换到 browse 视图
//   - Browse.vue onMounted 时读取 sessionStorage.jumpPath 自动定位
function handleRefClick(ref: Reference) {
  if (ref.source === 'vault' && ref.path) {
    sessionStorage.setItem('karpathy:jumpPath', ref.path);
    globalThis.dispatchEvent(new CustomEvent('karpathy:jump-vault', { detail: { path: ref.path } }));
  } else if (ref.url) {
    // web 引用：新窗口打开外部链接，加 noopener+noreferrer 防止 tab nabbing
    globalThis.open(ref.url, '_blank', 'noopener,noreferrer');
  }
}
</script>

<template>
  <div class="refs-list" v-if="refs.length > 0">
    <!-- 顶部横条：仿豆包「参考 N 篇资料」+ 来源统计 + 折叠箭头 -->
    <div class="refs-header" @click="toggleExpanded">
      <span class="refs-icon">📚</span>
      <span class="refs-title">
        参考 {{ refs.length }} 篇资料
        <span v-if="vaultCount > 0" class="source-stat vault">知识库 {{ vaultCount }}</span>
        <span v-if="webCount > 0" class="source-stat web">联网 {{ webCount }}</span>
      </span>
      <span class="toggle">{{ expanded ? '▼' : '▶' }}</span>
    </div>

    <!-- 卡片列表：默认前 3 条，超过折叠 -->
    <div class="refs-body" v-if="expanded">
      <div v-for="ref in visibleRefs" :key="ref.url || ref.path || ref.citeIndex"
        class="ref-item"
        :class="ref.source"
        @click="handleRefClick(ref)">
        <span class="ref-cite">[{{ ref.citeIndex }}]</span>
        <div class="ref-info">
          <div class="ref-title-row">
            <span class="ref-title">{{ ref.title }}</span>
            <span class="source-badge" :class="ref.source">
              {{ ref.source === 'vault' ? 'VAULT' : 'WEB' }}
            </span>
          </div>
          <div class="ref-snippet" v-if="ref.snippet">{{ ref.snippet }}</div>
        </div>
      </div>

      <!-- "展开更多" 按钮：仅当 refs 数量超过阈值且未展开时显示 -->
      <button v-if="hiddenCount > 0 && !showAll" class="show-more-btn"
        @click.stop="showAll = true">
        展开更多（剩余 {{ hiddenCount }} 条）
      </button>
      <button v-else-if="hiddenCount > 0 && showAll" class="show-more-btn"
        @click.stop="showAll = false">
        收起
      </button>
    </div>
  </div>
</template>

<style scoped>
.refs-list {
  margin: 8px 0;
  padding: 8px 12px;
  background: var(--accent-cyan-a04, rgba(0, 245, 255, 0.04));
  border-left: 3px solid var(--neon-cyan, #00f5ff);
  border-radius: 0 8px 8px 0;
}
.refs-header {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-soft, #888);
  user-select: none;
}
.refs-icon {
  font-size: 14px;
}
.refs-title {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  color: var(--text-main, #ccc);
}
.toggle {
  font-size: 10px;
  transition: transform 0.2s;
}
.source-stat {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
}
.source-stat.vault {
  background: var(--accent-cyan-a15, rgba(0, 245, 255, 0.15));
  color: var(--neon-cyan, #00f5ff);
}
.source-stat.web {
  background: var(--accent-purple-a15, rgba(99, 102, 241, 0.15));
  color: var(--accent-purple-base, #6366f1);
}
.refs-body {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ref-item {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s, transform 0.2s;
  border-left: 2px solid transparent;
}
.ref-item:hover {
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
  transform: translateX(2px);
}
.ref-item.vault {
  border-left-color: var(--neon-cyan, #00f5ff);
}
.ref-item.web {
  border-left-color: var(--accent-purple-base, #6366f1);
}
.ref-cite {
  font-size: 11px;
  color: var(--text-dim, #666);
  font-family: var(--font-mono, monospace);
  flex-shrink: 0;
  line-height: 1.5;
}
.ref-info {
  flex: 1;
  min-width: 0;
}
.ref-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ref-title {
  font-size: 13px;
  color: var(--text-main, #ccc);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.source-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 4px;
  font-weight: 600;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}
.source-badge.vault {
  background: var(--accent-cyan-a18, rgba(0, 245, 255, 0.18));
  color: var(--neon-cyan, #00f5ff);
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
}
.source-badge.web {
  background: var(--accent-purple-a18, rgba(99, 102, 241, 0.18));
  color: var(--accent-purple-base, #6366f1);
  border: 1px solid var(--accent-purple-a30, rgba(99, 102, 241, 0.3));
}
.ref-snippet {
  font-size: 11px;
  color: var(--text-soft, #888);
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.4;
}
.show-more-btn {
  margin-top: 4px;
  padding: 4px 8px;
  background: transparent;
  border: 1px dashed var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  border-radius: 6px;
  color: var(--text-soft, #888);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}
.show-more-btn:hover {
  background: var(--accent-cyan-a06, rgba(0, 245, 255, 0.06));
  border-color: var(--neon-cyan, #00f5ff);
  color: var(--neon-cyan, #00f5ff);
}
</style>

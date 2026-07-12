<script setup lang="ts">
import { ref } from 'vue';
import type { Reference } from '../types';

const props = defineProps<{ refs: Reference[] }>();
const expanded = ref(true);

function handleRefClick(ref: Reference) {
  if (ref.source === 'vault' && ref.path) {
    // vault 页面跳转到知识库浏览
    globalThis.location.hash = `#/files?path=${encodeURIComponent(ref.path)}`;
  } else if (ref.url) {
    // web 来源新窗口打开
    globalThis.open(ref.url, '_blank', 'noopener,noreferrer');
  }
}

function refIcon(source: string): string {
  return source === 'vault' ? '📄' : '🔗';
}
</script>

<template>
  <div class="refs-list" v-if="refs.length > 0">
    <div class="refs-header" @click="expanded = !expanded">
      <span class="refs-icon">📚</span>
      <span class="refs-title">参考来源 ({{ refs.length }})</span>
      <span class="toggle">{{ expanded ? '▼' : '▶' }}</span>
    </div>
    <div class="refs-body" v-if="expanded">
      <div v-for="(ref, i) in refs" :key="i"
        class="ref-item"
        :class="ref.source"
        @click="handleRefClick(ref)">
        <span class="ref-icon">{{ refIcon(ref.source) }}</span>
        <div class="ref-info">
          <div class="ref-title">[{{ ref.citeIndex }}] {{ ref.title }}</div>
          <div class="ref-snippet" v-if="ref.snippet">{{ ref.snippet }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.refs-list {
  margin: 8px 0;
  padding: 8px 12px;
  background: rgba(0, 245, 255, 0.04);
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
}
.refs-body {
  margin-top: 8px;
}
.ref-item {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s;
}
.ref-item:hover {
  background: rgba(0, 245, 255, 0.08);
}
.ref-icon {
  font-size: 16px;
  line-height: 1.5;
}
.ref-info {
  flex: 1;
  min-width: 0;
}
.ref-title {
  font-size: 13px;
  color: var(--text-main, #ccc);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ref-snippet {
  font-size: 11px;
  color: var(--text-soft, #888);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

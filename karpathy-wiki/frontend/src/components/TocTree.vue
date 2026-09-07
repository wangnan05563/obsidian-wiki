<script setup lang="ts">
// 目录树扁平化：仅展示一级章节（顶级标题）。
// 为什么移除子章节展开/折叠：多层级树形展开冗余，目录栏精简为单层导航；
//   打开文档时由 Browse 自动展开该文档章节面板并滚动定位，无需手动展开图标。
export interface TocNode {
  id: string;
  text: string;
}

const props = defineProps<{
  nodes: TocNode[];
  activeId: string | null;
}>();

const emit = defineEmits<{
  (e: 'navigate', id: string): void;
}>();
</script>

<template>
  <ul class="toc-tree">
    <li v-for="node in nodes" :key="node.id" class="toc-node">
      <div class="toc-row" :class="{ active: activeId === node.id }">
        <button
          type="button"
          class="toc-text-btn"
          title="跳到该章节"
          data-tip="跳到该章节"
          @click.stop="emit('navigate', node.id)"
        >
          <span class="toc-text">{{ node.text }}</span>
        </button>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.toc-tree {
  list-style: none;
  margin: 0;
  padding: 0;
}

.toc-node {
  margin-top: 2px;
}

.toc-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--text-base);
  transition: background 0.2s ease, color 0.2s ease;
}

.toc-row:hover {
  background: var(--accent-cyan-a12);
  color: var(--neon-cyan);
}

/* 当前定位章节高亮：表达「正在看这里」 */
.toc-row.active {
  background: var(--accent-cyan-a20);
  color: var(--neon-cyan);
  border-left: 2px solid var(--neon-cyan);
}

.toc-text-btn {
  flex: 1;
  min-width: 0;
  padding: 0;
  background: transparent;
  border: none;
  text-align: left;
  font-size: 12px;
  color: inherit;
  cursor: pointer;
}

/* 章节名完整展示不截断：允许换行，避免 ellipsis 吞掉长章节名 */
.toc-text {
  white-space: normal;
  overflow: visible;
  word-break: break-word;
}
</style>

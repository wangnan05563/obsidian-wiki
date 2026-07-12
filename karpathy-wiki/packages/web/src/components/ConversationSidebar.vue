<script setup lang="ts">
import { computed } from 'vue';
import { useConversationsStore } from '../stores/conversations';
import type { ConversationRecord } from '../types';

const props = defineProps<{ collapsed: boolean }>();
const emit = defineEmits<{
  toggle: [];
  newSession: [];
  select: [id: string];
}>();

const store = useConversationsStore();

// 过滤 + 排序：置顶在前，然后按 updatedAt 倒序
const sortedConversations = computed(() => {
  const filtered = store.searchKeyword
    ? store.conversations.filter((conversation: ConversationRecord) => conversation.title.includes(store.searchKeyword))
    : store.conversations;
  return [...filtered].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
});

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;
  return d.toLocaleDateString();
}

function handlePin(e: Event, id: string) {
  e.stopPropagation();
  store.togglePin(id);
}
</script>

<template>
  <aside class="conversation-sidebar" :class="{ collapsed }">
    <div class="sidebar-header" v-if="!collapsed">
      <button class="new-btn" @click="emit('newSession')">+ 新对话</button>
      <input class="search-input" v-model="store.searchKeyword"
        placeholder="搜索对话..." />
    </div>
    <div class="conversation-list" v-if="!collapsed">
      <div v-for="conv in sortedConversations" :key="conv.id"
        class="conversation-item"
        :class="{ active: conv.id === store.currentConversationId }"
        @click="emit('select', conv.id)">
        <span class="pin-icon" v-if="conv.isPinned" @click="(e) => handlePin(e, conv.id)">📌</span>
        <div class="conv-info">
          <div class="conv-title">{{ conv.title }}</div>
          <div class="conv-time">{{ formatTime(conv.updatedAt) }}</div>
        </div>
      </div>
      <div class="empty-hint" v-if="sortedConversations.length === 0">
        暂无历史对话
      </div>
    </div>
    <button class="collapse-btn" @click="emit('toggle')">
      {{ collapsed ? '▶' : '◀' }}
    </button>
  </aside>
</template>

<style scoped>
.conversation-sidebar {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar, rgba(255, 255, 255, 0.03));
  border-right: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
  transition: width 0.3s ease;
  position: relative;
}
.conversation-sidebar.collapsed {
  width: 40px;
}
.sidebar-header {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.new-btn {
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  background: var(--accent-cyan-a12, rgba(0, 245, 255, 0.12));
  color: var(--text-bright, #f3e9ff);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}
.new-btn:hover {
  background: var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  border-color: var(--neon-cyan, #00f5ff);
}
.search-input {
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-main, #ccc);
  font-size: 12px;
  outline: none;
}
.search-input:focus {
  border-color: var(--neon-cyan, #00f5ff);
}
.conversation-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 8px;
}
.conversation-item {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
  margin-bottom: 4px;
}
.conversation-item:hover {
  background: rgba(255, 255, 255, 0.05);
}
.conversation-item.active {
  background: rgba(0, 245, 255, 0.1);
  border-left: 2px solid var(--neon-cyan, #00f5ff);
}
.pin-icon {
  cursor: pointer;
  font-size: 14px;
}
.conv-info {
  flex: 1;
  min-width: 0;
}
.conv-title {
  font-size: 13px;
  color: var(--text-main, #ccc);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-time {
  font-size: 11px;
  color: var(--text-soft, #888);
  margin-top: 2px;
}
.empty-hint {
  text-align: center;
  color: var(--text-soft, #888);
  font-size: 12px;
  padding: 20px;
}
.collapse-btn {
  position: absolute;
  top: 50%;
  right: -12px;
  transform: translateY(-50%);
  width: 24px;
  height: 40px;
  border-radius: 0 8px 8px 0;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
  background: var(--bg-sidebar, rgba(255, 255, 255, 0.05));
  color: var(--text-soft, #888);
  cursor: pointer;
  font-size: 10px;
  z-index: 10;
}
.collapse-btn:hover {
  background: rgba(0, 245, 255, 0.1);
}
</style>

<script setup lang="ts">
// §2.4 InputToolbar — 输入区上方工具栏。
// 职责：展示工具按钮（联网搜索/深度思考/附件等），点击切换 activeMode。
// 设计选择：图标内置为自定义 SVG（霓虹科技风线条风格），不依赖 emoji 或第三方图标库。
//   每个 tool.key 对应一个手绘 SVG path，保证视觉一致性。

interface Tool {
  key: string;
  label: string;
}

const props = defineProps<{
  tools: Tool[];
  activeMode: string;
}>();
const emit = defineEmits<{ select: [mode: string] }>();
</script>

<template>
  <div class="input-toolbar">
    <button v-for="tool in props.tools" :key="tool.key"
      class="tool-chip"
      :class="{ active: props.activeMode === tool.key }"
      @click="emit('select', tool.key)">
      <!-- 联网搜索图标：地球 + 信号线，表达"连接互联网" -->
      <svg v-if="tool.key === 'web'" class="tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/>
        <ellipse cx="12" cy="12" rx="4" ry="9" stroke="currentColor" stroke-width="1.5"/>
        <line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="18" cy="6" r="2" fill="currentColor" opacity="0.6"/>
      </svg>
      <!-- 深度思考图标：神经网络节点连线，表达"AI 深度推理" -->
      <svg v-else-if="tool.key === 'deep'" class="tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="18" cy="6" r="2" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="12" cy="14" r="2.5" stroke="currentColor" stroke-width="1.8"/>
        <circle cx="6" cy="20" r="2" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="18" cy="20" r="2" stroke="currentColor" stroke-width="1.5"/>
        <line x1="7.5" y1="7" x2="10.5" y2="12.5" stroke="currentColor" stroke-width="1.2"/>
        <line x1="16.5" y1="7" x2="13.5" y2="12.5" stroke="currentColor" stroke-width="1.2"/>
        <line x1="10.5" y1="15.5" x2="7.5" y2="19" stroke="currentColor" stroke-width="1.2"/>
        <line x1="13.5" y1="15.5" x2="16.5" y2="19" stroke="currentColor" stroke-width="1.2"/>
      </svg>
      <span class="tool-label">{{ tool.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.input-toolbar {
  display: flex;
  gap: 8px;
  padding: 4px 0 0;
  overflow-x: auto;
  position: relative;
  z-index: 2;
}
.tool-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 16px;
  border: 1px solid rgba(0, 245, 255, 0.2);
  background: rgba(0, 245, 255, 0.05);
  color: var(--text-soft, #888);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.25s;
  white-space: nowrap;
}
.tool-chip:hover {
  background: rgba(0, 245, 255, 0.12);
  border-color: var(--neon-cyan, #00f5ff);
  box-shadow: 0 0 8px rgba(0, 245, 255, 0.2);
}
.tool-chip.active {
  background: rgba(0, 245, 255, 0.18);
  border-color: var(--neon-cyan, #00f5ff);
  color: var(--neon-cyan, #00f5ff);
  box-shadow: 0 0 12px rgba(0, 245, 255, 0.3);
}
.tool-icon {
  flex-shrink: 0;
  transition: filter 0.25s;
}
.tool-chip.active .tool-icon {
  filter: drop-shadow(0 0 3px var(--neon-cyan, #00f5ff));
}
.tool-label {
  font-size: 12px;
  font-weight: 500;
}
</style>

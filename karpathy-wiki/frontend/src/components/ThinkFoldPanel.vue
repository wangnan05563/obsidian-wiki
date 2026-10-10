<script lang="ts">
// FR-23 思考过程折叠面板（T01742）：模型 <think> 内容的可折叠展示。
// 展开状态会话级记忆：以模块级 Map 保存 panelKey → 展开与否（页面生命周期内，
// 切换会话回来仍保持各自状态）；流式面板用固定 key（live 态只有当前会话一个实例）。
const expandedPanels = new Set<string>();
export default {
  inheritAttrs: false,
};
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 模型 <think> 内容（纯文本，含换行） */
    thinking: string;
    /** 流式进行中：默认展开跟随输出，收起后不再自动展开 */
    live?: boolean;
    /** 展开状态记忆键（历史消息传消息 id；流式面板传固定串） */
    panelKey?: string;
  }>(),
  { live: false, panelKey: '' },
);

const key = computed(() => props.panelKey || '__live__');
const expanded = ref(expandedPanels.has(key.value));

// 会话级记忆：切换即写回模块级 Map，同一面板重挂载（切会话回来）时恢复
watch(
  key,
  (k) => {
    expanded.value = expandedPanels.has(k);
  },
  { immediate: true },
);

function toggle() {
  expanded.value = !expanded.value;
  if (expanded.value) expandedPanels.add(key.value);
  else expandedPanels.delete(key.value);
}

// 标题「思考过程（N 字）」：字数按规格取思考内容长度
const title = computed(() => `思考过程（${props.thinking.length} 字）`);
</script>

<template>
  <div class="think-fold" :class="{ live }">
    <button class="think-fold-head" type="button" :data-testid="live ? 'think-panel-live' : 'think-panel'" @click="toggle">
      <span class="think-fold-arrow" :class="{ open: expanded }">▸</span>
      <span class="think-fold-title">{{ title }}</span>
      <span v-if="live" class="think-fold-live-dot" title="思考输出中"></span>
    </button>
    <!-- 纯文本 + 换行渲染（white-space: pre-wrap），不做 Markdown 重排（FR-23 规格 3） -->
    <div v-show="expanded" class="think-fold-body" data-testid="think-panel-body">{{ thinking }}</div>
  </div>
</template>

<style scoped>
/* 折叠面板：轻量灰底卡片，置于回答顶部；颜色消费语义变量（FR-24 token 迁移自动适配） */
.think-fold {
  margin: 0 0 8px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
  border-radius: 8px;
  background: var(--bg-card, rgba(247, 248, 250, 0.9));
  overflow: hidden;
}

.think-fold-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-soft, #888);
  text-align: left;
}

.think-fold-arrow {
  display: inline-block;
  transition: transform 0.15s ease;
  font-size: 11px;
}

.think-fold-arrow.open {
  transform: rotate(90deg);
}

.think-fold-title {
  font-weight: 500;
}

/* 流式中的呼吸点：提示思考仍在输出 */
.think-fold-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warning, #e6a23c);
  animation: think-pulse 1.2s ease-in-out infinite;
}

@keyframes think-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.think-fold-body {
  padding: 8px 12px;
  border-top: 1px dashed var(--border-color, rgba(128, 128, 128, 0.25));
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-soft, #888);
  /* FR-23 规格 3：纯文本 + 换行渲染，禁止 Markdown 重排 */
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
</style>

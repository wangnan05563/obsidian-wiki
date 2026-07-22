<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ThinkingStep } from '../types';

const props = defineProps<{ steps: ThinkingStep[] }>();
// 默认折叠：减少视觉噪音，用户主动展开查看思考细节
const expanded = ref(false);

// 折叠态摘要：已思考 N 步 · 搜索 N 次 · 阅读 N 页
const summary = computed(() => {
  const toolCalls = props.steps.filter(s => s.phase === 'tool_call');
  const searches = toolCalls.filter(s => s.tool === 'search_pages').length;
  const reads = toolCalls.filter(s => s.tool === 'read_page').length;
  return `已思考 ${props.steps.length} 步 · 搜索 ${searches} 次 · 阅读 ${reads} 页`;
});

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    thinking: '思考',
    tool_call: '调用',
    composing: '组织',
  };
  return labels[phase] || phase;
}
</script>

<template>
  <div class="thinking-block" :class="{ collapsed: !expanded }">
    <div class="thinking-header" @click="expanded = !expanded">
      <span class="thinking-icon">💭</span>
      <span class="thinking-summary">{{ summary }}</span>
      <span class="toggle">{{ expanded ? '▼' : '▶' }}</span>
    </div>
    <!-- 用 v-show + max-height transition 替代 v-if，实现 200ms 平滑展开/折叠（F-3.1 验收标准） -->
    <div class="thinking-body" v-show="expanded">
      <div v-for="(step, idx) in steps" :key="step.message + idx" class="thinking-step">
        <span class="step-phase" :class="step.phase">{{ phaseLabel(step.phase) }}</span>
        <span class="step-message">{{ step.message }}</span>
        <span class="step-tool" v-if="step.tool">{{ step.tool }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.thinking-block {
  margin: 8px 0;
  padding: 8px 12px;
  background: rgba(176, 38, 255, 0.06);
  border-left: 3px solid var(--neon-purple, #b226ff);
  border-radius: 0 8px 8px 0;
}
.thinking-header {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-soft, #888);
}
/* F-3.1 加载态：thinking-icon 脉动，让用户感知 AI 正在工作 */
.thinking-icon {
  display: inline-block;
  animation: thinking-pulse 1.5s ease-in-out infinite;
}
@keyframes thinking-pulse {
  0%, 100% { opacity: 0.6; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.15); }
}
/* F-3.1 折叠/展开过渡 ≤ 200ms：用 max-height + opacity transition 实现平滑动画 */
.thinking-body {
  margin-top: 8px;
  max-height: 200px;
  overflow-y: auto;
  /* 展开时 max-height 200px + opacity 1；折叠时 max-height 0 + opacity 0 */
  transition: max-height 200ms ease, opacity 200ms ease, margin-top 200ms ease;
}
.thinking-block.collapsed .thinking-body {
  max-height: 0;
  opacity: 0;
  margin-top: 0;
  overflow: hidden;
}
.thinking-step {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px dashed rgba(128, 128, 128, 0.1);
}
.step-phase {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  white-space: nowrap;
}
.step-phase.tool_call { background: rgba(0, 245, 255, 0.15); }
.step-phase.thinking { background: rgba(176, 38, 255, 0.15); }
.step-phase.composing { background: rgba(181, 234, 215, 0.15); }
.step-message { flex: 1; }
.step-tool {
  color: var(--text-soft, #888);
  font-family: monospace;
  font-size: 11px;
}
</style>

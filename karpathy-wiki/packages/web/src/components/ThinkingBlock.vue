<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ThinkingStep } from '../types';

const props = defineProps<{ steps: ThinkingStep[] }>();
const expanded = ref(true);

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
    <div class="thinking-body" v-if="expanded">
      <div v-for="(step, idx) in steps" :key="idx" class="thinking-step">
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
.thinking-body {
  margin-top: 8px;
  max-height: 200px;
  overflow-y: auto;
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

<script setup lang="ts">
import { ref, computed } from 'vue';
import { ChatRound, ArrowDown, ArrowRight } from '@element-plus/icons-vue';
import type { ThinkingStep } from '../types';

const props = withDefaults(defineProps<{ steps: ThinkingStep[]; live?: boolean }>(), {
  live: false,
});
// 默认折叠：减少视觉噪音，用户主动展开查看思考细节
// live=true（流式生成中）时强制展开，让用户实时看到思考过程；生成结束自动折叠回摘要
const userExpanded = ref(false);
const expanded = computed(() => props.live || userExpanded.value);
function toggle() {
  // 流式阶段不允许手动折叠，避免与实时更新冲突；结束后用户可自由展开/折叠
  if (props.live) return;
  userExpanded.value = !userExpanded.value;
}

// 折叠态摘要：已思考 N 步 · 搜索 N 次 · 阅读 N 页 · 耗时 X.Xs
// v2 优化：新增耗时统计，体现多输出模式可观测性
const summary = computed(() => {
  const toolCalls = props.steps.filter(s => s.phase === 'tool_call');
  const searches = toolCalls.filter(s => s.tool === 'search_pages').length;
  const reads = toolCalls.filter(s => s.tool === 'read_page').length;
  // 计算思考耗时：第一条到当前时间的差（前端时间），后端 ts 字段补齐可换算
  const first = props.steps[0]?.ts;
  const last = props.steps[props.steps.length - 1]?.ts;
  let duration = '';
  if (first && last) {
    const ms = new Date(last).getTime() - new Date(first).getTime();
    duration = ms < 1000 ? `· ${ms}ms` : `· ${(ms / 1000).toFixed(1)}s`;
  }
  return `已思考 ${props.steps.length} 步 · 搜索 ${searches} 次 · 阅读 ${reads} 页 ${duration}`;
});

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    thinking: '思考',
    tool_call: '调用',
    composing: '组织',
  };
  return labels[phase] || phase;
}

// v2：单步骤耗时（与上一条 ts 差），让用户感知每个思考节点的耗时
// 为什么用前端差：SSE 接收时序已记录到 ts，可直接相减；后端网络延迟不计入"思考耗时"
function stepDuration(idx: number, ts?: string): string {
  if (!ts || idx === 0) return '';
  const prev = props.steps[idx - 1]?.ts;
  if (!prev) return '';
  const ms = new Date(ts).getTime() - new Date(prev).getTime();
  return ms < 1000 ? `+${ms}ms` : `+${(ms / 1000).toFixed(1)}s`;
}
</script>

<template>
  <div class="thinking-block" :class="{ collapsed: !expanded, live: props.live }">
    <div class="thinking-header" @click="toggle">
      <el-icon class="thinking-icon"><ChatRound /></el-icon>
      <span class="thinking-summary">{{ summary }}</span>
      <el-icon class="toggle"><component :is="expanded ? ArrowDown : ArrowRight" /></el-icon>
    </div>
    <!-- 用 v-show + max-height transition 替代 v-if，实现 200ms 平滑展开/折叠（F-3.1 验收标准） -->
    <div class="thinking-body" v-show="expanded">
      <div v-for="(step, idx) in steps" :key="step.message + idx" class="thinking-step">
        <span class="step-phase" :class="step.phase">{{ phaseLabel(step.phase) }}</span>
        <span class="step-message">{{ step.message }}</span>
        <span class="step-tool" v-if="step.tool">{{ step.tool }}</span>
        <!-- v2：单步骤耗时（与上一条 ts 差） -->
        <span class="step-duration" v-if="step.ts">{{ stepDuration(idx, step.ts) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* v2 优化：辅助信息字体更小、颜色更浅
   折叠态 header 字号 13 → 11.5px，颜色改用 --text-dim；
   内边距 8px 12px → 6px 10px 让思考块更紧凑。
   为什么保留微弱左 border：主题色辨识 + 弱化不抢眼 */
.thinking-block {
  margin: 6px 0;
  padding: 6px 10px;
  background: var(--accent-purple-a04, rgba(176, 38, 255, 0.04));
  border-left: 2px solid var(--neon-purple, #b226ff);
  border-radius: 0 6px 6px 0;
}
/* 流式生成中：提亮背景 + 脉冲边框，让用户明确感知"正在思考" */
.thinking-block.live {
  background: var(--accent-purple-a08, rgba(176, 38, 255, 0.08));
  border-left-color: var(--neon-purple, #b226ff);
}
.thinking-header {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-dim, #aaa);
}
/* F-3.1 加载态：thinking-icon 脉动，让用户感知 AI 正在工作 */
.thinking-icon {
  display: inline-block;
  animation: thinking-pulse 1.5s ease-in-out infinite;
  font-size: 12px;
}
/* v2 优化：折叠态摘要更浅，hover 时提亮到 --text-soft */
.thinking-summary {
  color: var(--text-dim, #aaa);
  font-size: 11.5px;
}
.thinking-block:hover .thinking-summary {
  color: var(--text-soft, #888);
}
@keyframes thinking-pulse {
  0%, 100% { opacity: 0.6; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.15); }
}
/* F-3.1 折叠/展开过渡 ≤ 200ms：用 max-height + opacity transition 实现平滑动画 */
.thinking-body {
  margin-top: 6px;
  max-height: 240px;
  overflow-y: auto;
  transition: max-height 200ms ease, opacity 200ms ease, margin-top 200ms ease;
}
.thinking-block.collapsed .thinking-body {
  max-height: 0;
  opacity: 0;
  margin-top: 0;
  overflow: hidden;
}
/* v2 优化：单步骤字号 12 → 11px，dashed 分割线更弱化 */
.thinking-step {
  display: flex;
  gap: 6px;
  padding: 3px 0;
  font-size: 11px;
  color: var(--text-dim, #aaa);
  border-bottom: 1px dashed var(--text-dim, rgba(128, 128, 128, 0.08));
  align-items: center;
}
.step-phase {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  white-space: nowrap;
  color: var(--text-soft, #888);
}
.step-phase.tool_call { background: var(--accent-cyan-a10, rgba(0, 245, 255, 0.1)); }
.step-phase.thinking { background: var(--accent-purple-a10, rgba(176, 38, 255, 0.1)); }
.step-phase.composing { background: var(--accent-cyan-a10, rgba(181, 234, 215, 0.1)); }
.step-message {
  flex: 1;
  color: var(--text-dim, #aaa);
  font-size: 11px;
}
.step-tool {
  color: var(--text-dim, #888);
  font-family: monospace;
  font-size: 10px;
}
/* v2 新增：单步骤耗时显示，更浅更小 */
.step-duration {
  color: var(--text-dim, rgba(128, 128, 128, 0.6));
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  white-space: nowrap;
  margin-left: auto;
}
</style>

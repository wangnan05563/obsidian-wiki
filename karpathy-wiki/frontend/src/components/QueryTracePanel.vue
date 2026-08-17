<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { Timer, ArrowDown, ArrowRight } from '@element-plus/icons-vue';
import { apiFetch, API_BASE } from '../utils/apiBase';
import type { QueryRunTrace } from '../types';

// §X-1 步骤级追踪面板：给定 harness runId，拉取每步耗时分解并渲染表格，
// 用于定位 143s/282s 级长耗时瓶颈（LLM 调用 ms vs 工具执行 ms vs token 消耗）。
const props = withDefaults(defineProps<{ runId: string }>(), {});

const expanded = ref(false);
const loading = ref(false);
const error = ref('');
const trace = ref<QueryRunTrace | null>(null);

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// 折叠态摘要：步数 + 总耗时 + LLM/工具拆分，让用户在未展开时也能一眼看到总开销
const summary = computed(() => {
  if (!trace.value) return '耗时分析';
  const t = trace.value;
  return `耗时分析 · ${t.timings.length} 步 · 总 ${fmtMs(t.totalMs)}（LLM ${fmtMs(t.totalLlmMs)} / 工具 ${fmtMs(t.totalToolMs)}）`;
});

// 单步是否为"热点"（>2s）：高亮瓶颈步骤，快速定位长耗时卡点
function isHot(t: { llmMs: number; toolMs: number }): boolean {
  return t.llmMs + t.toolMs > 2000;
}

async function load() {
  if (trace.value || loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const res = await apiFetch(`${API_BASE}/query/runs/${encodeURIComponent(props.runId)}`);
    if (!res.ok) {
      error.value = res.status === 404 ? 'trace 尚未落盘' : `加载失败 (${res.status})`;
      return;
    }
    trace.value = (await res.json()) as QueryRunTrace;
  } catch {
    error.value = '加载失败';
  } finally {
    loading.value = false;
  }
}

function toggle() {
  expanded.value = !expanded.value;
  // 懒加载：首次展开才拉取 trace，避免每条消息都打一次接口
  if (expanded.value) load();
}

// runId 变化（新问答）时重置缓存
watch(
  () => props.runId,
  () => {
    trace.value = null;
    error.value = '';
  },
);
</script>

<template>
  <div class="trace-panel" :class="{ collapsed: !expanded }">
    <div class="trace-header" @click="toggle">
      <el-icon class="trace-icon"><Timer /></el-icon>
      <span class="trace-summary">{{ summary }}</span>
      <span v-if="loading" class="trace-loading">加载中…</span>
      <el-icon class="toggle"><component :is="expanded ? ArrowDown : ArrowRight" /></el-icon>
    </div>
    <div class="trace-body" v-show="expanded">
      <div v-if="error" class="trace-error">{{ error }}</div>
      <table v-else-if="trace" class="trace-table">
        <thead>
          <tr>
            <th class="col-step">步</th>
            <th class="col-tools">调用工具</th>
            <th class="col-num">LLM</th>
            <th class="col-num">工具</th>
            <th class="col-num">tokens</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(t, i) in trace.timings" :key="i" :class="{ hot: isHot(t) }">
            <td class="col-step">{{ t.step + 1 }}</td>
            <td class="col-tools">{{ t.toolNames.join(', ') || '—' }}</td>
            <td class="col-num">{{ fmtMs(t.llmMs) }}</td>
            <td class="col-num">{{ fmtMs(t.toolMs) }}</td>
            <td class="col-num">{{ t.tokens }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
/* 复用 ThinkingBlock 的轻量折叠视觉语言，但用主色（蓝）区分，标识"性能诊断"语义 */
.trace-panel {
  margin: 6px 0;
  padding: 6px 10px;
  background: var(--trace-bg, rgba(64, 158, 255, 0.04));
  border-left: 2px solid var(--el-color-primary, #409eff);
  border-radius: 0 6px 6px 0;
}
.trace-header {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-dim, #aaa);
}
.trace-icon {
  font-size: 12px;
  color: var(--el-color-primary, #409eff);
}
.trace-summary {
  color: var(--text-dim, #aaa);
  font-size: 11.5px;
}
.trace-panel:hover .trace-summary {
  color: var(--text-soft, #888);
}
.trace-loading {
  color: var(--text-dim, #999);
  font-size: 11px;
}
.trace-body {
  margin-top: 6px;
  max-height: 280px;
  overflow-y: auto;
  transition: max-height 200ms ease, opacity 200ms ease, margin-top 200ms ease;
}
.trace-panel.collapsed .trace-body {
  max-height: 0;
  opacity: 0;
  margin-top: 0;
  overflow: hidden;
}
.trace-error {
  font-size: 11px;
  color: var(--el-color-danger, #f56c6c);
  padding: 2px 0;
}
.trace-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.trace-table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-dim, #999);
  padding: 3px 6px;
  border-bottom: 1px solid var(--text-dim, rgba(128, 128, 128, 0.12));
}
.trace-table td {
  padding: 3px 6px;
  border-bottom: 1px dashed var(--text-dim, rgba(128, 128, 128, 0.08));
  color: var(--text-dim, #aaa);
}
.trace-table .col-step {
  width: 28px;
  color: var(--text-soft, #888);
  font-family: var(--font-mono, monospace);
}
.trace-table .col-tools {
  font-family: var(--font-mono, monospace);
  color: var(--text-soft, #888);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trace-table .col-num {
  text-align: right;
  font-family: var(--font-mono, monospace);
  white-space: nowrap;
}
/* 热点步骤高亮：>2s 用暖色左条 + 浅红背景，快速锁定瓶颈 */
.trace-table tr.hot td {
  background: var(--trace-hot-bg, rgba(245, 108, 108, 0.1));
  color: var(--text-soft, #666);
}
.trace-table tr.hot .col-step {
  box-shadow: inset 2px 0 0 var(--el-color-danger, #f56c6c);
}
</style>

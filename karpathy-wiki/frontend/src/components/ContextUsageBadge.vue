<script setup lang="ts">
// T00265：消息气泡右下角上下文占用徽章 —— 圆形进度环 + 动态百分比 + 悬浮详情 + 压缩
// 数据来源：SSE done 事件携带的 governor 统计（inputTokens = 当前上下文 token 数）
//   与 maxTokens（上下文预算上限），父组件从 query store 读取后以 props 传入；
//   压缩用 POST /api/threads/:id/compact（后端存储层折叠），成功后下次问答的 done
//   事件会携带更低的 inputTokens，进度环自动刷新（架构内数据流驱动）。
import { ref, computed } from 'vue';
import { API_BASE, apiFetch } from '../utils/apiBase';
import { ElMessage } from 'element-plus';

const props = defineProps<{
  threadId: string | null;
  inputTokens: number;
  maxTokens: number;
}>();

const compacting = ref(false);

// 使用率百分比（0~100，上限截断）；maxTokens 未就绪时徽章隐藏（父组件 v-if）
const percent = computed(() => {
  if (props.maxTokens <= 0) return 0;
  return Math.min(100, Math.round((props.inputTokens / props.maxTokens) * 100));
});

// 圆环周长 = 2πr ≈ 2*3.1416*15.5 ≈ 97.4；strokeDasharray 按百分比映射到周长
const RING_CIRCUMFERENCE = 97.4;
const ringDash = computed(() => `${(percent.value / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`);

// 压缩上下文：触发后端存储层折叠；persist=false（默认）后端返回 ok 但无持久化记忆可压，
// 提示用户下次问答自动更新；persist=true 时实际压缩并随下次问答刷新显示
async function compactContext() {
  if (!props.threadId || compacting.value) return;
  compacting.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/threads/${props.threadId}/compact`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ElMessage.success('上下文已压缩');
  } catch (err) {
    ElMessage.error('压缩失败：' + (err as Error).message);
  } finally {
    compacting.value = false;
  }
}
</script>

<template>
  <!-- 仅在有上下文数据时显示 -->
  <div v-if="maxTokens > 0" class="context-usage-badge">
    <el-tooltip placement="top" :show-after="250" :hide-after="0" popper-class="ctx-tooltip-popper">
      <template #content>
        <div class="ctx-tip">
          <div class="ctx-tip-row"><span>当前上下文</span><strong>{{ inputTokens }} tokens</strong></div>
          <div class="ctx-tip-row"><span>最大上下文</span><strong>{{ maxTokens }} tokens</strong></div>
          <div class="ctx-tip-row"><span>使用率</span><strong>{{ percent }}%</strong></div>
          <el-button
            size="small"
            type="primary"
            class="ctx-compact-btn"
            :loading="compacting"
            @click.stop="compactContext"
          >压缩上下文</el-button>
        </div>
      </template>
      <div class="ctx-badge-inner" title="上下文占用">
        <svg class="ctx-ring" width="20" height="20" viewBox="0 0 36 36">
          <circle cx="18" cy="18" r="15.5" class="ctx-ring-bg" />
          <circle
            cx="18" cy="18" r="15.5"
            class="ctx-ring-fg"
            :class="{ warn: percent >= 75 && percent < 90, danger: percent >= 90 }"
            :style="{ strokeDasharray: ringDash }"
          />
        </svg>
        <span class="ctx-pct" :class="{ warn: percent >= 75 && percent < 90, danger: percent >= 90 }">{{ percent }}%</span>
      </div>
    </el-tooltip>
  </div>
</template>

<style scoped>
/* 徽章定位在消息气泡右下角，不占文档流（absolute），不影响正文布局 */
.context-usage-badge {
  position: absolute;
  right: 8px;
  bottom: 6px;
  z-index: 3;
  cursor: pointer;
}

.ctx-badge-inner {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px 2px 3px;
  border-radius: 10px;
  background: var(--bg-card, rgba(247, 248, 250, 0.85));
  border: 1px solid var(--accent-purple-a15, rgba(128, 128, 128, 0.15));
  box-shadow: 0 2px 8px var(--accent-purple-a10, rgba(0, 0, 0, 0.1));
  transition: all 0.2s ease;
}

.ctx-badge-inner:hover {
  border-color: var(--neon-cyan, #00f5ff);
  box-shadow: 0 0 10px var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
}

/* 圆环：背景环 + 前景进度环（旋转 -90° 从顶部开始，长度变化平滑过渡） */
.ctx-ring-bg {
  fill: none;
  stroke: var(--accent-purple-a20, rgba(128, 128, 128, 0.2));
  stroke-width: 4;
}

.ctx-ring-fg {
  fill: none;
  stroke: var(--neon-cyan, #00f5ff);
  stroke-width: 4;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: 18px 18px;
  transition: stroke-dasharray 0.5s ease, stroke 0.5s ease;
}

/* 高占用预警色：≥75% 橙、≥90% 红 */
.ctx-ring-fg.warn { stroke: #f59e0b; }
.ctx-ring-fg.danger { stroke: #f56c6c; }

.ctx-pct {
  font-size: 10px;
  font-weight: 600;
  font-family: var(--font-mono, monospace);
  color: var(--text-main, #ccc);
  line-height: 1;
}

.ctx-pct.warn { color: #f59e0b; }
.ctx-pct.danger { color: #f56c6c; }

/* 悬浮详情浮层 */
.ctx-tip {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  min-width: 180px;
}

.ctx-tip-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  color: var(--text-soft, #aaa);
}

.ctx-tip-row strong {
  color: var(--text-bright, #f3e9ff);
  font-family: var(--font-mono, monospace);
}

.ctx-compact-btn {
  margin-top: 4px;
  width: 100%;
}
</style>

<style>
/* T00265 悬浮详情浮层（非 scoped）：el-tooltip 默认 is-dark 深色背景与浅色主题的
   深色文字冲突，用户看不清。改为 popper 背景跟随主题（--bg-card：浅色主题浅色、
   暗色主题暗色），文字由 .ctx-tip 内主题变量控制，保证深浅主题均可读。
   为什么非 scoped：popper 经 teleport 挂到 body，scoped 样式无法命中 .el-popper。 */
.ctx-tooltip-popper.el-popper {
  background: var(--bg-card, #ffffff) !important;
  border: 1px solid var(--accent-purple-a20, rgba(128, 128, 128, 0.2));
  box-shadow: 0 8px 24px var(--accent-purple-a15, rgba(0, 0, 0, 0.15));
  color: var(--text-bright, #f3e9ff);
}

.ctx-tooltip-popper .el-popper__arrow::before {
  background: var(--bg-card, #ffffff) !important;
  border-color: var(--accent-purple-a20, rgba(128, 128, 128, 0.2)) !important;
}
</style>

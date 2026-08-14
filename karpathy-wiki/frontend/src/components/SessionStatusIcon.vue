<script setup lang="ts">
// 会话状态动画图标（PC / 移动端历史列表共用）
// 使用开源 UI 库 Element Plus 的图标组件（@element-plus/icons-vue），
// 颜色走主题感知 CSS 变量回退链（var(--m-*, var(--neon-*))），自动适配
// PC(neon) / 移动玻璃(m--*) / 移动浅色(覆盖 --m-*) 三种主题，遵循 theme-aware-icon-rule。
// 状态实时：由 props.conv 经 getSessionStatus 响应式推导，状态切换自动更新图标与动画。
import { computed } from 'vue';
import {
  Loading,
  WarningFilled,
  BellFilled,
  CircleCheckFilled,
} from '@element-plus/icons-vue';
import type { ConversationRecord } from '../types';
import { getSessionStatus, type SessionStatus } from '../utils/sessionStatus';

const props = defineProps<{ conv: ConversationRecord }>();

const status = computed<SessionStatus>(() => getSessionStatus(props.conv));

const iconComp = computed(() => {
  switch (status.value) {
    case 'running':
      return Loading; // 旋转加载
    case 'error':
      return WarningFilled; // 警告
    case 'unread':
      return BellFilled; // 未读标记
    case 'read':
      return CircleCheckFilled; // 已完成（静态淡化）
    default:
      return CircleCheckFilled;
  }
});
</script>

<template>
  <!-- idle 不渲染任何图标，避免列表视觉噪声 -->
  <span
    v-if="status !== 'idle'"
    class="ss-icon"
    :class="'ss-' + status"
    :data-status="status"
    :title="status"
    aria-hidden="true"
  >
    <el-icon><component :is="iconComp" /></el-icon>
  </span>
</template>

<style scoped>
.ss-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  line-height: 1;
}
.ss-icon :deep(svg) {
  width: 14px;
  height: 14px;
}

/* 运行中：旋转脉冲（青/主色） */
.ss-running {
  color: var(--m-primary, var(--neon-cyan, #00f5ff));
  filter: drop-shadow(0 0 3px currentColor);
}
.ss-running :deep(svg) {
  animation: ss-spin 1s linear infinite;
}

/* 异常中断：警告脉冲（洋红/危险色） */
.ss-error {
  color: var(--m-danger, var(--neon-magenta, #ff006e));
  filter: drop-shadow(0 0 3px currentColor);
  animation: ss-pulse-danger 1.2s ease-in-out infinite;
}

/* 已完成未读：高亮脉冲（紫/主色） */
.ss-unread {
  color: var(--m-primary, var(--neon-purple, #b026ff));
  filter: drop-shadow(0 0 3px currentColor);
  animation: ss-pulse-primary 1.4s ease-in-out infinite;
}

/* 已完成已读：静态淡化 */
.ss-read {
  color: var(--m-text-3, var(--text-soft, #9d8ec4));
  opacity: 0.55;
}

@keyframes ss-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes ss-pulse-danger {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.45;
    transform: scale(1.18);
  }
}
@keyframes ss-pulse-primary {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
    filter: drop-shadow(0 0 1px currentColor);
  }
  50% {
    opacity: 0.7;
    transform: scale(1.16);
    filter: drop-shadow(0 0 5px currentColor);
  }
}
</style>

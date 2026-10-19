<script setup lang="ts">
// T02476（PRD X2 / X8）：加载态与空态单一组件。
// 此前同一产品里五套加载写法（骨架屏 / `// xxx中…` / 「加载中…」 / 硬编码英文 LOADING… / 「搜索中…」）
// 且「加载中…」同时表达「加载中」与「无数据」两种语义；空态里 Progress、Tunnel、Graph 是死胡同。
// 本组件把口径固定成三态（loading / empty / error）+ ready 透传：
// 三态文案一律中文（术语表 §6），空态按 X8 模板「一句现状 + 一句原因 + 一个主按钮」，失败态自带重试。
import { Loading } from '@element-plus/icons-vue';

type StateKind = 'ready' | 'loading' | 'empty' | 'error';

const props = withDefaults(
  defineProps<{
    state: StateKind;
    loadingText?: string;
    skeletonRows?: number;
    emptyTitle?: string;
    emptyDesc?: string;
    errorText?: string;
    retryLabel?: string;
    compact?: boolean;
  }>(),
  {
    loadingText: '加载中…',
    skeletonRows: 0,
    emptyTitle: '暂无内容',
    emptyDesc: '',
    errorText: '加载失败，请重试',
    retryLabel: '重试',
    compact: false,
  },
);

defineEmits<{ (e: 'retry'): void }>();
</script>

<template>
  <div
    v-if="state === 'loading'"
    class="state-block"
    :class="{ 'is-compact': compact }"
    role="status"
    aria-live="polite"
  >
    <el-skeleton v-if="skeletonRows > 0" :rows="skeletonRows" animated class="state-skeleton" />
    <template v-else>
      <el-icon class="state-spin"><Loading /></el-icon>
      <span class="state-text">{{ loadingText }}</span>
    </template>
  </div>

  <div v-else-if="state === 'empty'" class="state-block" :class="{ 'is-compact': compact }">
    <p class="state-title">{{ emptyTitle }}</p>
    <p v-if="emptyDesc" class="state-desc">{{ emptyDesc }}</p>
    <div v-if="$slots.action" class="state-action">
      <slot name="action" />
    </div>
  </div>

  <div v-else-if="state === 'error'" class="state-block" :class="{ 'is-compact': compact }" role="alert">
    <p class="state-title">{{ errorText }}</p>
    <div class="state-action">
      <el-button class="neon-btn secondary" size="small" :icon="Loading" @click="$emit('retry')">{{ retryLabel }}</el-button>
    </div>
  </div>

  <slot v-else />
</template>

<style scoped>
.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 18px 12px;
  text-align: center;
  color: var(--text-muted);
}
.state-block.is-compact {
  flex-direction: row;
  justify-content: center;
  gap: 8px;
  padding: 8px;
}
.state-skeleton {
  width: 100%;
}
.state-spin {
  animation: state-rotate 1s linear infinite;
}
.state-text {
  font-size: 13px;
}
.state-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary, var(--text-muted));
}
.state-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}
.state-block[role='alert'] .state-title {
  color: #f87171;
}
.state-action {
  margin-top: 6px;
}

@keyframes state-rotate {
  to {
    transform: rotate(360deg);
  }
}
</style>

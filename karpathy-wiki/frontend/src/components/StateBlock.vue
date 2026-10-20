<script setup lang="ts">
// T02476（PRD X2 / X8）：加载态与空态单一组件。
// 此前同一产品里五套加载写法（骨架屏 / `// xxx中…` / 「加载中…」 / 硬编码英文 LOADING… / 「搜索中…」）
// 且「加载中…」同时表达「加载中」与「无数据」两种语义；空态里 Progress、Tunnel、Graph 是死胡同。
// 本组件把口径固定成三态（loading / empty / error）+ ready 透传：
// 三态文案一律中文（术语表 §6），空态按 X8 模板「一句现状 + 一句原因 + 一个主按钮」，失败态自带重试。
import { Loading } from '@element-plus/icons-vue';

// T02720（PRD X2/X8 移动端收尾）：新增 `variant="mobile"` 皮肤。
// 移动端此前自写 `mb-hint`/`ml-hint`/`mq-empty-list` 方言，与桌面端两套口径并行（「两头挂」）。
// 组件化时不能把桌面霓虹皮直接搬进窄屏，故这里只加一层「皮肤」维度：
// 三态语义、props、@retry 契约完全共用，只有配色/间距/按钮形状按 `--m-*` token 重绘。
// 窄屏空态口径（术语表 §6）：页面级列表空态 = 一句现状 + 一句原因 + 一个行内主按钮
// （按钮通过 emit 让 MobileShell 切到能解决它的 Tab）；行内二级空态（搜索无结果、预览无正文）用 compact。
type StateKind = 'ready' | 'loading' | 'empty' | 'error';
type StateVariant = 'desktop' | 'mobile';

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
    variant?: StateVariant;
  }>(),
  {
    loadingText: '加载中…',
    skeletonRows: 0,
    emptyTitle: '暂无内容',
    emptyDesc: '',
    errorText: '加载失败，请重试',
    retryLabel: '重试',
    compact: false,
    variant: 'desktop',
  },
);

defineEmits<{ (e: 'retry'): void }>();
</script>

<template>
  <div
    v-if="state === 'loading'"
    class="state-block"
    :class="{ 'is-compact': compact, 'is-mobile': variant === 'mobile' }"
    role="status"
    aria-live="polite"
  >
    <el-skeleton v-if="skeletonRows > 0" :rows="skeletonRows" animated class="state-skeleton" />
    <template v-else>
      <el-icon class="state-spin"><Loading /></el-icon>
      <span class="state-text">{{ loadingText }}</span>
    </template>
  </div>

  <div v-else-if="state === 'empty'" class="state-block" :class="{ 'is-compact': compact, 'is-mobile': variant === 'mobile' }">
    <p class="state-title">{{ emptyTitle }}</p>
    <p v-if="emptyDesc" class="state-desc">{{ emptyDesc }}</p>
    <div v-if="$slots.action" class="state-action">
      <slot name="action" />
    </div>
  </div>

  <div
    v-else-if="state === 'error'"
    class="state-block"
    :class="{ 'is-compact': compact, 'is-mobile': variant === 'mobile' }"
    role="alert"
  >
    <p class="state-title">{{ errorText }}</p>
    <div class="state-action">
      <el-button class="neon-btn secondary state-retry" size="small" :icon="Loading" @click="$emit('retry')">{{ retryLabel }}</el-button>
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

/* T02720：窄屏皮肤——只重绘配色/间距/按钮形状，三态语义与文案契约与桌面端完全共用。
   token 全部走移动端命名空间（--m-*），与 styles/mobile-light.css / 毛玻璃主题一致。 */
.state-block.is-mobile {
  gap: 8px;
  padding: 26px 18px;
  color: var(--m-text-2, #777777);
}
.state-block.is-mobile .state-title {
  color: var(--m-text, #111111);
  font-size: 15px;
}
.state-block.is-mobile .state-desc,
.state-block.is-mobile .state-text {
  font-size: 13px;
  line-height: 1.6;
}
.state-block.is-mobile.is-compact {
  gap: 8px;
  padding: 14px 16px;
}
.state-block.is-mobile.is-compact .state-title {
  font-size: 13px;
  font-weight: 500;
}
/* 失败态自带重试：窄屏用胶囊描边按钮，不带桌面霓虹发光 */
.state-block.is-mobile :deep(.state-retry) {
  border: 1px solid var(--m-border-2, #e2e4e8);
  border-radius: 999px;
  background: var(--m-surface, #ffffff);
  color: var(--m-primary, #1554d1);
  box-shadow: none;
  font-size: 13px;
  padding: 7px 18px;
  height: auto;
}

@keyframes state-rotate {
  to {
    transform: rotate(360deg);
  }
}
</style>

<script setup lang="ts">
// 图标化操作按钮（T01628：全模块按钮改图标并加悬浮提示）
// ------------------------------------------------------------------
// 设计目标：
//   1. 统一：所有被改造的功能按钮共用同一套「仅图标」外观（尺寸/圆角/边框/悬停/按下态一致），
//      避免各页面手写一套方形图标按钮样式；
//   2. 可理解：图标按钮必须带悬浮提示，文案固定为「{按钮名称} - {功能说明}」，
//      复用全局 data-tip 提示系统（directives/tip.ts），不引入第二套 tooltip；
//   3. 功能不变：click / loading / disabled 语义原样透传，仅替换 UI 表现形式；
//   4. 可访问性：写入 aria-label，屏幕阅读器仍能读出按钮名称。
//
// 图标来源：开源图标库 @element-plus/icons-vue（MIT），由父级以组件形式传入。
import { computed } from 'vue';
import type { Component } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 按钮名称：tooltip 前缀 + aria-label */
    name: string;
    /** 功能说明：tooltip 后缀 */
    desc: string;
    /** 自定义 aria-label 覆盖：默认用 name；SRS 有完整 aria-label 硬性要求时使用 */
    ariaLabel?: string;
    /** Element Plus 图标组件 */
    icon: Component;
    /** 尺寸（沿用 Element Plus 三档） */
    size?: 'small' | 'default' | 'large';
    /** 语义类型，决定配色（primary=主操作，danger=危险操作 …） */
    variant?: 'default' | 'primary' | 'success' | 'warning' | 'danger';
    loading?: boolean;
    disabled?: boolean;
  }>(),
  { size: 'default', variant: 'default' },
);

const emit = defineEmits<{ (e: 'click', ev: MouseEvent): void }>();

// 提示文案：{按钮名称} - {功能说明}
const tip = computed(() => `${props.name} - ${props.desc}`);

// 图标尺寸随按钮档位变化，保证视觉重心一致
const iconSize = computed(() => (props.size === 'large' ? 20 : props.size === 'small' ? 14 : 16));
</script>

<template>
  <el-button
    class="icon-action-btn"
    :size="size"
    :type="variant"
    :loading="loading"
    :disabled="disabled"
    :aria-label="ariaLabel ?? name"
    :data-tip="tip"
    @click="emit('click', $event)"
  >
    <el-icon v-if="!loading" :size="iconSize"><component :is="icon" /></el-icon>
  </el-button>
</template>

<style>
/* 统一图标按钮外观：正方形 + 主题圆角 + 统一的悬停/按下反馈。
   不设 scoped：该类名是全站复用规范，且需覆盖 Element Plus 内部 padding。 */
.icon-action-btn {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 0 !important;
  border-radius: var(--radius-btn) !important;
  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease,
    box-shadow 0.2s ease, transform 0.2s ease !important;
}

/* 三档固定尺寸：小 28 / 默认 34 / 大 42（Element Plus 默认档无 size 修饰类） */
.icon-action-btn.el-button--small {
  width: 28px;
  height: 28px;
}
.icon-action-btn:not(.el-button--small):not(.el-button--large) {
  width: 34px;
  height: 34px;
}
.icon-action-btn.el-button--large {
  width: 42px;
  height: 42px;
}

/* 悬停/按下：微抬升 + 回弹，全站一致 */
.icon-action-btn:hover:not(.is-disabled):not(.is-loading) {
  transform: translateY(-1px);
}
.icon-action-btn:active:not(.is-disabled):not(.is-loading) {
  transform: translateY(0) scale(0.94);
}

/* 加载态：隐藏图标仅留 spinner，避免图标与 spinner 并排导致宽度跳动 */
.icon-action-btn.is-loading {
  pointer-events: none;
}
</style>

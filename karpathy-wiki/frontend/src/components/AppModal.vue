<script setup lang="ts">
// 统一弹窗组件（T01629：统一所有菜单弹窗交互效果）
// ------------------------------------------------------------------
// 为什么需要：此前各菜单页面直接调用 el-dialog / el-drawer，宽度、圆角、遮罩、
//   动效、点击遮罩是否关闭各写一套。本组件把这些规格收敛为默认值（对齐全站设计系统），
//   页面只声明「标题 + 宽度 + 内容」，交互细节不再逐页漂移。
//
// 交互规格（详见 styles/modal.css）：
//   - 对话框默认居中；抽屉默认贴右侧；
//   - 点击遮罩默认【不】关闭（避免表单/长任务误关），ESC 始终可关闭，右上角统一关闭按钮；
//   - 内容区统一限制 70vh 内滚动；进场 220ms / 退场 180ms。
//
// 兼容：对外仍暴露 title / width / close / open，迁移时只需替换标签名。
// T02721：不再提供 loading 遮罩 prop——弹窗内容各自的加载态由内容自己用 StateBlock 表达，
// 避免同一块内容被「外层蒙层 + 内层骨架」两层加载态同时描述。
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 显隐（v-model） */
    modelValue: boolean;
    title?: string;
    /** 对话框宽度 */
    width?: string | number;
    /** 形态：dialog=居中对话框（默认），drawer=右侧抽屉 */
    variant?: 'dialog' | 'drawer';
    /** 抽屉宽度（百分比或像素），仅 variant=drawer 生效 */
    size?: string;
    /** 点击遮罩是否关闭（默认 false，防误关） */
    closeOnClickModal?: boolean;
    closeOnPressEscape?: boolean;
    showClose?: boolean;
    destroyOnClose?: boolean;
  }>(),
  {
    title: '',
    width: '560px',
    variant: 'dialog',
    size: '60%',
    closeOnClickModal: false,
    closeOnPressEscape: true,
    showClose: true,
    destroyOnClose: true,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'close'): void;
  (e: 'open'): void;
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
});
</script>

<template>
  <!-- 居中对话框形态 -->
  <el-dialog
    v-if="variant === 'dialog'"
    v-model="visible"
    class="app-modal"
    :title="title"
    :width="width"
    align-center
    append-to-body
    :close-on-click-modal="closeOnClickModal"
    :close-on-press-escape="closeOnPressEscape"
    :show-close="showClose"
    :destroy-on-close="destroyOnClose"
    @close="emit('close')"
    @opened="emit('open')"
  >
    <div class="app-modal-body">
      <slot />
    </div>
    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
    </template>
  </el-dialog>

  <!-- 右侧抽屉形态 -->
  <el-drawer
    v-else
    v-model="visible"
    class="app-modal app-modal-drawer"
    :title="title"
    :size="size"
    direction="rtl"
    :close-on-click-modal="closeOnClickModal"
    :close-on-press-escape="closeOnPressEscape"
    :show-close="showClose"
    :destroy-on-close="destroyOnClose"
    @close="emit('close')"
    @opened="emit('open')"
  >
    <div class="app-modal-body">
      <slot />
    </div>
    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import CognitionIcon from './CognitionIcon.vue';

// RobotAvatar 已废弃：不再使用霓虹赛博风机器人 SVG，
// 统一替换为系统图标（书本 + 灯泡 3D 粘土风格）。
// 保留组件包装以保持现有引用零改动。
withDefaults(
  defineProps<{
    size?: number;
    floating?: boolean;
  }>(),
  {
    size: 120,
    floating: false
  }
);
</script>

<template>
  <CognitionIcon :size="size" :floating="floating" />
</template>

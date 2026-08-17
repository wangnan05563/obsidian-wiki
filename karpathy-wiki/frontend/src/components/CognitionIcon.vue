<script setup lang="ts">
// 系统统一图标：书本 + 灯泡 3D 粘土风格
// 替代 RobotAvatar 预制机器人图标，去除所有机器人/赛博风元素
// 深色/浅色主题共用同一份图标资源
withDefaults(
  defineProps<{
    size?: number;
    floating?: boolean;
  }>(),
  {
    size: 96,
    floating: false
  }
);

// 为什么用 import.meta.env.BASE_URL：vite.config.ts 配置了 base: '/wiki/'，
// 硬编码 '/images/...' 会被浏览器解析为 host 根路径导致 404，必须拼接 base 前缀
const iconSrc = `${import.meta.env.BASE_URL}images/login/cognition-icon-new.png`;
</script>

<template>
  <div
    class="cognition-icon"
    :class="{ 'icon-floating': floating }"
    :style="{ width: size + 'px', height: size + 'px' }"
  >
    <img
      :src="iconSrc"
      alt="AI 知识库"
      class="cognition-img"
      draggable="false"
    />
  </div>
</template>

<style scoped>
.cognition-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 温和投影：与 3D 粘土风格图标匹配，避免赛博霓虹光晕 */
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.08));
}

.cognition-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
  pointer-events: none;
}

.icon-floating {
  animation: icon-float 4s ease-in-out infinite;
}

@keyframes icon-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}
</style>

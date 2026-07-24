<script setup lang="ts">
import { computed } from 'vue';
import { useTheme } from '../composables/useTheme';

// Luminous Cognition 主题自适应图标
// 设计哲学：单一几何 + 双相光（dark/light 同构，仅光相位变化）
// 替代 RobotAvatar 预制图标，与系统整体"光之认知"语言统一
//
// 为什么需要两份图标：浅色主题（macaron/ecommerce）背景接近白，
// 深色版图标的青色卫星 (#00f5ff) 与半透明光晕在白底上几乎不可见；
// light 版使用更深更饱和的同色系（深紫 #7a4ab8 / 深青 #2d9d8d / 深粉 #d4699b），
// 保证 WCAG 对比度，同时维持同一构图 DNA
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

const { currentTheme } = useTheme();

// 浅色主题清单：与 Login.vue 中的视觉分类保持一致
const lightThemes = ['macaron', 'ecommerce'];
const iconSrc = computed(() => {
  const isLight = lightThemes.includes(currentTheme.value);
  return isLight
    ? '/images/login/cognition-icon-light.png'
    : '/images/login/cognition-icon.png';
});
</script>

<template>
  <div
    class="cognition-icon"
    :class="{ 'icon-floating': floating }"
    :style="{ width: size + 'px', height: size + 'px' }"
  >
    <img
      :src="iconSrc"
      alt="Luminous Cognition"
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
  /* 微妙发光：与 RobotAvatar 一致的 drop-shadow 量级，保持视觉一致性 */
  filter: drop-shadow(0 0 14px var(--robot-glow, rgba(176, 38, 255, 0.4)));
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

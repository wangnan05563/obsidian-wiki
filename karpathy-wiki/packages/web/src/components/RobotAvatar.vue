<script setup lang="ts">
// 卡通机器人 IP 形象，纯 SVG 实现，避免外部图片依赖
// size 控制整体尺寸，floating 控制是否启用浮动动画
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
  <div
    class="robot-avatar"
    :class="{ 'robot-floating': floating }"
    :style="{ width: size + 'px', height: size + 'px' }"
  >
    <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
      <!-- 天线 -->
      <line x1="60" y1="8" x2="60" y2="22" stroke="#E886A6" stroke-width="3" stroke-linecap="round" />
      <circle cx="60" cy="6" r="5" fill="#FFD6E0" stroke="#E886A6" stroke-width="2" />

      <!-- 头部：圆角矩形 + 渐变 -->
      <defs>
        <linearGradient id="robotHead" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#FFFFFF" />
          <stop offset="100%" stop-color="#FFEEF3" />
        </linearGradient>
        <linearGradient id="robotBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#E8F7F4" />
          <stop offset="100%" stop-color="#C8E6E0" />
        </linearGradient>
      </defs>

      <rect
        x="24" y="22" width="72" height="56" rx="20" ry="20"
        fill="url(#robotHead)" stroke="#E886A6" stroke-width="2.5"
      />

      <!-- 脸颊腮红 -->
      <circle cx="34" cy="58" r="5" fill="#FFD6E0" opacity="0.85" />
      <circle cx="86" cy="58" r="5" fill="#FFD6E0" opacity="0.85" />

      <!-- 眼睛：可眨眼 -->
      <g class="robot-eyes">
        <circle cx="46" cy="48" r="6.5" fill="#4A3B47" />
        <circle cx="74" cy="48" r="6.5" fill="#4A3B47" />
        <!-- 高光 -->
        <circle cx="48" cy="46" r="2" fill="#FFFFFF" />
        <circle cx="76" cy="46" r="2" fill="#FFFFFF" />
      </g>

      <!-- 嘴巴：微笑曲线 -->
      <path
        d="M52 66 Q60 72 68 66"
        fill="none" stroke="#4A3B47" stroke-width="2.5" stroke-linecap="round"
      />

      <!-- 身体：圆角梯形 -->
      <rect
        x="34" y="78" width="52" height="32" rx="14" ry="14"
        fill="url(#robotBody)" stroke="#7CCFB4" stroke-width="2.5"
      />
      <!-- 胸前指示灯 -->
      <circle cx="60" cy="94" r="4" fill="#FFF1B8" stroke="#E886A6" stroke-width="1.5" />
      <circle cx="48" cy="94" r="2.5" fill="#FFD6E0" />
      <circle cx="72" cy="94" r="2.5" fill="#C8E6E0" />
    </svg>
  </div>
</template>

<style scoped>
.robot-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* 眨眼动画：绝大多数时间睁眼，仅偶尔眨一下，让 IP 显得灵动 */
.robot-eyes {
  transform-origin: center 48px;
  animation: robot-blink 4.5s infinite;
}
</style>

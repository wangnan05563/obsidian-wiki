<script setup lang="ts">
// 霓虹赛博风机器人 IP 形象，纯 SVG 实现
// 升级要点：渐变机身 + 发光眼睛 + 扫描线 + 赛博装饰线条
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
    <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="robot-svg">
      <defs>
        <!-- 机身渐变：紫→品红→青蓝 -->
        <linearGradient id="cyberHead" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#1a0533" />
          <stop offset="50%" stop-color="#2d0a4a" />
          <stop offset="100%" stop-color="#0d1a3d" />
        </linearGradient>
        <linearGradient id="cyberBody" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#3d0a5c" />
          <stop offset="100%" stop-color="#0a1f4d" />
        </linearGradient>
        <!-- 眼睛发光渐变 -->
        <radialGradient id="eyeGlow">
          <stop offset="0%" stop-color="#ffffff" />
          <stop offset="40%" stop-color="#00f5ff" />
          <stop offset="100%" stop-color="#0088aa" />
        </radialGradient>
        <!-- 天线发光 -->
        <radialGradient id="antennaGlow">
          <stop offset="0%" stop-color="#ffffff" />
          <stop offset="50%" stop-color="#ff006e" />
          <stop offset="100%" stop-color="#b026ff" />
        </radialGradient>
        <!-- 发光滤镜 -->
        <filter id="neonGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>

      <!-- 天线：霓虹发光球 -->
      <line x1="60" y1="8" x2="60" y2="22" stroke="#b026ff" stroke-width="2" stroke-linecap="round" filter="url(#neonGlow)" />
      <circle cx="60" cy="6" r="4" fill="url(#antennaGlow)" filter="url(#neonGlow)" class="antenna-pulse" />

      <!-- 头部：六边形赛博风圆角矩形 -->
      <rect
        x="22" y="22" width="76" height="58" rx="18" ry="18"
        fill="url(#cyberHead)" stroke="#b026ff" stroke-width="1.5"
      />
      <!-- 头部霓虹高光边 -->
      <rect
        x="22" y="22" width="76" height="58" rx="18" ry="18"
        fill="none" stroke="#00f5ff" stroke-width="0.8" opacity="0.6"
      />

      <!-- 头部装饰线：赛博风侧边线条 -->
      <line x1="26" y1="30" x2="26" y2="72" stroke="#ff006e" stroke-width="0.8" opacity="0.5" />
      <line x1="94" y1="30" x2="94" y2="72" stroke="#00f5ff" stroke-width="0.8" opacity="0.5" />

      <!-- 扫描线效果：横贯脸部的半透明线 -->
      <line x1="24" y1="0" x2="96" y2="0" stroke="#00f5ff" stroke-width="2" opacity="0.8" class="scan-line" filter="url(#neonGlow)" />

      <!-- 眼睛：发光青蓝色，可眨眼 -->
      <g class="robot-eyes">
        <circle cx="45" cy="48" r="7" fill="url(#eyeGlow)" filter="url(#neonGlow)" />
        <circle cx="75" cy="48" r="7" fill="url(#eyeGlow)" filter="url(#neonGlow)" />
        <!-- 眼睛高光 -->
        <circle cx="47" cy="46" r="2" fill="#ffffff" opacity="0.9" />
        <circle cx="77" cy="46" r="2" fill="#ffffff" opacity="0.9" />
      </g>

      <!-- 嘴巴：赛博风折线 -->
      <polyline
        points="50,66 56,70 60,68 64,70 70,66"
        fill="none" stroke="#ff006e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        filter="url(#neonGlow)"
      />

      <!-- 身体：赛博风梯形 -->
      <rect
        x="32" y="80" width="56" height="32" rx="12" ry="12"
        fill="url(#cyberBody)" stroke="#8338ec" stroke-width="1.5"
      />
      <!-- 身体霓虹高光 -->
      <rect
        x="32" y="80" width="56" height="32" rx="12" ry="12"
        fill="none" stroke="#00f5ff" stroke-width="0.8" opacity="0.5"
      />

      <!-- 胸前核心指示灯：发光品红 -->
      <circle cx="60" cy="96" r="3.5" fill="#ff006e" filter="url(#neonGlow)" class="core-pulse" />
      <!-- 侧边状态灯 -->
      <circle cx="46" cy="96" r="2" fill="#00f5ff" filter="url(#neonGlow)" />
      <circle cx="74" cy="96" r="2" fill="#b026ff" filter="url(#neonGlow)" />

      <!-- 身体装饰线 -->
      <line x1="36" y1="88" x2="44" y2="88" stroke="#00f5ff" stroke-width="0.8" opacity="0.6" />
      <line x1="76" y1="88" x2="84" y2="88" stroke="#ff006e" stroke-width="0.8" opacity="0.6" />
    </svg>
  </div>
</template>

<style scoped>
.robot-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  filter: drop-shadow(0 0 12px rgba(176, 38, 255, 0.4));
}

.robot-svg {
  width: 100%;
  height: 100%;
}

/* 眨眼动画 */
.robot-eyes {
  transform-origin: center 48px;
  animation: robot-blink 4.5s infinite;
}

/* 天线脉动 */
.antenna-pulse {
  animation: neon-pulse 1.8s ease-in-out infinite;
}

/* 核心指示灯脉动 */
.core-pulse {
  animation: neon-pulse 2.2s ease-in-out infinite;
}

/* 扫描线：从头到脚循环移动 */
.scan-line {
  animation: scan-move 3s linear infinite;
}

@keyframes scan-move {
  0% { transform: translateY(24px); opacity: 0; }
  10% { opacity: 0.8; }
  90% { opacity: 0.8; }
  100% { transform: translateY(78px); opacity: 0; }
}

@keyframes neon-pulse {
  0%, 100% { opacity: 1; filter: brightness(1); }
  50% { opacity: 0.6; filter: brightness(1.5); }
}
</style>

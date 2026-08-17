<script setup lang="ts">
// 菜单图标组件：12 个手绘 SVG 矢量图标，stroke 线条风格
// 颜色策略：使用 currentColor，父级通过 CSS color 控制实际颜色，
// 从而自动跟随主题 CSS 变量变色，无需为每个主题单独配色
// 不使用任何第三方图标库（@element-plus/icons 等），全部原创绘制

defineProps<{
  name: string;
  size?: number;
}>();
</script>

<template>
  <svg
    :width="size || 20"
    :height="size || 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="nav-icon"
  >
    <!-- 仪表盘：圆形表盘 + 指针 + 刻度点 -->
    <template v-if="name === 'dashboard'">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <path d="M12 12 L16 8" />
      <circle cx="18.5" cy="12" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="12" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="0.6" fill="currentColor" stroke="none" />
    </template>

    <!-- 投递资料：云 + 上箭头，寓意上传 -->
    <template v-else-if="name === 'ingest'">
      <path d="M7 18 a4 4 0 0 1 0-8 a5 5 0 0 1 9.5-1.5 a3.5 3.5 0 0 1 0.5 7" />
      <path d="M12 21 L12 13" />
      <path d="M9 16 L12 13 L15 16" />
    </template>

    <!-- 编译进度：齿轮 + 进度环 -->
    <template v-else-if="name === 'progress'">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2 L12 5 M12 19 L12 22 M2 12 L5 12 M19 12 L22 12 M4.9 4.9 L7 7 M17 17 L19.1 19.1 M4.9 19.1 L7 17 M17 7 L19.1 4.9" />
    </template>

    <!-- 知识浏览：打开的书本 -->
    <template v-else-if="name === 'browse'">
      <path d="M3 5 L12 7 L21 5 L21 19 L12 21 L3 19 Z" />
      <path d="M12 7 L12 21" />
      <path d="M6 10 L9 10.5 M6 13 L9 13.5 M15 10.5 L18 10 M15 13.5 L18 13" />
    </template>

    <!-- 知识问答：对话气泡 + 问号 -->
    <template v-else-if="name === 'query'">
      <path d="M4 5 a2 2 0 0 1 2-2 L18 3 a2 2 0 0 1 2 2 L20 14 a2 2 0 0 1-2 2 L9 16 L5 20 L5 16 a2 2 0 0 1-1-2 Z" />
      <path d="M9.5 8 a2.5 2.5 0 0 1 5 0 c0 1.5-2.5 2-2.5 3.5" stroke-width="1.6" />
      <circle cx="12" cy="13.8" r="0.8" fill="currentColor" stroke="none" />
    </template>

    <!-- 图谱：节点 + 连线 -->
    <template v-else-if="name === 'graph'">
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="7" r="2" />
      <circle cx="12" cy="18" r="2" />
      <circle cx="6" cy="6" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="18" cy="7" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18" r="0.6" fill="currentColor" stroke="none" />
      <path d="M7.5 7 L10.5 16 M16.5 8 L13.5 16 M7.5 6 L16.5 6.5" />
    </template>

    <!-- 体检：心跳波形 -->
    <template v-else-if="name === 'health'">
      <path d="M2 12 L6 12 L8 7 L11 17 L13 10 L15 14 L18 12 L22 12" />
      <circle cx="8" cy="7" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="13" cy="10" r="0.6" fill="currentColor" stroke="none" />
    </template>

    <!-- 配置：滑块/设置 -->
    <template v-else-if="name === 'config'">
      <path d="M4 7 L14 7 M18 7 L20 7" />
      <circle cx="16" cy="7" r="2" />
      <path d="M4 12 L8 12 M12 12 L20 12" />
      <circle cx="10" cy="12" r="2" />
      <path d="M4 17 L12 17 M16 17 L20 17" />
      <circle cx="14" cy="17" r="2" />
    </template>

    <!-- 内网穿透：地球 + 穿透箭头 -->
    <template v-else-if="name === 'tunnel'">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12 L21 12" />
      <path d="M12 3 a14 14 0 0 1 0 18 a14 14 0 0 1 0-18" />
      <path d="M16 8 L20 4 M20 4 L17 4 M20 4 L20 7" stroke-width="1.6" />
    </template>

    <!-- 系统清理：扫帚 -->
    <template v-else-if="name === 'cleanup'">
      <path d="M14 3 L18 7 L13 12 L9 8 Z" />
      <path d="M9 8 L4 18 L13 12" />
      <path d="M5 18 L13 18" />
      <circle cx="16" cy="5" r="0.6" fill="currentColor" stroke="none" />
    </template>

    <!-- 帮助文档：问号圆圈 -->
    <template v-else-if="name === 'help'">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5 a2.5 2.5 0 0 1 5 0 c0 1.5-2.5 2-2.5 3.5" stroke-width="1.6" />
      <circle cx="12" cy="16" r="0.8" fill="currentColor" stroke="none" />
    </template>

    <!-- 关于：信息 i -->
    <template v-else-if="name === 'about'">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
      <path d="M12 10 L12 17" stroke-width="2" />
    </template>

    <!-- 点赞（向上大拇指）：采用 MIT 许可的 Lucide 线条几何，沿用 currentColor + stroke 风格
         thumb 在左、fist 在右的标准竖起大拇指；下方腕部与拳头由两条分离路径构成 -->
    <template v-else-if="name === 'thumb-up'">
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
    </template>

    <!-- 点踩（向下大拇指）：由 thumb-up 旋转 180° 得到，thumb 朝下、fist 在左，完全对称 -->
    <template v-else-if="name === 'thumb-down'">
      <g transform="rotate(180 12 12)">
        <path d="M7 10v12" />
        <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
      </g>
    </template>

    <!-- 归档（archive）：采用 MIT 许可的 Lucide 线条几何，沿用 currentColor + stroke 风格
         箱体外形 + 顶盖横线 + 向上箭头，语义为"存入归档"，与 thumb 图标同源保持一致 -->
    <template v-else-if="name === 'archive'">
      <path d="m2 4 2 14h16l2-14" />
      <path d="M2 4h20" />
      <path d="M12 11v6" />
      <path d="m9 14 3-3 3 3" />
    </template>

    <!-- 置顶大头针（pushpin）：0° 时针头垂直向下 = 已置顶态；
         由父层 .pin-rot 旋转 180° 得到针头朝上 = 未置顶态，点击切换时平滑翻转 -->
    <template v-else-if="name === 'pin'">
      <circle cx="12" cy="6" r="3.4" />
      <path d="M12 9.4 L12 19" />
      <path d="M8.8 19 L15.2 19" stroke-width="1.8" />
    </template>
  </svg>
</template>

<style scoped>
.nav-icon {
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
  /* 发光效果通过 drop-shadow 实现，颜色继承 currentColor，跟随主题 */
  filter: drop-shadow(0 0 4px currentColor);
  transition: transform 0.3s ease, filter 0.3s ease;
}

.nav-icon:hover {
  transform: scale(1.1);
  filter: drop-shadow(0 0 8px currentColor);
}
</style>

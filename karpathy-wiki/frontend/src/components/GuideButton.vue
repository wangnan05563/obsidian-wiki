<script setup lang="ts">
// 用户引导向导系统 · 常驻入口按钮组件
//
// 职责：为已登录用户在内容区右下角提供常驻悬浮按钮，点击即唤起当前视图的引导流程
//   （供"后续访问通过常驻按钮唤起"场景使用，不依赖首次标记）。
// 为什么放右下角而非侧边：右下角悬浮不挤压功能入口，且与全局层（如引导遮罩）随同
//   覆盖在内容之上；引导激活时按钮自动隐藏，避免遮挡气泡。
import { computed } from 'vue';
import { useGuideStore } from '../stores/guide';

const guide = useGuideStore();
// 当前所处视图 key（由父组件传入），点击入口按钮时据此唤起对应引导
const props = defineProps<{ view: string }>();

const tooltip = computed(() => (guide.visible ? '引导进行中' : '查看本页引导'));
</script>

<template>
  <!-- 悬浮入口按钮：点击唤起当前视图引导；引导进行中自动隐藏避免遮挡 -->
  <button
    v-if="!guide.visible"
    type="button"
    class="guide-entry-btn"
    :title="tooltip"
    :data-tip="tooltip"
    @click="guide.start(props.view)"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2a7 7 0 0 0-4 12.74V16a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-1.26A7 7 0 0 0 12 2zM9 20a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm3 .5c.52 0 1 .45 1 1s-.48 1-1 1-1-.45-1-1 .48-1 1-1z"/>
      <circle cx="12" cy="9" r="1.6" fill="currentColor"/>
    </svg>
  </button>
</template>

<style scoped>
/* 常驻入口按钮：主题色圆角悬浮球，hover 高亮成强调色 */
.guide-entry-btn {
  position: fixed;
  right: 24px;
  bottom: 88px;
  z-index: 3200;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--bg-card, #ffffff);
  color: var(--text-secondary, #6b7380);
  cursor: pointer;
  box-shadow: 0 6px 20px var(--accent-purple-a20, rgba(124, 77, 255, 0.2));
  transition: color 0.2s ease, background 0.2s ease, transform 0.2s ease;
}

.guide-entry-btn:hover {
  color: var(--neon-cyan, #00e5ff);
  background: var(--accent-cyan-a12, rgba(0, 229, 255, 0.12));
  transform: translateY(-2px);
}

.guide-entry-btn:focus-visible {
  outline: 2px solid var(--neon-cyan, #00e5ff);
  outline-offset: 2px;
}
</style>
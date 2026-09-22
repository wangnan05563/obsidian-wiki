<script setup lang="ts">
// 用户引导向导系统 · 引导遮罩组件
//
// 职责：在指定视图上渲染半透明遮罩，高亮当前步骤的目标元素，并在气泡卡片中
//   展示标题/说明，提供 上一步/下一步/跳过 交互。
// 为什么用 Teleport 到 body：遮罩需覆盖整个视口且脱离 .content 滚动容器裁剪，
//   与 Browse.vue 全屏层、DocumentTabs 右键菜单同一策略（scoped-pitfall）。
// 为什么用 requestAnimationFrame 测量并监听 resize/scroll：目标元素可能随滚动/
//   布局变化移动，需持续校正高亮框位置，否则气泡会错位。
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useGuideStore } from '../stores/guide';

const guide = useGuideStore();

// 高亮框与气泡位置（px）：相对视口 fixed 定位
const box = ref({ top: 0, left: 0, width: 0, height: 0 });
const hasTarget = ref(false);

// 当前步的目标选择器（center 时不高亮具体元素，仅居中显示说明卡）
const targetSel = computed(() => guide.currentStep?.target ?? '');

// 依据目标元素测量其视口矩形
function measure(): void {
  if (!guide.visible) return;
  const sel = targetSel.value;
  if (!sel) {
    hasTarget.value = false;
    return;
  }
  // 高亮主内容区 .content 时直接取该元素；否则取选择器命中的元素
  const el = sel === '.content'
    ? document.querySelector('.content')
    : document.querySelector(sel);
  if (!el) {
    hasTarget.value = false;
    return;
  }
  const r = el.getBoundingClientRect();
  box.value = { top: r.top, left: r.left, width: r.width, height: r.height };
  hasTarget.value = true;
}

// 折中：跟随滚动/缩放用 passive 监听 + rAF 计算，减少主线程抖动
let raf = 0;
function scheduleMeasure(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; measure(); });
}

// 步骤切换/引导显隐变化后延迟一帧测量（等 DOM 稳定）
watch(
  () => [guide.activeView, guide.stepIndex, guide.visible] as const,
  async () => {
    await nextTick();
    scheduleMeasure();
  },
);

onMounted(() => {
  window.addEventListener('resize', scheduleMeasure, { passive: true });
  window.addEventListener('scroll', scheduleMeasure, { passive: true });
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleMeasure);
  window.removeEventListener('scroll', scheduleMeasure);
  if (raf) cancelAnimationFrame(raf);
  stopAutoPlay();
});

// ===== 自动播放（操作流程演示）：每步停留后自动进入下一步 =====
// 为什么单独实现而非依赖外部：需求要求"手动步进与自动播放两种模式"，两者共用
//   guide store 的 next/prev 状态，仅在速度上前者由用户点按、后者由定时器驱动。
const AUTO_PLAY_INTERVAL_MS = 3500;
const autoPlay = ref(false);
let autoTimer: ReturnType<typeof setInterval> | null = null;

function startAutoPlay(): void {
  if (autoTimer) return;
  autoPlay.value = true;
  autoTimer = setInterval(() => guide.next(), AUTO_PLAY_INTERVAL_MS);
}
function stopAutoPlay(): void {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  autoPlay.value = false;
}
// 手动前后步进时重置定时器，避免刚点完下一瞬又被自动跳过
function stepManually(dir: 'prev' | 'next'): void {
  if (dir === 'prev') guide.prev();
  else guide.next();
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = setInterval(() => guide.next(), AUTO_PLAY_INTERVAL_MS);
  }
}
// 引导结束（关闭/跳过/完成）时停止自动播放
watch(() => guide.visible, (v) => { if (!v) stopAutoPlay(); });
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩层：半透明 + 允许点击空白跳过/关闭不阻止 -->
    <div v-if="guide.visible" class="guide-overlay" @click="guide.skip()">
      <!-- 高亮框：虚线边框强调目标元素（如有具体目标） -->
      <div
        v-if="hasTarget"
        class="guide-box"
        :style="{ top: box.top + 'px', left: box.left + 'px', width: box.width + 'px', height: box.height + 'px' }"
      ></div>

      <!-- 气泡说明卡：展示当前步骤文案与步进控制 -->
      <div
        class="guide-card"
        :class="{
          'pos-center': !hasTarget || guide.currentStep?.placement === 'center',
          [`pos-${guide.currentStep?.placement ?? 'top'}`]: hasTarget && guide.currentStep?.placement !== 'center',
        }"
        :style="hasTarget ? {
          top: (box.top + box.height + 12) + 'px',
          left: box.left + 'px',
        } : {}"
        @click.stop
      >
        <header class="guide-card-head">
          <span class="guide-title">{{ guide.current?.title }}</span>
          <span class="guide-step">{{ guide.stepIndex + 1 }} / {{ guide.current?.steps.length }}</span>
        </header>
        <p class="guide-desc">{{ guide.currentStep?.description }}</p>
        <footer class="guide-card-foot">
          <el-button
            v-if="guide.stepIndex > 0"
            size="small"
            data-tip="上一步"
            @click="stepManually('prev')"
          >上一步</el-button>
          <span class="guide-spacer"></span>
          <!-- 自动播放开关：切换手动/自动两种演示模式 -->
          <el-button
            size="small"
            plain
            :type="autoPlay ? 'success' : 'default'"
            :data-tip="autoPlay ? '暂停自动播放' : '自动播放本引导'"
            @click="autoPlay ? stopAutoPlay() : startAutoPlay()"
          >{{ autoPlay ? '⏸ 暂停' : '▶ 自动' }}</el-button>
          <el-button size="small" text data-tip="跳过此引导" @click="guide.skip()">跳过</el-button>
          <el-button
            v-if="guide.stepIndex < (guide.current?.steps.length ?? 1) - 1"
            size="small"
            type="primary"
            data-tip="下一步"
            @click="stepManually('next')"
          >下一步</el-button>
          <el-button
            v-else
            size="small"
            type="primary"
            data-tip="完成引导"
            @click="guide.close()"
          >完成</el-button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style>
/* 引导遮罩样式放非 scoped：Teleport 到 body 后不受组件 scoped 属性选择器影响 */
.guide-overlay {
  position: fixed;
  inset: 0;
  z-index: 3500;
  background: rgba(10, 10, 18, 0.35);
  backdrop-filter: blur(1px);
}

/* 高亮框：主题色虚线边框 + 柔和光晕，突出目标元素 */
.guide-box {
  position: fixed;
  border: 2px dashed var(--neon-cyan, #00e5ff);
  border-radius: 10px;
  box-shadow: 0 0 0 4px var(--accent-cyan-a20, rgba(0, 229, 255, 0.15));
  pointer-events: none;
  transition: all 0.2s ease;
}

/* 气泡卡片：半透场景背景 + 主题描边，右上角步骤计数 */
.guide-card {
  position: fixed;
  z-index: 3501;
  width: 280px;
  padding: 14px 16px;
  background: var(--bg-card, #ffffff);
  border: 1px solid var(--accent-purple-a25, rgba(124, 77, 255, 0.25));
  border-radius: 12px;
  box-shadow: 0 12px 32px var(--accent-purple-a20, rgba(124, 77, 255, 0.15));
  color: var(--text-base, #2b2f36);
}

.guide-card.pos-center {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.guide-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.guide-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright, #20242a);
}

.guide-step {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--neon-cyan, #00e5ff);
  letter-spacing: 1px;
}

.guide-desc {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-soft, #6b7380);
}

.guide-card-foot {
  display: flex;
  align-items: center;
  gap: 6px;
}

.guide-spacer {
  flex: 1;
}
</style>
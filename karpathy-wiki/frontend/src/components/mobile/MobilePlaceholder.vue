<script setup lang="ts">
// 移动端 Tab 占位视图（M0 阶段）：问答/浏览/聆听/投递四个场景的完整移动 UI
// 属于 SRS 里程碑 M2–M5，本占位仅保证底部 Tab 导航可点击、结构可扩展，避免半成品。
defineProps<{
  tab: 'query' | 'browse' | 'listen' | 'ingest';
  label: string;
  desc: string;
}>();
</script>

<template>
  <div class="mph-root">
    <div class="mph-icon-wrap">
      <span class="mph-dot" />
      <span class="mph-ring" />
    </div>
    <h3 class="mph-label">{{ label }}</h3>
    <p class="mph-desc">{{ desc }}</p>
    <div class="mph-badge">开发中 · 预计 M2–M5 上线</div>
  </div>
</template>

<style scoped>
.mph-root {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 32px 28px;
  gap: 14px;
  font-family: var(--font-body);
}

.mph-icon-wrap {
  position: relative;
  width: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mph-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--grad-fire);
  box-shadow: 0 0 14px rgba(255, 0, 110, 0.6);
}

.mph-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1.5px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  animation: mph-pulse 2.4s ease-out infinite;
}

@keyframes mph-pulse {
  0% { transform: scale(0.6); opacity: 0.9; }
  100% { transform: scale(1.25); opacity: 0; }
}

.mph-label {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 800;
  margin: 0;
  color: var(--text-bright);
}

.mph-desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-soft);
  margin: 0;
  max-width: 260px;
}

.mph-badge {
  margin-top: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--neon-cyan);
  padding: 5px 12px;
  border: 1px dashed var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
  border-radius: 999px;
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
}
</style>

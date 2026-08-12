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
      <svg class="mph-icon" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M9 12h6M12 9v6" />
      </svg>
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
  color: var(--m-text, #111111);
}

.mph-icon-wrap {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--m-surface, #f5f6f8);
  color: var(--m-muted, #777777);
}

.mph-icon {
  opacity: 0.8;
}

.mph-label {
  font-size: 17px;
  font-weight: 700;
  margin: 0;
  color: var(--m-text, #111111);
}

.mph-desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--m-muted, #777777);
  margin: 0;
  max-width: 260px;
}

.mph-badge {
  margin-top: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--m-primary, #0f4c81);
  padding: 5px 12px;
  border: 1px dashed rgba(15, 76, 129, 0.25);
  border-radius: 999px;
  background: rgba(15, 76, 129, 0.06);
}
</style>

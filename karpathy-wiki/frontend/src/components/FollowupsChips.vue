<script setup lang="ts">
import { ChatRound } from '@element-plus/icons-vue';
const props = defineProps<{
  followups: string[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ click: [question: string] }>();
</script>

<template>
  <div class="followups-chips" v-if="props.followups.length > 0">
    <span class="followups-label">
      <el-icon class="label-icon"><ChatRound /></el-icon>
      <span>你可能想问：</span>
    </span>
    <div class="chips-scroll">
      <button v-for="(f, i) in followups" :key="f"
        class="followup-chip"
        @click="emit('click', f)"
        :title="'点击继续追问'">
        {{ f }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.followups-chips {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.followups-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-soft, #888);
  white-space: nowrap;
}
.label-icon {
  font-size: 14px;
}
.chips-scroll {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 2px 0;
}
.chips-scroll::-webkit-scrollbar {
  display: none;
}
.followup-chip {
  white-space: nowrap;
  padding: 6px 14px;
  border-radius: 16px;
  background: rgba(255, 214, 224, 0.15);
  border: 1px solid rgba(255, 214, 224, 0.3);
  color: var(--text-soft, #888);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.followup-chip:hover:not(:disabled) {
  background: rgba(255, 214, 224, 0.25);
  border-color: var(--neon-cyan, #00f5ff);
  color: var(--neon-cyan, #00f5ff);
}
.followup-chip:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>

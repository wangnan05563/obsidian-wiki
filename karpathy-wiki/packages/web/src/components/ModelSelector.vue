<script setup lang="ts">
import { onMounted } from 'vue';
import { useModelStore } from '../stores/model';

const store = useModelStore();
onMounted(async () => {
  try {
    await store.loadPresets();
  } catch {}
});

async function handleChange(key: string) {
  await store.switchModel(key);
}
</script>

<template>
  <select class="model-selector"
    :value="store.selectedPresetKey"
    :title="store.loadError || '选择当前问答模型'"
    @change="handleChange(($event.target as HTMLSelectElement).value)">
    <option v-if="store.presets.length === 0" value="" disabled>
      {{ store.loadError ? '模型服务不可用' : '正在加载模型…' }}
    </option>
    <option v-for="preset in store.presets" :key="preset.key" :value="preset.key">
      {{ preset.label }}
    </option>
  </select>
</template>

<style scoped>
.model-selector {
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-main, #ccc);
  font-size: 12px;
  cursor: pointer;
  outline: none;
}
.model-selector:focus {
  border-color: var(--neon-cyan, #00f5ff);
}
.model-selector option {
  background: #1a1a2e;
  color: var(--text-main, #ccc);
}
</style>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useModelStore } from '../stores/model';
import { useQueryStore } from '../stores/query';

// F-3.9 模型切换 UI
// 关键约束（SRS F-3.9 §9.1 R8）：
//   1. 切换前检查 isLoading，in-flight 问答未结束时禁止切换，避免 SSE 中途换模型导致响应错乱
//   2. 切换成功后 Toast 200ms 内出现「已切换到 xxx」
//   3. 切换失败回滚到上一个预设 key，避免 UI 显示与后端实际配置不一致
const store = useModelStore();
const queryStore = useQueryStore();
const previousPresetKey = ref<string>('');

onMounted(async () => {
  try {
    await store.loadPresets();
    previousPresetKey.value = store.selectedPresetKey;
  } catch {}
});

async function handleChange(key: string) {
  // R8 风险缓解：SSE 进行中禁止切换模型
  if (queryStore.isLoading) {
    ElMessage.warning('回答生成中，请稍后再切换模型');
    return;
  }
  if (!key || key === store.selectedPresetKey) return;

  previousPresetKey.value = store.selectedPresetKey;
  await store.switchModel(key);

  // 切换失败回滚：switchModel 内部 catch 但不抛出，这里通过比对 selectedPresetKey 判断
  // 为什么不依赖 catch：switchModel 在 fetch 失败时已 selectedPresetKey.value = preset.key
  //（先更新 UI 再发请求），失败后 UI 仍是新值但后端未生效，需手动回滚
  // 通过读取后端 /api/ai/config 验证是否真的生效
  try {
    const res = await fetch('/api/ai/config');
    if (res.ok) {
      const cfg = await res.json() as { model?: string };
      const preset = store.presets.find(p => p.key === key);
      if (preset && cfg.model !== preset.model) {
        // 后端 model 未更新，回滚
        store.selectedPresetKey = previousPresetKey.value;
        ElMessage.error('模型切换失败，已回滚');
        return;
      }
    }
    const presetLabel = store.presets.find(p => p.key === key)?.label ?? key;
    ElMessage.success(`已切换到 ${presetLabel}`);
  } catch {
    // 验证失败不阻断（切换请求已发出），仅提示
    ElMessage.success('已切换模型');
  }
}
</script>

<template>
  <select class="model-selector"
    :value="store.selectedPresetKey"
    :disabled="queryStore.isLoading"
    :title="queryStore.isLoading ? '回答生成中，暂不可切换' : (store.loadError || '选择当前问答模型')"
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
  transition: opacity 0.2s ease;
}
.model-selector:focus {
  border-color: var(--neon-cyan, #00f5ff);
}
.model-selector:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.model-selector option {
  background: #1a1a2e;
  color: var(--text-main, #ccc);
}
</style>

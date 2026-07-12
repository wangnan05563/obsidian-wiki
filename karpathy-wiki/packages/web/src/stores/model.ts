import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { LlmPreset } from '../types';

// §3.3 useModelStore — 模型预设管理。
// 职责：加载预设列表、切换当前模型并持久化到 localStorage、同步到后端即时生效。
// 与概要设计 §2.3.3 一致：模型切换通过 PUT /api/ai/config 立即生效，无需重启。
export const useModelStore = defineStore('model', () => {
  // localStorage 持久化当前选择，刷新页面后仍记得用户选择
  const selectedPresetKey = ref<string>(localStorage.getItem('selectedModelPreset') || '');
  const currentModel = ref<string>('');
  const presets = ref<LlmPreset[]>([]);
  const loadError = ref('');

  async function loadPresets() {
    try {
      const res = await fetch('/api/ai/presets');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { presets?: LlmPreset[] } | LlmPreset[];
      presets.value = Array.isArray(data) ? data : (data.presets ?? []);
      const selected = presets.value.find(p => p.key === selectedPresetKey.value) ?? presets.value[0];
      selectedPresetKey.value = selected?.key ?? '';
      currentModel.value = selected?.model ?? '';
      loadError.value = presets.value.length ? '' : '暂无可用模型预设';
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async function switchModel(key: string) {
    const preset = presets.value.find(item => item.key === key);
    if (!preset) return;
    selectedPresetKey.value = preset.key;
    currentModel.value = preset.model;
    localStorage.setItem('selectedModelPreset', preset.key);
    // 调用后端即时生效（与概要设计 §2.3.3 一致）
    try {
      await fetch('/api/ai/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: preset.provider,
          baseUrl: preset.baseUrl,
          model: preset.model,
        }),
      });
    } catch (err) {
      console.error('切换模型失败:', err);
    }
  }

  return { currentModel, selectedPresetKey, presets, loadError, loadPresets, switchModel };
});

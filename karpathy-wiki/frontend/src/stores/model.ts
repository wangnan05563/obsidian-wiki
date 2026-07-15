import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { LlmPreset } from '../types';

// §3.3 useModelStore — 模型预设管理。
// 职责：加载预设列表、切换当前模型并持久化到 localStorage、同步到后端即时生效。
// §5.2 增强：每个预设的 apiKey 独立持久化到 localStorage，切换预设时回填对应 apiKey。
// 为什么按预设存储 apiKey：不同 provider 的 key 互不通用，切换预设时若不复用历史 key 体验差。
// 安全取舍：localStorage 明文有 XSS 风险，但用户明确选择体验优先（与 config.json 落盘策略一致）。
const SELECTED_PRESET_KEY = 'selectedModelPreset';

// 按预设 key 存储 apiKey，避免不同 provider 的 key 互相覆盖
function apiKeyStorageKey(presetKey: string): string {
  return `apiKey:${presetKey}`;
}

function loadApiKeyFor(presetKey: string): string {
  return localStorage.getItem(apiKeyStorageKey(presetKey)) || '';
}

function saveApiKeyFor(presetKey: string, apiKey: string): void {
  if (apiKey) {
    localStorage.setItem(apiKeyStorageKey(presetKey), apiKey);
  } else {
    // 空串表示清除，移除条目避免遗留空值
    localStorage.removeItem(apiKeyStorageKey(presetKey));
  }
}

export const useModelStore = defineStore('model', () => {
  // 防止 SSR 或隐私模式下 localStorage 不可用
  const savedPresetKey = (() => {
    try { return localStorage.getItem(SELECTED_PRESET_KEY); }
    catch { return null; }
  })();
  const selectedPresetKey = ref<string>(savedPresetKey || '');
  const currentModel = ref<string>('');
  // 当前预设的 apiKey，切换预设时自动回填
  const apiKey = ref<string>('');
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
      // 回填当前预设持久化的 apiKey
      apiKey.value = selected ? loadApiKeyFor(selected.key) : '';
      loadError.value = presets.value.length ? '' : '暂无可用模型预设';
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  // 切换预设：更新 selectedPresetKey、currentModel、apiKey，并同步到后端即时生效。
  // 为什么同步到后端：后端 config.json 是全局唯一 LLM 配置，切换预设需覆盖之。
  async function switchModel(key: string) {
    const preset = presets.value.find(item => item.key === key);
    if (!preset) return;
    selectedPresetKey.value = preset.key;
    currentModel.value = preset.model;
    // 切换预设后回填对应 apiKey
    apiKey.value = loadApiKeyFor(preset.key);
    localStorage.setItem(SELECTED_PRESET_KEY, preset.key);
    try {
      await fetch('/api/ai/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: preset.provider,
          baseUrl: preset.baseUrl,
          model: preset.model,
          // 同步 apiKey 到后端 config.json
          // 空串表示该预设未配置 key，后端将落盘空串清除原值
          apiKey: apiKey.value,
        }),
      });
    } catch (err) {
      console.error('切换模型失败:', err);
    }
  }

  // 保存当前预设的 apiKey 到 localStorage 并同步到后端。
  // 供 AI 配置页面「保存」按钮调用。
  async function saveApiKey(newKey: string) {
    apiKey.value = newKey;
    saveApiKeyFor(selectedPresetKey.value, newKey);
    try {
      await fetch('/api/ai/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: newKey }),
      });
    } catch (err) {
      console.error('保存 API Key 失败:', err);
    }
  }

  return { currentModel, selectedPresetKey, apiKey, presets, loadError, loadPresets, switchModel, saveApiKey };
});

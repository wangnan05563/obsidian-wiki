import { API_BASE, apiFetch } from '../utils/apiBase';
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { LlmPreset } from '../types';
import { STORAGE_KEYS } from '../constants/storageKeys';

// §3.3 useModelStore — 模型预设管理。
// 职责：加载预设列表、切换当前模型并持久化"选中预设"到 localStorage、同步到后端即时生效。
// apiKey 权威源：后端 config.json。前端不再 localStorage 明文存储 apiKey，
// 避免 localStorage 与 config.json 双轨保存导致状态不一致。
// 切换预设时从后端读取当前脱敏 apiKey 返显，明文 key 仅用户输入时短暂存在内存。

export const useModelStore = defineStore('model', () => {
  // 防止 SSR 或隐私模式下 localStorage 不可用
  const savedPresetKey = (() => {
    try { return localStorage.getItem(STORAGE_KEYS.SELECTED_MODEL_PRESET); }
    catch { return null; }
  })();
  const selectedPresetKey = ref<string>(savedPresetKey || '');
  const currentModel = ref<string>('');
  // 当前预设的 apiKey 脱敏值（从后端读取，仅用于展示是否已设置）
  const apiKeyMasked = ref<string>('');
  const apiKeySet = ref<boolean>(false);
  const presets = ref<LlmPreset[]>([]);
  const loadError = ref('');

  // F-3.5 vision 能力检测：当前选中的预设是否支持图片输入
  // 用于 AttachmentUploader 灰显图片按钮（不支持 vision 时禁用上传 + tooltip 提示）
  const currentPresetVision = computed(() => {
    const preset = presets.value.find(p => p.key === selectedPresetKey.value);
    return preset?.vision ?? false;
  });

  async function loadPresets() {
    try {
      const res = await apiFetch(`${API_BASE}/ai/presets`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { presets?: LlmPreset[] } | LlmPreset[];
      presets.value = Array.isArray(data) ? data : (data.presets ?? []);
      const selected = presets.value.find(p => p.key === selectedPresetKey.value) ?? presets.value[0];
      selectedPresetKey.value = selected?.key ?? '';
      currentModel.value = selected?.model ?? '';
      // 从后端读取当前生效的 apiKey 状态（脱敏值 + 是否已设置）
      try {
        const cfgRes = await apiFetch(`${API_BASE}/ai/config`);
        if (cfgRes.ok) {
          const cfg = await cfgRes.json() as { apiKeyMasked?: string; apiKeySet?: boolean };
          apiKeyMasked.value = cfg.apiKeyMasked ?? '';
          apiKeySet.value = Boolean(cfg.apiKeySet);
        }
      } catch {
        // 后端不可用时不阻断预设加载
      }
      loadError.value = presets.value.length ? '' : '暂无可用模型预设';
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  // 切换预设：更新 selectedPresetKey、currentModel，并同步到后端即时生效。
  // 为什么不同步 apiKey：后端 config.json 是全局唯一 LLM 配置，切换预设时
  // 后端会保留当前 apiKey（除非用户主动清除），避免切换预设导致 key 丢失。
  async function switchModel(key: string) {
    const preset = presets.value.find(item => item.key === key);
    if (!preset) return;
    selectedPresetKey.value = preset.key;
    currentModel.value = preset.model;
    localStorage.setItem(STORAGE_KEYS.SELECTED_MODEL_PRESET, preset.key);
    try {
      const res = await apiFetch(`${API_BASE}/ai/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // 不传 apiKey：后端收到 undefined 表示不修改现有 key
        body: JSON.stringify({
          provider: preset.provider,
          baseUrl: preset.baseUrl,
          model: preset.model,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { config?: { apiKeyMasked?: string; apiKeySet?: boolean } };
        if (data.config) {
          apiKeyMasked.value = data.config.apiKeyMasked ?? '';
          apiKeySet.value = Boolean(data.config.apiKeySet);
        }
      }
    } catch (err) {
      console.error('切换模型失败:', err);
    }
  }

  // 保存 apiKey 到后端 config.json（唯一权威源）。
  // 供 AI 配置页面「保存」按钮调用。前端不再 localStorage 存储 apiKey 明文。
  async function saveApiKey(newKey: string) {
    try {
      const res = await apiFetch(`${API_BASE}/ai/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: newKey }),
      });
      if (res.ok) {
        const data = await res.json() as { config?: { apiKeyMasked?: string; apiKeySet?: boolean } };
        if (data.config) {
          apiKeyMasked.value = data.config.apiKeyMasked ?? '';
          apiKeySet.value = Boolean(data.config.apiKeySet);
        }
      }
    } catch (err) {
      console.error('保存 API Key 失败:', err);
    }
  }

  return { currentModel, selectedPresetKey, apiKeyMasked, apiKeySet, presets, loadError, currentPresetVision, loadPresets, switchModel, saveApiKey };
});

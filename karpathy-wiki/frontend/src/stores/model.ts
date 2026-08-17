import { API_BASE, apiFetch } from '../utils/apiBase';
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { LlmPreset } from '../types';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { AUTO_MODEL, resolveAutoPreset } from '../utils/autoModel';
import { useAuthStore } from './auth';
import { loadAiUserConfigForPreset } from '../services/userConfig';

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
  // 默认选中 auto（自动）模式：与 workbuddy 机制一致，系统自动从已配置模型列表择优，用户无需手动指定。
  const selectedPresetKey = ref<string>(savedPresetKey || AUTO_MODEL);
  const currentModel = ref<string>('');
  // 当前预设的 apiKey 脱敏值（从后端读取，仅用于展示是否已设置）
  const apiKeyMasked = ref<string>('');
  const apiKeySet = ref<boolean>(false);
  const presets = ref<LlmPreset[]>([]);
  const loadError = ref('');

  // ── 动态模型列表（FR：AI 服务按 baseUrl+apiKey 自动获取服务商可用模型）──
  // availableModels：后端 /api/ai/models 返回的真实模型清单（[{id}]）。
  // 用于 AI 服务配置页下拉、以及问答页 ModelSelector 的"该服务商真实模型"分组。
  const availableModels = ref<{ id: string }[]>([]);
  const modelsLoading = ref(false);
  const modelsError = ref('');

  // 拉取服务商可用模型列表：优先用调用方传入的 baseUrl/apiKey（用户当前编辑/配置的），
  // 缺省由后端回退到服务端 config.llm。返回是否成功，便于调用方分支处理。
  async function fetchModels(opts?: { baseUrl?: string; apiKey?: string; provider?: string }): Promise<boolean> {
    modelsLoading.value = true;
    modelsError.value = '';
    try {
      const res = await apiFetch(`${API_BASE}/ai/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: opts?.baseUrl ?? '',
          apiKey: opts?.apiKey ?? '',
          provider: opts?.provider ?? '',
        }),
      });
      const data = (await res.json()) as { ok?: boolean; models?: { id: string }[]; detail?: string };
      if (!data.ok) {
        modelsError.value = data.detail || '获取模型列表失败';
        availableModels.value = [];
        return false;
      }
      availableModels.value = data.models ?? [];
      return true;
    } catch (err) {
      modelsError.value = err instanceof Error ? err.message : String(err);
      availableModels.value = [];
      return false;
    } finally {
      modelsLoading.value = false;
    }
  }

  // F-3.5 vision 能力检测：当前选中的预设是否支持图片输入
  // 用于 AttachmentUploader 灰显图片按钮（不支持 vision 时禁用上传 + tooltip 提示）
  // auto 模式：解析出实际将使用的预设，取其 vision 能力
  const currentPresetVision = computed(() => {
    if (selectedPresetKey.value === AUTO_MODEL) {
      return resolveAutoPreset(presets.value)?.vision ?? false;
    }
    const preset = presets.value.find(p => p.key === selectedPresetKey.value);
    return preset?.vision ?? false;
  });

  async function loadPresets() {
    try {
      const res = await apiFetch(`${API_BASE}/ai/presets`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { presets?: LlmPreset[] } | LlmPreset[];
      presets.value = Array.isArray(data) ? data : (data.presets ?? []);
      const selected = presets.value.find(p => p.key === selectedPresetKey.value);
      if (selectedPresetKey.value === AUTO_MODEL) {
        // 自动模式（默认）：收起态显示「自动」，实际模型在发起问答时由 resolveAutoPreset 动态择优。
        // 不覆盖 selectedPresetKey（保持 auto 哨兵），仅将 currentModel 记为 auto 供 UI 展示。
        currentModel.value = AUTO_MODEL;
      } else {
        const chosenKey = selected?.key ?? presets.value[0]?.key ?? '';
        selectedPresetKey.value = chosenKey;
        // 显示模型以用户在「AI 服务配置」页为该预设配置的具体模型为准（BYOK 本地存储），
        // 未配置时回退预设模板模型；与问答实际下发模型保持一致，避免"选了模板模型、
        // 实际却是用户自定义模型"的显示与生效不一致。
        currentModel.value = await resolveDisplayModel(chosenKey);
      }
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
      // 仅记录错误状态，不向上抛出：调用方（MobileQuery/ModelSelector/Config 的
      // onMounted）多为裸 await，抛出会产生未捕获 rejection 并在控制台刷屏。
      // 失效 token 导致的 401 已由 apiBase 的 401 自愈逻辑处理（清理 token + 跳登录）。
      loadError.value = err instanceof Error ? err.message : String(err);
    }
  }

  // 切换预设：更新本地选中态并持久化。
  // 架构说明：本项目问答采用 BYOK 设计——实际问答模型由用户按预设在本地的
  // llmConfig（apiKey/baseUrl/model）于发起问答时随请求体下发；后端全局
  // config.llm.model 仅作「无 BYOK 配置」时的兜底，且为管理员权限管控，
  // 普通用户不可写。因此预设切换是纯本地偏好，不需要也不应 PUT 后端全局配置。
  // （历史实现曾向 PUT /api/ai/config 同步后端，但该接口 requireAdmin，普通用户
  // 必然失败，随后前端 GET 校验回滚误报「模型切换失败，已回滚」。）
  async function switchModel(key: string) {
    const preset = presets.value.find(item => item.key === key);
    if (!preset) return;
    selectedPresetKey.value = preset.key;
    // 显示模型以用户在「AI 服务配置」页为该预设配置的具体模型为准（BYOK 本地存储），
    // 未配置时回退预设模板模型；与问答实际下发模型保持一致。
    currentModel.value = await resolveDisplayModel(key);
    try {
      localStorage.setItem(STORAGE_KEYS.SELECTED_MODEL_PRESET, preset.key);
    } catch {
      // 隐私模式 localStorage 不可用：仅内存态生效，不阻断切换
    }
  }

  // 解析某预设在 Q&A 页应展示的模型名称：优先用户在「AI 服务配置」页为该预设配置的
  // 具体模型（BYOK 本地存储），未配置时回退预设模板模型。auto 哨兵直接返回自身。
  // 与发起问答时 loadAiUserConfigForPreset 实际下发的模型保持一致，避免"选了 gpt-4o
  // 模板、实际却是 gpt-4o-mini"的显示与生效不一致。
  async function resolveDisplayModel(key: string): Promise<string> {
    if (key === AUTO_MODEL) return AUTO_MODEL;
    const preset = presets.value.find(p => p.key === key);
    if (!preset) return '';
    const uid = useAuthStore().user?.id || 'guest';
    try {
      const cfg = await loadAiUserConfigForPreset(uid, key, preset);
      return cfg.model || preset.model;
    } catch {
      return preset.model;
    }
  }

  // 切换到自动（auto）模式：仅更新本地选中态并持久化，不调后端（无具体预设可同步），
  // 实际模型在发起问答时由 resolveAutoPreset 从已配置列表动态择优。与 workbuddy auto 机制一致。
  function selectAuto() {
    selectedPresetKey.value = AUTO_MODEL;
    currentModel.value = AUTO_MODEL;
    try {
      localStorage.setItem(STORAGE_KEYS.SELECTED_MODEL_PRESET, AUTO_MODEL);
    } catch {
      // localStorage 不可用（隐私模式）时仅内存态生效
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

  return { currentModel, selectedPresetKey, apiKeyMasked, apiKeySet, presets, loadError, currentPresetVision, loadPresets, switchModel, selectAuto, saveApiKey, availableModels, modelsLoading, modelsError, fetchModels };
});

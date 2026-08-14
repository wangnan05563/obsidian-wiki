<script setup lang="ts">
import { API_BASE, apiFetch } from '../utils/apiBase';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useModelStore } from '../stores/model';
import { useQueryStore } from '../stores/query';
import { useAuthStore } from '../stores/auth';
import { loadAiUserConfigForPreset } from '../services/userConfig';
import type { LlmPreset } from '../types';

// F-3.9 模型切换 UI
// 关键约束（SRS F-3.9 §9.1 R8）：
//   1. 切换前检查 isLoading，in-flight 问答未结束时禁止切换，避免 SSE 中途换模型导致响应错乱
//   2. 切换成功后 Toast 200ms 内出现「已切换到 xxx」
//   3. 切换失败回滚到上一个预设 key，避免 UI 显示与后端实际配置不一致
//
// 显示规范（本次迭代）：
//   - 收起态（触发器）：仅显示「模型名称」(preset.model)，不含厂商，节省空间且聚焦当前模型
//   - 展开态（下拉列表）：每项显示「模型名称 · 厂商名称」(preset.model · preset.label)，
//     厂商信息仅在展开列表出现，收起后的选中显示不含厂商，二者文本格式明确区分
const store = useModelStore();
const queryStore = useQueryStore();
const authStore = useAuthStore();
const previousPresetKey = ref<string>('');

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const activeIndex = ref(0);

const isBusy = computed(() => queryStore.isLoading);

const selectedPreset = computed<LlmPreset | undefined>(() =>
  store.presets.find(p => p.key === store.selectedPresetKey),
);

// 收起态显示文本：仅模型名称（加载/错误态给出占位）
const collapsedLabel = computed(() => {
  if (store.loadError) return '模型服务不可用';
  if (store.presets.length === 0) return '正在加载模型…';
  return selectedPreset.value?.model || store.selectedPresetKey || '';
});

// 展开态列表项文本：模型名称 + 厂商名称（例如 "gpt-4o-mini · OpenAI"）
function itemModel(preset: LlmPreset): string {
  return preset.model;
}
function itemProvider(preset: LlmPreset): string {
  return preset.label;
}

onMounted(async () => {
  try {
    await store.loadPresets();
    previousPresetKey.value = store.selectedPresetKey;
  } catch {}
  document.addEventListener('click', onDocClick, true);
});
onBeforeUnmount(() => document.removeEventListener('click', onDocClick, true));

// 点击组件外部时收起面板
function onDocClick(e: MouseEvent) {
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) {
    open.value = false;
  }
}

function toggle() {
  if (isBusy.value) return;
  open.value = !open.value;
  if (open.value) {
    const idx = store.presets.findIndex(p => p.key === store.selectedPresetKey);
    activeIndex.value = idx >= 0 ? idx : 0;
  }
}

function closePanel() {
  open.value = false;
}

async function handleSelect(key: string) {
  closePanel();
  // R8 风险缓解：SSE 进行中禁止切换模型
  if (isBusy.value) {
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
    const res = await apiFetch(`${API_BASE}/ai/config`);
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
    await showSwitchSuccess(key);
  } catch {
    // 验证失败不阻断（切换请求已发出），直接基于 BYOK 状态给出结果提示
    await showSwitchSuccess(key);
  }
}

// 切换成功提示：直接校验当前用户 BYOK llmConfig（本地命名空间），判断该切换对该用户
// 是否真正生效——BYOK 用户的实际模型由其本地 llmConfig 决定，而非服务端全局预设。
//   - 已配置 BYOK（apiKey 非空）：提示已使用用户自有配置；
//   - 未配置 BYOK：提示将回退到全局模型，引导用户去「配置 / 我的」中填写 API Key。
async function showSwitchSuccess(key: string) {
  const preset = store.presets.find(p => p.key === key);
  const presetLabel = preset?.label ?? key;
  const userId = authStore.user?.id || 'guest';
  let byokSet = false;
  try {
    const cfg = await loadAiUserConfigForPreset(userId, key, preset);
    byokSet = !!cfg.apiKey && cfg.apiKey.trim().length > 0;
  } catch {
    /* BYOK 读取失败（如 IndexedDB 不可用）不阻断，按"未配置"提示 */
  }
  if (byokSet) {
    ElMessage.success(`已切换到 ${presetLabel}，已使用你的 BYOK 配置`);
  } else {
    ElMessage.warning(`已切换到 ${presetLabel}，但未检测到你的 BYOK 配置，问答将使用全局模型`);
  }
}

// 键盘可达性：收起态 Enter/Space/↑/↓ 展开；展开态 ↑/↓ 移动、Enter/Space 选中、Esc 关闭
async function onKeydown(e: KeyboardEvent) {
  if (isBusy.value) return;
  if (!open.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      toggle();
    }
    return;
  }
  const len = store.presets.length || 1;
  if (e.key === 'Escape') {
    e.preventDefault();
    closePanel();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex.value = (activeIndex.value + 1) % len;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex.value = (activeIndex.value - 1 + len) % len;
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const preset = store.presets[activeIndex.value];
    if (preset) await handleSelect(preset.key);
  }
}
</script>

<template>
  <div ref="rootRef" class="model-selector-root">
    <!-- 收起态触发器：仅显示模型名称（不含厂商） -->
    <button
      type="button"
      class="model-selector-trigger"
      :class="{ open: open, disabled: isBusy }"
      :disabled="isBusy"
      :title="store.loadError || (isBusy ? '回答生成中，暂不可切换' : '选择当前问答模型')"
      :aria-haspopup="'listbox'"
      :aria-expanded="open"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="ms-label">{{ collapsedLabel }}</span>
      <svg class="ms-caret" viewBox="0 0 1024 1024" width="10" height="10" aria-hidden="true">
        <path fill="currentColor" d="M512 704 144 336a32 32 0 0 1 45.3-45.3L512 613.3 834.7 290.7A32 32 0 0 1 880 336z" />
      </svg>
    </button>

    <!-- 展开态面板：每项显示「模型名称 · 厂商名称」 -->
    <ul
      v-if="open && store.presets.length > 0"
      class="model-selector-panel"
      role="listbox"
      :aria-activedescendant="`ms-item-${activeIndex}`"
    >
      <li
        v-for="(preset, idx) in store.presets"
        :id="`ms-item-${idx}`"
        :key="preset.key"
        class="model-selector-item"
        :class="{ selected: preset.key === store.selectedPresetKey, active: idx === activeIndex }"
        role="option"
        :aria-selected="preset.key === store.selectedPresetKey"
        @mouseenter="activeIndex = idx"
        @click="handleSelect(preset.key)"
      >
        <span class="ms-item-model">{{ itemModel(preset) }}</span>
        <span class="ms-item-sep" aria-hidden="true">·</span>
        <span class="ms-item-provider">{{ itemProvider(preset) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.model-selector-root {
  position: relative;
  display: inline-block;
}
.model-selector-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-main, #ccc);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  outline: none;
  transition: border-color 0.2s ease, opacity 0.2s ease;
  max-width: 220px;
}
.model-selector-trigger.open {
  border-color: var(--neon-cyan, #00f5ff);
}
.model-selector-trigger:focus-visible {
  border-color: var(--neon-cyan, #00f5ff);
}
.model-selector-trigger.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ms-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ms-caret {
  flex: none;
  transition: transform 0.2s ease;
}
.model-selector-trigger.open .ms-caret {
  transform: rotate(180deg);
}

.model-selector-panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 100%;
  margin: 0;
  padding: 4px;
  list-style: none;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  background: var(--bg-elevated, #1a1a2e);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  z-index: 1000;
  max-height: 280px;
  overflow-y: auto;
}
.model-selector-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-main, #ccc);
  font-size: 12px;
  white-space: nowrap;
}
.ms-item-model {
  font-weight: 600;
}
.ms-item-sep {
  color: var(--text-muted, #888);
}
.ms-item-provider {
  color: var(--text-muted, #888);
  font-size: 11px;
}
.model-selector-item:hover,
.model-selector-item.active {
  background: rgba(255, 255, 255, 0.08);
}
.model-selector-item.selected {
  background: rgba(0, 245, 255, 0.12);
}
.model-selector-item.selected .ms-item-model {
  color: var(--neon-cyan, #00f5ff);
}
</style>

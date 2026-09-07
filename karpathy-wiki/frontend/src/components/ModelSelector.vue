<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useModelStore } from '../stores/model';
import { useQueryStore } from '../stores/query';
import { useAuthStore } from '../stores/auth';
import { loadAiUserConfigForPreset, saveAiUserConfigForPreset } from '../services/userConfig';
import { AUTO_MODEL } from '../utils/autoModel';
import type { LlmPreset } from '../types';

// F-3.9 模型切换 UI
// 关键约束（SRS F-3.9 §9.1 R8）：
//   1. 切换前检查 isLoading，in-flight 问答未结束时禁止切换，避免 SSE 中途换模型导致响应错乱
//   2. 切换成功后 Toast 200ms 内出现「已切换到 xxx」
//   3. 预设切换为纯本地偏好（BYOK 架构下实际模型于发起问答时本地解析下发），
//      不再回滚——原"比对后端全局 model 不一致则回滚"的逻辑对普通用户必然误报
//      （PUT /api/ai/config 为管理员权限，普通用户不可写）。切换是否真正生效由
//      showSwitchSuccess 据本地 BYOK 配置状态给出提示。
//
// 显示规范（本次迭代）：
//   - 收起态（触发器）：仅显示「模型名称」(preset.model)，不含厂商，节省空间且聚焦当前模型
//   - 展开态（下拉列表）：每项显示「模型名称 · 厂商名称」(preset.model · preset.label)，
//     厂商信息仅在展开列表出现，收起后的选中显示不含厂商，二者文本格式明确区分
const store = useModelStore();
const queryStore = useQueryStore();
const authStore = useAuthStore();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const activeIndex = ref(0);
// 展开方向：false=向下（默认），true=向上。当下方空间不足时自动改为向上，避免被容器/视口截断
const dropUp = ref(false);

const isBusy = computed(() => queryStore.isLoading);

const selectedPreset = computed<LlmPreset | undefined>(() =>
  store.presets.find(p => p.key === store.selectedPresetKey),
);

// 渲染列表：自动（auto）虚拟项置顶 + 已配置预设列表。
// auto 项不对应真实预设，仅作为「系统自动选择」入口；选中后由 resolveAutoPreset 动态择优。
const items = computed<LlmPreset[]>(() => {
  const autoItem: LlmPreset = {
    key: AUTO_MODEL,
    label: '系统自动选择',
    provider: 'auto',
    baseUrl: '',
    model: '自动',
    apiKeyRef: '',
    apiKeyUrl: '',
    vision: false,
  };
  return [autoItem, ...store.presets];
});

// 收起态显示文本：优先显示当前真实模型（含用户从服务商清单选取的具体模型），
// 否则回退预设模板模型或预设 key（加载/错误态给出占位）
// auto 模式下固定显示「自动」，提示系统将自动择优，而非展示某个具体模型。
const collapsedLabel = computed(() => {
  if (store.selectedPresetKey === AUTO_MODEL) return '自动';
  if (store.loadError) return '模型服务不可用';
  if (store.presets.length === 0) return '正在加载模型…';
  if (store.currentModel) return store.currentModel;
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
  } catch {}
  document.addEventListener('click', onDocClick, true);
  // 视口/布局变化（缩放、滚动、侧栏伸缩等）时重新计算展开方向，保证不被边界截断
  window.addEventListener('resize', onReflow);
  window.addEventListener('scroll', onReflow, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
  window.removeEventListener('resize', onReflow);
  window.removeEventListener('scroll', onReflow, true);
});

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
    const idx = store.selectedPresetKey === AUTO_MODEL
      ? 0
      : items.value.findIndex(p => p.key === store.selectedPresetKey);
    activeIndex.value = idx >= 0 ? idx : 0;
    // 面板已渲染后（nextTick 在浏览器绘制前完成），测量真实高度并据此选择展开方向，避免首帧抖动
    nextTick(updateDirection);
    // 展开时拉取「当前服务商真实模型」清单，供用户在问答内直接切换具体模型（FR）
    void loadRealModels();
  }
}

// 当前预设下用户 BYOK 真实模型（用于高亮"服务商真实模型"分组中的已选项）
const currentRealModel = ref('');

// 拉取当前预设对应的服务商真实模型清单。
// 读取当前用户该预设的 BYOK 配置（provider/baseUrl/apiKey/model），仅当用户已配置 key 才拉取；
// 拉取结果落入 modelStore.availableModels，panel 内"服务商真实模型"分组据此渲染。
async function loadRealModels() {
  const uid = authStore.user?.id || 'guest';
  const preset = store.presets.find(p => p.key === store.selectedPresetKey);
  const cfg = await loadAiUserConfigForPreset(uid, store.selectedPresetKey, preset);
  currentRealModel.value = cfg.model || '';
  if (!cfg.apiKey) {
    // 未配置该预设的 API Key：无法以用户身份拉取服务商模型，清空清单（panel 给出提示）
    store.availableModels = [];
    return;
  }
  await store.fetchModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, provider: cfg.provider });
  // 拉取后若清单中恰好包含当前模型，保持高亮一致
  if (store.availableModels.length && currentRealModel.value && !store.availableModels.some(m => m.id === currentRealModel.value)) {
    // 当前模型不在清单内（如自定义模型名），不强制处理，仅不亮选
  }
}

// 从"服务商真实模型"分组选取具体模型：写入当前预设的用户 BYOK 槽位并即时生效。
// 与预设切换不同——provider/baseUrl 不变，仅覆盖 model 字段，使问答实际使用该模型。
async function selectRealModel(id: string) {
  closePanel();
  if (isBusy.value) {
    ElMessage.warning('回答生成中，请稍后再切换模型');
    return;
  }
  if (!id) return;
  const uid = authStore.user?.id || 'guest';
  const preset = store.presets.find(p => p.key === store.selectedPresetKey);
  const cfg = await loadAiUserConfigForPreset(uid, store.selectedPresetKey, preset);
  await saveAiUserConfigForPreset(uid, store.selectedPresetKey, { ...cfg, model: id });
  currentRealModel.value = id;
  store.currentModel = id;
  ElMessage.success(`已切换到 ${id}（已写入你的本地配置，问答将使用此模型）`);
}

function isRealSelected(id: string): boolean {
  return id === currentRealModel.value;
}

// 找到真正会裁剪面板的祖先容器（任何 overflow 为 hidden/auto/scroll/clip 的祖先），
// 找不到则返回视口（documentElement），用于把"下方可用空间"算在正确的边界内。
function getClippingContainer(): HTMLElement {
  let el = rootRef.value?.parentElement ?? null;
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    const clips =
      cs.overflowY === 'hidden' || cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'clip' ||
      cs.overflowX === 'hidden' || cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowX === 'clip';
    if (clips) return el;
    el = el.parentElement;
  }
  return document.documentElement;
}

// 根据触发器上下方可用空间自动选择展开方向：下方够放则向下，否则向上，都不够则朝空间更大一侧（剩余靠滚动）
function updateDirection() {
  const root = rootRef.value;
  const panel = panelRef.value;
  if (!root || !panel) return;
  const rect = root.getBoundingClientRect();
  const cont = getClippingContainer();
  const cRect =
    cont === document.documentElement
      ? { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
      : cont.getBoundingClientRect();
  const gap = 4; // 与面板 top/bottom: calc(100% + 4px) 的间距一致
  const spaceBelow = cRect.bottom - rect.bottom - gap;
  const spaceAbove = rect.top - cRect.top - gap;
  const panelH = panel.getBoundingClientRect().height;
  if (spaceBelow >= panelH) {
    dropUp.value = false;
  } else if (spaceAbove >= panelH) {
    dropUp.value = true;
  } else {
    dropUp.value = spaceAbove >= spaceBelow;
  }
}

// 视口/滚动变化时若处于展开态则重算方向
function onReflow() {
  if (open.value) updateDirection();
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
  // 自动（auto）模式：仅切换本地选中态，不调后端、无需回滚校验（无具体预设可同步）。
  if (key === AUTO_MODEL) {
    store.selectAuto();
    ElMessage.success('已切换到自动模式，系统将自动选择最合适的模型');
    return;
  }
  if (!key || key === store.selectedPresetKey) return;

  await store.switchModel(key);
  // BYOK 架构下，实际问答模型在发起问答时按所选预设本地解析并随请求体下发，
  // 预设切换是纯本地偏好操作，无需也不应 PUT 后端全局配置。是否真正生效
  //（用户是否已为对应预设配置 BYOK）由 showSwitchSuccess 据本地状态给出提示。
  await showSwitchSuccess(key);
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
  const len = items.value.length || 1;
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
    const preset = items.value[activeIndex.value];
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
      ref="panelRef"
      class="model-selector-panel"
      :class="{ 'drop-up': dropUp }"
      role="listbox"
      :aria-activedescendant="`ms-item-${activeIndex}`"
    >
      <li
        v-for="(preset, idx) in items"
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

      <!-- 服务商真实模型分组：按当前预设的 baseUrl+key 拉取，用户可直接选具体模型（FR） -->
      <li class="ms-divider" role="separator"></li>
      <li class="ms-group-header">
        服务商真实模型
        <span v-if="store.modelsLoading" class="ms-loading">加载中…</span>
      </li>
      <li
        v-for="m in store.availableModels"
        :key="`real-${m.id}`"
        class="model-selector-item"
        :class="{ selected: isRealSelected(m.id) }"
        role="option"
        :aria-selected="isRealSelected(m.id)"
        @click="selectRealModel(m.id)"
      >
        <span class="ms-item-model">{{ m.id }}</span>
      </li>
      <li v-if="!store.modelsLoading && store.availableModels.length === 0" class="ms-empty">
        未获取到真实模型（请先在「配置 → AI 服务」填写 API Key 并获取列表）
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
  /* T00263：去掉按钮边框、透明背景，简洁样式；hover/展开再显现反馈 */
  border: none;
  background: transparent;
  color: var(--text-main, #ccc);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  outline: none;
  transition: background 0.2s ease, opacity 0.2s ease;
  max-width: 220px;
}
.model-selector-trigger:hover {
  background: var(--accent-cyan-a10, rgba(0, 245, 255, 0.1));
}
.model-selector-trigger.open {
  background: var(--accent-cyan-a12, rgba(0, 245, 255, 0.12));
}
.model-selector-trigger:focus-visible {
  box-shadow: 0 0 0 2px var(--neon-cyan, #00f5ff);
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
/* 下方空间不足时改为向上展开：从触发器的上边缘向上生长，避免超出容器/视口被截断 */
.model-selector-panel.drop-up {
  top: auto;
  bottom: calc(100% + 4px);
  box-shadow: 0 -6px 20px rgba(0, 0, 0, 0.35);
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

/* 分组分隔线 + 分组标题（预设模型 / 服务商真实模型） */
.ms-divider {
  height: 1px;
  margin: 4px 2px;
  padding: 0;
  background: var(--border-color, rgba(128, 128, 128, 0.2));
  cursor: default;
}
.ms-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-muted, #888);
  cursor: default;
  text-transform: none;
}
.ms-loading {
  font-size: 10px;
  color: var(--neon-cyan, #00f5ff);
}
.ms-empty {
  padding: 6px 8px;
  font-size: 11px;
  color: var(--text-muted, #888);
  cursor: default;
  white-space: normal;
  line-height: 1.5;
}
</style>

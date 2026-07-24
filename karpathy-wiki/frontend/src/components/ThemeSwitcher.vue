<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useTheme, type ThemeName } from '../composables/useTheme';

const props = withDefaults(defineProps<{ embedded?: boolean }>(), {
  embedded: false,
});

const { currentTheme, themes, setTheme } = useTheme();
const open = ref(false);
const panelRef = ref<HTMLDivElement | null>(null);

// 缓存当前主题信息，避免模板中重复 themes.find 调用导致的多次遍历
const currentThemeInfo = computed(() =>
  themes.find((t) => t.key === currentTheme.value)
);

const currentLabel = computed(() => currentThemeInfo.value?.label ?? '');

const currentSwatch = computed<[string, string]>(() =>
  currentThemeInfo.value?.swatch ?? ['', '']
);

// 渐变样式字符串，供 trigger-swatch 直接绑定，避免模板内拼接
const triggerGradient = computed(
  () =>
    `linear-gradient(135deg, ${currentSwatch.value[0]} 0%, ${currentSwatch.value[1]} 100%)`
);

// 切换器标题：macaron 主题存在时显示双语标题
// 用 .some() 表达"存在性"语义，比 .find() 更准确
const hasMacaron = computed(() => themes.some((t) => t.key === 'macaron'));
const panelTitle = computed(() => (hasMacaron.value ? 'Theme Switch' : 'Theme'));

function toggle() {
  open.value = !open.value;
}

function select(key: ThemeName) {
  setTheme(key);
  open.value = false;
}

// 点击面板外部时关闭：contains 返回 false 表示点击发生在面板外
function handleClickOutside(e: MouseEvent) {
  if (panelRef.value && !panelRef.value.contains(e.target as Node)) {
    open.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside);
});
</script>

<template>
  <div class="theme-switcher" :class="{ embedded: props.embedded }" ref="panelRef">
    <!-- Trigger button: shows current theme swatch -->
    <button
      v-if="!props.embedded"
      class="trigger hover-glow"
      :class="{ active: open }"
      @click.stop="toggle"
      :title="`Current theme: ${currentLabel}`"
    >
      <span class="trigger-swatch" :style="{ background: triggerGradient }"></span>
      <svg class="trigger-icon" :class="{ spin: open }" viewBox="0 0 24 24" width="16" height="16">
        <path d="M12 2L2 7l10 5 10-5-10-5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <path d="M2 17l10 5 10-5M2 12l10 5 10-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      </svg>
    </button>

    <!-- Theme selection panel -->
    <transition name="panel">
      <div v-if="open || props.embedded" class="panel glass-card">
        <div class="panel-header">
          <span class="panel-title">{{ panelTitle }}</span>
          <span class="panel-sub">{{ themes.length }} styles</span>
        </div>
        <div class="theme-list">
          <button
            v-for="theme in themes"
            :key="theme.key"
            class="theme-item hover-glow"
            :class="{ selected: theme.key === currentTheme }"
            @click="select(theme.key)"
          >
            <span class="theme-swatch" :style="{
              background: `linear-gradient(135deg, ${theme.swatch[0]} 0%, ${theme.swatch[1]} 100%)`
            }"></span>
            <span class="theme-info">
              <span class="theme-label">{{ theme.label }}</span>
              <span class="theme-desc">{{ theme.description }}</span>
            </span>
            <span v-if="theme.key === currentTheme" class="theme-check">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.theme-switcher {
  /* 浮动模式：避开右下角 FloatingChat（56px 高 + 36px 间距），
     放在其正上方避免位置冲突 */
  position: fixed;
  right: 24px;
  bottom: 92px;
  z-index: 1000;
}

.theme-switcher.embedded {
  position: relative;
  right: auto;
  bottom: auto;
  z-index: 1;
  width: 100%;
}

/* Trigger button */
.trigger {
  width: 52px;
  height: 52px;
  border-radius: var(--radius-pill);
  border: var(--border-glass);
  background: var(--bg-card);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  box-shadow: var(--glow-soft);
  transition: all 0.3s cubic-bezier(0.23, 1, 0.32, 1);
  position: relative;
}

.trigger:hover {
  transform: translateY(-3px) scale(1.05);
  box-shadow: var(--glow-purple);
}

.trigger.active {
  transform: scale(0.95);
}

/* Current theme swatch preview */
.trigger-swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  position: absolute;
  transition: all 0.3s ease;
  box-shadow: 0 0 12px rgba(255, 255, 255, 0.3);
}

.trigger.active .trigger-swatch {
  width: 16px;
  height: 16px;
}

.trigger-icon {
  color: var(--text-bright);
  opacity: 0;
  transition: opacity 0.3s ease;
  position: relative;
  z-index: 1;
}

.trigger.active .trigger-icon {
  opacity: 1;
}

.trigger-icon.spin {
  animation: spin 0.5s ease;
}

@keyframes spin {
  to { transform: rotate(180deg); }
}

/* Panel */
.panel {
  position: absolute;
  bottom: 64px;
  right: 0;
  width: 280px;
  padding: 16px;
  background: var(--bg-card-solid);
}

.embedded .panel {
  position: relative;
  bottom: auto;
  right: auto;
  width: 100%;
  background: var(--bg-card);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 4px 8px 12px;
  border-bottom: 1px solid var(--border-glass);
  margin-bottom: 8px;
}

.panel-title {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 1px;
}

.panel-sub {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
  letter-spacing: 1px;
}

/* Theme list */
.theme-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 360px;
  overflow-y: auto;
}

.theme-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-btn);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  transition: all 0.25s ease;
  text-align: left;
  width: 100%;
}

.theme-item:hover {
  background: var(--bg-glass);
  transform: translateX(4px);
}

.theme-item.selected {
  background: var(--bg-glass);
  border-color: var(--border-neon);
}

/* Swatch preview */
.theme-swatch {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-input);
  flex-shrink: 0;
  box-shadow: 0 2px 8px var(--accent-purple-a20, rgba(0, 0, 0, 0.2));
  transition: transform 0.3s ease;
}

.theme-item:hover .theme-swatch {
  transform: scale(1.1) rotate(-5deg);
}

.theme-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.theme-label {
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
  letter-spacing: 0.5px;
}

.theme-desc {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-soft);
  letter-spacing: 0.3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.theme-check {
  color: var(--neon-cyan);
  flex-shrink: 0;
  filter: drop-shadow(0 0 4px currentColor);
}

/* Panel transition */
.panel-enter-active,
.panel-leave-active {
  transition: all 0.3s cubic-bezier(0.23, 1, 0.32, 1);
}

.panel-enter-from,
.panel-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.95);
}

/* Responsive: small screen */
@media (max-width: 600px) {
  .theme-switcher {
    right: 16px;
    bottom: 16px;
  }

  .panel {
    width: 260px;
  }

  .theme-switcher.embedded {
    position: relative;
    right: auto;
    bottom: auto;
  }

  .embedded .panel {
    width: 100%;
  }
}
</style>

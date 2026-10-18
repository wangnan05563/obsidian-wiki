<script setup lang="ts">
// 配置中心左侧分组导航（T02467 / PRD §10 C2+C3 / REQ-033+REQ-034）
// ------------------------------------------------------------------
// 替掉原来「11 个 tab 单行平铺」的两条硬伤：
//   C2 溢出被截断（实测最后一项只显示「Prom」）→ 竖排分组导航，11 项全可见、无需横向滚动；
//   C3 无权限 tab 靠 v-if 直接消失，非管理员「刚才那个 tab 怎么没了」无从解释
//      → 锁定项保留、置灰 + 「仅管理员」标注，点击发出 locked 事件由页面给说明。
// 组件只做渲染与选择，分组/锁定判定全在 utils/configTabs.ts（可单测）。
import type { ConfigNavGroup, ConfigTabMeta } from '../utils/configTabs';

const props = defineProps<{
  modelValue: string;
  groups: ConfigNavGroup[];
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', name: string): void;
  (e: 'select', name: string): void;
  (e: 'locked', tab: ConfigTabMeta & { locked: boolean }): void;
}>();

function pick(item: ConfigTabMeta & { locked: boolean }): void {
  if (item.locked) {
    emit('locked', item);
    return;
  }
  if (item.name !== props.modelValue) emit('select', item.name);
  emit('update:modelValue', item.name);
}
</script>

<template>
  <nav class="config-nav" aria-label="配置分组">
    <section v-for="group in groups" :key="group.key" class="nav-group">
      <h3 class="nav-group-title">{{ group.label }}</h3>
      <p class="nav-group-desc">{{ group.desc }}</p>
      <ul class="nav-list" role="tablist" aria-orientation="vertical">
        <li v-for="item in group.items" :key="item.name">
          <button
            type="button"
            class="nav-item"
            :class="{ 'is-active': item.name === modelValue, 'is-locked': item.locked }"
            role="tab"
            :aria-selected="item.name === modelValue"
            :aria-disabled="item.locked ? true : undefined"
            :data-tip="item.locked ? `${item.label} - 仅管理员可修改` : `${item.label} - ${item.desc}`"
            @click="pick(item)"
          >
            <span class="nav-label">{{ item.label }}</span>
            <span v-if="item.locked" class="nav-lock">仅管理员</span>
          </button>
        </li>
      </ul>
    </section>
  </nav>
</template>

<style scoped>
.config-nav {
  width: 176px;
  flex: 0 0 176px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-right: 12px;
}
.nav-group-title {
  margin: 0 0 2px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--text-muted, #6b7280);
  text-transform: uppercase;
}
.nav-group-desc {
  margin: 0 0 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint, #9aa3af);
}
.nav-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-color, #333);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.nav-item:hover {
  background: rgba(21, 84, 209, 0.06);
}
.nav-item.is-active {
  background: rgba(0, 245, 255, 0.08);
  border-color: rgba(21, 84, 209, 0.28);
  color: #1554d1;
  font-weight: 600;
}
.nav-item.is-locked {
  color: var(--text-faint, #9aa3af);
  cursor: not-allowed;
}
.nav-item.is-locked:hover {
  background: rgba(154, 163, 175, 0.08);
}
.nav-lock {
  font-size: 10px;
  line-height: 14px;
  padding: 0 5px;
  border-radius: 999px;
  color: #8a5a00;
  background: rgba(217, 154, 24, 0.12);
  border: 1px solid rgba(217, 154, 24, 0.28);
  white-space: nowrap;
}
@media (max-width: 900px) {
  .config-nav {
    width: auto;
    flex: none;
    flex-direction: row;
    flex-wrap: wrap;
  }
}
</style>

<script setup lang="ts">
// 字段生效方式徽标（T02467 / PRD §10 C1 / REQ-032）
// ------------------------------------------------------------------
// 用户在改任何一个字段之前，都要能预判「改完要不要重启」。此前这个信息只出现在保存后的
// 一句 toast 里（且三套口径并存），本组件把它前置到字段旁边：即时 / 点热加载生效 / 需重启服务。
// 文案与配色一律走 configEffects.EFFECT_META，字段名与原因来自服务端登记表，视图不自行判断。
import { computed } from 'vue';
import type { EffectBadge } from '../utils/configEffects';

const props = withDefaults(
  defineProps<{
    /** 由 utils/configEffects.badgeFor() 产出的徽标（文案与配色单一来源） */
    badge?: EffectBadge;
    /** 字段级补充说明（来自服务端登记表 reason），有则并入 tooltip */
    reason?: string;
    /** 紧凑模式：只留短标签，用于行内密集排布 */
    compact?: boolean;
  }>(),
  { badge: undefined, reason: '', compact: false },
);

const tip = computed(() => {
  if (!props.badge) return '';
  const suffix = props.reason ? `｜${props.reason}` : '';
  const detail = props.compact ? '' : ` - ${props.badge.tip}`;
  return `${props.badge.label}${detail}${suffix}`;
});
</script>

<template>
  <span
    v-if="badge"
    class="effect-tag"
    :class="[`effect-tag--${badge.tone}`, { 'is-compact': compact }]"
    :data-tip="tip"
    :aria-label="tip"
  >
    <span class="effect-dot" aria-hidden="true"></span>
    <span class="effect-text">{{ badge.label }}</span>
  </span>
</template>

<style scoped>
.effect-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
  border: 1px solid transparent;
  white-space: nowrap;
  cursor: help;
}
.effect-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.effect-tag--instant {
  color: #1d7a5f;
  background: rgba(29, 122, 95, 0.08);
  border-color: rgba(29, 122, 95, 0.28);
}
.effect-tag--reload {
  color: #8a5a00;
  background: rgba(217, 154, 24, 0.1);
  border-color: rgba(217, 154, 24, 0.32);
}
.effect-tag--restart {
  color: #b3261e;
  background: rgba(179, 38, 30, 0.08);
  border-color: rgba(179, 38, 30, 0.3);
}
.effect-tag.is-compact .effect-text {
  font-size: 10px;
}
</style>

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { GUIDE_DEFINITIONS, GUIDE_SEEN_KEY } from '../guides';
import type { GuideDefinition, GuideStep } from '../guides';

// 用户引导向导系统 · 状态管理
//
// 职责：
//   1. 维护当前激活的引导（activeView + stepIndex）与整体显隐
//   2. 记录「已引导过的视图」集合（localStorage 持久化，满足"首次引导仅一次"）
//   3. 提供 start / next / prev / skip / close 等交互方法，供组件调用
//
// 为什么用 pinia store 而非组件内 ref：引导要在 App.vue（触发）与
//   GuideOverlay.vue（渲染）两个组件间共享状态，且需底层持久化，集中管理更清晰。

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(GUIDE_SEEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    // localStorage 不可用/数据损坏时降级为空集合，不阻塞引导
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  try {
    localStorage.setItem(GUIDE_SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // 写入失败静默降级，不影响体验
  }
}

export const useGuideStore = defineStore('guide', () => {
  // 当前可见的引导视图 key（空=无引导显示）
  const activeView = ref('');
  // 当前引导内的步骤下标
  const stepIndex = ref(0);
  // 已引导过的视图集合（取 localStorage 初始值）
  const seenViews = ref<Set<string>>(loadSeen());

  const visible = computed(() => activeView.value !== '');
  // 当前激活引导定义（undefined 时无引导）
  const current = computed<GuideDefinition | undefined>(() => GUIDE_DEFINITIONS[activeView.value]);
  // 当前步（可能不存在，用 computed 兜底避免模板空指针）
  const currentStep = computed<GuideStep | undefined>(() => current.value?.steps[stepIndex.value]);

  // 判断某视图是否已引导过
  function isSeen(view: string): boolean {
    return seenViews.value.has(view);
  }

  // 标记某视图已引导
  function markSeen(view: string): void {
    if (seenViews.value.has(view)) return;
    seenViews.value.add(view);
    saveSeen(seenViews.value);
  }

  // 启动指定视图的引导（强制重放；不改变已引导标记）
  function start(view: string): void {
    if (!GUIDE_DEFINITIONS[view]) return;
    activeView.value = view;
    stepIndex.value = 0;
  }

  // 首次访问检查：若该视图未引导过则启动，并标记已引导
  // 返回是否实际启动了引导
  function maybeStartFirstTime(view: string): boolean {
    if (!GUIDE_DEFINITIONS[view]) return false;
    if (isSeen(view)) return false;
    start(view);
    markSeen(view);
    return true;
  }

  // 关闭当前引导（无论到了哪一步都直接关闭）
  function close(): void {
    activeView.value = '';
    stepIndex.value = 0;
  }

  // 跳到下一步；已是最后一步则关闭
  function next(): void {
    if (!current.value) return;
    if (stepIndex.value >= current.value.steps.length - 1) {
      close();
      return;
    }
    stepIndex.value += 1;
  }

  // 回到上一步（存在上一步时）
  function prev(): void {
    if (stepIndex.value > 0) stepIndex.value -= 1;
  }

  // 跳过：直接关闭当前引导（不标记已引导，下次访问仍可能触发）
  function skip(): void {
    activeView.value = '';
    stepIndex.value = 0;
  }

  return {
    // 状态
    activeView,
    stepIndex,
    seenViews,
    visible,
    current,
    currentStep,
    // 方法
    isSeen,
    markSeen,
    start,
    maybeStartFirstTime,
    close,
    next,
    prev,
    skip,
  };
});
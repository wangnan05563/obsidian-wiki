import { ref, onMounted, onBeforeUnmount } from 'vue';

// 响应式移动端判定（SRS §3 信息架构：底部 Tab 替代桌面侧边栏）。
//
// 断点 768px：平板（≥768px）回退桌面端布局，手机（<768px）启用 MobileShell。
// 为什么用 matchMedia 而非读 UA：避免伪装 UA 误判，且能在旋转/缩放时实时切换，
// 与项目「复用现有 SPA、不引入 vue-router」策略契合（App.vue 用 isMobile 决定渲染分支）。
const MOBILE_QUERY = '(max-width: 768px)';

function getInitial(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(MOBILE_QUERY).matches;
}

/**
 * 返回响应式 isMobile。组件挂载后自动监听视口变化并更新，卸载时移除监听。
 */
export function useIsMobile() {
  const isMobile = ref(getInitial());
  let mql: MediaQueryList | null = null;

  const update = () => {
    if (mql) isMobile.value = mql.matches;
  };

  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    mql = window.matchMedia(MOBILE_QUERY);
    update();
    // 现代浏览器用 addEventListener；老浏览器回退 addListener
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update);
    } else if (typeof (mql as unknown as { addListener?: (cb: () => void) => void }).addListener === 'function') {
      (mql as unknown as { addListener: (cb: () => void) => void }).addListener(update);
    }
  });

  onBeforeUnmount(() => {
    if (!mql) return;
    if (typeof mql.removeEventListener === 'function') {
      mql.removeEventListener('change', update);
    } else if (typeof (mql as unknown as { removeListener?: (cb: () => void) => void }).removeListener === 'function') {
      (mql as unknown as { removeListener: (cb: () => void) => void }).removeListener(update);
    }
  });

  return { isMobile };
}

import { ref, watch } from 'vue';

export type MobileTheme = 'glass' | 'light';

const STORAGE_KEY = 'karpathy-mobile-theme';

function readInitial(): MobileTheme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'glass' || v === 'light') return v;
  } catch {
    /* localStorage 不可用时回退默认 */
  }
  // 用户选定默认浅白风；无历史记录时首屏即浅白商务风
  return 'light';
}

// 模块级单例 ref：MobileShell（负责在 .mobile-root 挂 theme-light 类）
// 与 MobileMe（主题切换控件）共享同一状态，切换即时联动。
const theme = ref<MobileTheme>(readInitial());

watch(
  theme,
  (v) => {
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      /* 忽略持久化失败（隐私模式等）*/
    }
  },
  { immediate: false },
);

export function useMobileTheme() {
  return {
    theme,
    isLight: () => theme.value === 'light',
    isGlass: () => theme.value === 'glass',
    setTheme: (t: MobileTheme) => {
      theme.value = t;
    },
    toggle: () => {
      theme.value = theme.value === 'glass' ? 'light' : 'glass';
    },
  };
}

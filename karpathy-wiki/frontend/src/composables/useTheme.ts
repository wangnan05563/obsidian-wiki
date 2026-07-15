/* ============================================================
 * 主题切换 composable · useTheme
 * 管理主题状态、持久化、DOM 属性同步
 * ============================================================ */
import { ref, watch } from 'vue';

export type ThemeName =
  | 'macaron'
  | 'enterprise'
  | 'creative'
  | 'product'
  | 'ecommerce'
  | 'portfolio';

export interface ThemeMeta {
  key: ThemeName;
  label: string;
  description: string;
  /** 预览色块：主色 + 强调色，用于切换器视觉提示 */
  swatch: [string, string];
}

// 主题元数据：集中管理，供切换器渲染
export const THEMES: ThemeMeta[] = [
  {
    key: 'macaron',
    label: '马卡龙',
    description: '浅粉浅青 · 圆润可爱',
    swatch: ['#ffb3d1', '#a8e0d8'],
  },
  {
    key: 'enterprise',
    label: '现代企业',
    description: '科技蓝灰 · 专业可依赖',
    swatch: ['#2563eb', '#06b6d4'],
  },
  {
    key: 'creative',
    label: '创意品牌',
    description: '霓虹赛博 · 大胆渐变',
    swatch: ['#b026ff', '#00f5ff'],
  },
  {
    key: 'product',
    label: '产品展示',
    description: '暗黑霓虹 · 科技未来',
    swatch: ['#00ff88', '#ff0080'],
  },
  {
    key: 'ecommerce',
    label: '电商零售',
    description: '明亮扁平 · 橙蓝活力',
    swatch: ['#ff6b35', '#00a8e8'],
  },
  {
    key: 'portfolio',
    label: '艺术作品集',
    description: '米色金黑 · 优雅极简',
    swatch: ['#c9a961', '#1a1a1a'],
  }
];

const STORAGE_KEY = 'karpathy-wiki-theme';

function readStoredTheme(): ThemeName {
  // 从 localStorage 读取用户上次选择，非法值回退到 creative
  // 通过 valid.key 返回而非 stored 类型断言，避免不安全的类型转换
  const stored = localStorage.getItem(STORAGE_KEY);
  const valid = THEMES.find((t) => t.key === stored);
  return valid ? valid.key : 'creative';
}

const currentTheme = ref<ThemeName>(readStoredTheme());

function applyTheme(theme: ThemeName) {
  // 同步到 <html data-theme="xxx">，CSS 变量随之切换
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
}

// 监听变化自动应用，组件只需修改 currentTheme.value
watch(currentTheme, (val) => applyTheme(val), { immediate: true });

export function useTheme() {
  function setTheme(theme: ThemeName) {
    currentTheme.value = theme;
  }

  function toggleTheme() {
    // 循环切换，方便快捷键操作
    const idx = THEMES.findIndex((t) => t.key === currentTheme.value);
    const next = THEMES[(idx + 1) % THEMES.length];
    currentTheme.value = next.key;
  }

  return {
    currentTheme,
    themes: THEMES,
    setTheme,
    toggleTheme,
  };
}

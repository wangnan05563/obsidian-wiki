// wiki三期 T02394（PRD N4 / 技术方案 D1）：hash 路由同步
// 背景：项目为单 SPA，无 vue-router（全项目 6 处显式声明不引入），视图切换靠 currentView ref。
// 本 composable 让 currentView 与 URL hash 双向同步，获得：刷新保持 / 回退前进 / 深链分享。
// 设计约束：
//   - 单通道：go() 权限通过后调 syncHash() 写 history（pushState，产生可回退条目）；
//     外部变化（回退/前进/手改地址栏）统一走 hashchange 监听 → applyHashView()
//   - 非法 hash 不切换视图；hashchange 场景下 replaceState 归一化回当前视图，保证地址栏真实
//   - 初始挂载不归一化：未登录/未恢复会话时深链 hash 需保留，待会话恢复后再应用
//   - 权限校验在调用方（App.vue 的 guard），本模块只做格式与白名单

import { ref, onMounted, onBeforeUnmount, type Ref } from 'vue';

/** 从 location.hash 解析视图名：'#/query' → 'query'；'#/query/abc' → 'query'；非法 → null */
export function parseHashView(hash: string): string | null {
  const m = /^#\/([A-Za-z0-9_-]+)/.exec(hash.trim());
  return m ? m[1].toLowerCase() : null;
}

/** 视图名转 hash：'query' → '#/query' */
export function formatViewHash(view: string): string {
  return `#/${view}`;
}

export interface UseHashViewOptions {
  /** 白名单校验：视图名是否合法（通常是菜单 key 集合） */
  isValid: (view: string) => boolean;
  /** 守卫：hash 驱动切换时是否允许（未登录/无权限 → false，保持当前视图） */
  guard?: (view: string) => boolean;
}

export function useHashView(
  currentView: Ref<string>,
  options: UseHashViewOptions,
): { syncHash: (view: string) => void; applyHashView: (normalizeInvalid?: boolean) => boolean } {
  const { isValid, guard } = options;

  // 外部 hash 变化（回退/前进/用户手改地址栏）→ 驱动 currentView
  // normalizeInvalid=false 时（初始挂载）不清除非法 hash，留给会话恢复后再应用
  function applyHashView(normalizeInvalid = true): boolean {
    const view = parseHashView(window.location.hash);
    if (view && isValid(view) && (!guard || guard(view))) {
      if (currentView.value !== view) currentView.value = view;
      return true;
    }
    if (normalizeInvalid) {
      const want = formatViewHash(currentView.value);
      if (window.location.hash !== want) {
        window.history.replaceState(null, '', want);
      }
    }
    return false;
  }

  // go() 权限通过后调用：写入历史条目（pushState 不触发 hashchange，回退由监听统一处理）
  function syncHash(view: string): void {
    const want = formatViewHash(view);
    if (window.location.hash !== want) {
      window.history.pushState(null, '', want);
    }
  }

  function onHashChange(): void {
    applyHashView();
  }

  onMounted(() => {
    window.addEventListener('hashchange', onHashChange);
    applyHashView(false);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('hashchange', onHashChange);
  });

  return { syncHash, applyHashView };
}

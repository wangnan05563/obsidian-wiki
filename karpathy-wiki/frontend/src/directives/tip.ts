// 全局按钮悬浮提示（tooltip）系统
// ------------------------------------------------------------------
// 设计目标（与需求对齐）：
//   1. 统一：所有交互按钮共用同一套浮层样式，不随按钮逐个漂移；
//   2. 及时：鼠标移入立即显示，移出即隐（带极短宽限避免闪烁）；
//   3. 不阻塞主线程 / 不影响操作：浮层 position:fixed + pointer-events:none，
//      仅用 CSS 过渡做淡入，不抢占点击、不拦截滚动；
//   4. 轻量：document 级事件委托 + 单例浮层，不为每个按钮单独挂载监听。
//
// 用法：
//   - 给任意元素加 `data-tip="说明文字"` 即可（推荐，语义清晰、兼容图标按钮/链接）；
//   - 也可使用 `v-tip="'说明文字'"` 指令（会自动写入 data-tip 并兜底注册监听）；
//   - 若元素同时有原生 `title`，会临时隐藏原生提示以避免双层 tooltip，
//     浮层隐藏后恢复。
import type { App, Directive } from 'vue';
import { computeTipPlacement } from './tipPosition';

// 定位基础：浮层始终挂 document.body 且 position:fixed → 相对视口定位。
// 因此触发元素祖先链上的 transform/filter/backdrop-filter/will-change 一律不影响浮层坐标，
// 无需（也不应）切换到 absolute。历史上曾为这些祖先换算 absolute 偏移，但浮层不是它们
// 的 DOM 后代，absolute 的实际包含块仍是视口，"相对玻璃卡的偏移被当视口坐标套用"导致严重错位。

const TIP_ATTR = 'data-tip';
const TITLE_STASH = 'data-tip-title-stash';

let layer: HTMLDivElement | null = null;
let currentEl: HTMLElement | null = null;
let hideTimer: number | null = null;

function ensureLayer(): HTMLDivElement {
  if (layer) return layer;
  const el = document.createElement('div');
  el.className = 'app-global-tip';
  el.setAttribute('role', 'tooltip');
  el.style.display = 'none';
  document.body.appendChild(el);
  layer = el;
  return el;
}

function getTipText(el: HTMLElement): string {
  const dt = el.getAttribute(TIP_ATTR);
  if (dt && dt.trim()) return dt.trim();
  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();
  // 不读 aria-label：aria-label 是无障碍语义标签，专供屏幕阅读器，不应触发自定义 tooltip 浮层。
  // 否则 App.vue 导航的 aria-label="主导航/主导航侧边栏/折叠态主导航" 等会误触发大量冗余浮层。
  return '';
}

// 定位基础：浮层（app-global-tip）始终挂 document.body 且 position:fixed → 相对视口定位。
// 因此触发元素祖先链上的 transform/filter/backdrop-filter/perspective/will-change 一律不影响
// 浮层坐标，无需（也不应）切换到 absolute。历史上曾为 glass-card 这类祖先换算 absolute 偏移，
// 但浮层不是它们的 DOM 后代，absolute 的实际包含块仍是视口——「相对玻璃卡的偏移被当视口
// 坐标套用」导致玻璃卡内按钮的 tooltip 严重错位。
function position(el: HTMLElement, text: string) {
  const tip = ensureLayer();
  tip.textContent = text;
  tip.style.display = 'block';
  // 布局尺寸（offsetWidth/offsetHeight）不受自身 transform/过渡影响，避免测量偏差
  const rect = el.getBoundingClientRect();
  const tipSize = { width: tip.offsetWidth, height: tip.offsetHeight };
  // fixed + 视口坐标：浮层挂 body，恒以视口为基准，无需换算玻璃卡等祖先偏移
  const placement = computeTipPlacement(
    rect,
    tipSize,
    { width: window.innerWidth, height: window.innerHeight },
  );
  tip.style.position = 'fixed';
  tip.style.top = `${placement.top}px`;
  tip.style.left = `${placement.left}px`;
}

function show(el: HTMLElement) {
  const text = getTipText(el);
  if (!text) return;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  // 抑制原生 title（避免与自定义浮层双层提示）
  const nativeTitle = el.getAttribute('title');
  if (nativeTitle && !el.getAttribute(TITLE_STASH)) {
    el.setAttribute(TITLE_STASH, nativeTitle);
    el.setAttribute('title', '');
  }
  currentEl = el;
  position(el, text);
  // 下一帧加 is-visible，触发 CSS 淡入；兼容无 requestAnimationFrame 的环境（如部分测试 DOM）
  const raf: (cb: () => void) => void =
    typeof requestAnimationFrame === 'function'
      ? (cb) => requestAnimationFrame(() => cb())
      : (cb) => window.setTimeout(cb, 0);
  raf(() => {
    if (layer) {
      // 二次定位：覆盖触发元素仍在动画/布局中（如侧栏展开、菜单过渡）导致首帧位置偏差的情况
      if (currentEl) position(currentEl, text);
      layer.classList.add('is-visible');
    }
  });
}

function hide() {
  if (hideTimer) return;
  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    if (layer) {
      layer.classList.remove('is-visible');
      layer.style.display = 'none';
    }
    if (currentEl) {
      const stash = currentEl.getAttribute(TITLE_STASH);
      if (stash !== null) {
        currentEl.setAttribute('title', stash);
        currentEl.removeAttribute(TITLE_STASH);
      }
      currentEl = null;
    }
  }, 80);
}

function onOver(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const el = target.closest<HTMLElement>(`[${TIP_ATTR}], [title]`);
  if (!el) return;
  if (getTipText(el)) show(el);
}

function onOut(e: MouseEvent) {
  const related = e.relatedTarget as Node | null;
  // 仍在同一个提示元素内部移动（例如按钮内的图标/文字子节点）时不隐藏
  if (currentEl && related && currentEl.contains(related)) return;
  hide();
}

function onScrollOrResize() {
  if (layer && layer.style.display !== 'none') hide();
}

function onClickAway() {
  hide();
}

let installed = false;
function ensureInstalled() {
  if (installed) return;
  installed = true;
  // 捕获阶段委托，确保浮层自身（pointer-events:none）不会干扰
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  document.addEventListener('click', onClickAway, true);
}

export const TipPlugin = {
  install(_app: App) {
    ensureInstalled();
  },
};

// 可选指令：v-tip="'说明'" 直接写入 data-tip，并兜底注册全局监听
export const vTip: Directive<HTMLElement, string> = {
  mounted(el, binding) {
    if (binding.value) el.setAttribute(TIP_ATTR, binding.value);
    ensureInstalled();
  },
  updated(el, binding) {
    if (binding.value) el.setAttribute(TIP_ATTR, binding.value);
    else el.removeAttribute(TIP_ATTR);
  },
  unmounted(el) {
    el.removeAttribute(TIP_ATTR);
  },
};

export default TipPlugin;

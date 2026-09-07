import { watch, onBeforeUnmount, type Ref } from 'vue';

/**
 * 聊天区自动贴底滚动（流式输出场景）
 *
 * 解决三类"自动下拉展示"失效：
 * ① 单次 nextTick 定位在异步内容（图片懒加载 / 代码渲染撑高）完成前就执行，
 *    导致贴底位置落后最终高度，用户看不到最新 token；
 * ② 用户上滑阅读时被强制拉回底部，体验割裂；
 * ③ 连续 token 涌入时，单次定位容易落后滚动节奏。
 *
 * 策略：
 * - nextTick + 双 requestAnimationFrame 双保险：等 Vue 完成 DOM 更新并浏览器绘制一帧后定位，
 *   捕获 markdown 渲染 / 图片占位等同步布局变化，真正贴到最终底部；
 * - 监听容器 scroll：用户离开底部阈值即暂停自动贴底，回到底部自动恢复（避免与用户争夺滚动位置）；
 * - 捕获阶段监听容器内 img load：图片异步加载撑高后补滚一次；
 * - 流式进行中且用户贴底时持续贴底；非流式时仅当用户已在底部才跟随（不强行打扰）。
 *
 * @param containerRef 聊天滚动容器（需设 ref）。对 FloatingChat 这类面板按需渲染的场景，
 *        通过 watch(ref, {immediate}) 在容器挂载/卸载时自动绑定/解绑监听。
 * @param isStreaming  返回当前是否处于流式生成中（用于决定是否"持续跟随"）。
 */
export function useChatAutoScroll(
  containerRef: Ref<HTMLElement | null>,
  isStreaming: () => boolean,
) {
  const NEAR_BOTTOM_PX = 80;
  let stickToBottom = true;
  let boundEl: HTMLElement | null = null;

  function nearBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  // 将容器滚动到底部。force=true 时忽略"用户上滑"暂停态（如新消息到达应始终展示）。
  function scrollToBottom(force = false): void {
    const el = containerRef.value;
    if (!el) return;
    // 仅三种情况贴底：强制 / 流式进行且用户贴底 / 用户当前已在底部（非流也可平滑跟随）
    if (force || (isStreaming() && stickToBottom) || nearBottom(el)) {
      // 双 rAF：等本次 DOM 更新并浏览器绘制一帧后再定位，确保捕获同步布局变化
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      });
    }
  }

  function onScroll(): void {
    const el = containerRef.value;
    if (!el) return;
    // 用户滚动后重新评估是否贴底：上滑超过阈值则暂停自动贴底，回到底部恢复
    stickToBottom = nearBottom(el);
  }

  // 图片异步加载（含 lazy）撑高容器后补滚一次
  function onMediaLoad(e: Event): void {
    const t = e.target as HTMLElement | null;
    if (t?.tagName === 'IMG') {
      scrollToBottom();
    }
  }

  function bind(el: HTMLElement): void {
    el.addEventListener('scroll', onScroll, { passive: true });
    // 捕获阶段：img 的 load 事件不冒泡，需在捕获阶段于容器层拦截
    el.addEventListener('load', onMediaLoad, true);
    boundEl = el;
  }

  function unbind(el: HTMLElement): void {
    el.removeEventListener('scroll', onScroll);
    el.removeEventListener('load', onMediaLoad, true);
    if (boundEl === el) boundEl = null;
  }

  // 容器可能按需挂载（如 FloatingChat 面板 v-if）：immediate 在 setup 即执行，
  // 容器出现/消失时自动绑定/解绑监听。
  watch(
    containerRef,
    (el, prev) => {
      if (prev) unbind(prev);
      if (el) bind(el);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    if (boundEl) unbind(boundEl);
  });

  return { scrollToBottom };
}

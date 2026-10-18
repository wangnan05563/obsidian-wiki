// T02461（PRD Q8）：配置中心子 tab 可点击直达。
// 写入一次性 sessionStorage 指令（Config.vue onMounted 消费切 tab），并广播 karpathy:navigate
// 由 App.vue 的 handleNavigateEvent 切到 config 视图。两步合并，保证「点一下直达对应配置页」。
export function openConfigTab(tab: string): void {
  try {
    sessionStorage.setItem(
      'karpathy:navigate-tab',
      JSON.stringify({ view: 'config', tab }),
    );
  } catch {
    // 隐私模式 / 写入失败：忽略，仍尝试跳转视图（保持默认 tab）
  }
  globalThis.dispatchEvent(
    new CustomEvent('karpathy:navigate', { detail: 'config' }),
  );
}

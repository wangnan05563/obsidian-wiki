// T02461（PRD Q8）：配置中心子 tab 可点击直达。
// openConfigTab 写入一次性 sessionStorage 指令并广播 karpathy:navigate(config)，
// 由 App.vue 切视图、Config.vue 读指令切 tab。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openConfigTab } from '../src/utils/nav';

describe('openConfigTab（T02461 Q8）', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('写入 sessionStorage tab 指令并广播 karpathy:navigate(config)', () => {
    const spy = vi.spyOn(globalThis, 'dispatchEvent');
    openConfigTab('ai');

    const raw = sessionStorage.getItem('karpathy:navigate-tab');
    expect(raw).toBeTruthy();
    const nav = JSON.parse(raw!) as { view: string; tab: string };
    expect(nav.view).toBe('config');
    expect(nav.tab).toBe('ai');

    expect(spy).toHaveBeenCalledTimes(1);
    const evt = spy.mock.calls[0][0] as CustomEvent<string>;
    expect(evt.type).toBe('karpathy:navigate');
    expect(evt.detail).toBe('config');
  });

  it('sessionStorage 不可用时仍广播跳转事件（不抛错）', () => {
    const spy = vi.spyOn(globalThis, 'dispatchEvent');
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => openConfigTab('ai')).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

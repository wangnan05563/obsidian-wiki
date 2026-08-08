// @vitest-environment node
// 验证消息输入框个人偏好按 userId 命名空间隔离存储与读取（需求：每个用户拥有独立、私有的
// 输入框设置——字体大小 / 主题 / 快捷回复 / 历史偏好 / 回车发送 / 紧凑模式，互不可见 / 互不干扰）。
// 复用 chatDb 的 preferences store，键名内嵌 userId：'usercfg::inputbox::<userId>'。
//
// 隔离策略：每条测试用例使用互不相同的 userId（namespace），因此即便 fake-indexeddb 因
// chatDb 持有未关闭连接导致 deleteDatabase 无法即时生效，也不会发生键碰撞导致的误判。
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Node 环境无 localStorage/sessionStorage，localVault 需要，提供内存实现（沿用 userConfig-isolation 测试）。
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as any).localStorage = new MemStorage();
(globalThis as any).sessionStorage = new MemStorage();

const userConfig = await import('../src/services/userConfig');
const { useInputBoxSettings } = await import('../src/stores/inputBoxSettings');

const ibA = {
  fontSize: 18,
  inputTheme: 'sepia' as const,
  quickReplies: ['你好', '介绍一下 Karpathy'],
  historyPreference: 'send' as const,
  enterSends: true,
  compact: true,
};
const ibB = {
  fontSize: 12,
  inputTheme: 'midnight' as const,
  quickReplies: ['帮帮我'],
  historyPreference: 'rely' as const,
  enterSends: false,
  compact: false,
};

describe('输入框偏好按用户隔离（服务层）', () => {
  it('不同用户相互独立、读取互不可见', async () => {
    await userConfig.saveInputBoxSettings('ibUserA', ibA);
    await userConfig.saveInputBoxSettings('ibUserB', ibB);

    const la = await userConfig.loadInputBoxSettings('ibUserA');
    const lb = await userConfig.loadInputBoxSettings('ibUserB');

    expect(la).toEqual(ibA);
    expect(lb).toEqual(ibB);
    expect(la.fontSize).toBe(18);
    expect(lb.fontSize).toBe(12);
    expect(la.quickReplies).not.toEqual(lb.quickReplies);
  });

  it('第三用户未配置 -> 仅见默认，绝不泄漏 A/B 的设置', async () => {
    await userConfig.saveInputBoxSettings('ibUserA', ibA);
    const lc = await userConfig.loadInputBoxSettings('ibUserC');
    expect(lc).toEqual(userConfig.DEFAULT_INPUT_BOX_SETTINGS);
    expect(lc.fontSize).toBe(14);
    expect(lc.enterSends).toBe(false);
    expect(lc.quickReplies).toEqual([]);
  });

  it('跨配置域隔离：inputbox 写入不影响同用户的 AI 命名空间', async () => {
    await userConfig.saveInputBoxSettings('ibCrossUserA', ibA);
    const ai = await userConfig.loadAiUserConfig('ibCrossUserA');
    expect(ai).toEqual(userConfig.DEFAULT_AI_USER_CONFIG);
  });

  it('更新某用户配置不影响另一用户', async () => {
    await userConfig.saveInputBoxSettings('ibUpdA', { ...userConfig.DEFAULT_INPUT_BOX_SETTINGS, fontSize: 14 });
    await userConfig.saveInputBoxSettings('ibUpdB', { ...userConfig.DEFAULT_INPUT_BOX_SETTINGS, fontSize: 16 });
    await userConfig.saveInputBoxSettings('ibUpdA', { ...userConfig.DEFAULT_INPUT_BOX_SETTINGS, fontSize: 20 });

    const la = await userConfig.loadInputBoxSettings('ibUpdA');
    const lb = await userConfig.loadInputBoxSettings('ibUpdB');
    expect(la.fontSize).toBe(20);
    expect(lb.fontSize).toBe(16);
  });

  it('返回对象为深拷贝：修改返回值不影响底层默认值与再次读取', async () => {
    const la = await userConfig.loadInputBoxSettings('ibCloneA');
    const la2 = await userConfig.loadInputBoxSettings('ibCloneA');
    la.quickReplies.push('MUTATED');
    expect(la2.quickReplies).toEqual([]); // 默认值未被污染
  });

  it('游客（空 userId）不持久化：写入被忽略，读取回退默认', async () => {
    await userConfig.saveInputBoxSettings('', ibA);
    const lg = await userConfig.loadInputBoxSettings('');
    expect(lg).toEqual(userConfig.DEFAULT_INPUT_BOX_SETTINGS);
  });
});

describe('输入框偏好 store（会话隔离行为）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('applyForUser 同步重置为默认，阻断上一账户设置残留', () => {
    const s = useInputBoxSettings();
    s.applyForUser('storeIbA');
    // 同步重置：即使异步加载尚未完成，UI 也立即回到默认，绝不沿用上一账户
    expect(s.userId).toBe('storeIbA');
    expect(s.settings.fontSize).toBe(14);
    expect(s.settings.enterSends).toBe(false);
  });

  it('update 按当前 userId 持久化，切换账户后互不覆盖', async () => {
    const s = useInputBoxSettings();
    s.applyForUser('storeIbA');
    await s.update({ fontSize: 20, enterSends: true });
    // 持久化应落到 storeIbA 命名空间
    const reloadedA = await userConfig.loadInputBoxSettings('storeIbA');
    expect(reloadedA.fontSize).toBe(20);
    expect(reloadedA.enterSends).toBe(true);

    // 切换到另一用户：同步重置，且加载其（无记录 -> 默认）
    s.applyForUser('storeIbB');
    expect(s.userId).toBe('storeIbB');
    expect(s.settings.fontSize).toBe(14); // 同步重置
    await new Promise((r) => setTimeout(r, 0)); // 等待异步加载完成
    expect(s.settings.fontSize).toBe(14);

    // storeIbA 的设置不被覆盖
    const aAgain = await userConfig.loadInputBoxSettings('storeIbA');
    expect(aAgain.fontSize).toBe(20);
  });

  it('resetToDefaults 恢复默认并持久化', async () => {
    const s = useInputBoxSettings();
    s.applyForUser('storeIbReset');
    await s.update({ fontSize: 22, compact: true });
    expect((await userConfig.loadInputBoxSettings('storeIbReset')).fontSize).toBe(22);
    await s.resetToDefaults();
    const reloaded = await userConfig.loadInputBoxSettings('storeIbReset');
    expect(reloaded).toEqual(userConfig.DEFAULT_INPUT_BOX_SETTINGS);
    expect(s.settings.fontSize).toBe(14);
    expect(s.settings.compact).toBe(false);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';

// 覆盖 FR-RM-07 本地密钥生命周期：内存驻留 + sessionStorage 镜像（同标签页刷新免密恢复）
// + 关闭标签页清空（须重新 unlock）。使用 vi.resetModules 模拟进程重启/刷新后模块内存归零，
// 而 sessionStorage / localStorage 作为浏览器存储仍保留，从而忠实复现刷新与关标签页两种场景。
const PW = 'Passw0rd!2026';

async function freshModule() {
  vi.resetModules();
  return (await import('../src/services/localVault')) as typeof import('../src/services/localVault');
}

describe('localVault 密钥生命周期（FR-RM-07）', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('初始未解锁：内存无密钥', async () => {
    const v = await freshModule();
    expect(v.isUnlocked()).toBe(false);
    expect(v.getKey()).toBeNull();
  });

  it('unlock 后内存密钥可用，并镜像到 sessionStorage', async () => {
    const v = await freshModule();
    await v.unlock(PW);
    expect(v.isUnlocked()).toBe(true);
    expect(v.getKey()).not.toBeNull();
    expect(sessionStorage.getItem('karpathy-wiki-local-key')).not.toBeNull();
  });

  it('lock 清除内存密钥与会话镜像', async () => {
    const v = await freshModule();
    await v.unlock(PW);
    expect(v.isUnlocked()).toBe(true);
    v.lock();
    expect(v.isUnlocked()).toBe(false);
    expect(v.getKey()).toBeNull();
    expect(sessionStorage.getItem('karpathy-wiki-local-key')).toBeNull();
  });

  it('同标签页刷新：sessionStorage 镜像可免密恢复（无需重新输入密码）', async () => {
    // 第一轮：登录解锁，写入 sessionStorage 镜像
    const v1 = await freshModule();
    await v1.unlock(PW);
    expect(sessionStorage.getItem('karpathy-wiki-local-key')).not.toBeNull();

    // 第二轮：模拟刷新（模块内存归零，但浏览器 sessionStorage 保留）
    const v2 = await freshModule();
    expect(v2.isUnlocked()).toBe(false); // 刷新后内存为空
    const restored = await v2.restoreKeyFromSession();
    expect(restored).toBe(true);
    expect(v2.isUnlocked()).toBe(true);
    expect(v2.getKey()).not.toBeNull();
  });

  it('关闭标签页（sessionStorage 清空）后无法免密恢复，必须重新 unlock', async () => {
    const v1 = await freshModule();
    await v1.unlock(PW);

    // 模拟关闭标签页：sessionStorage 随标签页销毁
    sessionStorage.clear();
    const v2 = await freshModule();
    const restored = await v2.restoreKeyFromSession();
    expect(restored).toBe(false);
    expect(v2.isUnlocked()).toBe(false);

    // 必须重新输入密码 unlock 才能解密本地数据
    await v2.unlock(PW);
    expect(v2.isUnlocked()).toBe(true);
  });
});

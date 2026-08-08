// @vitest-environment node
// 验证 AI 服务 / 搜索引擎 / 工具 三类用户配置均按 userId 命名空间隔离存储与读取
// （需求：各用户仅能访问自身配置，互不可见 / 互不干扰；软件升级或重装不影响本地配置）。
// 复用 chatDb 的 preferences store，键名内嵌 userId：'usercfg::<kind>::<userId>'。
//
// 隔离策略：每条测试用例使用互不相同的 userId（namespace），因此即便 fake-indexeddb 因
// chatDb 持有未关闭连接导致 deleteDatabase 无法即时生效，也不会发生键碰撞导致的误判。
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

// Node 环境无 localStorage/sessionStorage，localVault 需要，提供内存实现（沿用 ttsConfig-isolation 测试）。
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

const aiA = { provider: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4', apiKey: 'KEY_A' };
const aiB = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'KEY_B' };
const searchA = { provider: 'tavily' as const, apiKey: 'WS_A', maxResults: 5 };
const searchB = { provider: 'bing' as const, apiKey: 'WS_B', maxResults: 10 };
const toolsA = { mcpServers: [{ id: 'a1' }], cliTools: [], scenes: [], routerMode: 'keyword' as const };
const toolsB = { mcpServers: [], cliTools: [{ name: 'bcli' }], scenes: [], routerMode: 'auto' as const };

describe('用户配置（AI/搜索/工具）按用户隔离', () => {
  it('AI 配置：不同用户相互独立、读取互不可见', async () => {
    await userConfig.saveAiUserConfig('aiUserA', aiA);
    await userConfig.saveAiUserConfig('aiUserB', aiB);

    const la = await userConfig.loadAiUserConfig('aiUserA');
    const lb = await userConfig.loadAiUserConfig('aiUserB');

    expect(la).toEqual(aiA);
    expect(lb).toEqual(aiB);
    expect(la.apiKey).toBe('KEY_A');
    expect(lb.apiKey).toBe('KEY_B');
    expect(la.apiKey).not.toBe(lb.apiKey);

    // 第三用户未配置 -> 仅见默认，绝不泄漏 A/B 的密钥
    const lc = await userConfig.loadAiUserConfig('aiUserC');
    expect(lc).toEqual(userConfig.DEFAULT_AI_USER_CONFIG);
    expect(lc.apiKey).toBe('');
  });

  it('搜索配置：不同用户相互独立、读取互不可见', async () => {
    await userConfig.saveSearchUserConfig('srUserA', searchA);
    await userConfig.saveSearchUserConfig('srUserB', searchB);

    const la = await userConfig.loadSearchUserConfig('srUserA');
    const lb = await userConfig.loadSearchUserConfig('srUserB');

    expect(la).toEqual(searchA);
    expect(lb).toEqual(searchB);
    expect(la.apiKey).toBe('WS_A');
    expect(lb.apiKey).toBe('WS_B');

    const lc = await userConfig.loadSearchUserConfig('srUserC');
    expect(lc).toEqual(userConfig.DEFAULT_SEARCH_USER_CONFIG);
    expect(lc.apiKey).toBe('');
  });

  it('工具配置：不同用户相互独立、读取互不可见', async () => {
    await userConfig.saveToolsUserConfig('tlUserA', toolsA);
    await userConfig.saveToolsUserConfig('tlUserB', toolsB);

    const la = await userConfig.loadToolsUserConfig('tlUserA');
    const lb = await userConfig.loadToolsUserConfig('tlUserB');

    expect(la).toEqual(toolsA);
    expect(lb).toEqual(toolsB);
    expect(la.routerMode).toBe('keyword');
    expect(lb.routerMode).toBe('auto');

    const lc = await userConfig.loadToolsUserConfig('tlUserC');
    expect(lc).toEqual(userConfig.DEFAULT_TOOLS_USER_CONFIG);
  });

  it('跨配置域隔离：AI 写入不影响同用户的搜索/工具命名空间', async () => {
    await userConfig.saveAiUserConfig('crossUserA', aiA);
    // 同用户未写搜索/工具 -> 仍是默认，不被 AI 写入污染
    const sa = await userConfig.loadSearchUserConfig('crossUserA');
    const ta = await userConfig.loadToolsUserConfig('crossUserA');
    expect(sa).toEqual(userConfig.DEFAULT_SEARCH_USER_CONFIG);
    expect(ta).toEqual(userConfig.DEFAULT_TOOLS_USER_CONFIG);
  });

  it('更新某用户配置不影响另一用户', async () => {
    await userConfig.saveAiUserConfig('updUserA', { ...userConfig.DEFAULT_AI_USER_CONFIG, apiKey: 'OLD_A' });
    await userConfig.saveAiUserConfig('updUserB', { ...userConfig.DEFAULT_AI_USER_CONFIG, apiKey: 'OLD_B' });
    // 仅改 updUserA
    await userConfig.saveAiUserConfig('updUserA', { ...userConfig.DEFAULT_AI_USER_CONFIG, apiKey: 'NEW_A' });

    const la = await userConfig.loadAiUserConfig('updUserA');
    const lb = await userConfig.loadAiUserConfig('updUserB');
    expect(la.apiKey).toBe('NEW_A');
    expect(lb.apiKey).toBe('OLD_B');
  });

  it('游客命名空间隔离：guest 与已登录用户互不干扰', async () => {
    await userConfig.saveAiUserConfig('guest', { ...userConfig.DEFAULT_AI_USER_CONFIG, apiKey: 'GUEST_KEY' });
    await userConfig.saveAiUserConfig('guestUserA', aiA);
    const lg = await userConfig.loadAiUserConfig('guest');
    const la = await userConfig.loadAiUserConfig('guestUserA');
    expect(lg.apiKey).toBe('GUEST_KEY');
    expect(la.apiKey).toBe('KEY_A');
    expect(lg.apiKey).not.toBe(la.apiKey);
  });

  it('返回对象为深拷贝：修改返回值不影响底层默认值与再次读取', async () => {
    const la = await userConfig.loadAiUserConfig('cloneUserA');
    const la2 = await userConfig.loadAiUserConfig('cloneUserA');
    la.apiKey = 'MUTATED';
    expect(la2.apiKey).toBe(userConfig.DEFAULT_AI_USER_CONFIG.apiKey); // 默认值未被污染
  });
});

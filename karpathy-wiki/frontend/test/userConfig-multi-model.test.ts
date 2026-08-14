// @vitest-environment node
// 验证「多模型（按 LLM 预设）配置」的存储与读取：每个预设独立保存各自的
// provider/baseUrl/model/apiKey，切换预设互不干扰、各自正确返显。
// 这是修复「切换模型 API Key 不跟随当前模型变化返显」的核心回归测试。
//
// 隔离策略：每条用例使用互不相同的 userId，避免 fake-indexeddb 键碰撞误判。
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

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
const { dbPut, CHAT_STORES } = await import('../src/services/chatDb');

const openaiCfg = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'KEY_OPENAI' };
const glmCfg = { provider: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4', apiKey: 'KEY_GLM' };

describe('多模型（按预设）配置：独立持久化与返显', () => {
  it('不同预设各自保存，互不被覆盖（修复切换模型 API Key 错乱）', async () => {
    const uid = 'mmUserA';
    await userConfig.saveAiUserConfigForPreset(uid, 'openai', openaiCfg);
    await userConfig.saveAiUserConfigForPreset(uid, 'glm', glmCfg);

    const fromOpenai = await userConfig.loadAiUserConfigForPreset(uid, 'openai');
    const fromGlm = await userConfig.loadAiUserConfigForPreset(uid, 'glm');

    expect(fromOpenai.apiKey).toBe('KEY_OPENAI');
    expect(fromOpenai.model).toBe('gpt-4o');
    expect(fromGlm.apiKey).toBe('KEY_GLM');
    expect(fromGlm.model).toBe('glm-4');
  });

  it('保存后切换预设再读回，原预设配置保持不变', async () => {
    const uid = 'mmUserB';
    await userConfig.saveAiUserConfigForPreset(uid, 'openai', openaiCfg);
    // 模拟「切换模型」：保存另一个预设
    await userConfig.saveAiUserConfigForPreset(uid, 'glm', glmCfg);
    // 再切回 openai，API Key 应跟随该模型返显，而非错乱为 glm 的
    const back = await userConfig.loadAiUserConfigForPreset(uid, 'openai');
    expect(back.apiKey).toBe('KEY_OPENAI');
  });

  it('未单独保存的预设回退兼容槽，再回退默认值', async () => {
    const uid = 'mmUserC';
    // 仅保存兼容槽（旧版单份 / 移动端未分预设）
    await userConfig.saveAiUserConfigForPreset(uid, undefined, openaiCfg);
    // 查询某个具体预设（无独立槽位）→ 应回退兼容槽
    const viaPreset = await userConfig.loadAiUserConfigForPreset(uid, 'deepseek');
    expect(viaPreset.apiKey).toBe('KEY_OPENAI');

    // 完全无配置的用户 → 默认值
    const fresh = await userConfig.loadAiUserConfigForPreset('mmUserFresh', 'openai');
    expect(fresh.apiKey).toBe('');
    expect(fresh.provider).toBe(userConfig.DEFAULT_AI_USER_CONFIG.provider);
  });

  it('清空映射表（恢复初始配置）会移除所有预设槽位', async () => {
    const uid = 'mmUserD';
    await userConfig.saveAiUserConfigForPreset(uid, 'openai', openaiCfg);
    await userConfig.saveAiUserConfigForPreset(uid, 'glm', glmCfg);
    await userConfig.saveAiUserConfigMap(uid, {});
    const after = await userConfig.loadAiUserConfigForPreset(uid, 'openai');
    expect(after.apiKey).toBe('');
  });

  it('旧版扁平配置自动迁移到兼容槽并可被按预设读取', async () => {
    const uid = 'mmUserLegacy';
    const flat = { provider: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4', apiKey: 'KEY_LEGACY' };
    // 直接写入旧版扁平结构，模拟升级前的数据
    await dbPut(CHAT_STORES.preferences, { key: `usercfg::ai::${uid}`, ...flat });

    const migrated = await userConfig.loadAiUserConfigForPreset(uid, 'openai');
    expect(migrated.apiKey).toBe('KEY_LEGACY');

    // 迁移后磁盘应变为映射表（含兼容槽），不再是扁平结构
    const map = await userConfig.loadAiUserConfigMap(uid);
    expect(map['__legacy__'].apiKey).toBe('KEY_LEGACY');
    expect((map as any).provider).toBeUndefined();
  });

  it('预设槽位为空且传入模板：模型跟随预设，厂商不一致时 apiKey 置空（修复切换模型不生效）', async () => {
    const uid = 'mmUserTpl';
    // 仅有 glm 的 legacy 配置（模拟迁移前单厂商用户）
    await userConfig.saveAiUserConfigForPreset(uid, undefined, glmCfg);
    const openaiPreset = {
      key: 'openai', label: 'OpenAI', provider: 'openai',
      baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
      apiKeyRef: 'OPENAI_API_KEY', apiKeyUrl: '', vision: false,
    } as any;
    const r = await userConfig.loadAiUserConfigForPreset(uid, 'openai', openaiPreset);
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('gpt-4o-mini'); // 模型跟随模板，而非 legacy 的 glm-4
    expect(r.apiKey).toBe(''); // 厂商不一致，不沿用 glm 的 key
  });

  it('预设槽位为空但厂商一致：沿用 legacy 的 apiKey（兼容老用户单厂商配置）', async () => {
    const uid = 'mmUserSame';
    await userConfig.saveAiUserConfigForPreset(uid, undefined, glmCfg);
    const glmPreset = {
      key: 'glm', label: 'GLM', provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
      apiKeyRef: 'GLM_KEY', apiKeyUrl: '', vision: true,
    } as any;
    const r = await userConfig.loadAiUserConfigForPreset(uid, 'glm', glmPreset);
    expect(r.provider).toBe('glm');
    expect(r.model).toBe('glm-4-flash'); // 模板 model 优先
    expect(r.apiKey).toBe('KEY_GLM'); // 同厂商沿用 legacy key
  });
});

// 配置生效登记表单测（T02467 / PRD §10 C1 / REQ-032）
// 登记表是「即时 / 热加载 / 需重启」的唯一可信源：路由响应、前端徽标、页顶待重启清单都由它派生，
// 所以这里锁住它的内部一致性与派生函数口径，防止后续加字段时悄悄写回硬编码数组。
import { describe, it, expect } from 'vitest';
import {
  CONFIG_EFFECT_ITEMS,
  changedRestartKeys,
  configPathOf,
  findEffectItem,
  restartHints,
  restartKeys,
  restartKeysForChange,
  valueChangedForConfigKey,
} from '../src/utils/config-effects.js';

describe('config-effects 登记表一致性', () => {
  it('key 不重复（前端与待重启清单都按 key 建索引）', () => {
    const keys = CONFIG_EFFECT_ITEMS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每条都有中文 label 与 reason（面向用户的文案，不出现裸技术词）', () => {
    for (const item of CONFIG_EFFECT_ITEMS) {
      expect(item.label).toMatch(/[一-龥]/);
      expect(item.reason.length).toBeGreaterThan(8);
      // label 是给用户看的，不能是 config.json 的点分路径
      expect(item.label).not.toMatch(/\./);
    }
  });

  it('需重启的字段手改文件也必须标需重启（restart ⇒ viaFile=restart）', () => {
    for (const item of CONFIG_EFFECT_ITEMS) {
      if (item.effect === 'restart') expect(item.viaFile).toBe('restart');
    }
  });

  it('restartKeys 与登记表逐项对应，且不含即时生效字段', () => {
    expect(restartKeys()).toEqual(
      CONFIG_EFFECT_ITEMS.filter((i) => i.effect === 'restart').map((i) => i.key),
    );
    expect(restartKeys()).not.toContain('budget.maxSteps');
    expect(restartKeys()).toContain('server.port');
  });

  it('tab 取值必须落在前端 configTabs 的 tab 名集合内', () => {
    const TABS = ['schema', 'config', 'migrate', 'mcp', 'ai', 'sharedAi', 'tts', 'tools', 'theme', 'qq', 'prompts'];
    for (const item of CONFIG_EFFECT_ITEMS) expect(TABS).toContain(item.tab);
  });
});

describe('派生函数', () => {
  it('restartKeysForChange 只认映射到需重启 key 的字段，且去重', () => {
    const map = { maxFileSizeMb: 'multipart.fileSize', allowedExtensions: 'batch.allowedExtensions' };
    expect(restartKeysForChange(['maxFileSizeMb', 'allowedExtensions'], map)).toEqual(['multipart.fileSize']);
    expect(restartKeysForChange(['maxFileSizeMb', 'maxFileSizeMb'], map)).toEqual(['multipart.fileSize']);
    // 未声明映射的字段（新加请求体字段忘了登记）→ 不提示，也不报错
    expect(restartKeysForChange(['unknownField'], map)).toEqual([]);
  });

  it('restartHints 按 key 给出可读条目，未知 key 直接跳过', () => {
    const hints = restartHints(['vaultPath', '不存在的key']);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ key: 'vaultPath', label: 'Vault 路径' });
    expect(hints[0].reason).toContain('重启');
  });

  it('configPathOf 让登记名与存储路径解耦', () => {
    expect(configPathOf('multipart.fileSize')).toBe('batch.maxFileSizeMb');
    expect(configPathOf('logging.level')).toBe('logging.level');
    expect(configPathOf('没有这个key')).toBeUndefined();
  });

  describe('valueChangedForConfigKey', () => {
    const cfg = { batch: { maxFileSizeMb: 10 }, logging: { level: 'info' } };
    it('值相同→未改；值不同→已改（按存储路径 batch.maxFileSizeMb 比对）', () => {
      expect(valueChangedForConfigKey(cfg, 'multipart.fileSize', 10)).toBe(false);
      expect(valueChangedForConfigKey(cfg, 'multipart.fileSize', 4)).toBe(true);
      expect(valueChangedForConfigKey(cfg, 'logging.level', 'info')).toBe(false);
      expect(valueChangedForConfigKey(cfg, 'logging.level', 'debug')).toBe(true);
    });

    it('读不到旧配置时保守视为已改（宁可多提示一次重启）', () => {
      expect(valueChangedForConfigKey(null, 'logging.level', 'info')).toBe(true);
      expect(valueChangedForConfigKey(undefined, 'logging.level', 'info')).toBe(true);
    });
  });

  describe('changedRestartKeys', () => {
    it('只列出实际被覆盖的需重启字段（即时字段即使改了也不出现）', () => {
      const before = { adapter: 'harness', vaultPath: 'C:/a', server: { host: 'localhost', port: 3000 }, logging: { level: 'info' }, budget: { maxSteps: 20 } };
      const after = { adapter: 'harness', vaultPath: 'D:/b', server: { host: 'localhost', port: 3000 }, logging: { level: 'debug' }, budget: { maxSteps: 8 } };
      expect(changedRestartKeys(before, after)).toEqual(['vaultPath', 'logging.level']);
    });

    it('任一侧读不到时返回全部需重启 key，不谎报「不用重启」', () => {
      expect(changedRestartKeys(null, { adapter: 'harness' })).toEqual(restartKeys());
      expect(changedRestartKeys({ adapter: 'harness' }, undefined)).toEqual(restartKeys());
    });

    it('完全相同的两份配置返回空数组', () => {
      const cfg = { adapter: 'harness', server: { port: 3000 } };
      expect(changedRestartKeys(cfg, cfg)).toEqual([]);
    });
  });
});

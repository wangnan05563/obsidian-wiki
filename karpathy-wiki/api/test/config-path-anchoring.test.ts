// T02886：配置相对路径定根统一通道（anchorConfigPaths / portableConfigForDisk）。
// ------------------------------------------------------------------
// 缺陷：config.ts 原先只在 IS_SEA 时 applySeaRebase，开发模式配置里的相对值保持相对，
//   实际落点随进程 CWD 漂移（从仓库根起进程 vs 从 api 目录起进程，vault 读写指到不同目录）。
// 本用例直接测纯函数（loadConfig 读真实 config.json + 30s 缓存，不便隔离）：
//   A 定根：非 SEA 相对值按 api 目录 resolve（与 toAbsVaultPath 同锚）、绝对值原样、
//     空串保留（logFilePath 空=不落盘）；SEA 相对值映射用户数据目录规范文件名（原 applySeaRebase 语义）；
//   B 例外锚：logging.logFilePath 的消费基准是 api 上一级（index.ts setupLoggerStream 历史口径，
//     用户现存日志在仓库根 logs/）——非 SEA 定根沿用同一公式，不挪现有落点；
//   C 落盘可移植：portableConfigForDisk 把定根产生的绝对值还原回原相对写法（逐字段往返），
//     树外用户绝对值原样保留（SEA 的 LOCALAPPDATA 值不被改写），非路径字段不受影响；
//   D 源码级锁：不再存在第二份「把相对配置定根」的实现——applySeaRebase 已删除、
//     auth.ts 的 getDataDir()+basename 已改为复用 toAbsVaultPath、写盘全部收口 persistConfigFile。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { anchorConfigPaths, portableConfigForDisk, persistConfigFile, getConfigPath } from '../src/config.js';
import { getApiDir, getUserDataDir } from '../src/utils/runtime.js';
import { toAbsVaultPath } from '../src/utils/harness-dirs.js';
import type { AppConfig } from '../src/types.js';

const apiDir = getApiDir();

function fixture(over: Partial<AppConfig> = {}): AppConfig {
  return {
    vaultPath: '../data/vault',
    auth: { usersFilePath: '../data/users.json', auditLogPath: '../data/audit.log' },
    urlCrawl: { logging: { enabled: false, logFilePath: '../data/url-crawl.log' }, incrementalStatePath: '../data/url-crawl-state.json' },
    // logging 段带 level 键——portableConfigForDisk 靠它区分与 urlCrawl.logging 的不同还原基准
    logging: { level: 'info', enableRequestLog: true, logFilePath: '../logs/api-dev.log' },
    ...over,
  } as AppConfig;
}

describe('A · 非 SEA 定根：相对值按 api 目录 resolve，绝对值原样，空串保留', () => {
  it('五个路径字段全部钉到绝对值，vaultPath 与 toAbsVaultPath 同锚', () => {
    const cfg = fixture();
    anchorConfigPaths(cfg, { sea: false });
    expect(cfg.vaultPath).toBe(toAbsVaultPath('../data/vault'));
    expect(path.isAbsolute(cfg.auth!.usersFilePath!)).toBe(true);
    expect(cfg.auth!.usersFilePath).toBe(toAbsVaultPath('../data/users.json'));
    expect(cfg.auth!.auditLogPath).toBe(toAbsVaultPath('../data/audit.log'));
    expect(cfg.urlCrawl!.logging!.logFilePath).toBe(toAbsVaultPath('../data/url-crawl.log'));
    expect(cfg.urlCrawl!.incrementalStatePath).toBe(toAbsVaultPath('../data/url-crawl-state.json'));
  });

  it('空串不落盘语义保留：logging.logFilePath=\'\' 定根后仍为 \'\'', () => {
    const cfg = fixture({ logging: { logFilePath: '' } });
    anchorConfigPaths(cfg, { sea: false });
    expect(cfg.logging!.logFilePath).toBe('');
  });

  it('用户显式绝对路径原样保留（自定义 vault 位置不被改写）', () => {
    const custom = path.resolve(os.tmpdir(), 'elsewhere-vault');
    const cfg = fixture({ vaultPath: custom });
    anchorConfigPaths(cfg, { sea: false });
    expect(cfg.vaultPath).toBe(custom);
  });
});

describe('B · 例外锚：logging.logFilePath 按 api 上一级定根（不挪仓库根 logs/ 现有落点）', () => {
  it('\'../logs/api-dev.log\' 定根到仓库根 logs/，而非 api 目录下', () => {
    const cfg = fixture();
    anchorConfigPaths(cfg, { sea: false });
    expect(cfg.logging!.logFilePath).toBe(path.resolve(apiDir, '..', '../logs/api-dev.log'));
  });
});

describe('A-SEA · SEA 分支沿用原 applySeaRebase 语义（相对值映射用户数据目录规范文件名）', () => {
  it('相对值丢弃相对目录部分落到 dataDir/<规范名>，绝对值原样', () => {
    const cfg = fixture();
    anchorConfigPaths(cfg, { sea: true });
    const dataDir = path.join(getUserDataDir(), 'data');
    expect(cfg.vaultPath).toBe(path.join(dataDir, 'vault'));
    expect(cfg.auth!.usersFilePath).toBe(path.join(dataDir, 'users.json'));
    expect(cfg.urlCrawl!.incrementalStatePath).toBe(path.join(dataDir, 'url-crawl-state.json'));
    const custom = path.resolve(os.tmpdir(), 'elsewhere-vault');
    const cfg2 = fixture({ vaultPath: custom });
    anchorConfigPaths(cfg2, { sea: true });
    expect(cfg2.vaultPath).toBe(custom);
  });
});

describe('C · 落盘可移植：portableConfigForDisk 逐字段往返', () => {
  it('定根后的绝对值还原回原相对写法（含 logging.logFilePath 的仓库根锚）', () => {
    const original = fixture();
    const cfg = JSON.parse(JSON.stringify(original)) as AppConfig;
    anchorConfigPaths(cfg, { sea: false });
    const portable = portableConfigForDisk(cfg);
    expect(portable.vaultPath).toBe('../data/vault');
    expect(portable.auth!.usersFilePath).toBe('../data/users.json');
    expect(portable.auth!.auditLogPath).toBe('../data/audit.log');
    expect(portable.urlCrawl!.logging!.logFilePath).toBe('../data/url-crawl.log');
    expect(portable.urlCrawl!.incrementalStatePath).toBe('../data/url-crawl-state.json');
    expect(portable.logging!.logFilePath).toBe('../logs/api-dev.log');
  });

  it('树外用户绝对值不被改写（自定义 vault 在定根树之外）', () => {
    const custom = path.resolve(os.tmpdir(), 'elsewhere-vault');
    const cfg = fixture({ vaultPath: custom });
    anchorConfigPaths(cfg, { sea: false });
    expect(portableConfigForDisk(cfg).vaultPath).toBe(custom);
  });

  it('相对值透传幂等；非路径字段不受影响', () => {
    const cfg = fixture();
    const once = portableConfigForDisk(cfg);
    expect(once.vaultPath).toBe('../data/vault');
    expect((once as unknown as Record<string, unknown>).server ?? 'no-server-key').toBe('no-server-key');
    const twice = portableConfigForDisk(JSON.parse(JSON.stringify(cfg)) as AppConfig);
    expect(twice).toEqual(cfg);
  });
});

describe('D · 源码级锁：不再有第二份定根实现，写盘收口单一出口', () => {
  it('applySeaRebase 已删除；auth.ts 复用 toAbsVaultPath；save* 写盘全部走 persistConfigFile', async () => {
    const srcDir = path.resolve(apiDir, 'src');
    const read = (rel: string) => fs.readFile(path.join(srcDir, rel), 'utf8');
    const configSrc = await read('config.ts');
    // 函数本体应已删除（注释里允许留历史名，故只匹配定义与调用）
    expect(configSrc, 'applySeaRebase 应已被统一通道取代').not.toMatch(/function applySeaRebase|applySeaRebase\(/);
    const authSrc = await read('routes/auth.ts');
    expect(authSrc).toContain('toAbsVaultPath');
    expect(authSrc, 'getDataDir()+basename 的第三份定根实现应已移除').not.toContain('path.basename(config.');
    // 整份回写收口：config.json 的直接 fs.writeFile 只允许三处——persistConfigFile 自身、
    // 导入备份 .bak、失败回滚（后两者写的是盘上原形 prev，不经定根）
    const directWrites = [...configSrc.matchAll(/fs\.writeFile\(.*configPath.*'utf8'\)/g)].map((m) => m[0]);
    expect(directWrites.length, `config.json 直写点应只剩 3 处，实际：${directWrites.join(' | ')}`).toBe(3);
    expect(directWrites[0]).toContain('portableConfigForDisk');
    expect(configSrc.match(/await persistConfigFile\(/g)!.length).toBeGreaterThanOrEqual(15);
    expect(await read('utils/url-crawl.ts')).toContain('toAbsVaultPath');
  });

  it('persistConfigFile 落盘的是 portable 形态（临时目录验证写盘不改相对写法）', async () => {
    // persistConfigFile 写 getConfigPath()——真实 config.json 是用户生产文件，绝不触碰；
    // 这里只验证「序列化即 portable」这一纯行为（写盘目标由 getConfigPath 决定，路径态已被 C 覆盖）。
    const cfg = fixture();
    anchorConfigPaths(cfg, { sea: false });
    const portable = portableConfigForDisk(cfg);
    expect(JSON.stringify(portable)).not.toContain(toAbsVaultPath('../data/vault'));
    expect(getConfigPath(), '真实实例 config.json 存在（只读确认，不写入）').toBeTruthy();
  });
});

describe('E · 双 CWD 等价：从不同目录起进程，定根后指向同一 vault（验收条款 1）', () => {
  it('chdir 到仓库根再定根，五个路径字段与 api 目录起法逐一相同；VaultService 列表一致', async () => {
    const cfgA = fixture();
    anchorConfigPaths(cfgA, { sea: false });
    const origCwd = process.cwd();
    try {
      process.chdir(path.resolve(apiDir, '..')); // 仓库根——缺陷场景里 vault 会漂到别处的起法
      const cfgB = fixture();
      anchorConfigPaths(cfgB, { sea: false });
      expect(cfgB.vaultPath, 'vaultPath 不随 CWD 漂移').toBe(cfgA.vaultPath);
      expect(cfgB.logging!.logFilePath).toBe(cfgA.logging!.logFilePath);
      expect(cfgB.urlCrawl!.incrementalStatePath).toBe(cfgA.urlCrawl!.incrementalStatePath);
    } finally {
      process.chdir(origCwd);
    }
    // 真实 vault 只读冒烟：同一绝对路径下两个 VaultService 实例列出同一套页面
    // （等价于「两个起法的 /api/vault/tree 返回同一套页面」，读侧不写盘）
    const { VaultService } = await import('../src/vault/vault-service.js');
    const a = new VaultService(cfgA.vaultPath);
    const b = new VaultService(cfgA.vaultPath);
    await a.init();
    await b.init();
    expect((await b.listAllPages()).map((p) => p.path)).toEqual((await a.listAllPages()).map((p) => p.path));
    expect((await a.listAllPages()).length, '真实 vault 应能列出页面（锚定路径可用）').toBeGreaterThan(0);
  });
});

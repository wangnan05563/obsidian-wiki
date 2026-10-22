// SSRF 防护 + 代理探针校验回归测试。
// 覆盖：① checkSSRF 私网/保留/链路本地/IPv6 网段拦截（不再被 catch 吞掉）；
//       ② probeProxyEgress 在爬取前对目标 URL 做 SSRF 校验，命中即返回 error 且 reachable=false（路由据此中止）。
// IP 字面量分支不依赖网络；域名分支统一打桩 DNS（见下），保证测试确定性。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 为什么要打桩 DNS：真实解析结果随部署环境而变——企业内网 DNS 常把公网域名 sinkhole 到
// 0.0.0.0（本机实测 example.com → 0.0.0.0），此时「公网域名应放行」用例会因拦截逻辑
// 判 0.0.0.0 为保留地址而失败。打桩后两个分支都能确定性覆盖，且额外补上
// 「域名解析到私网地址必须拦截」这条 DNS-rebinding/sinkhole 场景（此前无覆盖）。
const dnsMock = vi.hoisted(() => ({
  resolve4: vi.fn<[string], Promise<string[]>>(async () => ['93.184.216.34']),
  resolve6: vi.fn<[string], Promise<string[]>>(async () => []),
}));

vi.mock('node:dns', () => ({ promises: dnsMock }));

import { checkSSRF, probeProxyEgress } from '../src/utils/url-crawl.js';

describe('checkSSRF 私网/保留网段拦截（修复后真正生效）', () => {
  beforeEach(() => {
    // 默认：域名解析到一个公网 IPv4，无 IPv6
    dnsMock.resolve4.mockReset().mockResolvedValue(['93.184.216.34']);
    dnsMock.resolve6.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  const blocked = [
    'http://127.0.0.1/x',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/', // 云元数据（链路本地）
    'http://100.64.0.1/', // CGNAT
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[::ffff:127.0.0.1]/', // IPv4 映射，应递归判内嵌 v4
  ];

  for (const url of blocked) {
    it(`拦截 ${url}`, async () => {
      await expect(checkSSRF(url)).rejects.toThrow(/SSRF blocked/);
    });
  }

  const allowed = [
    'http://93.184.216.34/', // 公网 IPv4 字面量（非私网段）
    'http://public.test/', // 域名：DNS 解析到公网地址 → 放行
  ];
  for (const url of allowed) {
    it(`放行 ${url}`, async () => {
      // 不抛即视为放行
      await expect(checkSSRF(url)).resolves.toBeUndefined();
    });
  }

  it('域名解析到保留地址 0.0.0.0（DNS sinkhole）时必须拦截', async () => {
    dnsMock.resolve4.mockResolvedValue(['0.0.0.0']);
    await expect(checkSSRF('http://sinkhole.test/')).rejects.toThrow(/SSRF blocked/);
  });

  it('域名解析到云元数据地址（DNS rebinding）时必须拦截', async () => {
    dnsMock.resolve4.mockResolvedValue(['169.254.169.254']);
    await expect(checkSSRF('http://rebind.test/latest/meta-data/')).rejects.toThrow(/SSRF blocked/);
  });

  it('任一 AAAA 记录落在私网段时同样拦截（双栈混排不能被绕过）', async () => {
    dnsMock.resolve4.mockResolvedValue(['93.184.216.34']);
    dnsMock.resolve6.mockResolvedValue(['::1']);
    await expect(checkSSRF('http://mixed.test/')).rejects.toThrow(/SSRF blocked/);
  });

  it('DNS 解析失败时静默放行（保持「解析不了交给 fetch 决定」的既有行为）', async () => {
    dnsMock.resolve4.mockRejectedValue(new Error('ENOTFOUND'));
    dnsMock.resolve6.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(checkSSRF('http://nxdomain.test/')).resolves.toBeUndefined();
  });
});

describe('probeProxyEgress 爬取前 SSRF 校验', () => {
  it('目标为内网/元数据地址时返回 error 且 reachable=false（路由据此中止，不开盲 SSRF 窗口）', async () => {
    const r = await probeProxyEgress(
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:9', // 合法 http 代理地址（代理本身是否可达不影响 SSRF 先拦）
      3000,
    );
    expect(r.level).toBe('error');
    expect(r.reachable).toBe(false);
    expect(r.message).toMatch(/SSRF/);
  });

  it('目标为 127.0.0.1 回环地址时被 SSRF 拦截', async () => {
    const r = await probeProxyEgress('http://127.0.0.1:3000/', 'http://127.0.0.1:9', 3000);
    expect(r.level).toBe('error');
    expect(r.message).toMatch(/SSRF/);
  });
});

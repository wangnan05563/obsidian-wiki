// SSRF 防护 + 代理探针校验回归测试。
// 覆盖：① checkSSRF 私网/保留/链路本地/IPv6 网段拦截（不再被 catch 吞掉）；
//       ② probeProxyEgress 在爬取前对目标 URL 做 SSRF 校验，命中即返回 error 且 reachable=false（路由据此中止）。
// 均使用 IP 字面量，避免 DNS/网络不确定性，测试确定性。
import { describe, it, expect } from 'vitest';
import { checkSSRF, probeProxyEgress } from '../src/utils/url-crawl.js';

describe('checkSSRF 私网/保留网段拦截（修复后真正生效）', () => {
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
    'http://example.com/', // 域名：DNS 解析失败放行，命中私网才拦；此处不抛
  ];
  for (const url of allowed) {
    it(`放行 ${url}`, async () => {
      // 不抛即视为放行（域名可能因无网络解析失败而放行，符合预期行为）
      await expect(checkSSRF(url)).resolves.toBeUndefined();
    });
  }
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

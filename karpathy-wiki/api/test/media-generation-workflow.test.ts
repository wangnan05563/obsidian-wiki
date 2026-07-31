import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// fetchWithDiagnostics 单元测试
// 为什么单独测试：该函数负责把 Node 原生 fetch 的 "fetch failed" 翻译为可读诊断信息，
// 是用户排查网络问题的主要线索。若错误转换逻辑回归，用户将再次看到 "fetch failed" 无法定位问题。
// 为什么 mock global.fetch：真实网络调用不可靠（依赖外部服务可达性），单元测试需确定性。

import { fetchWithDiagnostics } from '../src/workflows/media-generation-workflow.js';

// 构造一个模拟 fetch 失败的错误对象，模拟 undici 的 TypeError("fetch failed") + cause 结构
function makeFetchFailedError(code: string, message?: string): TypeError {
  const err = new TypeError('fetch failed') as TypeError & { cause?: { code?: string; message?: string } };
  err.cause = { code, message: message ?? code };
  return err;
}

describe('fetchWithDiagnostics', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // 恢复 global.fetch，避免影响其他测试
    global.fetch = originalFetch;
  });

  it('成功时直接返回 response', async () => {
    const mockResp = new Response('{"ok":1}', { status: 200 });
    global.fetch = vi.fn().mockResolvedValue(mockResp);

    const resp = await fetchWithDiagnostics('https://example.com/api', { method: 'GET' });
    expect(resp).toBe(mockResp);
    expect(resp.status).toBe(200);
  });

  it('连接超时（UND_ERR_CONNECT_TIMEOUT）转换为可读提示', async () => {
    global.fetch = vi.fn().mockRejectedValue(makeFetchFailedError('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'));

    // 同一错误同时包含可读提示与原始 code，便于用户排查和开发者定位
    await expect(
      fetchWithDiagnostics('https://apihub.agnes-ai.com/v1/images/generations', { method: 'POST' }),
    ).rejects.toThrow(/网络连接超时.*UND_ERR_CONNECT_TIMEOUT|UND_ERR_CONNECT_TIMEOUT.*网络连接超时/);
  });

  it('DNS 解析失败（ENOTFOUND）转换为可读提示', async () => {
    global.fetch = vi.fn().mockRejectedValue(makeFetchFailedError('ENOTFOUND'));

    await expect(
      fetchWithDiagnostics('https://api.example.com/x', { method: 'GET' }),
    ).rejects.toThrow(/域名解析失败/);
  });

  it('连接被拒绝（ECONNREFUSED）转换为可读提示', async () => {
    global.fetch = vi.fn().mockRejectedValue(makeFetchFailedError('ECONNREFUSED'));

    await expect(
      fetchWithDiagnostics('http://localhost:9999/x', { method: 'GET' }),
    ).rejects.toThrow(/连接被拒绝/);
  });

  it('TLS 证书过期（CERT_HAS_EXPIRED）转换为可读提示', async () => {
    global.fetch = vi.fn().mockRejectedValue(makeFetchFailedError('CERT_HAS_EXPIRED'));

    await expect(
      fetchWithDiagnostics('https://expired.badssl.com/x', { method: 'GET' }),
    ).rejects.toThrow(/TLS 证书校验失败/);
  });

  it('请求中止（UND_ERR_ABORTED）转换为可读提示', async () => {
    global.fetch = vi.fn().mockRejectedValue(makeFetchFailedError('UND_ERR_ABORTED'));

    await expect(
      fetchWithDiagnostics('https://example.com/x', { method: 'GET' }),
    ).rejects.toThrow(/请求超时或被中止/);
  });

  it('未知错误码时回退到 cause.message', async () => {
    global.fetch = vi.fn().mockRejectedValue(makeFetchFailedError('EAI_AGAIN', 'temporary DNS failure'));

    await expect(
      fetchWithDiagnostics('https://example.com/x', { method: 'GET' }),
    ).rejects.toThrow(/temporary DNS failure/);
  });

  it('错误消息包含请求的 URL 便于定位', async () => {
    global.fetch = vi.fn().mockRejectedValue(makeFetchFailedError('ECONNRESET'));

    await expect(
      fetchWithDiagnostics('https://api.example.com/specific/path', { method: 'POST' }),
    ).rejects.toThrow(/api\.example\.com\/specific\/path/);
  });
});

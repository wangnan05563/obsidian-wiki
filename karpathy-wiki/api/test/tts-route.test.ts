import { describe, it, expect, vi, beforeAll } from 'vitest';
import Fastify from 'fastify';

// TTS 路由测试：用 vi.mock 替换 edgeTtsClient（避免真实 WebSocket 到微软）
// 与 audioPostprocess（避免 ffmpeg 依赖），使路由测试不依赖网络与外部二进制。
//
// 验证重点：
//   - 输入校验（缺 text / 空白 / 超长 / 非法 voice）→ 400
//   - 合法请求 → 200 audio/mpeg 二进制流
//   - GET /api/tts/voices 返回音色列表

const FAKE_MP3 = Buffer.from([0xff, 0xf3, 0x00, 0x00]);

vi.mock('../src/utils/edgeTtsClient.js', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/edgeTtsClient.js')>(
    '../src/utils/edgeTtsClient.js',
  );
  return {
    ...actual,
    synthesizeEdgeTts: vi.fn(async () => FAKE_MP3),
  };
});

vi.mock('../src/utils/audioPostprocess.js', () => ({
  applyAudioPostprocess: vi.fn(async (buf: Buffer) => buf),
}));

import { registerTtsRoute } from '../src/routes/tts.js';
import { synthesizeEdgeTts } from '../src/utils/edgeTtsClient.js';

async function buildApp() {
  const app = Fastify();
  registerTtsRoute(app);
  await app.ready();
  return app;
}

describe('TTS 路由：输入校验（400）', () => {
  let app: ReturnType<typeof Fastify>;
  beforeAll(async () => {
    app = await buildApp();
  });

  it('缺少 text 字段 → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'Content-Type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('空白 text（trim 后为空）→ 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'Content-Type': 'application/json' },
      payload: { text: '    ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('文本超长（>5000 字）→ 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'Content-Type': 'application/json' },
      payload: { text: 'x'.repeat(5001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('非法 voice 格式（不符合 ^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$）→ 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'Content-Type': 'application/json' },
      payload: { text: '你好', voice: 'not-a-voice' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('合法 voice 但 text 为空 → 400（先判空，再判 voice）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'Content-Type': 'application/json' },
      payload: { text: '', voice: 'zh-CN-XiaoxiaoNeural' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('非法 rate（含双引号注入 SSML 属性）→ 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'Content-Type': 'application/json' },
      payload: { text: '你好', rate: '"><voice name="evil">' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('非法 volume（非百分比格式）→ 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'Content-Type': 'application/json' },
      payload: { text: '你好', volume: 'loud' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('非法 pitch（非 Hz 格式）→ 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'Content-Type': 'application/json' },
      payload: { text: '你好', pitch: '+5st' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('合法 rate/volume/pitch（+10%/-5%/+3Hz）→ 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'Content-Type': 'application/json' },
      payload: { text: '你好', rate: '+10%', volume: '-5%', pitch: '+3Hz' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('TTS 路由：合成成功（200）/ 音色列表', () => {
  let app: ReturnType<typeof Fastify>;
  beforeAll(async () => {
    app = await buildApp();
  });

  it('合法请求返回 audio/mpeg 二进制流', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'Content-Type': 'application/json' },
      payload: { text: '你好世界', voice: 'zh-CN-XiaoxiaoNeural' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(Buffer.isBuffer(res.rawPayload) || res.rawPayload instanceof Uint8Array).toBe(true);
    expect((res.rawPayload as Buffer).length).toBe(FAKE_MP3.length);
    // 前端按 magic 字节识别 MP3：0xFF 0xF3
    expect((res.rawPayload as Buffer)[0]).toBe(0xff);
    expect((res.rawPayload as Buffer)[1]).toBe(0xf3);
  });

  it('GET /api/tts/voices 返回音色列表', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tts/voices' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { voices: unknown[] };
    expect(Array.isArray(body.voices)).toBe(true);
    expect(body.voices.length).toBe(10);
  });
});

describe('TTS 路由：合成失败（502）', () => {
  it('synthesizeEdgeTts 抛错时返回 502 + error 信息', async () => {
    const app = await buildApp();
    vi.mocked(synthesizeEdgeTts).mockRejectedValueOnce(new Error('WebSocket 连接失败'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'Content-Type': 'application/json' },
      payload: { text: '你好', voice: 'zh-CN-XiaoxiaoNeural' },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json() as { error: string };
    expect(body.error).toContain('语音合成失败');
    expect(body.error).toContain('WebSocket 连接失败');
  });
});

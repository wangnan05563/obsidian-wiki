import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { synthesizeEdgeTts, getEdgeTtsVoices, type EdgeTtsParams } from '../utils/edgeTtsClient.js';
import { applyAudioPostprocess } from '../utils/audioPostprocess.js';

// 注册 TTS 路由：基于微软 Edge 神经网络语音的文本朗读服务。
//
//   POST /api/tts/synthesize  合成文本为 MP3 音频（返回二进制流）
//   GET  /api/tts/voices       获取可用音色列表
//
// 设计动机：
//   - 浏览器原生 Web Speech API 中文音色机械，用户体验差
//   - Edge TTS 提供与 Azure 同源的神经网络音色，免费、无 API Key、音质自然
//   - 参考 20_News 项目的 Python edge-tts 方案，后端用 Node 22 内置 WebSocket 实现
//
// 安全约束：
//   - 文本长度上限 5000 字（防止 WebSocket 帧过大）
//   - 音色名白名单校验（防止注入恶意 SSML）
//   - 请求体大小上限 10KB（文本本身不大，防止滥用）
const ALLOWED_VOICE_PATTERN = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;

// prosody 属性格式校验：rate/volume 为 [+-]N%，pitch 为 [+-]NHz。
// 为什么需要：rate/volume/pitch 被直接插入 SSML <prosody> 属性值，若不加校验，
// 攻击者可发送 rate='"><voice name="evil">' 注入任意 SSML 标签（属性注入）。
// 限制为纯数值百分比/Hz 格式即可杜绝注入（与 buildSSML 的文本转义形成纵深防御）。
const PROSODY_RATE_PATTERN = /^[+-]\d{1,3}%$/;
const PROSODY_PITCH_PATTERN = /^[+-]\d{1,3}Hz$/;

// 说话风格白名单（Edge TTS neural 专属，提升拟人度）。
// 仅放行已知安全的风格名；未知/不支持的风格由后端合成时自动降级为标准朗读。
const ALLOWED_STYLES = new Set<string>([
  'general',          // 标准（不使用 express-as）
  'narration-relaxed', // 轻松讲述（知识朗读首选）
  'chat',             // 闲聊
  'newscast',         // 新闻播报
  'newscast-casual',  // 轻松新闻播报
  'empathetic',       // 亲切
  'cheerful',         // 开心
  'calm',             // 平静
  'gentle',           // 温柔
  'serious',          // 严肃
  'lyrical',          // 抒情
  'poetic',           // 诗意
  'affectionate',     // 亲昵
  'sad',              // 悲伤
  'angry',            // 生气
  'fearful',          // 恐惧
  'whisper',          // 耳语
]);

export function registerTtsRoute(app: FastifyInstance) {
  // 合成文本为 MP3 音频
  app.post('/api/tts/synthesize', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Partial<EdgeTtsParams> | undefined;

    if (!body?.text || typeof body.text !== 'string') {
      return void reply.code(400).send({ error: '请求体须包含 text 字段（字符串）' });
    }

    const text = body.text.trim();
    if (!text) {
      return void reply.code(400).send({ error: 'text 不能为空' });
    }
    if (text.length > 5000) {
      return void reply.code(400).send({ error: `文本过长（${text.length} 字），上限 5000 字` });
    }

    // 音色白名单校验
    const voice = body.voice ?? 'zh-CN-XiaoxiaoNeural';
    if (!ALLOWED_VOICE_PATTERN.test(voice)) {
      return void reply.code(400).send({ error: `音色名格式不合法: ${voice}` });
    }

    // 语速/音量/音调格式校验（SSML prosody 属性）
    const rate = body.rate ?? '+0%';
    const volume = body.volume ?? '+0%';
    const pitch = body.pitch ?? '+0Hz';
    if (!PROSODY_RATE_PATTERN.test(rate)) {
      return void reply.code(400).send({ error: `rate 格式不合法（须为 [+-]N%）：${rate}` });
    }
    if (!PROSODY_RATE_PATTERN.test(volume)) {
      return void reply.code(400).send({ error: `volume 格式不合法（须为 [+-]N%）：${volume}` });
    }
    if (!PROSODY_PITCH_PATTERN.test(pitch)) {
      return void reply.code(400).send({ error: `pitch 格式不合法（须为 [+-]NHz）：${pitch}` });
    }

    // 说话风格白名单校验（仅作安全过滤；本环境 Edge 端点不支持 express-as，
    // 实际拟人化由前端 prosody 预设 + 后端 FFmpeg 响度归一化实现）
    const rawStyle = typeof body.style === 'string' ? body.style.trim() : '';
    const style = rawStyle && ALLOWED_STYLES.has(rawStyle) ? rawStyle : undefined;
    let styledegree: number | undefined;
    if (typeof body.styledegree === 'number' && body.styledegree >= 0.01 && body.styledegree <= 2) {
      styledegree = body.styledegree;
    }

    try {
      // 合成（prosody 调节 + 可选 FFmpeg 后处理；后端绝不 502 退化）
      let audioBuffer = await synthesizeEdgeTts({ text, voice, rate, volume, pitch, style, styledegree });
      // 可选音频后处理（响度归一化 + 去首尾静音）；ffmpeg 不可用时自动跳过
      audioBuffer = await applyAudioPostprocess(audioBuffer);

      // 直接返回 MP3 二进制流，前端用 blob → audio.src 播放
      reply.header('Content-Type', 'audio/mpeg');
      reply.header('Content-Length', audioBuffer.length);
      // 缓存控制：合成结果确定性强（同文本同参数同音色 → 同音频），允许浏览器缓存
      reply.header('Cache-Control', 'private, max-age=3600');
      return void reply.send(audioBuffer);
    } catch (err: unknown) {
      request.log.error({ err, voice, textLen: text.length }, 'Edge TTS synthesis failed');
      const message = err instanceof Error ? err.message : String(err);
      reply.code(502).send({ error: `语音合成失败: ${message}` });
    }
  });

  // 获取可用音色列表（静态返回，无需网络请求）
  app.get('/api/tts/voices', async (_request: FastifyRequest, reply: FastifyReply) => {
    return void reply.send({ voices: getEdgeTtsVoices() });
  });
}

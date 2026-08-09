// Edge TTS 客户端：基于 undici WebSocket 调用微软 Edge Read Aloud 服务。
//
// 设计动机：
//   - 浏览器原生 Web Speech API 中文音色机械、不自然，用户体验差
//   - 微软 Edge TTS 提供与 Azure 神经网络音色同源的免费 TTS（无 API Key、无字符上限）
//   - 参考 D:\code\otherProjects\20_News 的 Python edge-tts 方案，用 undici WebSocket 实现
//   - 为什么用 undici 而非 Node 22 内置 WebSocket：内置 WebSocket 不支持自定义 headers，
//     Edge TTS 服务需要 User-Agent / Origin headers；undici 已是项目直接依赖
//
// 协议要点：
//   1. 生成 Sec-MS-GEC 令牌：SHA-256(windows_ticks + TRUSTED_CLIENT_TOKEN)
//   2. WebSocket 连接 wss://speech.platform.bing.com/.../edge/v1
//   3. 发送 speech.config 配置消息（指定输出格式）
//   4. 发送 SSML 合成请求（指定音色、语速、音量、音调）
//   5. 接收二进制帧：Path:audio 后为 MP3 数据，Path:turn.end 表示合成完成
//
// 约束：
//   - 单次合成文本上限 5000 字（超出由上层分段）
//   - WebSocket 连接为短连接：每次合成创建新连接，合成完毕即关闭
//   - 仅支持 MP3 输出格式（Edge TTS 限制）

import { WebSocket } from 'undici';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const JSON_XML_DELIM = '\r\n\r\n';
const AUDIO_DELIM = 'Path:audio\r\n';

/**
 * 单次合成超时（毫秒）。可通过环境变量 EDGE_TTS_TIMEOUT_MS 覆盖（评审 S4 / BR-ASYNC-01）。
 * 默认 30s：Edge TTS 单次合成通常 < 5s，30s 已留足网络抖动余量。
 */
const EDGE_TTS_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.EDGE_TTS_TIMEOUT_MS ?? 30_000) || 30_000,
);

/** 预置中文音色列表（供前端选择） */
export const EDGE_TTS_VOICES = [
  { shortName: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女声·温婉自然）', gender: 'Female', locale: 'zh-CN' },
  { shortName: 'zh-CN-YunyangNeural', name: '云扬（男声·新闻播报）', gender: 'Male', locale: 'zh-CN' },
  { shortName: 'zh-CN-XiaoyiNeural', name: '晓伊（女声·温柔甜美）', gender: 'Female', locale: 'zh-CN' },
  { shortName: 'zh-CN-YunxiNeural', name: '云希（男声·沉稳大气）', gender: 'Male', locale: 'zh-CN' },
  { shortName: 'zh-CN-XiaochenNeural', name: '晓辰（女声·知性成熟）', gender: 'Female', locale: 'zh-CN' },
  { shortName: 'zh-CN-YunfengNeural', name: '云枫（男声·磁性低沉）', gender: 'Male', locale: 'zh-CN' },
  { shortName: 'zh-CN-XiaohanNeural', name: '晓涵（女声·亲和温暖）', gender: 'Female', locale: 'zh-CN' },
  { shortName: 'zh-CN-YunhaoNeural', name: '云皓（男声·清亮活力）', gender: 'Male', locale: 'zh-CN' },
  { shortName: 'zh-CN-XiaomengNeural', name: '晓梦（女声·少女清新）', gender: 'Female', locale: 'zh-CN' },
  { shortName: 'zh-CN-YunzeNeural', name: '云泽（男声·儒雅成熟）', gender: 'Male', locale: 'zh-CN' },
] as const;

/** TTS 合成参数 */
export interface EdgeTtsParams {
  /** 待合成文本（<= 5000 字） */
  text: string;
  /** 音色短名（如 zh-CN-XiaoxiaoNeural），默认 zh-CN-XiaoxiaoNeural */
  voice?: string;
  /** 语速："+10%" / "-10%" 等 SSML 格式，默认 "+0%" */
  rate?: string;
  /** 音量："+20%" / "-10%" 等 SSML 格式，默认 "+0%" */
  volume?: string;
  /** 音调："+5Hz" / "-3Hz" 等 SSML 格式，默认 "+0Hz" */
  pitch?: string;
  /**
   * 说话风格（保留字段，前端 prosody 预设映射用）。
   * 注意：微软 Edge 免费 TTS 端点（edge/v1）实测不支持 <mstts:express-as> 说话风格
   *（WebSocket 关闭 code=1007 reason="SSML is invalid"），故 buildSSML 不再使用该字段。
   * 路由层仍做白名单校验供前端 API 前向兼容，但该值不会被写入 SSML。
   */
  style?: string;
  /** 风格强度 0.01-2.0，默认 1.0；随 style 保留，当前不消费（express-as 已弃用） */
  styledegree?: number;
}

/** 生成 Sec-MS-GEC 令牌（Edge TTS 鉴权） */
export async function generateSecMsGec(): Promise<string> {
  const ticks = Math.floor(Date.now() / 1000) + 11644473600;
  const rounded = ticks - (ticks % 300);
  const windowsTicks = rounded * 10000000;
  const data = new TextEncoder().encode(`${windowsTicks}${TRUSTED_CLIENT_TOKEN}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** 生成随机 ConnectionId（十六进制） */
function generateConnectionId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 构建 SSML 请求体
 * 仅使用 prosody（语速/音量/音调）调节——这是微软 Edge 免费 TTS 端点（edge/v1）实际支持的
 * 拟人化手段（参考 20_News 的 edge-tts 方案：prosody + FFmpeg 后处理）。
 *
 * 注：<mstts:express-as> 说话风格在本环境实测被该端点拒绝
 * （WebSocket 关闭 code=1007 reason="SSML is invalid"），官方 edge-tts 库亦未实现该标签，
 * 故不采用。拟人度通过 (1) 优质 neural 音色 + (2) prosody 微调 + (3) FFmpeg 响度归一化 三层叠加实现。
 */
export function buildSSML(
  text: string,
  voice: string,
  rate: string,
  volume: string,
  pitch: string,
): string {
  const locale = voice.match(/\w{2}-\w{2}/)?.[0] ?? 'zh-CN';
  const safe = text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c);
  const prosody = `    <prosody rate="${rate}" volume="${volume}" pitch="${pitch}">
      ${safe}
    </prosody>`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">
  <voice name="${voice}">
${prosody}
  </voice>
</speak>`.trim();
}

/**
 * 合成文本为 MP3 音频二进制数据。
 *
 * 使用 Node 22 内置 WebSocket 连接 Edge TTS 服务，流式收集音频块后返回完整 MP3。
 * 每次调用创建新 WebSocket 连接，合成完毕即关闭。
 *
 * @throws Error 文本为空/过长、WebSocket 连接失败、合成超时
 */
/** 单次合成（WebSocket 短连接）。 */
function doSynthesize(args: {
  wsUrl: string;
  text: string;
  voice: string;
  rate: string;
  volume: string;
  pitch: string;
}): Promise<Buffer> {
  const { wsUrl, text, voice, rate, volume, pitch } = args;
  return new Promise<Buffer>((resolve, reject) => {
    const audioChunks: Buffer[] = [];
    let settled = false;

    // 超时保护：EDGE_TTS_TIMEOUT_MS 毫秒未完成则拒绝（默认 30s，可配置）
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch { /* 超时后关闭 ws 失败可忽略 */ }
        reject(new Error(`Edge TTS 合成超时（${EDGE_TTS_TIMEOUT_MS}ms）`));
      }
    }, EDGE_TTS_TIMEOUT_MS);

    const ws = new WebSocket(wsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      },
    });

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // 1. 发送配置消息
      const configMsg = `Content-Type:application/json; charset=utf-8\r\nPath:speech.config${JSON_XML_DELIM}` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: 'false',
                  wordBoundaryEnabled: 'false',
                },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        });
      ws.send(configMsg);

      // 2. 发送 SSML 合成请求（prosody 调节语速/音量/音调）
      const requestId = generateConnectionId();
      const ssml = buildSSML(text, voice, rate, volume, pitch);
      const ssmlMsg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml${JSON_XML_DELIM}${ssml}`;
      ws.send(ssmlMsg);
    };

    // 处理 turn.end 消息：合成完成，关闭连接并返回结果
    const handleTurnEnd = (): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        try { ws.close(); } catch { /* 合成完成后关闭 ws 失败可忽略 */ }
        if (audioChunks.length === 0) {
          reject(new Error('Edge TTS 未返回音频数据（可能文本被过滤或音色无效）'));
        } else {
          resolve(Buffer.concat(audioChunks));
        }
      }
    };

    // 处理音频数据消息：提取音频块并收集
    const handleAudioData = (buffer: Buffer): void => {
      const delimIndex = buffer.indexOf(AUDIO_DELIM);
      if (delimIndex >= 0) {
        const audioData = buffer.subarray(delimIndex + AUDIO_DELIM.length);
        if (audioData.length > 0) {
          audioChunks.push(audioData);
        }
      }
    };

    ws.onmessage = (event) => {
      const buffer = Buffer.from(event.data as ArrayBuffer);
      const messageStr = buffer.subarray(0, Math.min(buffer.length, 200)).toString('utf8');

      if (messageStr.includes('Path:turn.end')) {
        handleTurnEnd();
        return;
      }
      if (messageStr.includes('Path:audio')) {
        handleAudioData(buffer);
      }
    };

    ws.onerror = (event: Event) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        // undici 的 WebSocket error 事件可能携带 .error / .data / .message，统一提取可读信息
        const anyEvent = event as unknown as { error?: unknown; data?: unknown; message?: string };
        const errData = anyEvent.error ?? anyEvent.data ?? anyEvent;
        const msg =
          (typeof errData === 'object' && errData !== null
            ? (errData as { message?: string; cause?: { message?: string } }).message ??
              (errData as { cause?: { message?: string } }).cause?.message
            : undefined) ?? anyEvent.message ?? '未知错误（WebSocket 握手/连接失败）';
        reject(new Error(`Edge TTS WebSocket 错误: ${msg}`));
      }
    };

    ws.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        if (audioChunks.length > 0) {
          resolve(Buffer.concat(audioChunks));
        } else {
          reject(new Error('Edge TTS 连接关闭但未收到音频数据'));
        }
      }
    };
  });
}

export async function synthesizeEdgeTts(params: EdgeTtsParams): Promise<Buffer> {
  const {
    text,
    voice = 'zh-CN-XiaoxiaoNeural',
    rate = '+0%',
    volume = '+0%',
    pitch = '+0Hz',
  } = params;

  if (!text.trim()) {
    throw new Error('Edge TTS 合成文本为空');
  }
  if (text.length > 5000) {
    throw new Error(`Edge TTS 单次合成文本过长: ${text.length} > 5000`);
  }

  const secMsGec = await generateSecMsGec();
  const connectionId = generateConnectionId();
  const wsUrl = `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId=${connectionId}`;

  return await doSynthesize({ wsUrl, text, voice, rate, volume, pitch });
}

/**
 * 获取可用音色列表。
 * 静态返回预置列表，避免每次请求都调 API。
 */
export function getEdgeTtsVoices() {
  return EDGE_TTS_VOICES;
}

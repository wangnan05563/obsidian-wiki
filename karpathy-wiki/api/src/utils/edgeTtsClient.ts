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
// 长连接复用（延迟优化核心）：
//   - 历史实现每次合成新建 WebSocket（短连接），国内网络连接境外 Edge 服务需 TLS 握手
//     + 建连，实测单段朗读延迟可达 7~19s，是"点击朗读很久才出声"的根因。
//   - 现改为维护单个可复用长连接：同一连接连续多次合成，省去每次握手；合成请求串行
//     执行（一次一个，用 requestId 区分 turn），避免帧交叉。
//   - 断线/超时/失败时主动关闭连接，下次合成自动重建（最多重试 1 次）。
//   - 空闲回收：长时间无请求（默认 2 分钟）主动关闭，避免常驻耗尽服务端连接配额。
//
// 约束：
//   - 单次合成文本上限 5000 字（超出由上层分段）
//   - 复用连接仍一次合成一次（串行），不并发发送多个 SSML
//   - 仅支持 MP3 输出格式（Edge TTS 限制）

import { WebSocket, type MessageEvent } from 'undici';

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

/** 长连接空闲回收阈值（毫秒）。无请求超过该时长则主动关闭连接，释放资源、规避服务端踢连。 */
const EDGE_CONNECTION_IDLE_MS = Math.max(
  10_000,
  Number(process.env.EDGE_TTS_CONNECTION_IDLE_MS ?? 120_000) || 120_000,
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

/** 生成随机 RequestId / ConnectionId（十六进制） */
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

// ===== 长连接管理（延迟优化） =====
// 全局持有单个 WebSocket，跨多次合成复用；串行执行避免帧交叉。
// sharedConn 仅存 open 的连接：readyState 非 OPEN 时视为失效，由 getConnection 重建。

let sharedConn: WebSocket | null = null;
let connecting: Promise<WebSocket> | null = null;
/** 串行队列尾指针：用 promise 链保证同一时刻只有一个合成请求持有连接 */
let queueTail: Promise<unknown> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 重置空闲回收计时：合成开始/结束时调用，延长连接存活时间 */
function resetIdleClock(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { closeSharedConnection(); }, EDGE_CONNECTION_IDLE_MS);
}

/** 关闭并清理共享连接（幂等）。合成失败/超时/空闲回收时调用，让下次合成重建新连。 */
function closeSharedConnection(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const ws = sharedConn;
  sharedConn = null;
  if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
    try { ws.close(1000, 'close'); } catch { /* 关闭失败可忽略 */ }
  }
}

/** 构建连接 URL（含鉴权令牌与固定 ConnectionId；长连接复用同一 ConnectionId） */
async function buildWsUrl(): Promise<string> {
  const secMsGec = await generateSecMsGec();
  const connectionId = generateConnectionId();
  return `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId=${connectionId}`;
}

/**
 * 惰性获取共享连接。若已有 open 连接直接复用；否则新建。
 * connecting 信号防并发重复握手，返回同一新建连接。
 */
function getConnection(): Promise<WebSocket> {
  if (sharedConn && sharedConn.readyState === WebSocket.OPEN) {
    return Promise.resolve(sharedConn);
  }
  if (connecting) return connecting;

  connecting = createConnectionWithConfig();
  const p = connecting;
  // 无论成败都清空 connecting 信号，允许下次重建
  void p.then(
    () => { if (connecting === p) connecting = null; },
    () => { if (connecting === p) connecting = null; },
  );
  return p;
}

/** 建立连接并发送初始化 speech.config 消息（连接建立即完成配置，后续复用无需重复发送） */
async function createConnectionWithConfig(): Promise<WebSocket> {
  const wsUrl = await buildWsUrl();
  const ws = new WebSocket(wsUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    },
  });
  ws.binaryType = 'arraybuffer';

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* 握手超时关闭可忽略 */ }
      reject(new Error('Edge TTS 连接建立超时'));
    }, EDGE_TTS_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(timer);
      // 首次建连发送配置消息；该消息与合成无关且不会再有 turn.end，
      // 之后的合成仅需发 SSML。断开重连时 createConnectionWithConfig 会再次发送。
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
      try { ws.send(configMsg); } catch (e) { reject(e as Error); return; }
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Edge TTS WebSocket 连接错误'));
    };
  });

  // 共享连接的全局错误/关闭兜底：连接意外终止时清理引用，让后续合成能重建。
  // （单次合成期间的事件由 synthesizeOnce 暂存接管，此处仅处理"游离"时的异常）
  ws.onclose = () => {
    if (sharedConn === ws) sharedConn = null;
  };

  sharedConn = ws;
  return ws;
}

/**
 * 在给定连接上完成一次合成：发送带新 requestId 的 SSML，按 turn.end 收集音频。
 * 串行模式下同一连接同时只有一个本调用在执行，事件 handler 可安全接管。
 */
function synthesizeOnce(ws: WebSocket, opts: {
  text: string; voice: string; rate: string; volume: string; pitch: string;
}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const requestId = generateConnectionId();
    const audioChunks: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        detach();
        // 连接可能已异常/挂起，主动关闭以便下次重建
        closeSharedConnection();
        reject(new Error(`Edge TTS 合成超时（${EDGE_TTS_TIMEOUT_MS}ms）`));
      }
    }, EDGE_TTS_TIMEOUT_MS);

    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      detach();
      if (err) reject(err);
      else if (audioChunks.length === 0) reject(new Error('Edge TTS 未返回音频数据（可能文本被过滤或音色无效）'));
      else resolve(Buffer.concat(audioChunks));
    };

    const onMessage = (event: MessageEvent): void => {
      const buffer = Buffer.from(event.data as ArrayBuffer);
      const head = buffer.subarray(0, Math.min(buffer.length, 200)).toString('utf8');
      if (head.includes('Path:turn.end')) {
        done();
        return;
      }
      if (head.includes('Path:audio')) {
        const idx = buffer.indexOf(AUDIO_DELIM);
        if (idx >= 0) {
          const data = buffer.subarray(idx + AUDIO_DELIM.length);
          if (data.length > 0) audioChunks.push(data);
        }
      }
    };
    const onClose = (): void => done(new Error('Edge TTS 连接意外关闭'));
    const onError = (): void => done(new Error('Edge TTS 连接错误'));

    function attach(): void {
      ws.onmessage = onMessage;
      ws.onclose = onClose;
      ws.onerror = onError;
    }
    function detach(): void {
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
    }

    attach();
    const ssml = buildSSML(opts.text, opts.voice, opts.rate, opts.volume, opts.pitch);
    const msg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml${JSON_XML_DELIM}${ssml}`;
    try { ws.send(msg); } catch (e) { done(e instanceof Error ? e : new Error(String(e))); }
  });
}

/** 在共享连接上执行一次合成；失败时关闭连接并重建重试一次 */
async function synthesizeOnShared(opts: {
  text: string; voice: string; rate: string; volume: string; pitch: string;
}): Promise<Buffer> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let ws: WebSocket;
    try {
      ws = await getConnection();
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      await sleep(300);
      continue;
    }
    resetIdleClock();
    try {
      const buf = await synthesizeOnce(ws, opts);
      resetIdleClock();
      return buf;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      // 本次合成失败：连接可能已不可用，关闭后下一轮重建
      closeSharedConnection();
      await sleep(300);
    }
  }
  throw lastErr ?? new Error('Edge TTS 合成失败');
}

/**
 * 合成文本为 MP3 音频二进制数据（对外入口）。
 *
 * 通过共享长连接串行执行；失败时重建连接重试一次。
 * 空闲超时后连接会被自动关闭，下次调用再惰性重建（对本接口无感）。
 *
 * @throws Error 文本为空/过长、连接失败、合成超时
 */
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

  // 串行入队：保证同一连接同一时刻只有一个合成，避免帧交叉（轮流持有连接）
  const p = queueTail.then(
    () => synthesizeOnShared({ text, voice, rate, volume, pitch }),
    () => synthesizeOnShared({ text, voice, rate, volume, pitch }),
  );
  // 队列吞掉异常，避免一条失败污染后续排队的合成
  queueTail = p.catch(() => undefined);
  return p;
}

/**
 * 获取可用音色列表。
 * 静态返回预置列表，避免每次请求都调 API。
 */
export function getEdgeTtsVoices() {
  return EDGE_TTS_VOICES;
}
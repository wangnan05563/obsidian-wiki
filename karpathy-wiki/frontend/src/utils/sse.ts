// SSE 事件流解析与分发工具
// 抽取自 FloatingChat.vue / Query.vue / Progress.vue 共享的 SSE 处理逻辑
// 为什么独立成模块：消除三处重复实现，并通过对象映射降低认知复杂度（S3776）

import { ElMessage } from 'element-plus';
import type { ThinkingStep, MultimodalOutput, ChatMessage, Reference } from '../types';

// §按会话隔离（v4）：SSE 写入目标抽象为 SSEWriter，由调用方决定路由到哪个会话缓冲。
// 桌面端传入 store.getSessionWriter()（默认 active 缓冲）；移动端传入
// store.getSessionWriter(conversationId)（按会话动态路由，支持后台并行流式）。
export interface SSEWriter {
  appendAnswer(text: string): void;
  setRefs(refs: string[] | Reference[], webRefs?: Array<{ title: string; url: string; snippet: string }>): void;
  setFollowups(followups: string[]): void;
  appendThinking(step: ThinkingStep): void;
  setProgress(step: string, count?: number): void;
  setMultimodal(payload: MultimodalOutput): void;
  setImage(payload: NonNullable<ChatMessage['image']>): void;
  setPpt(payload: NonNullable<ChatMessage['ppt']>): void;
  setThreadId(id: string | null): void;
  finalizeAnswer(sessionId?: string, messageIndex?: number, threadId?: string, followups?: string[]): void;
  handleError(message: string): void;
  // 供 consumeQuerySSE 做「流结束但未收到 done」的兜底判定
  readonly isLoading: boolean;
  readonly streamingAnswer: string;
}

// Query SSE 事件处理器签名：接收已 JSON.parse 的数据，调用 writer 对应方法
type QueryEventHandler = (parsed: any, writer: SSEWriter) => void;

// 事件类型 → 处理函数映射表
// 为什么用对象映射而非 if/else 链：避免 S3776 认知复杂度超阈（<15）
const QUERY_EVENT_HANDLERS: Record<string, QueryEventHandler> = {
  answer: (parsed, writer) => writer.appendAnswer(parsed.text || ''),
  refs: (parsed, writer) => writer.setRefs(parsed.refs || [], parsed.webRefs || []),
  thinking: (parsed, writer) => {
    // ts 字段优先用后端提供的（query-workflow 中在 yield 时补齐），
    // 后端未传时降级到前端接收时间（保持类型必填约束）
    const step: ThinkingStep = {
      phase: parsed.phase,
      message: parsed.message,
      tool: parsed.tool,
      args: parsed.args,
      ts: parsed.ts || new Date().toISOString(),
    };
    writer.appendThinking(step);
  },
  progress: (parsed, writer) => writer.setProgress(parsed.step, parsed.count),
  followups: (parsed, writer) => writer.setFollowups(parsed.followups || []),
  // FR-09-2 多模态输出：mindmap/faq/timeline 结构化输出，渲染为独立卡片
  // 为什么独立事件：与 answer 解耦，前端按 type 分别渲染（mindmap 用 mermaid.js，faq/timeline 用 markdown）
  multimodal: (parsed, writer) => {
    const payload: MultimodalOutput = {
      type: parsed.type,
      content: parsed.content || '',
    };
    writer.setMultimodal(payload);
  },
  // v3 图像生成结果：在 done 之前到达，writer.setImage 暂存，finalizeAnswer 时附加到消息
  // 为什么独立事件：image 与 multimodal 结构不同（含 url/alt/archivePath），需独立处理器
  image: (parsed, writer) => {
    writer.setImage({
      url: parsed.url || '',
      alt: parsed.alt || '',
      archivePath: parsed.archivePath,
    });
  },
  // v3 PPT 生成结果：Marp Markdown 源码，前端用 @marp-team/marp-core 渲染为幻灯片
  // 为什么独立事件：ppt 与 multimodal 结构不同（含 markdown/title/archivePath），需独立处理器
  ppt: (parsed, writer) => {
    writer.setPpt({
      markdown: parsed.markdown || '',
      title: parsed.title || '',
      archivePath: parsed.archivePath || '',
    });
  },
  done: (parsed, writer) => {
    // 记录线程隔离键（与 sessionId 同源），供后续问答续接本地记忆
    if (parsed.threadId) writer.setThreadId(parsed.threadId);
    writer.finalizeAnswer(parsed.sessionId, parsed.messageIndex, parsed.threadId);
  },
  error: (parsed, writer) => {
    writer.handleError(parsed.message || '问答出错');
    ElMessage.warning(parsed.message || '问答出错');
  },
};

// 解析单个 SSE 事件，提取 event 与 data 字段
// 返回 null 表示事件不完整或无效，调用方应跳过
export function parseSSEEvent(evt: string): { eventType: string; data: string } | null {
  const lines = evt.split('\n');
  let eventType = '';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) eventType = line.slice(7);
    if (line.startsWith('data: ')) data = line.slice(6);
  }
  if (!eventType || !data) return null;
  return { eventType, data };
}

// 分发 query 类 SSE 事件到 writer
// 非 JSON 数据或未知事件类型静默跳过，不抛异常打断流
export function dispatchQuerySSEEvent(eventType: string, data: string, writer: SSEWriter): void {
  const handler = QUERY_EVENT_HANDLERS[eventType];
  if (!handler) return;
  try {
    handler(JSON.parse(data), writer);
  } catch {
    // 非 JSON 数据跳过：部分心跳/keepalive 事件无 payload
  }
}

// 批量处理 SSE 事件数组
export function processQuerySSEEvents(events: string[], writer: SSEWriter): void {
  for (const evt of events) {
    const parsed = parseSSEEvent(evt);
    if (!parsed) continue;
    dispatchQuerySSEEvent(parsed.eventType, parsed.data, writer);
  }
}

// 从 Response 读取并消费 SSE 流，逐事件分发到 writer
// 封装 reader/decoder/buffer 的样板代码，避免各页面重复实现
// 主动取消（signal.abort）时不抛 AbortError，正常返回让调用方在 finally 中处理停止态
// 为什么不抛 AbortError：调用方需要在 catch 中区分"用户停止"和"真实错误"，
// 抛 AbortError 会让调用方走错误处理分支，污染 errorMessage 状态
// onActivity：每次从网络读取到数据块时回调，供调用方实现"滑动窗口"超时判定
//   （只收到字节即视为有活动，即便该块是心跳注释而非完整事件，也能重置 watchdog）。
export async function consumeQuerySSE(
  response: Response,
  writer: SSEWriter,
  signal?: AbortSignal,
  onActivity?: () => void,
): Promise<void> {
  if (!response.body) throw new Error('Response body is empty');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // 网络层收到任意字节即视为"有响应"，重置前端超时滑动窗口
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      // 最后一段可能不完整，留到下次拼接
      buffer = events.pop() || '';
      processQuerySSEEvents(events, writer);
    }
    // 流正常结束但未收到 done 事件时兜底
    if (writer.isLoading && writer.streamingAnswer) {
      writer.finalizeAnswer();
    }
  } catch (err: unknown) {
    // AbortError 是主动取消的正常路径，吞掉避免污染调用方错误处理
    if ((err as Error).name === 'AbortError') return;
    throw err;
  } finally {
    // 主动取消时释放 reader
    if (signal?.aborted) {
      try { await reader.cancel(); } catch { /* 忽略已释放 */ }
    }
  }
}

// 通用 SSE 流消费：对每个完整的 SSE 事件调用 handler(eventType, parsedData)
// 为什么独立于 consumeQuerySSE：compile 等场景使用 store.handleEvent 而非 query store 方法
// 非 JSON 数据跳过，不抛异常打断流
export async function consumeSSE(
  response: Response,
  handler: (eventType: string, parsed: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error('Response body is empty');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const evt of events) {
        const parsed = parseSSEEvent(evt);
        if (!parsed) continue;
        try {
          handler(parsed.eventType, JSON.parse(parsed.data));
        } catch {
          // 非 JSON 数据跳过
        }
      }
    }
  } finally {
    if (signal?.aborted) {
      try { await reader.cancel(); } catch { /* 忽略已释放 */ }
    }
  }
}

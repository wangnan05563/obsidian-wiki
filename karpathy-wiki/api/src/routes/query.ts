import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import type { EngineAdapter, QueryInput, AnswerChunk } from '../types.js';
import type { VaultService } from '../vault/vault-service.js';
import { createSSESender } from '../utils/sse.js';
import { withCompileLock } from '../compile-queue.js';
import { ThreadMemoryStore } from '../engine/thread-memory-store.js';
import type { HistoryMessage } from '../engine/thread-memory-store.js';
// 上下文记忆治理模块：注入 LLM 前对历史做语义压缩/清理/重组/容量淘汰
import { govern } from '../engine/context-governor.js';
import type { ContextGovernorConfig, GovernorStats } from '../engine/context-governor.js';
// §6.0.2 per-session Lock：按 question 前 32 字符做 key 串行化
import { withSessionLock } from '../session-lock.js';
import type { IsolationGuards } from '../middleware/auth.js';
import { createIsolationGuards } from '../middleware/auth.js';

// 注册 POST /api/query 路由。
// §5.2 改造：请求体扩展 mode/webSearch/attachments/model；SSE 事件扩展 thinking/progress/followups
// 本地持久化改造：问答会话与记忆通过 ThreadMemoryStore 落盘到 data/threads/{threadId}/，
// 按 threadId 隔离；history 优先由后端记忆注入（保证跨重启连贯），否则回退前端透传 history。
export function registerQueryRoute(
  app: FastifyInstance,
  adapter: EngineAdapter,
  store: ThreadMemoryStore,
  governorConfig: ContextGovernorConfig,
  guards: IsolationGuards = createIsolationGuards(),
) {
  app.post('/api/query', {
    // 破坏性端点更严格限流：query 触发 LLM 调用，20/min 防 token 耗尽
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    // 归属隔离：auth 启用时要求登录，避免游客越权创建/续接他人线程记忆（BR-ISOLATION-01）
    preHandler: guards.requireAuth,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      question?: string;
      history?: QueryInput['history'];
      // 线程隔离键：携带后由后端从本地记忆注入历史上下文，并在本地持久化会话/记忆
      threadId?: string;
      // §5.2 模式：'web' 联网搜索 / 'deep' 深度思考
      mode?: string;
      // 是否启用联网搜索工具
      webSearch?: boolean;
      // 附件 base64 列表
      attachments?: Array<{ data: string; mimeType: string; filename: string }>;
      // 当前请求使用的模型（即时切换）
      model?: string;
      // FR-09-2 多模态输出模式：'normal' 默认 | 'mindmap' 思维导图 | 'faq' 问答对 | 'timeline' 时间线
      // v3 扩展：'image' 图像生成 | 'ppt' PPT 生成（走 wrapWithMultimodal 分流到 media-generation-workflow）
      outputMode?: 'normal' | 'mindmap' | 'faq' | 'timeline' | 'image' | 'ppt';
      // v2: 多选输出模式（控制 thinking/tool_call/answer/multimodal 流式事件可见性）
      // 与 outputMode 独立：outputMode 控制多模态结构，outputModes 控制流式阶段事件可见性
      outputModes?: Array<'thinking' | 'tool_call' | 'answer' | 'multimodal'>;
      // §真流式开关：true 走 LLM 逐 token 推送，false 走按句切分假流式
      // 未传时由 queryWorkflow 内部用 harnessConfig.llm.stream 兜底
      stream?: boolean;
      // 中间件开关：query workflow 中可启用/禁用的功能模块
      // 与已有字段关系：middlewares 优先，已有字段（webSearch/mode/stream）作为兜底
      middlewares?: string[];
      // ── BYOK per-user 配置覆盖项（见 types.ts QueryInput 注释）──
      // 前端按当前用户携带自己配置的 API 信息；后端以其覆盖服务端共享配置。
      llmConfig?: { provider: string; baseUrl: string; model: string; apiKey: string };
      searchConfig?: { provider: 'tavily' | 'bing'; apiKey: string; maxResults?: number };
      toolsConfig?: import('../types.js').ToolsConfig;
    };
    // 可选链合并 body nullish 守卫与字段访问（S6582）
    if (!body?.question || typeof body.question !== 'string') {
      return reply.code(400).send({ error: '请求体须含 question 字段' });
    }

    // ── BYOK 强制每用户各自配置 ──
    // 需求明确"不保留服务端默认密钥"，故缺失或不带 apiKey 的 llmConfig 一律拒绝，
    // 不允许回落到服务端共享 config.llm.apiKey（避免全员共用同一额度/互现限流）。
    // 同时校验 provider/baseUrl/model 非空，避免畸形配置透传到 harness 后触发 500。
    // 前端仅在用户已填完整 API 配置时才下发 llmConfig，未配置用户会命中此处得到明确指引。
    const llmOverride = body.llmConfig;
    const keyOk = !!llmOverride && typeof llmOverride.apiKey === 'string' && llmOverride.apiKey.trim() !== '';
    const fieldsOk = !!llmOverride
      && typeof llmOverride.provider === 'string' && llmOverride.provider.trim() !== ''
      && typeof llmOverride.baseUrl === 'string' && llmOverride.baseUrl.trim() !== ''
      && typeof llmOverride.model === 'string' && llmOverride.model.trim() !== '';
    if (!llmOverride || !keyOk || !fieldsOk) {
      return reply.code(400).send({
        error: '请先在「配置 → AI 服务」中填写完整且有效的 API 配置（provider / baseUrl / model / API Key）。本应用不为用户共用服务端密钥，各用户的额度与限流相互独立。',
      });
    }

    // 模型切换由 PUT /api/ai/config 统一处理（switchModel 时同步 adapter）
    // 不在每次问答时重复切换，避免只更新 model 不更新 baseUrl 导致不匹配
    const input: QueryInput = {
      question: body.question,
      // history 先置空，下面按线程隔离策略解析（优先后端记忆，否则回退前端透传）
      history: undefined,
      mode: body.mode,
      webSearch: body.webSearch,
      attachments: body.attachments,
      model: body.model,
      // FR-09-2 透传 outputMode 到 queryWorkflow，由 wrapWithMultimodal 在 done 之前追加 multimodal 输出
      outputMode: body.outputMode,
      // v2: 透传 outputModes 到 queryWorkflow 内部 yield 过滤
      // 为空/undefined 时 workflow 视为全开（不修改现有行为）
      outputModes: body.outputModes && body.outputModes.length > 0 ? body.outputModes : undefined,
      // §真流式透传：undefined 时 queryWorkflow 用 harnessConfig.llm.stream 兜底
      stream: body.stream,
      // 中间件配置透传：undefined 时 queryWorkflow 按各功能默认行为执行
      // 后端按 middlewares 数组中是否包含对应 key 决定是否覆盖默认行为
      middlewares: body.middlewares,
      // ── BYOK per-user 覆盖项透传：adapter.query 内部据此覆盖服务端共享配置 ──
      // llmConfig：必带（上方已校验），整体覆盖 harnessConfig.llm 的 provider/baseUrl/model/apiKey。
      llmConfig: llmOverride,
      // searchConfig：可选；缺 apiKey 时后端回退服务端 webSearch 配置（仅搜索附加能力，不强制）。
      searchConfig: body.searchConfig,
      // toolsConfig：始终下发（即便空），整体替换服务端共享 MCP/CLI，落实用户维度工具隔离。
      toolsConfig: body.toolsConfig,
    };

    // ── 线程隔离 + 本地记忆解析 ──────────────────────────────────────────
    // 线程隔离边界：所有会话与记忆都通过 threadId 命名空间隔离。
    //   - 携带合法 threadId：从本地记忆注入历史上下文（保证跨重启连贯），
    //     写入时也落盘到该线程目录。
    //   - 未携带或非法：回退为前端透传 history（向后兼容），并自动创建新线程。
    //   - 非法 threadId：直接 400，绝不落到"全局"或越界目录。
    let threadId: string;
    // 上下文治理统计（done 事件回传，便于前端/运维观测压缩清理效果）；声明提前以覆盖 try 作用域
    let governorStats: GovernorStats | null = null;
    try {
      const provided = body.threadId?.trim();
      if (provided && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(provided)) {
        return reply.code(400).send({ error: `非法的 threadId: ${provided}` });
      }
      // ── 归属隔离（BR-ISOLATION-01）─────────────────────────────────────
      // auth 启用时线程必须归属当前用户：携带的 threadId 须属本人，否则 404（不暴露存在性）；
      // 未携带时新建线程并盖章 owner。单租户（auth 关闭）跳过校验，保持既有行为。
      const owner = guards.enabled ? (request.currentUser?.userId ?? null) : null;
      if (provided) {
        if (guards.enabled) {
          const existing = await store.getThread(provided);
          if (!existing || (existing.ownerId ?? null) !== owner) {
            return reply.code(404).send({ error: `非法的 threadId: ${provided}` });
          }
        }
        threadId = provided;
      } else {
        threadId = (await store.ensureThread(randomUUID(), owner)).id;
      }
      // 解析历史上下文：优先后端记忆（连贯性），否则回退前端透传 history
      const memoryContext = await store.getHistoryContext(threadId);
      // 统一为 HistoryMessage[]（前端透传 history 缺 ts，补空串占位）
      const rawHistory: HistoryMessage[] =
        memoryContext.length > 0
          ? memoryContext
          : (body.history ?? []).map((h) => ({ role: h.role, content: h.content, ts: '' }));

      // ── 上下文记忆治理 ────────────────────────────────────────────────
      // 在注入 LLM 前，对历史做主动治理：语义压缩（早期→摘要）/ 清理（去重+低价值）/
      // 重组（相关性排序）/ 容量淘汰（接近上限自动触发）。保护关键信息（摘要+最近窗口），
      // 保证跨窗口连贯。existingSummary 来自存储层折叠（compactMemory），与新压缩合并。
      const existingSummary = await store.getMemorySummary(threadId);
      const governed = await govern(rawHistory, {
        question: input.question,
        config: governorConfig,
        existingSummary: existingSummary || undefined,
      });
      governorStats = governed.stats;
      input.history = governed.messages.length > 0 ? governed.messages : undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }

    // 本轮问答使用的会话/记忆标识（sessionId === threadId，1 线程 1 会话）
    const sessionId = threadId;
    const answerBuffer: string[] = [];
    let refs: string[] = [];
    // §5.2 联网搜索外部链接：与 refs 并行发送
    let webRefs: Array<{ title: string; url: string; snippet: string }> = [];

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 为什么用 createSSESender：客户端 abort 后 reply.raw 被销毁，继续 write 会抛 ERR_STREAM_DESTROYED
    // 被 Fastify 作为未捕获异常处理为 HTTP 500，污染日志并误导排障
    const { send, isAborted, safeEnd } = createSSESender(reply, request);

    try {
      // §6.0.2 per-session Lock：同 question 的并发请求串行化，避免 LLM 重复调用浪费 token
      // 为什么包裹整个 SSE 流而非只包裹 LLM 调用：
      //   1. 同问题重复请求必须等前一次完成才允许第二次开始，否则 LLM 调用并发会浪费 token
      //   2. 第二次请求开始时复用前一次的 SSE 流式输出已无意义（用户已看到第一次答案）
      // 代价：用户同问题重复点击会卡住等前一次完成，这是 SRS 设计意图
      // 进度类事件分发：提取为函数降低主循环认知复杂度
      const dispatchProgressEvents = (chunk: AnswerChunk): void => {
        // §5.2 thinking 事件：前端 ThinkingBlock 渲染
        if (chunk.thinking) {
          send('thinking', chunk.thinking);
        }
        // §5.2 progress 事件：联网搜索进度
        if (chunk.progress) {
          send('progress', chunk.progress);
        }
        // §5.2 image 事件：多模态图片推送
        if (chunk.image) {
          send('image', chunk.image);
        }
        // v3 PPT 事件：Marp Markdown 幻灯片推送
        if (chunk.ppt) {
          send('ppt', chunk.ppt);
        }
        // §5.2 followups 事件：追问建议
        if (chunk.followups) {
          send('followups', { followups: chunk.followups });
        }
        // FR-09-2 多模态输出事件：前端 MultimodalOutput 组件渲染 mindmap/faq/timeline
        // 为什么单独事件类型：与 answer/refs/done 解耦，前端按事件类型独立渲染
        if (chunk.multimodal) {
          send('multimodal', chunk.multimodal);
        }
        // §5.2 联网搜索引用：缓存最新 webRefs，与 refs 一起在 done 时发送
        if (chunk.webRefs && chunk.webRefs.length > 0) {
          webRefs = chunk.webRefs;
        }
      };

      // done 事件处理：发送 refs + 本地持久化会话与记忆 + 发送 done 事件
      // 注意：改为 async，因为持久化走 ThreadMemoryStore（文件 IO）。
      const handleDoneChunk = async (chunk: AnswerChunk): Promise<void> => {
        if ((chunk.refs?.length ?? 0) > 0) {
          refs = chunk.refs ?? [];
        }
        // refs 与 webRefs 一起发送：前端 RefsList 合并渲染"参考来源"
        send('refs', { refs, webRefs });

        const answer = answerBuffer.join('');
        const now = new Date().toISOString();
        // 本地持久化①：会话（完整 Q&A 轮次）→ data/threads/{threadId}/session.json
        const { messageIndex } = await store.appendSessionMessage(threadId, {
          question: input.question,
          answer,
          refs,
          ts: now,
        });
        // 本地持久化②：记忆（滚动上下文）→ data/threads/{threadId}/memory.json
        // 用于后续问答注入 ## 历史对话，实现连贯交互
        await store.appendMemory(threadId, [
          { role: 'user', content: input.question, ts: now },
          { role: 'assistant', content: answer, ts: now },
        ]);
        // done 事件附带 threadId + sessionId + messageIndex，客户端保存供归档与记忆续接；
        // 同时回传上下文治理统计（压缩/清理/淘汰效果），便于观测
        send('done', { threadId, sessionId, messageIndex, governor: governorStats });
      };

      await withSessionLock(input.question, async () => {
        for await (const chunk of adapter.query(input)) {
          // 客户端已断开：提前退出迭代，停止后续 LLM 调用避免浪费 token
          if (isAborted()) break;
          dispatchProgressEvents(chunk);

          if (chunk.done) {
            await handleDoneChunk(chunk);
          } else if ((chunk.refs?.length ?? 0) > 0) {
            // 兜底：非 done 时收到 refs 也下发（兼容 v1 行为）
            send('refs', { refs: chunk.refs, webRefs });
          } else if (chunk.text) {
            answerBuffer.push(chunk.text);
            send('answer', { text: chunk.text });
          }
        }
      });
    } catch (err: unknown) {
      // 为什么同时调用 request.log.error：SSE 错误只推前端，后端日志流需独立记录以便排障
      request.log.error(
        { err, question: input.question, sessionId },
        'query SSE stream error',
      );
      send('error', {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      safeEnd();
    }
  });
}

// 独立导出归档路由注册函数，在 index.ts 中与 query 路由一起注册。
// 拆分是因为 archive 需要 vault 注入，而 query 需要 adapter + 线程存储。
// 归档取数策略：优先从请求体读取 question/answer/refs（前端已持有完整内容），
// 仅当请求体缺失 answer 时回退到 ThreadMemoryStore（兼容旧客户端 / threadsPersist=true）。
// 这样在默认 threadsPersist=false（服务端不落盘会话）部署下归档仍可用，符合「会话不上服务端」核心需求。

// UUID v4 正则：与 ThreadMemoryStore 一致，仅允许合法 UUID 作为文件名分组前缀，防路径穿越。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 安全解析日期：无效/缺失时回退今天，避免 new Date(invalid).toISOString() 抛 RangeError 导致 500。
function toArchiveDateStr(input: unknown): string {
  if (typeof input === 'string' && input.trim()) {
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

export function registerQueryArchiveRoute(
  app: FastifyInstance,
  vault: VaultService,
  store: ThreadMemoryStore,
  guards: IsolationGuards = createIsolationGuards(),
) {
  app.post('/api/query/archive', { preHandler: guards.requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      question?: string;
      answer?: string;
      refs?: unknown[];
      ts?: string;
      threadId?: string;
      sessionId?: string;
      messageIndex?: number;
    };

    // 优先从请求体取问答内容（前端已持有完整 question/answer/refs），
    // 不再依赖服务端 session 持久化 —— 使归档在 threadsPersist=false（默认部署，
    // 服务端不落盘会话）下也能工作，与「会话不上服务端」核心需求一致。
    // 仅当请求体缺失 answer 时，回退到服务端 session 取数（兼容旧客户端 / threadsPersist=true 场景）。
    let question = typeof body?.question === 'string' ? body.question.trim() : '';
    let answer = typeof body?.answer === 'string' ? body.answer.trim() : '';
    let refs: string[] = Array.isArray(body?.refs)
      ? body.refs.filter((r): r is string => typeof r === 'string')
      : [];
    let dateStr: string;

    const threadId = body?.threadId ?? body?.sessionId;
    if (!answer) {
      // 回退路径：需要 threadId + 整数 messageIndex，且 threadId 合法
      if (!threadId || typeof body?.messageIndex !== 'number' || !Number.isInteger(body.messageIndex)) {
        return reply.code(400).send({ error: '请求体须含 answer，或 threadId(或 sessionId) 与整数 messageIndex' });
      }
      if (!UUID_RE.test(threadId)) {
        return reply.code(400).send({ error: `非法的 threadId: ${threadId}` });
      }
      // 归属隔离：auth 启用时服务端会话须归属当前用户，否则 404（不暴露存在性）
      if (guards.enabled) {
        const existing = await store.getThread(threadId);
        if (!existing || (existing.ownerId ?? null) !== (request.currentUser?.userId ?? null)) {
          return reply.code(404).send({ error: `非法的 threadId: ${threadId}` });
        }
      }
      const session = await store.getSession(threadId);
      if (!session || body.messageIndex < 0 || body.messageIndex >= session.messages.length) {
        return reply.code(404).send({ error: '会话或消息不存在（可能已清理）' });
      }
      const record = session.messages[body.messageIndex];
      question = question || record.question;
      answer = record.answer;
      if (!refs.length) refs = record.refs;
      dateStr = toArchiveDateStr(record.ts);
    } else {
      dateStr = toArchiveDateStr(body.ts);
    }

    // 统一清洗 refs（去除可能破坏 wikilink 语法的换行/控制字符），并剔除空串
    refs = refs.map((r) => r.replace(/[\r\n]/g, ' ').trim()).filter(Boolean);

    // 防御：question 与 answer 均为空时无归档意义，直接拒绝
    if (!question && !answer) {
      return reply.code(400).send({ error: '归档内容为空（question 与 answer 均缺失）' });
    }

    // 生成归档页面文件名：queries/qa-{date}-{短分组id}-{随机}.md
    // shortId 用于同线程分组（合法 UUID 取前 8 位，否则随机）；uniq 保证同一线程同一天多次归档不互相覆盖。
    // 文件名仅含日期与十六进制，杜绝路径穿越。
    const shortId = threadId && UUID_RE.test(threadId)
      ? threadId.slice(0, 8)
      : randomUUID().slice(0, 8);
    const uniq = randomUUID().slice(0, 4);
    const relPath = `queries/qa-${dateStr}-${shortId}-${uniq}.md`;

    // 构造 frontmatter + 正文。type: query 符合 SCHEMA 规范
    const frontmatter = {
      title: `问答归档：${question.slice(0, 30)}${question.length > 30 ? '…' : ''}`,
      type: 'query',
      created: dateStr,
      updated: dateStr,
      source: 'qa-archive',
      tags: ['问答归档', ...refs],
    };

    // 提取嵌套模板到变量，降低模板复杂度（S4624）
    const refLines = refs.map((r) => `- [[${r}]]`).join('\n');
    const refsSection = refs.length > 0
      ? `\n\n## 引用页面\n${refLines}`
      : '';

    const content = matter.stringify(
      `# 问答归档\n\n## 问题\n${question}\n\n## 回答\n${answer}${refsSection}\n`,
      frontmatter,
    );

    try {
      // 串行化 vault 写入：与 compile 路由共用锁，避免 index.md/log.md 追加竞态
      await withCompileLock(async () => {
        await vault.writeFile(relPath, content);
        // 追加到 index.md
        await vault.appendIndex(
          frontmatter.title,
          `归档问答：${question.slice(0, 40)}`,
        );
        // 记录操作日志
        await vault.appendLog('query', [relPath], `归档问答: ${question.slice(0, 40)}`);
      });
      // 归档成功：本地会话记录保留（持久化在 data/threads/{threadId}/session.json），
      // 不再需要像内存 Map 那样主动释放——磁盘存储天然不受内存泄漏约束。
      return reply.send({ ok: true, path: relPath });
    } catch (err: unknown) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

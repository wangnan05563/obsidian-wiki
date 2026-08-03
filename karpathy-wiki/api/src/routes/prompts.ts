import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineAdapter, AppConfig } from '../types.js';
import { withCompileLock } from '../compile-queue.js';
import { createSSESender } from '../utils/sse.js';
import { getPromptsDir } from '../utils/runtime.js';

// FR-14-2 Prompt IDE 路由
// AC-14-4: 支持 GET 列出/读取、PUT 编辑 prompts/*.md
// AC-14-5: 支持 POST 试运行（用编辑后的 prompt 执行一次 compile 并流式返回结果）
//
// 设计要点：
// 1. 白名单校验 prompt name：禁止 ../ 路径穿越，仅允许已知 prompt 文件
// 2. 试运行通过临时覆盖 prompt 文件 → 执行 compile → finally 还原原文件
// 3. 复用 withCompileLock 串行化试运行，避免与正常 compile 请求产生 prompt 文件覆盖竞态
// 4. SSE 事件格式与 /api/compile 对齐（progress/page/done/error），前端可复用渲染逻辑

// 路径解析统一走 runtime.ts，兼容开发模式与 SEA 打包模式
const PROMPTS_DIR = getPromptsDir();

// 白名单：仅允许编辑已知 prompt 文件
// 为什么用白名单而非动态扫描：防止用户构造 ../ 路径穿越读取任意 .md 文件
const PROMPT_WHITELIST = [
  'compile.md',
  'query.md',
  'qq-extract.md',
  'tag-suggest.md',
  'multimodal-output.md',
  'health-check-fix.md',
  'podcast.md',
] as const;

const PROMPT_WHITELIST_SET = new Set<string>(PROMPT_WHITELIST);

interface PromptMeta {
  name: string;
  label: string;
  description: string;
}

// prompt 文件元信息：label 与 description 用于前端展示
// 为什么独立常量而非后端返回：文件名是稳定契约，描述文案属于 UI 层关注点
const PROMPT_META: Record<string, PromptMeta> = {
  'compile.md': {
    name: 'compile.md',
    label: '编译 Prompt',
    description: '控制将原始资料编译为 Wiki 页面的 AI 行为（核心 prompt）',
  },
  'query.md': {
    name: 'query.md',
    label: '问答 Prompt',
    description: '控制基于知识库回答用户问题的 AI 行为',
  },
  'qq-extract.md': {
    name: 'qq-extract.md',
    label: 'QQ 抽取 Prompt',
    description: '控制 QQ 聊天记录主题抽取的 AI 行为',
  },
  'tag-suggest.md': {
    name: 'tag-suggest.md',
    label: '标签建议 Prompt',
    description: '控制为页面生成 AI 标签建议的 prompt',
  },
  'multimodal-output.md': {
    name: 'multimodal-output.md',
    label: '多模态输出 Prompt',
    description: '控制生成思维导图/FAQ/时间线的 prompt',
  },
  'health-check-fix.md': {
    name: 'health-check-fix.md',
    label: '健康修复 Prompt',
    description: '控制自动修复知识库问题的 prompt',
  },
};

export function registerPromptsRoute(
  app: FastifyInstance,
  adapter: EngineAdapter,
  appConfig?: AppConfig,
) {
  // 列出所有可用 prompt 文件
  // 为什么返回 meta 而非纯文件名：前端需展示中文描述，元信息集中管理避免漂移
  app.get('/api/prompts', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const files = await fs.readdir(PROMPTS_DIR);
      const prompts = files
        .filter((f) => f.endsWith('.md') && PROMPT_WHITELIST_SET.has(f))
        .map((f) => PROMPT_META[f] ?? { name: f, label: f, description: '' });
      return reply.send({ prompts });
    } catch (err: unknown) {
      // 记录到后端日志流：catch 块只发前端不记日志时，500 排障无据可查
      request.log.error({ err, dir: PROMPTS_DIR }, 'GET /api/prompts failed');
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 读取指定 prompt 文件内容
  app.get<{ Params: { name: string } }>(
    '/api/prompts/:name',
    async (request, reply) => {
      const { name } = request.params;
      if (!PROMPT_WHITELIST_SET.has(name)) {
        return reply.code(400).send({ error: '不允许的 prompt 文件名' });
      }
      try {
        const filePath = path.join(PROMPTS_DIR, name);
        const content = await fs.readFile(filePath, 'utf8');
        return reply.send({ name, content });
      } catch (err: unknown) {
        return reply.code(404).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // 保存指定 prompt 文件内容
  // 为什么 PUT 而非 POST：语义为"替换文件全部内容"，符合 PUT 幂等语义
  app.put<{ Params: { name: string } }>(
    '/api/prompts/:name',
    async (request, reply) => {
      const { name } = request.params;
      if (!PROMPT_WHITELIST_SET.has(name)) {
        return reply.code(400).send({ error: '不允许的 prompt 文件名' });
      }
      const body = request.body as { content?: string };
      if (!body || typeof body.content !== 'string') {
        return reply.code(400).send({ error: '请求体须含 content 字段' });
      }
      try {
        const filePath = path.join(PROMPTS_DIR, name);
        await fs.writeFile(filePath, body.content, 'utf8');
        return reply.send({ ok: true });
      } catch (err: unknown) {
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // 试运行：用编辑后的 prompt 内容执行一次 compile，SSE 流式返回结果
  // AC-14-5: 输入测试资料，执行 compile 一次，查看输出
  //
  // 实现策略：
  // 1. 备份原 prompt 文件内容到内存
  // 2. 写入用户编辑的 prompt 内容到文件
  // 3. 在 withCompileLock 内执行 compile（避免与其他 compile 请求竞态）
  // 4. finally 还原原 prompt 文件内容（无论成功失败）
  //
  // 为什么选择临时覆盖文件而非参数注入：
  // - compile-workflow 通过 loadCompilePrompt() 读取文件，参数注入需修改 workflow 签名
  // - 临时覆盖 + 串行队列 + finally 还原 的组合最简单且零侵入
  // - withCompileLock 保证试运行期间不会有其他 compile 请求读到半覆盖的 prompt
  app.post('/api/prompts/test-run', {
    // 试运行触发 LLM 调用 + vault 写入，限流 5/min 防滥用
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      promptName?: string;
      promptContent?: string;
      testInput?: string;
    };
    if (!body || !body.promptName || !body.promptContent || !body.testInput) {
      return reply.code(400).send({
        error: '请求体须含 promptName、promptContent、testInput',
      });
    }
    if (!PROMPT_WHITELIST_SET.has(body.promptName)) {
      return reply.code(400).send({ error: '不允许的 prompt 文件名' });
    }
    // 仅 compile.md 支持试运行：其他 prompt（query/tag-suggest 等）调用链路不同
    if (body.promptName !== 'compile.md') {
      return reply.code(400).send({
        error: '当前仅支持 compile.md 的试运行',
      });
    }

    const filePath = path.join(PROMPTS_DIR, body.promptName);
    let originalContent: string | null = null;

    try {
      originalContent = await fs.readFile(filePath, 'utf8');
    } catch {
      // 原 prompt 文件不存在时 originalContent 保持 null，finally 跳过还原
    }

    // 写入用户编辑的 prompt 内容
    try {
      await fs.writeFile(filePath, body.promptContent, 'utf8');
    } catch (err: unknown) {
      return reply.code(500).send({
        error: `写入 prompt 文件失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const { send, isAborted, safeEnd } = createSSESender(reply, request);

    try {
      // 串行队列保证试运行期间不会被其他 compile 请求打断
      await withCompileLock(async () => {
        // 使用 text 模式调用 compile：testInput 作为原始资料文本
        for await (const ev of adapter.compile(
          { type: 'text', content: body.testInput! },
          appConfig,
        )) {
          if (isAborted()) break;
          if (ev.step === 'done') {
            send('done', ev);
          } else if (ev.data?.path && ev.data?.title) {
            send('page', ev);
          } else {
            send('progress', ev);
          }
        }
      });
    } catch (err: unknown) {
      // 后端日志流需独立记录以便排障，与 SSE 错误推送并行
      request.log.error(
        { err, promptName: body.promptName },
        'prompt test-run SSE stream error',
      );
      send('error', {
        step: 'finalize',
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // 无论成功失败都还原原 prompt 文件，避免污染正式 compile 流程
      if (originalContent !== null) {
        try {
          await fs.writeFile(filePath, originalContent, 'utf8');
        } catch {
          // 还原失败记录到日志但不抛错（SSE 已结束）
          request.log.error(
            { promptName: body.promptName },
            'failed to restore original prompt file after test-run',
          );
        }
      }
      safeEnd();
    }
  });
}

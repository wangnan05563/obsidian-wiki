import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EngineAdapter, CompileInput, BatchCompileConfig, AppConfig } from '../types.js';
import { withCompileLock } from '../compile-queue.js';
import { createSSESender } from '../utils/sse.js';

// 默认批量编译配置，当 index.ts 未传 config.batch 时回退使用。
// 为什么需要默认值：避免 config.json 缺失 batch 字段时路由崩溃
// 同步要求：修改时需同步更新 config.ts 的 defaultConfig().batch 与 DEFAULT_BATCH_FALLBACK
const DEFAULT_BATCH_CONFIG: BatchCompileConfig = {
  allowedExtensions: ['md', 'txt', 'pdf', 'html', 'json', 'docx', 'xlsx', 'pptx', 'doc', 'xls'],
  maxBatchSize: 50,
  maxFileSizeMb: 10,
};

// 批量文件校验：剥离目录前缀 + 白名单 + 大小校验，独立为纯函数降低 batch 端点认知复杂度
function validateBatchFiles(
  uploaded: Array<{ name: string; buffer: Buffer }>,
  batch: BatchCompileConfig,
): { validFiles: Array<{ name: string; buffer: Buffer }>; rejected: Array<{ name: string; reason: string }> } {
  const allowedSet = new Set(batch.allowedExtensions.map((e) => e.toLowerCase()));
  const validFiles: Array<{ name: string; buffer: Buffer }> = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  const maxBytes = batch.maxFileSizeMb * 1024 * 1024;
  for (const f of uploaded) {
    // basename 剥离目录前缀防路径穿越，正则替换非法字符沿用单文件模式。
    // 白名单保留 Unicode 字母/数字（含中文），避免中文文件名被替换成下划线。
    const safeName = path.basename(f.name).replaceAll(/[^\p{L}\p{N}._-]/gu, '_');
    const ext = path.extname(safeName).slice(1).toLowerCase();
    if (!ext) {
      rejected.push({ name: f.name, reason: '缺少扩展名' });
      continue;
    }
    if (!allowedSet.has(ext)) {
      rejected.push({ name: f.name, reason: `不支持的扩展名: ${ext}` });
      continue;
    }
    if (f.buffer.length > maxBytes) {
      rejected.push({ name: f.name, reason: `超过 ${batch.maxFileSizeMb}MB 上限` });
      continue;
    }
    validFiles.push({ name: safeName, buffer: f.buffer });
  }
  return { validFiles, rejected };
}

// 注册 POST /api/compile 与 POST /api/compile/batch 路由。
// 单文件端点接受两种 Content-Type：
//   - multipart/form-data：file 字段上传单文件
//   - application/json：{ type: 'url'|'text', content: string }
// 批量端点仅接受 multipart/form-data：files 字段（多值）上传文件夹扫描结果。
// 响应均为 SSE 流，事件格式：event: <type>\ndata: <json>\n\n
// 批量端点 data 字段扩展 fileIndex/fileCount/fileName 以便前端按文件分组渲染。
export function registerCompileRoute(
  app: FastifyInstance,
  adapter: EngineAdapter,
  batchConfig?: BatchCompileConfig,
  // FR-10-1: 传入完整 config 用于 compile 末尾生成 ai_tags 建议（调用 LLM）
  appConfig?: AppConfig,
) {
  const batch = batchConfig ?? DEFAULT_BATCH_CONFIG;
  app.post('/api/compile', {
    // 破坏性端点更严格限流：compile 触发 LLM + 写 vault，10/min 防滥用
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    let input: CompileInput;

    const contentType = request.headers['content-type'] ?? '';
    if (contentType.startsWith('multipart/form-data')) {
      // multipart 文件上传
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: '缺少 file 字段' });
      }
      const buffer = await file.toBuffer();
      // sanitize filename：防路径穿越，剥离目录前缀并替换非法字符。
      // 白名单保留 Unicode 字母/数字（含中文），避免中文文件名被替换成下划线。
      const safeName = path.basename(file.filename).replaceAll(/[^\p{L}\p{N}._-]/gu, '_');
      // 落盘到临时目录，compile-workflow 会读取后存档到 raw/
      const tmp = path.join(os.tmpdir(), `wiki-compile-${Date.now()}-${process.pid}-${safeName}`);
      await fs.writeFile(tmp, buffer);
      // 传入原始文件名（已 sanitize），供 compile-workflow 保留原名到 raw/ 存档
      input = { type: 'file', content: tmp, originalName: safeName };
    } else {
      // JSON：url 或 text
      const body = request.body as { type?: string; content?: string; rawPath?: string };
      if (!body || (body.type !== 'url' && body.type !== 'text') || !body.content) {
        return reply.code(400).send({ error: '请求体须含 type(url|text) 与 content' });
      }
      input = {
        type: body.type,
        content: body.content,
        rawPath: body.rawPath,
      };
    }

    // SSE headers。Connection: keep-alive 防代理断开，X-Accel-Buffering: no 防 Nginx 缓冲。
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 通过工厂创建 SSE sender：客户端 abort 时 send 自动短路，safeEnd 容错结束流
    const { send, isAborted, safeEnd } = createSSESender(reply, request);

    try {
      // §12.3-5：串行队列包装，保证并发 compile 请求不产生 index.md/log.md 追加竞态。
      // withCompileLock 等待前一个 compile 完成后才开始消费本次迭代。
      await withCompileLock(async () => {
        for await (const ev of adapter.compile(input, appConfig)) {
          // 客户端已断开：提前退出迭代避免继续触发 LLM 调用与 vault 写入
          if (isAborted()) break;
          // 区分进度事件与页面生成事件：data 含 path/title 视为 page 事件
          // FR-10-1: generate_tags 步骤归为 progress 事件（无 path/title）
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
      // 为什么同时调用 request.log.error：SSE 错误只推前端，后端日志流需独立记录以便排障
      request.log.error(
        { err, inputType: input.type },
        'compile SSE stream error',
      );
      send('error', {
        step: 'finalize',
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // 清理临时文件：仅 file 模式落盘了临时文件，避免 tmp 目录残留泄漏
      if (input.type === 'file') {
        await fs.unlink(input.content).catch(() => {});
      }
      safeEnd();
    }
  });

  // §11.2 断点续传：POST /api/compile/resume/:runId
  // 从中断点恢复编译，SSE 流式返回进度事件（同 /api/compile 格式）
  app.post<{ Params: { runId: string } }>(
    '/api/compile/resume/:runId',
    async (request, reply) => {
      const { runId } = request.params;
      // 防路径穿越：只允许 UUID 格式的 runId
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
        return reply.code(400).send({ error: '无效的 runId' });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // 通过工厂创建 SSE sender：客户端 abort 时 send 自动短路，safeEnd 容错结束流
      const { send, isAborted, safeEnd } = createSSESender(reply, request);

      try {
        await withCompileLock(async () => {
          for await (const ev of adapter.resumeCompile(runId)) {
            // 客户端已断开：提前退出迭代避免继续触发 LLM 调用与 vault 写入
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
        // 为什么同时调用 request.log.error：SSE 错误只推前端，后端日志流需独立记录以便排障
        request.log.error(
          { err, runId },
          'compile resume SSE stream error',
        );
        send('error', {
          step: 'finalize',
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        safeEnd();
      }
    },
  );

  // 批量编译端点：POST /api/compile/batch
  // 接收 multipart 多文件（字段名 files），按顺序串行编译每个文件，SSE 推送进度。
  // 为什么不并行：withCompileLock 是全局串行队列，batch 内部已串行；
  //   并行编译会导致 index.md/log.md 追加竞态（与单文件 compile 同理）
  // 为什么 batch 限流更严格（5/min）：批量端点单请求触发多次 LLM 调用，比单文件消耗更多 token
  app.post('/api/compile/batch', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    // 收集所有上传的文件：request.files() 是 async iterator
    const uploaded: Array<{ name: string; buffer: Buffer }> = [];
    try {
      for await (const f of request.files()) {
        // 字段名约定为 files（复数），忽略其他字段以兼容未来扩展
        if (f.fieldname !== 'files') continue;
        uploaded.push({ name: f.filename, buffer: await f.toBuffer() });
      }
    } catch (err: unknown) {
      request.log.error({ err }, 'batch compile multipart parse error');
      return reply.code(400).send({ error: '文件解析失败' });
    }

    if (uploaded.length === 0) {
      return reply.code(400).send({ error: '缺少 files 字段或文件为空' });
    }

    // 扩展名白名单校验：为什么用白名单而非黑名单：黑名单无法覆盖所有危险类型（如 .exe/.js），白名单更安全
    const { validFiles, rejected } = validateBatchFiles(uploaded, batch);

    if (validFiles.length === 0) {
      return reply.code(400).send({
        error: '没有符合白名单的文件',
        rejected,
      });
    }

    // 批量大小上限校验：防止单请求触发过多 LLM 调用导致 token 耗尽
    if (validFiles.length > batch.maxBatchSize) {
      return reply.code(400).send({
        error: `批量编译文件数 ${validFiles.length} 超过上限 ${batch.maxBatchSize}`,
      });
    }

    // SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 通过工厂创建 SSE sender：客户端 abort 时 send 自动短路，safeEnd 容错结束流
    const { send, isAborted, safeEnd } = createSSESender(reply, request);

    // 推送文件列表与被拒绝项，前端据此渲染初始分组
    send('batch_start', {
      step: 'batch_start',
      status: 'running',
      message: `开始批量编译 ${validFiles.length} 个文件`,
      data: {
        fileCount: validFiles.length,
        rejected,
      },
    });

    // 临时文件路径列表，无论成功失败都需清理
    const tmpPaths: string[] = [];
    const fileCount = validFiles.length;

    // 单文件编译流式推送：提取为局部函数降低 withCompileLock 回调认知复杂度
    // 返回值表示该文件是否成功（用于决定是否发送 file_complete 事件）
    const streamFileCompile = async (
      input: CompileInput,
      fileIndex: number,
      fileName: string,
    ): Promise<boolean> => {
      let fileFailed = false;
      try {
        for await (const ev of adapter.compile(input, appConfig)) {
          // 客户端已断开：提前退出迭代，停止当前文件的剩余步骤
          if (isAborted()) break;
          // 把 fileIndex/fileCount/fileName 注入到每个事件的 data，前端按 fileIndex 路由到对应分组
          const evWithData = {
            ...ev,
            data: {
              ...ev.data,
              fileIndex,
              fileCount,
              fileName,
            },
          };
          if (ev.step === 'done') {
            send('file_done', evWithData);
          } else if (ev.data?.path && ev.data?.title) {
            send('page', evWithData);
          } else {
            send('progress', evWithData);
          }
        }
      } catch (err: unknown) {
        fileFailed = true;
        const errMsg = err instanceof Error ? err.message : String(err);
        request.log.error(
          { err, fileName, fileIndex },
          'batch compile file error',
        );
        send('file_error', {
          step: 'finalize',
          status: 'error',
          message: `文件 ${fileName} 编译失败: ${errMsg}`,
          data: { fileIndex, fileCount, fileName },
        });
      }
      return !fileFailed;
    };

    try {
      // batch 整体作为 withCompileLock 的一个任务，保证与其他 compile/resume 请求串行
      await withCompileLock(async () => {
        for (let i = 0; i < validFiles.length; i++) {
          // 客户端已断开：提前退出循环，停止后续文件编译避免无谓 LLM 调用
          if (isAborted()) break;
          const f = validFiles[i];
          // 落盘到临时文件：compile-workflow 通过 fs.readFile 读取后存档到 raw/
          const tmp = path.join(os.tmpdir(), `wiki-batch-${Date.now()}-${process.pid}-${i}-${f.name}`);
          await fs.writeFile(tmp, f.buffer);
          tmpPaths.push(tmp);

          const input: CompileInput = { type: 'file', content: tmp, originalName: f.name };

          // 单文件开始事件：前端据此创建分组容器
          send('file_start', {
            step: 'archive',
            status: 'running',
            message: `开始编译文件 ${i + 1}/${fileCount}: ${f.name}`,
            data: { fileIndex: i, fileCount, fileName: f.name },
          });

          const success = await streamFileCompile(input, i, f.name);
          // 文件结束事件：标记该分组完成（仅成功时），前端据此切换 UI 状态
          if (success) {
            send('file_complete', {
              step: 'finalize',
              status: 'done',
              message: `文件 ${i + 1}/${fileCount} 完成: ${f.name}`,
              data: { fileIndex: i, fileCount, fileName: f.name },
            });
          }
        }
      });

      // 整体完成事件：包含总文件数与失败计数（前端需统计 file_error 事件）
      // 客户端可能已断开，send 内部会自动短路
      send('batch_done', {
        step: 'done',
        status: 'done',
        message: `批量编译完成，共处理 ${fileCount} 个文件`,
        data: { fileCount },
      });
    } catch (err: unknown) {
      request.log.error({ err }, 'batch compile SSE stream error');
      send('error', {
        step: 'finalize',
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // 清理临时文件：避免 tmp 目录残留
      for (const tmp of tmpPaths) {
        await fs.unlink(tmp).catch(() => {});
      }
      safeEnd();
    }
  });
}

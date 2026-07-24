// QQ 聊天记录导入子系统路由（SRS §6.1 路由族）
// 注册 6 个端点：upload/preview/extract/drafts/compile/compile/batch
// M1 阶段实现：upload（完整）、preview（完整）、drafts（完整）、compile（复用 adapter）
// M1 桩实现：extract（501，待 M2 实现 LLM 抽取）、compile/batch（501，待 M2 实现）

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EngineAdapter, AppConfig, QqPreprocessResult, QqConfig } from '../types.js';
import type { VaultService } from '../vault/vault-service.js';
import { createSSESender } from '../utils/sse.js';
import { withCompileLock } from '../compile-queue.js';
import { preprocessQqChat, redactExtractOutput } from '../qq-ingest/preprocess/qq-preprocess.js';
import { extractWorkflow } from '../qq-ingest/qq-extract-workflow.js';
import { saveQqConfig } from '../config.js';

// rawId 校验正则：UUID v4 格式，防路径穿越
const RAW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// draftPath 校验正则：仅允许 drafts/ 目录下的 .md 文件，防路径穿越
const DRAFT_PATH_PATTERN = /^drafts\/[\w\u4e00-\u9fa5-]+\.md$/i;

// 注册 QQ 导入路由族
// 为什么需要 config 参数：qq 配置字段可能缺失，路由层用 config.qq ?? defaultQqConfig 兜底
export function registerQqIngestRoute(
  app: FastifyInstance,
  adapter: EngineAdapter,
  vault: VaultService,
  config: AppConfig,
) {
  const qqConfig = config.qq ?? {
    noise_rules: { 'NR-1': true, 'NR-2': true, 'NR-3': true, 'NR-4': true, 'NR-5': true, 'NR-6': true },
    // 用 String.raw 避免双反斜杠转义，正则模式更接近字面量形式，降低维护时的心智负担
    privacy_patterns: {
      phone: String.raw`1[3-9]\d{9}`,
      id_card: String.raw`\d{17}[\dXx]`,
      email: String.raw`[\w.-]+@[\w.-]+\.\w+`,
      card: String.raw`\d{16,19}`,
      qq: String.raw`(?<=QQ|扣扣|qq号|企鹅)\s*[0-9]{5,11}`,
    },
    max_batch_size: 20,
    chunk_threshold: 200,
    extract_model: 'glm-4-plus',
    extract_base_url: '',
    extract_token_budget: 50000,
  };

  // ==========================================================================
  // POST /api/qq-ingest/upload
  // 上传 QQ 文件（.txt/.json），触发预清洗，返回 SSE 流（含进度与最终结果）
  // ==========================================================================
  app.post('/api/qq-ingest/upload', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: '缺少 file 字段' });
    }

    // 文件大小校验：与 multipart 全局上限 10MB 一致
    const buffer = await file.toBuffer();
    const fileName = file.filename || 'unknown.txt';

    // SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const { send, isAborted, safeEnd } = createSSESender(reply, request);

    try {
      // 阶段1：解析与格式归一化
      send('progress', { step: 'parse', status: 'running', message: `开始解析文件: ${fileName}` });

      const rawText = buffer.toString('utf8');
      const data = await preprocessQqChat(rawText, fileName, qqConfig);

      if (isAborted()) { safeEnd(); return; }

      // 阶段2：噪声过滤与脱敏（preprocessQqChat 内部已完成，发送统计进度）
      send('progress', {
        step: 'filter',
        status: 'done',
        message: `过滤完成：原始 ${data.result.meta.originalCount} 条 → 保留 ${data.result.meta.filteredCount} 条，脱敏 ${data.result.meta.redactedCount} 条`,
        data: data.result.meta,
      });

      // 阶段3：落盘到 raw/（复用 VaultService.archiveRaw，确保路径越界校验）
      // 文件名追加 rawId，便于 preview 通过 rawId 查找
      const rawFileNameWithId = `${data.rawFileName.replace(/\.json$/, '')}-${data.result.rawId}.json`;
      // 在 JSON 内容的 meta 中追加 rawId，便于后续溯源
      const jsonWithId = JSON.parse(data.jsonContent);
      jsonWithId.meta.rawId = data.result.rawId;
      const rawPath = await vault.archiveRaw(rawFileNameWithId, JSON.stringify(jsonWithId, null, 2));

      const result: QqPreprocessResult = {
        ...data.result,
        rawPath,
      };

      send('done', { step: 'done', status: 'done', message: '预清洗完成', data: result });
    } catch (err: unknown) {
      // SSE 错误双写：前端推送 + 后端日志（硬约束：SSE catch 必须request.log.error）
      request.log.error({ err, fileName }, 'qq-ingest upload error');
      send('error', {
        step: 'upload',
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      safeEnd();
    }
  });

  // ==========================================================================
  // GET /api/qq-ingest/preview/:rawId
  // 预览清洗后中间格式 JSON
  // ==========================================================================
  app.get<{ Params: { rawId: string } }>(
    '/api/qq-ingest/preview/:rawId',
    async (request, reply) => {
      const { rawId } = request.params;
      if (!RAW_ID_PATTERN.test(rawId)) {
        return reply.code(400).send({ error: '无效的 rawId' });
      }

      try {
        // 遍历 raw/ 目录查找文件名含 rawId 的文件
        // 为什么遍历而非直接拼接路径：rawId 是 UUID，文件名还含 chatName/dateRange，无法直接拼
        const tree = await vault.listTree('raw');
        const qqFiles = tree.filter(
          (n) => n.type === 'file' && n.name.endsWith('.json') && n.name.includes(rawId),
        );

        if (qqFiles.length === 0) {
          return reply.code(404).send({ error: `未找到 rawId=${rawId} 对应的预清洗结果` });
        }

        // 读取第一个匹配文件（rawId 是 UUID，理论上唯一）
        const content = await vault.readFile(qqFiles[0].path);
        const parsed = JSON.parse(content);
        return reply.send(parsed);
      } catch (err: unknown) {
        request.log.error({ err, rawId }, 'qq-ingest preview error');
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ==========================================================================
  // POST /api/qq-ingest/extract/:rawId
  // 触发价值抽取（SSE 流）
  // M2 实现：调用 extractWorkflow（LLM 单轮抽取 + draft 写入 + 二次脱敏）
  // ==========================================================================
  app.post<{ Params: { rawId: string } }>(
    '/api/qq-ingest/extract/:rawId',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { rawId } = request.params as { rawId: string };
      if (!RAW_ID_PATTERN.test(rawId)) {
        return reply.code(400).send({ error: '无效的 rawId' });
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
        // withCompileLock 串行化：避免 drafts/ 目录并发写入导致文件交错
        // 与 compile 端点共用同一锁，避免 extract + compile 同时写 drafts/ 目录
        await withCompileLock(async () => {
          for await (const ev of extractWorkflow({ rawId, vault, config, logger: request.log })) {
            if (isAborted()) break;
            // 事件映射：与 compile 端点同模式
            // - step='done' → 'done' 事件（前端终止 SSE 流）
            // - step='draft_written' (data 含 path+title) → 'page' 事件（前端渲染 draft 列表）
            // - 其他 → 'progress' 事件（前端更新进度条）
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
        // SSE 错误双写：前端推送 + 后端日志（硬约束：SSE catch 必须 request.log.error）
        request.log.error({ err, rawId }, 'qq-ingest extract error');
        send('error', {
          step: 'extract',
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        safeEnd();
      }
    },
  );

  // ==========================================================================
  // GET /api/qq-ingest/drafts
  // 列出 draft 状态页面（扫描 vault/drafts/ 目录）
  // ==========================================================================
  app.get('/api/qq-ingest/drafts', async (request, reply) => {
    try {
      // drafts 目录可能不存在（首次使用），返回空数组
      const tree = await vault.listTree('drafts').catch(() => []);
      const drafts = tree
        .filter((n) => n.type === 'file' && n.name.endsWith('.md'))
        .map((n) => ({ path: n.path, name: n.name }));
      return reply.send({ drafts });
    } catch (err: unknown) {
      request.log.error({ err }, 'qq-ingest drafts list error');
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ==========================================================================
  // POST /api/qq-ingest/compile/:draftPath
  // 触发单 draft 编译为正式页面（复用 adapter.compile，SSE 流）
  // SRS §5.3.3：draft 路径作为 CompileInput type:'file' 输入，零接口改动
  // ==========================================================================
  app.post<{ Params: { draftPath: string } }>(
    '/api/qq-ingest/compile/:draftPath',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { draftPath } = request.params as { draftPath: string };
      // 路径穿越防护：draftPath 必须匹配 drafts/xxx.md 格式
      const decoded = decodeURIComponent(draftPath);
      if (!DRAFT_PATH_PATTERN.test(decoded)) {
        return reply.code(400).send({ error: '无效的 draftPath，必须为 drafts/xxx.md 格式' });
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
        // 读取 draft 文件内容，作为 text 类型输入 adapter.compile
        // 为什么用 text 而非 file：draft 文件已在 vault 内，adapter.compile 的 file 模式期望临时文件路径
        const draftContent = await vault.readFile(decoded);

        // 输出脱敏扫描（SRS §5.1.3 双向脱敏的"输出后"扫描）
        const redactedContent = redactExtractOutput(draftContent, qqConfig);

        await withCompileLock(async () => {
          for await (const ev of adapter.compile({ type: 'text', content: redactedContent })) {
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
        request.log.error({ err, draftPath: decoded }, 'qq-ingest compile error');
        send('error', {
          step: 'compile',
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        safeEnd();
      }
    },
  );

  // ==========================================================================
  // POST /api/qq-ingest/compile/batch
  // 批量编译多个 draft（SSE 流）
  // M2 实现：串行编译多个 draft，复用 adapter.compile
  // 请求体：{ drafts?: string[] }，未提供时扫描 drafts/ 目录全部 .md 文件
  // 上限：config.batch.maxBatchSize（默认 50），防滥用
  // ==========================================================================
  app.post('/api/qq-ingest/compile/batch', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { drafts?: string[] };

    // 解析待编译 draft 列表：请求体显式指定 > 扫描 drafts/ 目录
    let draftPaths: string[];
    if (Array.isArray(body.drafts) && body.drafts.length > 0) {
      draftPaths = body.drafts;
    } else {
      try {
        const tree = await vault.listTree('drafts').catch(() => []);
        draftPaths = tree
          .filter((n) => n.type === 'file' && n.name.endsWith('.md'))
          .map((n) => n.path);
      } catch (err) {
        request.log.error({ err }, 'qq-ingest compile/batch scan drafts error');
        return reply.code(500).send({ error: '扫描 drafts 目录失败' });
      }
    }

    // 路径穿越防护：每个 draftPath 必须匹配 drafts/xxx.md 格式
    const invalidPaths = draftPaths.filter((p) => !DRAFT_PATH_PATTERN.test(p));
    if (invalidPaths.length > 0) {
      return reply.code(400).send({
        error: '存在无效的 draftPath，必须为 drafts/xxx.md 格式',
        invalid: invalidPaths,
      });
    }

    // 上限校验：与 batch.maxBatchSize 联动，防滥用
    const maxBatchSize = config.batch?.maxBatchSize ?? 50;
    if (draftPaths.length > maxBatchSize) {
      return reply.code(400).send({
        error: `批量编译上限 ${maxBatchSize}，当前 ${draftPaths.length} 个 draft`,
        hint: '请分批提交或调整 config.batch.maxBatchSize',
      });
    }

    if (draftPaths.length === 0) {
      return reply.code(400).send({ error: '无可编译的 draft 文件' });
    }

    // SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const { send, isAborted, safeEnd } = createSSESender(reply, request);

    // 批量进度统计
    const total = draftPaths.length;
    let successCount = 0;
    let failCount = 0;

    // 单 draft 编译流式推送：提取为局部函数降低 withCompileLock 回调认知复杂度
    // 返回值表示该 draft 是否编译成功；失败计数通过闭包修改 failCount
    const compileSingleDraft = async (
      draftPath: string,
      index: number,
    ): Promise<boolean> => {
      const fileName = draftPath.split('/').pop() ?? draftPath;

      send('progress', {
        step: 'compile',
        status: 'running',
        message: `编译 ${index + 1}/${total}: ${fileName}`,
        data: { fileIndex: index, fileCount: total, fileName, path: draftPath },
      });

      try {
        // 读取 draft 文件内容，作为 text 类型输入 adapter.compile
        // 与单 draft compile 端点同模式：text 而非 file（draft 已在 vault 内）
        const draftContent = await vault.readFile(draftPath);
        const redactedContent = redactExtractOutput(draftContent, qqConfig);

        let draftSuccess = false;
        for await (const ev of adapter.compile({ type: 'text', content: redactedContent })) {
          if (isAborted()) break;
          // 事件映射：与单 draft compile 端点同模式，附加批量定位信息
          // 为什么覆盖 ev.data：保留原 ev.data 的 path/title，同时追加 fileIndex/fileCount/fileName
          const enrichedEv = {
            ...ev,
            data: {
              ...ev.data,
              fileIndex: index,
              fileCount: total,
              fileName,
              path: ev.data?.path ?? draftPath,
            },
          };
          if (ev.step === 'done') {
            send('done', enrichedEv);
            draftSuccess = ev.status === 'done';
          } else if (ev.data?.path && ev.data?.title) {
            send('page', enrichedEv);
          } else {
            send('progress', enrichedEv);
          }
        }

        return draftSuccess;
      } catch (err) {
        // 单 draft 编译失败不阻塞后续，记录错误继续
        request.log.error({ err, draftPath }, 'qq-ingest compile/batch single error');
        send('error', {
          step: 'compile',
          status: 'error',
          message: `编译失败 ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
          data: { fileIndex: index, fileCount: total, fileName, path: draftPath },
        });
        return false;
      }
    };

    try {
      // withCompileLock 包裹整个批量任务：与单 draft compile 端点共用锁，避免并发写 drafts/
      // 为什么不在循环内每个 draft 单独 withCompileLock：那样会增加锁竞争且 batch 之间无法保证原子性
      await withCompileLock(async () => {
        send('progress', {
          step: 'batch_start',
          status: 'running',
          message: `开始批量编译，共 ${total} 个 draft`,
          data: { fileCount: total },
        });

        for (let i = 0; i < draftPaths.length; i++) {
          if (isAborted()) break;
          const success = await compileSingleDraft(draftPaths[i], i);
          if (success) {
            successCount++;
          } else {
            failCount++;
          }
        }

        send('done', {
          step: 'batch_done',
          status: 'done',
          message: `批量编译完成：成功 ${successCount}/${total}，失败 ${failCount}`,
          data: { fileCount: total, path: `success=${successCount},fail=${failCount}` },
        });
      });
    } catch (err: unknown) {
      // SSE 错误双写：前端推送 + 后端日志（硬约束：SSE catch 必须 request.log.error）
      request.log.error({ err }, 'qq-ingest compile/batch error');
      send('error', {
        step: 'batch',
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      safeEnd();
    }
  });

  // ==========================================================================
  // GET /api/qq-ingest/config
  // 读取 QQ 导入子系统配置（config.json → qq 字段）
  // 为什么独立端点而非复用 /api/config：qq 字段结构复杂且可选，独立端点便于前端按需拉取
  // 缺失时返回默认值，确保前端表单始终有可编辑内容
  // ==========================================================================
  app.get('/api/qq-ingest/config', async (request, reply) => {
    try {
      // config.qq 可能缺失（首次使用），用默认值兜底
      const qq: QqConfig = config.qq ?? {
        noise_rules: {
          'NR-1': true, 'NR-2': true, 'NR-3': true,
          'NR-4': true, 'NR-5': true, 'NR-6': true,
        },
        privacy_patterns: {
          phone: String.raw`1[3-9]\d{9}`,
          id_card: String.raw`\d{17}[\dXx]`,
          email: String.raw`[\w.-]+@[\w.-]+\.\w+`,
          card: String.raw`\d{16,19}`,
          qq: String.raw`(?<=QQ|扣扣|qq号|企鹅)\s*[0-9]{5,11}`,
        },
        max_batch_size: 20,
        chunk_threshold: 200,
        extract_model: 'glm-4-plus',
        extract_base_url: '',
        extract_token_budget: 50000,
      };
      return reply.send({ qq });
    } catch (err: unknown) {
      request.log.error({ err }, 'qq-ingest config get error');
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ==========================================================================
  // PUT /api/qq-ingest/config
  // 更新 QQ 导入子系统配置（noise_rules/privacy_patterns/max_batch_size 等）
  // 仅更新显式提供的字段，未提供字段保留原值（saveQqConfig 内部条件合并）
  // 安全：privacy_patterns 是用户自定义正则，运行时由 qq-preprocess 编译，需 try/catch 防止正则错误
  // ==========================================================================
  app.put('/api/qq-ingest/config', async (request, reply) => {
    // 兼容两种请求格式：{ qq: QqConfig }（前端 Config.vue）和 QqConfig（直接传）
    // 为什么需要兼容：前端 saveQqConfigForm 发送 { qq: qqConfig }，但 API 约定可能变化
    const raw = (request.body ?? {}) as { qq?: Partial<QqConfig> } & Partial<QqConfig>;
    const body = raw.qq ?? raw;
    try {
      const updated = await saveQqConfig({
        noise_rules: body.noise_rules,
        privacy_patterns: body.privacy_patterns,
        max_batch_size: body.max_batch_size,
        chunk_threshold: body.chunk_threshold,
        extract_model: body.extract_model,
        extract_base_url: body.extract_base_url,
        extract_token_budget: body.extract_token_budget,
      });
      // 同步更新运行时 config 引用，避免后续路由用旧值
      config.qq = updated.qq;
      return reply.send({ qq: updated.qq });
    } catch (err: unknown) {
      request.log.error({ err }, 'qq-ingest config put error');
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

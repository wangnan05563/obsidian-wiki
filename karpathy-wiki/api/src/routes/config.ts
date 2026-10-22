import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  loadConfig,
  reloadConfig,
  saveBudgetConfig,
  saveHealthCheckConfig,
  saveBatchConfig,
  saveLoggingConfig,
  saveSubAgentConfig,
  saveMcpConfig,
  maskApiKey,
  buildConfigExport,
  importConfigData,
  ConfigMigrationError,
} from '../config.js';
import type { AppConfig } from '../types.js';
import type { HarnessAdapter } from '../engine/harness-adapter.js';
import { resolveSubAgents } from '../engine/harness-adapter.js';
import type { IsolationGuards } from '../middleware/auth.js';
import { createIsolationGuards, audit } from '../middleware/auth.js';
import {
  CONFIG_EFFECT_ITEMS,
  changedRestartKeys,
  restartHints,
  restartKeys,
  restartKeysForChange,
  valueChangedForConfigKey,
} from '../utils/config-effects.js';
// T02622：受控重启（A 方案）。空闲口径与清理守卫同源，拉起方按打包/dev 分两条通道。
import { activeStateAcrossProcesses } from '../cleanup-guard.js';
import { queuedCompileCount } from '../compile-queue.js';
import { performRestart, restartRefusal, RESTART_EXIT_DELAY_MS, type RestartMode } from '../restart.js';

/** 由 index.ts 注入：bootId 供前端确认「真的换了进程」，afterRestart 负责延迟关停旧实例。 */
export interface RestartController {
  bootId(): string;
  /** 打包通道：延迟执行优雅 shutdown；dev 通道由 watcher 杀旧进程，这里不做事 */
  afterRestart(mode: RestartMode): void;
  /** 覆盖拉起动作（测试用，避免真的动源码/拉进程）；默认走 restart.ts 的形态分派 */
  perform?: () => RestartMode;
}

// PUT 请求体字段名 → config-effects 登记 key 的映射。
// 为什么要显式声明：登记表按「用户可感知的配置项」组织，路由按「请求体字段」组织，
// 两者名字不同（maxFileSizeMb ↔ multipart.fileSize、level ↔ logging.level），
// 由路由自己给出映射，登记表保持与 UI 一致，避免两边互相猜。
const BATCH_RESTART_FIELD_MAP: Readonly<Record<string, string>> = {
  maxFileSizeMb: 'multipart.fileSize',
};
const LOGGING_RESTART_FIELD_MAP: Readonly<Record<string, string>> = {
  level: 'logging.level',
};

// 只为「判断字段是否真的改了 / 导入覆盖了哪些需重启项」而读配置。
// 读失败不能把一次已经成功的保存变成 500，也不能谎报「不用重启」——统一归 null，
// 由 valueChangedForConfigKey / changedRestartKeys 按保守口径处理（当作改了 / 列全量）。
async function readConfigForCompare(): Promise<AppConfig | null> {
  try {
    return (await loadConfig()) ?? null;
  } catch {
    return null;
  }
}

// 注册配置路由。
//   GET  /api/config                  读取当前配置（API Key 字段脱敏）
//   PUT  /api/config                  仅校验反馈，不落盘（向后兼容保留）
//   POST /api/config/reload           §12.3-7 热加载：重读 config.json 并将可热更新字段应用到 adapter
//   POST /api/restart                 T02622：受控重启（确认 + 空闲判定 + 先回 202 再退出）
//   GET  /api/config/effects          T02467 字段生效登记表（即时/热加载/需重启），前端徽标与待重启汇总的可信源
//   PUT  /api/config/budget           保存运行参数（maxSteps/tokenBudget）+ 同步 adapter
//   PUT  /api/config/health-check     保存健康检查阈值（staleDays）+ 同步 adapter
//   PUT  /api/config/batch            保存批量编译配置（需重启 multipart 限制才完全生效）
//   PUT  /api/config/logging          保存日志配置（level 需重启，enableRequestLog 可热更新）
// 配置中心前端展示与编辑入口，落盘 + 同步 adapter 运行时实例，避免双轨不一致。
export function registerConfigRoute(
  app: FastifyInstance,
  adapter: HarnessAdapter,
  guards: IsolationGuards = createIsolationGuards(),
  restart: RestartController,
) {
  app.get('/api/config', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } }, preHandler: guards.requireAuth }, async (_request, reply) => {
    const config = await loadConfig();
    // 脱敏：apiKeyRef 是环境变量名（非 Key 本身），可展示；实际 Key 不返回
    return void reply.send({
      vaultPath: config.vaultPath,
      adapter: config.adapter,
      llm: {
        provider: config.llm.provider,
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        apiKeyRef: config.llm.apiKeyRef,
        apiKeySet: Boolean(process.env[config.llm.apiKeyRef]),
        // §真流式默认值：前端 Config 页面展示，Query 页面开关可按请求覆盖
        stream: config.llm.stream ?? false,
      },
      budget: config.budget,
      server: config.server,
      localOnly: config.localOnly,
      healthCheck: config.healthCheck,
      // 暴露 batch/logging 给前端 Config.vue 展示与编辑
      batch: config.batch ?? {
        allowedExtensions: ['md', 'txt', 'pdf', 'html', 'json'],
        maxBatchSize: 20,
        maxFileSizeMb: 10,
      },
      logging: config.logging ?? { level: 'info', enableRequestLog: true },
      // 子智能体（多步 Agent）开关：前端 Config 页面「系统配置」实时切换
      enableSubAgents: config.enableSubAgents ?? false,
    });
  });

  // 向后兼容保留：原 PUT /api/config 不落盘，仅返回提示。
  // 新代码应使用 PUT /api/config/{budget,health-check,batch,logging} 子资源接口。
  app.put('/api/config', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Partial<AppConfig>;
    if (!body) {
      return void reply.code(400).send({ error: '请求体为空' });
    }
    return void reply.send({
      ok: true,
      message: '配置已收到。请使用 PUT /api/config/{budget,health-check,batch,logging} 子资源接口进行持久化。',
    });
  });

  // §12.3-7 热加载：重读 config.json，将可热更新字段（model/maxSteps/tokenBudget/staleDays）
  // 即时同步到运行中的 adapter。需重启字段清单由 config-effects 登记表给出（不再硬编码）。
  app.post('/api/config/reload', { preHandler: guards.requireAdmin }, async (_request, reply) => {
    const fresh = await reloadConfig();
    adapter.updateConfig({
      model: fresh.llm.model,
      maxSteps: fresh.budget.maxSteps,
      tokenBudget: fresh.budget.tokenBudget,
      staleDays: fresh.healthCheck.staleDays,
    });
    // 热加载无法逐项比对「哪些需重启字段真的变了」（旧值已被覆盖），
    // 因此保守地把全部需重启字段交给前端汇总，由用户确认重启后清除。
    const requireRestart = restartKeys();
    return void reply.send({
      ok: true,
      applied: {
        model: fresh.llm.model,
        maxSteps: fresh.budget.maxSteps,
        tokenBudget: fresh.budget.tokenBudget,
        staleDays: fresh.healthCheck.staleDays,
      },
      requireRestart,
      restartHints: restartHints(requireRestart),
    });
  });

  // T02622 / PRD §10 C1「一键重启」的受控通道（A 方案）。
  // 三道门缺一不可：
  //  1) confirm 显式确认：这不是「保存」，是让服务退出再起来，误触/误 curl 的代价是切断所有人；
  //  2) 空闲判定：有编译/问答在跑就拒绝并列名（口径与清理守卫同源，跨进程合并）；
  //  3) 先回 202 再退出：浏览器必须拿到响应才能开始轮询 /health 的 bootId。
  // 为什么不是 delayed SIGTERM：Windows 上 process.kill(pid,'SIGTERM') 是 TerminateProcess，
  // SIGTERM 处理器不会执行；这里改成由 index.ts 注入的优雅 shutdown（停隧道/工具/日志 flush），
  // 语义与 Ctrl+C 一致，只是延迟一点执行。
  app.post('/api/restart', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = (request.body ?? {}) as { confirm?: unknown };
    if (body.confirm !== true) {
      return void reply.code(400).send({
        code: 'restart_confirm_required',
        error: '重启会中断所有连接：请在确认后调用（confirm: true）',
      });
    }
    const active = await activeStateAcrossProcesses();
    const refusal = restartRefusal(active, queuedCompileCount());
    if (refusal) return void reply.code(409).send(refusal);

    const mode = (restart.perform ?? performRestart)();
    const payload = {
      ok: true,
      mode,
      bootId: restart.bootId(),
      pid: process.pid,
      delayMs: RESTART_EXIT_DELAY_MS,
      note:
        mode === 'packaged'
          ? '新实例正在拉起；页面会轮询 bootId，换进程后自动刷新。'
          : '已触发开发模式的监听重跑；页面会轮询 bootId 确认，若 15 秒内没变化请手动重启。',
    };
    reply.code(202).send(payload);
    // 必须在 send 之后：旧实例要先把 202 交出去，再关自己
    restart.afterRestart(mode);
  });

  // GET /api/config/effects：字段生效登记表（T02467 / REQ-032 单一可信源）。
  // 鉴权：requireAuth 而非 requireAdmin——普通用户同样要能在「朗读设置 / AI 服务」等
  // 自有 tab 上看到「即时生效」徽标，且登记表本身不含任何密钥。
  app.get('/api/config/effects', { preHandler: guards.requireAuth }, async (_request, reply) => {
    return void reply.send({
      items: CONFIG_EFFECT_ITEMS,
      restartKeys: restartKeys(),
      // 两条路径的取值域分开返回，前端图例不必自己猜：
      //   界面保存只有「即时 / 需重启」；直接改文件多出「热加载」这一档。
      uiEffects: ['instant', 'restart'],
      fileEffects: ['instant', 'reload', 'restart'],
    });
  });

  // 保存运行参数（maxSteps/tokenBudget）到 config.json + 同步 adapter 运行时。
  // 为什么需要：用户在前端 Config.vue 调整 token 预算与步数上限后，需即时生效无需重启。
  app.put('/api/config/budget', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      maxSteps?: number;
      tokenBudget?: number;
    };
    if (!body) {
      return void reply.code(400).send({ error: '请求体为空' });
    }
    // 输入校验：maxSteps 必须为正整数，tokenBudget 必须为正整数
    if (body.maxSteps !== undefined && (!Number.isInteger(body.maxSteps) || body.maxSteps < 1)) {
      return void reply.code(400).send({ error: 'maxSteps 必须为正整数' });
    }
    if (body.tokenBudget !== undefined && (!Number.isInteger(body.tokenBudget) || body.tokenBudget < 1)) {
      return void reply.code(400).send({ error: 'tokenBudget 必须为正整数' });
    }
    try {
      const merged = await saveBudgetConfig({
        maxSteps: body.maxSteps,
        tokenBudget: body.tokenBudget,
      });
      // 落盘后同步 adapter 运行时实例，避免下次请求使用旧值
      adapter.updateConfig({
        maxSteps: merged.budget.maxSteps,
        tokenBudget: merged.budget.tokenBudget,
      });
      return void reply.send({
        ok: true,
        config: merged.budget,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return void reply.code(500).send({ error: msg });
    }
  });

  // 保存健康检查配置（staleDays）到 config.json + 同步 adapter 运行时。
  // 为什么需要：用户根据知识库更新频率调整"过期页面"判定阈值后，需即时生效。
  app.put('/api/config/health-check', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      staleDays?: number;
    };
    if (!body) {
      return void reply.code(400).send({ error: '请求体为空' });
    }
    if (body.staleDays !== undefined && (!Number.isInteger(body.staleDays) || body.staleDays < 1)) {
      return void reply.code(400).send({ error: 'staleDays 必须为正整数' });
    }
    try {
      const merged = await saveHealthCheckConfig({
        staleDays: body.staleDays,
      });
      adapter.updateConfig({
        staleDays: merged.healthCheck.staleDays,
      });
      return void reply.send({
        ok: true,
        config: merged.healthCheck,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return void reply.code(500).send({ error: msg });
    }
  });

  // 保存批量编译配置（allowedExtensions/maxBatchSize/maxFileSizeMb）到 config.json。
  // 为什么不能热更新：multipart fileSize 限制在 Fastify 启动时注册，运行时不可变更。
  //   allowedExtensions/maxBatchSize 可热更新但为避免与 multipart 限制脱节，统一提示重启。
  app.put('/api/config/batch', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      allowedExtensions?: string[];
      maxBatchSize?: number;
      maxFileSizeMb?: number;
    };
    if (!body) {
      return void reply.code(400).send({ error: '请求体为空' });
    }
    // 输入校验：maxBatchSize/maxFileSizeMb 必须为正整数；allowedExtensions 必须为字符串数组
    if (body.maxBatchSize !== undefined && (!Number.isInteger(body.maxBatchSize) || body.maxBatchSize < 1)) {
      return void reply.code(400).send({ error: 'maxBatchSize 必须为正整数' });
    }
    if (body.maxFileSizeMb !== undefined && (!Number.isInteger(body.maxFileSizeMb) || body.maxFileSizeMb < 1)) {
      return void reply.code(400).send({ error: 'maxFileSizeMb 必须为正整数' });
    }
    if (body.allowedExtensions !== undefined) {
      if (!Array.isArray(body.allowedExtensions) || body.allowedExtensions.some(e => typeof e !== 'string' || !e.trim())) {
        return void reply.code(400).send({ error: 'allowedExtensions 必须为非空字符串数组' });
      }
    }
    try {
      // 与落盘前的现值比对：只有真的改了单文件上限才提示重启。
      // 否则前端每次保存（表单总是带上全部字段）都会误报「需重启」，正是 C1 说的不可预判。
      const before = await readConfigForCompare();
      const changed: string[] = [];
      if (body.maxFileSizeMb !== undefined && valueChangedForConfigKey(before, 'multipart.fileSize', body.maxFileSizeMb)) {
        changed.push('maxFileSizeMb');
      }
      const merged = await saveBatchConfig({
        allowedExtensions: body.allowedExtensions?.map(e => e.trim().toLowerCase()),
        maxBatchSize: body.maxBatchSize,
        maxFileSizeMb: body.maxFileSizeMb,
      });
      const requireRestart = restartKeysForChange(changed, BATCH_RESTART_FIELD_MAP);
      return void reply.send({
        ok: true,
        config: merged.batch,
        // 需重启判定来自 config-effects 登记表，不在此另写一份
        requireRestart,
        restartHints: restartHints(requireRestart),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return void reply.code(500).send({ error: msg });
    }
  });

  // 保存日志配置（level/enableRequestLog）到 config.json。
  // 为什么 level 需重启：pino logger 在 Fastify 启动时创建，运行时不可变更级别。
  //   enableRequestLog 可热更新（路由钩子运行时读取 config）。
  app.put('/api/config/logging', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      level?: string;
      enableRequestLog?: boolean;
    };
    if (!body) {
      return void reply.code(400).send({ error: '请求体为空' });
    }
    // 输入校验：level 必须为有效 pino 级别
    const validLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
    if (body.level !== undefined && !validLevels.includes(body.level)) {
      return void reply.code(400).send({ error: `level 必须为: ${validLevels.join(', ')}` });
    }
    if (body.enableRequestLog !== undefined && typeof body.enableRequestLog !== 'boolean') {
      return void reply.code(400).send({ error: 'enableRequestLog 必须为 boolean' });
    }
    try {
      // 同上：只有真的改了 level 才提示重启（前端表单总是带上两个字段）
      const before = await readConfigForCompare();
      const changed: string[] = [];
      if (body.level !== undefined && valueChangedForConfigKey(before, 'logging.level', body.level)) {
        changed.push('level');
      }
      const merged = await saveLoggingConfig({
        level: body.level,
        enableRequestLog: body.enableRequestLog,
      });
      const requireRestart = restartKeysForChange(changed, LOGGING_RESTART_FIELD_MAP);
      return void reply.send({
        ok: true,
        config: merged.logging,
        // level 需重启、enableRequestLog 即时——按登记表派生，只在实际改了 level 时提示
        requireRestart,
        restartHints: restartHints(requireRestart),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return void reply.code(500).send({ error: msg });
    }
  });

  // 保存子智能体（多步 Agent）开关到 config.json + 同步 adapter 运行时。
  // 为什么需要：用户在 Config 页面「系统配置」实时开启/关闭 researcher 子智能体，
  // 需即时生效（下次问答即可委派）并持久化（重启后仍保留）。
  app.put('/api/config/sub-agents', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      enabled?: boolean;
    };
    if (!body || typeof body.enabled !== 'boolean') {
      return void reply.code(400).send({ error: 'enabled 必须为 boolean' });
    }
    try {
      const merged = await saveSubAgentConfig(body.enabled);
      // 落盘后同步 adapter 运行时实例，下次 query 即按新开关注册/注销 spawn_researcher
      adapter.updateConfig({
        subAgents: resolveSubAgents(merged.enableSubAgents),
      });
      return void reply.send({
        ok: true,
        enabled: merged.enableSubAgents,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return void reply.code(500).send({ error: msg });
    }
  });

  // GET /api/config/mcp：读取对外 MCP 端点配置，token 脱敏返回（仅返回状态与掩码）。
  // 为什么需要：让管理员在配置页查看/管理 MCP 入口，而不必手改 config.json；
  // token 永不回显明文（避免 Authorization 头泄漏），只给「是否已设置 + 末4位」。
  app.get('/api/config/mcp', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } }, preHandler: guards.requireAuth }, async (_request, reply) => {
    const config = await loadConfig();
    const mcp = config.mcp ?? { enabled: false, endpointPath: '/mcp', name: 'karpathy-wiki', version: '1.0.0' };
    return void reply.send({
      enabled: mcp.enabled,
      endpointPath: mcp.endpointPath,
      name: mcp.name,
      version: mcp.version,
      authenticated: mcp.authenticated ?? false,
      userTokenMasked: maskApiKey(mcp.userToken ?? ''),
      userTokenSet: !!mcp.userToken,
      adminTokenMasked: maskApiKey(mcp.adminToken ?? ''),
      adminTokenSet: !!mcp.adminToken,
    });
  });

  // PUT /api/config/mcp：保存对外 MCP 端点配置（enabled/name/version/endpointPath/authenticated/token）。
  // 鉴权：requireAdmin——这是对全局暴露的写入能力（token 即权限），仅管理员可配。
  // token 语义：**** 开头视为未修改；空串清除；其他为新值（与 AI/联网搜索 key 约定一致）。
  app.put('/api/config/mcp', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as {
      enabled?: boolean;
      endpointPath?: string;
      name?: string;
      version?: string;
      authenticated?: boolean;
      userToken?: string;
      adminToken?: string;
    };
    try {
      const merged = await saveMcpConfig({
        enabled: body.enabled,
        endpointPath: body.endpointPath,
        name: body.name,
        version: body.version,
        authenticated: body.authenticated,
        userToken: body.userToken,
        adminToken: body.adminToken,
      });
      const mcp = merged.mcp!;
      return void reply.send({
        ok: true,
        config: {
          enabled: mcp.enabled,
          endpointPath: mcp.endpointPath,
          name: mcp.name,
          version: mcp.version,
          authenticated: mcp.authenticated ?? false,
          userTokenMasked: maskApiKey(mcp.userToken ?? ''),
          userTokenSet: !!mcp.userToken,
          adminTokenMasked: maskApiKey(mcp.adminToken ?? ''),
          adminTokenSet: !!mcp.adminToken,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return void reply.code(500).send({ error: msg });
    }
  });

  // GET /api/config/export：导出全部配置（密钥已脱敏），供换服务器/环境迁移。
  // 鉴权：requireAdmin——迁移属全局危险操作，仅管理员可见可执行。
  // 大小：返回当前 config.json（多为 KB~MB 级），未压缩；如需大体积压缩可在此扩展 gzip。
  app.get('/api/config/export', { preHandler: guards.requireAdmin }, async (request, reply) => {
    try {
      const { fileName, data } = await buildConfigExport();
      // 附带 attachment 文件名：前端可据此命名下载文件
      reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
      audit({
        request,
        action: 'config_change',
        resource: 'GET /api/config/export',
        result: 'success',
        message: `配置导出（${fileName}）`,
      });
      return void reply.send(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      audit({ request, action: 'config_change', resource: 'GET /api/config/export', result: 'fail', message: msg });
      return void reply.code(500).send({ error: msg });
    }
  });

  // POST /api/config/import：从导出文件批量导入配置（mode=merge 补齐缺失 / overwrite 整体替换）。
  // 鉴权：requireAdmin；overwrite 先备份 config.json.bak，失败可回滚。
  // 体积：Fastify 全局 bodyLimit=50MB 兜底（>50MB 直接在框架层拒绝）；
  // 校验：config.ts 内做白名单 + 类型校验，未知字段忽略，密钥掩码回传沿用现值。
  app.post('/api/config/import', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = (request.body ?? {}) as { data?: unknown; mode?: string };
    // 提取嵌套三元为独立语句（S3358）：mode 仅接受 'overwrite' / 'merge'，其余保持 undefined 走 400 分支
    let mode: 'merge' | 'overwrite' | undefined;
    if (body.mode === 'overwrite') {
      mode = 'overwrite';
    } else if (body.mode === 'merge') {
      mode = 'merge';
    }
    if (!mode) {
      audit({ request, action: 'config_change', resource: 'POST /api/config/import', result: 'fail', message: 'mode 必须为 merge 或 overwrite' });
      return void reply.code(400).send({ error: 'mode 必须为 merge 或 overwrite' });
    }
    if (body.data === undefined || body.data === null) {
      audit({ request, action: 'config_change', resource: 'POST /api/config/import', result: 'fail', message: '请求体缺少 data 字段' });
      return void reply.code(400).send({ error: '请求体缺少 data 字段' });
    }
    try {
      // T02467：导入前/后各读一次，按登记表逐字段比对出「哪些需重启项真的被改了」，
      // 避免只回 applied=N 让用户自己猜要不要重启（REQ-032 的迁移路径缺口）。
      const before = await readConfigForCompare();
      const result = await importConfigData(body.data, mode);
      const after = await readConfigForCompare();
      const requireRestart = changedRestartKeys(before, after);
      audit({
        request,
        action: 'config_change',
        resource: 'POST /api/config/import',
        result: 'success',
        message: `配置导入 mode=${mode} applied=${result.applied} skipped=${result.skipped} failed=${result.failed} requireRestart=${requireRestart.join('|') || '-'}`,
      });
      return void reply.send({
        ok: true,
        mode,
        ...result,
        requireRestart,
        restartHints: restartHints(requireRestart),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      audit({ request, action: 'config_change', resource: 'POST /api/config/import', result: 'fail', message: `mode=${mode} ${msg}` });
      // ConfigMigrationError：格式/完整性不符，返回 400 + 明确 message；其余为写盘等内部错误 → 500
      const status = err instanceof ConfigMigrationError ? 400 : 500;
      return void reply.code(status).send({ error: msg });
    }
  });
}

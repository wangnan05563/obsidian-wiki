// 配置路由层测试（T01552 覆盖率治理）
// 手法与 qq-ingest-routes.test.ts 一致：Fastify + inject，不 listen；
// mock ../src/config.js 的读写函数（spread actual 保留 maskApiKey / ConfigMigrationError 等真实导出），
// 避免污染项目真实 config.json。断言聚焦状态码、响应 JSON、adapter 同步调用参数、错误分支。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerConfigRoute } from '../src/routes/config.js';
import type { RestartController } from '../src/routes/config.js';
import { ConfigMigrationError } from '../src/config.js';
import { resolveSubAgents } from '../src/engine/harness-adapter.js';
import type { AppConfig } from '../src/types.js';
import type { HarnessAdapter } from '../src/engine/harness-adapter.js';

const {
  loadConfigMock,
  reloadConfigMock,
  saveBudgetConfigMock,
  saveHealthCheckConfigMock,
  saveBatchConfigMock,
  saveLoggingConfigMock,
  saveSubAgentConfigMock,
  saveMcpConfigMock,
  buildConfigExportMock,
  importConfigDataMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  reloadConfigMock: vi.fn(),
  saveBudgetConfigMock: vi.fn(),
  saveHealthCheckConfigMock: vi.fn(),
  saveBatchConfigMock: vi.fn(),
  saveLoggingConfigMock: vi.fn(),
  saveSubAgentConfigMock: vi.fn(),
  saveMcpConfigMock: vi.fn(),
  buildConfigExportMock: vi.fn(),
  importConfigDataMock: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
    reloadConfig: reloadConfigMock,
    saveBudgetConfig: saveBudgetConfigMock,
    saveHealthCheckConfig: saveHealthCheckConfigMock,
    saveBatchConfig: saveBatchConfigMock,
    saveLoggingConfig: saveLoggingConfigMock,
    saveSubAgentConfig: saveSubAgentConfigMock,
    saveMcpConfig: saveMcpConfigMock,
    buildConfigExport: buildConfigExportMock,
    importConfigData: importConfigDataMock,
  };
});

// 构造一份典型 AppConfig（缺 batch/logging/mcp/enableSubAgents，用于测路由内兜底默认值分支）
function baseConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    vaultPath: 'C:/tmp/vault',
    adapter: 'harness',
    llm: { provider: 'glm', baseUrl: 'https://example.test/v4', model: 'glm-4-plus', apiKeyRef: 'CFG_TEST_KEY_REF' },
    budget: { maxSteps: 20, tokenBudget: 50000 },
    server: { host: 'localhost', port: 3000 },
    localOnly: true,
    healthCheck: { staleDays: 30 },
    ...overrides,
  } as unknown as AppConfig;
}

function createAdapterSpy(): HarnessAdapter & { updateConfig: ReturnType<typeof vi.fn> } {
  return { updateConfig: vi.fn() } as unknown as HarnessAdapter & { updateConfig: ReturnType<typeof vi.fn> };
}

async function buildApp(adapter: HarnessAdapter): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // T02622：重启控制器是必填依赖（生产由 index.ts 注入真实 shutdown），测试给桩。
  const restart: RestartController = { bootId: () => 'test-boot', afterRestart: () => {} };
  registerConfigRoute(app, adapter, restart);
  await app.ready();
  return app;
}

const jsonHeaders = { 'content-type': 'application/json' };

describe('routes/config.ts 配置路由', () => {
  let adapter: HarnessAdapter & { updateConfig: ReturnType<typeof vi.fn> };
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.resetAllMocks();
    adapter = createAdapterSpy();
    delete process.env.CFG_TEST_KEY_REF;
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ==========================================================================
  // GET /api/config
  // ==========================================================================
  describe('GET /api/config', () => {
    it('返回脱敏配置：不含 apiKey，apiKeySet 依据环境变量存在性', async () => {
      loadConfigMock.mockResolvedValue(baseConfig());
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'GET', url: '/api/config' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.vaultPath).toBe('C:/tmp/vault');
      expect(body.llm.model).toBe('glm-4-plus');
      expect(body.llm.apiKeyRef).toBe('CFG_TEST_KEY_REF');
      expect(body.llm.apiKey).toBeUndefined();
      expect(body.llm.apiKeySet).toBe(false);
      expect(body.llm.stream).toBe(false);
      // batch/logging/enableSubAgents 缺失时的兜底默认值
      expect(body.batch.maxBatchSize).toBe(20);
      expect(body.logging).toEqual({ level: 'info', enableRequestLog: true });
      expect(body.enableSubAgents).toBe(false);
      expect(loadConfigMock).toHaveBeenCalledTimes(1);
    });

    it('apiKeyRef 对应环境变量已设置时 apiKeySet 为 true，且透传真实 batch/logging', async () => {
      process.env.CFG_TEST_KEY_REF = 'secret-value';
      loadConfigMock.mockResolvedValue(baseConfig({
        batch: { allowedExtensions: ['md'], maxBatchSize: 7, maxFileSizeMb: 3 },
        logging: { level: 'debug', enableRequestLog: false },
        enableSubAgents: true,
      }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'GET', url: '/api/config' });
      const body = res.json();
      expect(body.llm.apiKeySet).toBe(true);
      expect(body.batch.maxBatchSize).toBe(7);
      expect(body.logging.level).toBe('debug');
      expect(body.enableSubAgents).toBe(true);
    });
  });

  // ==========================================================================
  // PUT /api/config（向后兼容：仅校验不落盘）
  // ==========================================================================
  describe('PUT /api/config', () => {
    it('空请求体（null）应返回 400', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config', headers: jsonHeaders, payload: 'null' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('请求体为空');
    });

    it('正常请求体应返回提示且不落盘', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config', headers: jsonHeaders, payload: JSON.stringify({ vaultPath: 'x' }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().message).toContain('子资源接口');
      expect(saveBudgetConfigMock).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POST /api/config/reload
  // ==========================================================================
  describe('POST /api/config/reload', () => {
    it('应重读配置并把可热更新字段同步到 adapter', async () => {
      reloadConfigMock.mockResolvedValue(baseConfig({
        llm: { ...baseConfig().llm, model: 'glm-4-flash' },
        budget: { maxSteps: 8, tokenBudget: 1234 },
        healthCheck: { staleDays: 15 },
      }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'POST', url: '/api/config/reload' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.applied).toEqual({ model: 'glm-4-flash', maxSteps: 8, tokenBudget: 1234, staleDays: 15 });
      expect(body.requireRestart).toContain('vaultPath');
      // 需重启清单来自登记表：内部路径名（server.host）也要有可读中文名，前端不必再查表
      expect(body.requireRestart).toEqual(expect.arrayContaining(['adapter', 'server.host', 'server.port', 'logging.level']));
      expect(body.restartHints.find((h: { key: string }) => h.key === 'server.port')).toMatchObject({
        key: 'server.port',
        label: '服务端口',
      });
      expect(adapter.updateConfig).toHaveBeenCalledWith({
        model: 'glm-4-flash', maxSteps: 8, tokenBudget: 1234, staleDays: 15,
      });
    });
  });

  // ==========================================================================
  // GET /api/config/effects（T02467 单一可信源）
  // ==========================================================================
  describe('GET /api/config/effects', () => {
    it('返回登记表全量条目、需重启 key 与两条路径的取值域', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'GET', url: '/api/config/effects' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(10);
      // 每条都得有 key/label/effect/viaFile/tab/reason，前端徽标与待重启清单全靠这些字段
      for (const item of body.items) {
        expect(item.key).toBeTruthy();
        expect(item.label).toBeTruthy();
        expect(['instant', 'restart']).toContain(item.effect);
        expect(['instant', 'reload', 'restart']).toContain(item.viaFile);
        expect(item.tab).toBeTruthy();
        expect(item.reason).toBeTruthy();
      }
      expect(body.restartKeys).toEqual(expect.arrayContaining(['adapter', 'vaultPath', 'server.port', 'logging.level', 'multipart.fileSize']));
      expect(body.restartKeys).not.toContain('budget.maxSteps');
      expect(body.uiEffects).toEqual(['instant', 'restart']);
      expect(body.fileEffects).toEqual(['instant', 'reload', 'restart']);
      // 登记表只描述字段语义，不携带任何配置「现值」——密钥值因此不可能从这里流出
      const ALLOWED = ['key', 'label', 'effect', 'viaFile', 'tab', 'reason', 'configPath'];
      for (const item of body.items) {
        expect(Object.keys(item).every((k) => ALLOWED.includes(k))).toBe(true);
      }
    });

    it('key 唯一（前端按 key 建索引，重复会静默覆盖）', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'GET', url: '/api/config/effects' });
      const keys = res.json().items.map((i: { key: string }) => i.key);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  // ==========================================================================
  // PUT /api/config/budget
  // ==========================================================================
  describe('PUT /api/config/budget', () => {
    it('maxSteps 非正整数应 400 且不落盘', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/budget', headers: jsonHeaders, payload: JSON.stringify({ maxSteps: 0 }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('maxSteps 必须为正整数');
      expect(saveBudgetConfigMock).not.toHaveBeenCalled();
    });

    it('tokenBudget 非整数应 400', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/budget', headers: jsonHeaders, payload: JSON.stringify({ tokenBudget: 1.5 }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('tokenBudget 必须为正整数');
    });

    it('合法值应落盘并同步 adapter', async () => {
      saveBudgetConfigMock.mockResolvedValue(baseConfig({ budget: { maxSteps: 5, tokenBudget: 999 } }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/budget', headers: jsonHeaders, payload: JSON.stringify({ maxSteps: 5 }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().config).toEqual({ maxSteps: 5, tokenBudget: 999 });
      expect(saveBudgetConfigMock).toHaveBeenCalledWith({ maxSteps: 5, tokenBudget: undefined });
      expect(adapter.updateConfig).toHaveBeenCalledWith({ maxSteps: 5, tokenBudget: 999 });
    });

    it('落盘失败应 500 并透传错误信息', async () => {
      saveBudgetConfigMock.mockRejectedValue(new Error('disk full'));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/budget', headers: jsonHeaders, payload: JSON.stringify({ maxSteps: 2 }) });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('disk full');
      expect(adapter.updateConfig).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // PUT /api/config/health-check
  // ==========================================================================
  describe('PUT /api/config/health-check', () => {
    it('staleDays 非法应 400', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/health-check', headers: jsonHeaders, payload: JSON.stringify({ staleDays: -3 }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('staleDays 必须为正整数');
    });

    it('合法值应落盘并同步 adapter', async () => {
      saveHealthCheckConfigMock.mockResolvedValue(baseConfig({ healthCheck: { staleDays: 45 } }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/health-check', headers: jsonHeaders, payload: JSON.stringify({ staleDays: 45 }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().config).toEqual({ staleDays: 45 });
      expect(adapter.updateConfig).toHaveBeenCalledWith({ staleDays: 45 });
    });

    it('落盘失败应 500', async () => {
      saveHealthCheckConfigMock.mockRejectedValue(new Error('write denied'));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/health-check', headers: jsonHeaders, payload: JSON.stringify({ staleDays: 10 }) });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('write denied');
    });
  });

  // ==========================================================================
  // PUT /api/config/batch
  // ==========================================================================
  describe('PUT /api/config/batch', () => {
    it('maxBatchSize 非整数应 400', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/batch', headers: jsonHeaders, payload: JSON.stringify({ maxBatchSize: 2.5 }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('maxBatchSize 必须为正整数');
    });

    it('maxFileSizeMb 非法应 400', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/batch', headers: jsonHeaders, payload: JSON.stringify({ maxFileSizeMb: '10' }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('maxFileSizeMb 必须为正整数');
    });

    it('allowedExtensions 含空白字符串应 400', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/batch', headers: jsonHeaders, payload: JSON.stringify({ allowedExtensions: ['md', '  '] }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('allowedExtensions 必须为非空字符串数组');
    });

    it('合法值应 trim+小写后落盘，改了单文件上限才提示需重启（登记表 key）', async () => {
      // 旧值 maxFileSizeMb=10，本次写 4 → 真的改了 → 命中登记表 multipart.fileSize
      loadConfigMock.mockResolvedValue(baseConfig({ batch: { allowedExtensions: ['md'], maxBatchSize: 20, maxFileSizeMb: 10 } }));
      saveBatchConfigMock.mockResolvedValue(baseConfig({ batch: { allowedExtensions: ['pdf'], maxBatchSize: 9, maxFileSizeMb: 4 } }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/batch', headers: jsonHeaders, payload: JSON.stringify({ allowedExtensions: [' PDF '], maxBatchSize: 9, maxFileSizeMb: 4 }) });
      expect(res.statusCode).toBe(200);
      expect(saveBatchConfigMock).toHaveBeenCalledWith({ allowedExtensions: ['pdf'], maxBatchSize: 9, maxFileSizeMb: 4 });
      expect(res.json().config.maxBatchSize).toBe(9);
      expect(res.json().requireRestart).toEqual(['multipart.fileSize']);
      expect(res.json().restartHints).toEqual([{ key: 'multipart.fileSize', label: '单文件上限（MB）', reason: expect.any(String) }]);
    });

    it('单文件上限未变时不提示重启（扩展名/批量上限即时生效）', async () => {
      loadConfigMock.mockResolvedValue(baseConfig({ batch: { allowedExtensions: ['md'], maxBatchSize: 20, maxFileSizeMb: 4 } }));
      saveBatchConfigMock.mockResolvedValue(baseConfig({ batch: { allowedExtensions: ['pdf'], maxBatchSize: 9, maxFileSizeMb: 4 } }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/batch', headers: jsonHeaders, payload: JSON.stringify({ allowedExtensions: [' PDF '], maxBatchSize: 9, maxFileSizeMb: 4 }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().requireRestart).toEqual([]);
      expect(res.json().restartHints).toEqual([]);
    });

    it('落盘失败应 500', async () => {
      saveBatchConfigMock.mockRejectedValue(new Error('bad'));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/batch', headers: jsonHeaders, payload: JSON.stringify({ maxBatchSize: 3 }) });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('bad');
    });
  });

  // ==========================================================================
  // PUT /api/config/logging
  // ==========================================================================
  describe('PUT /api/config/logging', () => {
    it('非法 level 应 400', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/logging', headers: jsonHeaders, payload: JSON.stringify({ level: 'verbose' }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('fatal');
    });

    it('enableRequestLog 非 boolean 应 400', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/logging', headers: jsonHeaders, payload: JSON.stringify({ enableRequestLog: 'yes' }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('enableRequestLog 必须为 boolean');
    });

    it('仅改 enableRequestLog 时无需重启（requireRestart 为空数组）', async () => {
      saveLoggingConfigMock.mockResolvedValue(baseConfig({ logging: { level: 'info', enableRequestLog: false } }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/logging', headers: jsonHeaders, payload: JSON.stringify({ enableRequestLog: false }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().requireRestart).toEqual([]);
      expect(res.json().config).toEqual({ level: 'info', enableRequestLog: false });
    });

    it('修改 level 时应提示 logging.level 需重启（不再吐 pino.level 内部名）', async () => {
      loadConfigMock.mockResolvedValue(baseConfig({ logging: { level: 'info', enableRequestLog: true } }));
      saveLoggingConfigMock.mockResolvedValue(baseConfig({ logging: { level: 'debug', enableRequestLog: true } }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/logging', headers: jsonHeaders, payload: JSON.stringify({ level: 'debug' }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().requireRestart).toEqual(['logging.level']);
      expect(res.json().restartHints).toEqual([{ key: 'logging.level', label: '日志级别', reason: expect.any(String) }]);
    });

    it('level 未变（只回写同值）时不提示重启', async () => {
      loadConfigMock.mockResolvedValue(baseConfig({ logging: { level: 'warn', enableRequestLog: true } }));
      saveLoggingConfigMock.mockResolvedValue(baseConfig({ logging: { level: 'warn', enableRequestLog: false } }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/logging', headers: jsonHeaders, payload: JSON.stringify({ level: 'warn' }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().requireRestart).toEqual([]);
    });

    it('落盘失败应 500', async () => {
      saveLoggingConfigMock.mockRejectedValue(new Error('EACCES'));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/logging', headers: jsonHeaders, payload: JSON.stringify({ level: 'warn' }) });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('EACCES');
    });
  });

  // ==========================================================================
  // PUT /api/config/sub-agents
  // ==========================================================================
  describe('PUT /api/config/sub-agents', () => {
    it('enabled 非 boolean 应 400', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/sub-agents', headers: jsonHeaders, payload: JSON.stringify({ enabled: 'true' }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('enabled 必须为 boolean');
      expect(saveSubAgentConfigMock).not.toHaveBeenCalled();
    });

    it('开启应落盘并把子智能体注册同步到 adapter', async () => {
      saveSubAgentConfigMock.mockResolvedValue(baseConfig({ enableSubAgents: true }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/sub-agents', headers: jsonHeaders, payload: JSON.stringify({ enabled: true }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().enabled).toBe(true);
      expect(saveSubAgentConfigMock).toHaveBeenCalledWith(true);
      expect(adapter.updateConfig).toHaveBeenCalledWith({ subAgents: resolveSubAgents(true) });
    });

    it('关闭时 updateConfig 收到 undefined 子智能体列表', async () => {
      saveSubAgentConfigMock.mockResolvedValue(baseConfig({ enableSubAgents: false }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/sub-agents', headers: jsonHeaders, payload: JSON.stringify({ enabled: false }) });
      expect(res.statusCode).toBe(200);
      expect(adapter.updateConfig).toHaveBeenCalledWith({ subAgents: undefined });
    });

    it('落盘失败应 500', async () => {
      saveSubAgentConfigMock.mockRejectedValue(new Error('io'));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/sub-agents', headers: jsonHeaders, payload: JSON.stringify({ enabled: true }) });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('io');
    });
  });

  // ==========================================================================
  // GET /api/config/mcp
  // ==========================================================================
  describe('GET /api/config/mcp', () => {
    it('config.mcp 缺失时返回默认结构', async () => {
      loadConfigMock.mockResolvedValue(baseConfig());
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'GET', url: '/api/config/mcp' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.enabled).toBe(false);
      expect(body.endpointPath).toBe('/mcp');
      expect(body.name).toBe('karpathy-wiki');
      expect(body.authenticated).toBe(false);
      expect(body.userTokenSet).toBe(false);
      expect(body.userTokenMasked).toBe('');
    });

    it('存在 token 时应掩码回显（只暴露末 4 位）', async () => {
      loadConfigMock.mockResolvedValue(baseConfig({
        mcp: { enabled: true, endpointPath: '/mcp-x', name: 'n', version: '2.0.0', authenticated: true, userToken: 'user-secret-9876', adminToken: 'admin-secret-1234' },
      }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'GET', url: '/api/config/mcp' });
      const body = res.json();
      expect(body.enabled).toBe(true);
      expect(body.userTokenMasked).toBe('****9876');
      expect(body.userTokenSet).toBe(true);
      expect(body.adminTokenMasked).toBe('****1234');
      expect(JSON.stringify(body)).not.toContain('user-secret');
    });
  });

  // ==========================================================================
  // PUT /api/config/mcp
  // ==========================================================================
  describe('PUT /api/config/mcp', () => {
    it('保存成功后返回掩码配置', async () => {
      saveMcpConfigMock.mockResolvedValue(baseConfig({
        mcp: { enabled: true, endpointPath: '/mcp', name: 'wiki', version: '1.2.3', authenticated: true, userToken: 'tok-abc-4321', adminToken: '' },
      }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/mcp', headers: jsonHeaders, payload: JSON.stringify({ enabled: true, name: 'wiki' }) });
      expect(res.statusCode).toBe(200);
      expect(saveMcpConfigMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, name: 'wiki' }));
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.config.name).toBe('wiki');
      expect(body.config.userTokenMasked).toBe('****4321');
      expect(body.config.userTokenSet).toBe(true);
      expect(body.config.adminTokenSet).toBe(false);
    });

    it('保存失败应 500', async () => {
      saveMcpConfigMock.mockRejectedValue(new Error('mcp save fail'));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'PUT', url: '/api/config/mcp', headers: jsonHeaders, payload: '{}' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('mcp save fail');
    });
  });

  // ==========================================================================
  // GET /api/config/export
  // ==========================================================================
  describe('GET /api/config/export', () => {
    it('成功导出应带 attachment 文件名头', async () => {
      buildConfigExportMock.mockResolvedValue({ fileName: 'karpathy-wiki-config-20261007.json', data: { exportedAt: 'x', config: { a: 1 } } });
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'GET', url: '/api/config/export' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment; filename="karpathy-wiki-config-20261007.json"');
      expect(res.json().config).toEqual({ a: 1 });
    });

    it('导出失败应 500', async () => {
      buildConfigExportMock.mockRejectedValue(new Error('export boom'));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'GET', url: '/api/config/export' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('export boom');
    });
  });

  // ==========================================================================
  // POST /api/config/import
  // ==========================================================================
  describe('POST /api/config/import', () => {
    it('mode 缺失或非法应 400', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'POST', url: '/api/config/import', headers: jsonHeaders, payload: JSON.stringify({ data: {}, mode: 'replace' }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('mode 必须为 merge 或 overwrite');
      expect(importConfigDataMock).not.toHaveBeenCalled();
    });

    it('mode 合法但缺少 data 应 400', async () => {
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'POST', url: '/api/config/import', headers: jsonHeaders, payload: JSON.stringify({ mode: 'merge' }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('请求体缺少 data 字段');
    });

    it('merge 导入成功应回传统计并透传给 importConfigData', async () => {
      importConfigDataMock.mockResolvedValue({ applied: 3, skipped: 1, failed: 0, details: ['ok'] });
      // T02467：导入前后各读一次配置，比对出「需重启」字段是否真的被覆盖。
      // 这里前后只差 vaultPath（需重启），期望响应把它列进 requireRestart + restartHints。
      loadConfigMock
        .mockResolvedValueOnce(baseConfig({ vaultPath: 'C:/tmp/vault' }))
        .mockResolvedValueOnce(baseConfig({ vaultPath: 'D:/new/vault' }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'POST', url: '/api/config/import', headers: jsonHeaders, payload: JSON.stringify({ mode: 'merge', data: { budget: { maxSteps: 4, tokenBudget: 1 } } }) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({
        ok: true,
        mode: 'merge',
        applied: 3,
        skipped: 1,
        failed: 0,
        details: ['ok'],
        requireRestart: ['vaultPath'],
        restartHints: [{ key: 'vaultPath', label: 'Vault 路径', reason: expect.any(String) }],
      });
      expect(importConfigDataMock).toHaveBeenCalledWith({ budget: { maxSteps: 4, tokenBudget: 1 } }, 'merge');
    });

    it('导入未触及需重启字段时 requireRestart 为空（不误报「得重启」）', async () => {
      importConfigDataMock.mockResolvedValue({ applied: 1, skipped: 0, failed: 0, details: [] });
      loadConfigMock.mockResolvedValue(baseConfig({ budget: { maxSteps: 4, tokenBudget: 1 } }));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'POST', url: '/api/config/import', headers: jsonHeaders, payload: JSON.stringify({ mode: 'merge', data: { budget: { maxSteps: 4 } } }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().requireRestart).toEqual([]);
      expect(res.json().restartHints).toEqual([]);
    });

    it('前后配置都读不到时保守列出全部需重启字段（不静默报「不用重启」）', async () => {
      importConfigDataMock.mockResolvedValue({ applied: 1, skipped: 0, failed: 0, details: [] });
      loadConfigMock.mockRejectedValue(new Error('config.json 损坏'));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'POST', url: '/api/config/import', headers: jsonHeaders, payload: JSON.stringify({ mode: 'merge', data: {} }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().requireRestart).toEqual(expect.arrayContaining(['adapter', 'vaultPath', 'server.port', 'logging.level']));
    });

    it('ConfigMigrationError 应返回 400（格式问题而非内部错误）', async () => {
      importConfigDataMock.mockRejectedValue(new ConfigMigrationError('结构不合法'));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'POST', url: '/api/config/import', headers: jsonHeaders, payload: JSON.stringify({ mode: 'overwrite', data: {} }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('结构不合法');
    });

    it('其他异常应返回 500', async () => {
      importConfigDataMock.mockRejectedValue(new Error('EACCES'));
      app = await buildApp(adapter);
      const res = await app.inject({ method: 'POST', url: '/api/config/import', headers: jsonHeaders, payload: JSON.stringify({ mode: 'merge', data: {} }) });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('EACCES');
    });
  });
});

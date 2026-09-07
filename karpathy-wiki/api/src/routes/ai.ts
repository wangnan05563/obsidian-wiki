import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveAiConfig, saveWebSearchConfig, resetAiConfig, getEffectiveApiKey, maskApiKey, getProviderKeyStatus, saveSkillsConfig } from '../config.js';
import { getResourcePath } from '../utils/runtime.js';
import type { EngineAdapter, LlmPreset } from '../types.js';
import type { IsolationGuards } from '../middleware/auth.js';
import { createIsolationGuards } from '../middleware/auth.js';
import { testWebSearchConnection } from '../tools/web-search.js';
import { testImageGeneration, applyImageOverride } from '../workflows/media-generation-workflow.js';

// 模块加载时一次性读取 LLM 预设列表，避免每次请求都读盘。
// 为什么外置到 llm-presets.json：厂商预设（baseUrl/model/apiKeyRef）会随厂商更新迭代，
//   抽到独立文件后用户/运维可直接编辑 llm-presets.json 增删预设，无需改源码。
// 路径解析统一走 runtime.ts 的 getResourcePath：
//   开发模式：api/llm-presets.json
//   SEA 打包模式：exe 同级目录/llm-presets.json
// 多候选 fallback 保留 CWD 兜底，应对 pnpm --filter 符号链接等边缘场景
function resolvePresetsPath(): string {
  const candidates: string[] = [
    getResourcePath('llm-presets.json'),
    path.resolve(process.cwd(), 'llm-presets.json'),
    path.resolve(process.cwd(), 'api', 'llm-presets.json'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // 找不到时返回第一候选路径（保留原行为，让读盘错误自然抛出便于诊断）
  return candidates[0];
}
const PRESETS_PATH = resolvePresetsPath();
const LLM_PRESETS: LlmPreset[] = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8'));

// 格式化 HTTP 错误响应详情：解析 OpenAI 兼容协议的错误格式，独立为纯函数降低 test-connection 路由认知复杂度
function formatHttpError(status: number, errText: string): string {
  let detail = `API 返回 ${status}`;
  try {
    const errJson = JSON.parse(errText);
    if (errJson.error?.message) {
      detail += ': ' + errJson.error.message;
    }
  } catch {
    if (errText) detail += ': ' + errText.slice(0, 200);
  }
  return detail;
}

// 归一化服务商返回的模型列表为统一的 [{ id }] 结构。
// 兼容两种主流形态：
//   - OpenAI 兼容：{ data: [{ id: 'gpt-4o' }] }
//   - Ollama 原生：`{ models: [{ name: 'qwen2.5:7b' }] }`
// 未知形态或空列表返回 []，调用方据此提示"不支持 /models"。
function normalizeModels(json: unknown): { id: string }[] {
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;
  const data = obj.data;
  if (Array.isArray(data)) {
    return data
      .map((m) => (typeof m === 'string' ? m : (m as Record<string, unknown> | null)?.[ 'id']))
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((id) => ({ id }));
  }
  const models = obj.models;
  if (Array.isArray(models)) {
    return models
      .map((m) => {
        if (typeof m === 'string') return m;
        const rec = m as Record<string, unknown> | null;
        return rec?.[ 'id'] ?? rec?.[ 'name'];
      })
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((id) => ({ id }));
  }
  return [];
}

// 模型列表内存缓存：按 baseUrl|provider 维度缓存 5 分钟。
// 为什么与 apiKey 无关：可用模型清单不依赖具体密钥（只要任一有效 key 即可列出），
// 按 baseUrl|provider 缓存可避免「同一服务商反复展开下拉」重复打外部 API。
const modelsCache = new Map<string, { at: number; models: { id: string }[] }>();
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

// AI 服务路由：提供 LLM 配置的读取、保存与连接测试。
// 参考 17_xianyu 项目 AI 服务模块设计，适配本项目的 Fastify + config.json 架构。
//   GET  /api/ai/config           读取 AI 配置（API Key 脱敏）
//   PUT  /api/ai/config           保存 AI 配置到 config.json + 同步 adapter 运行时
//   POST /api/ai/reset-config     恢复 LLM 配置到出厂默认值 + 同步 adapter 运行时
//   GET  /api/ai/presets          返回 LLM 预设列表（从 llm-presets.json 读取）
//   POST /api/ai/test-connection  测试 LLM 连接（OpenAI 兼容协议）
//   GET  /api/ai/web-search       读取联网搜索配置
//   PUT  /api/ai/web-search       保存联网搜索配置 + 同步 adapter 运行时
//   POST /api/ai/web-search/test  测试联网搜索（搜索引擎）连接是否可用
export function registerAiRoute(
  app: FastifyInstance,
  adapter?: EngineAdapter,
  guards: IsolationGuards = createIsolationGuards(),
) {

  // GET /api/ai/config：返回当前 AI 配置，API Key 脱敏。
  // 脱敏策略：返回 ****xxxx 格式，前端回传此值视为未修改。
  // providerKeyStatus：按 provider 索引的 key 配置状态表，前端切换预设时展示各 provider 是否已配置 key。
  //   为什么需要：用户切换预设时需感知目标 provider 是否已配置过 key，避免重复输入。
  // FR-12 skills/activeSkill：AI 伙伴预设列表与当前激活项
  app.get('/api/ai/config', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } }, preHandler: guards.requireAuth }, async (_request, reply) => {
    const config = await loadConfig();
    const apiKey = getEffectiveApiKey(config);
    const maskedKey = maskApiKey(apiKey);

    return void reply.send({
      provider: config.llm.provider,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      apiKeyRef: config.llm.apiKeyRef,
      apiKeyMasked: maskedKey,
      apiKeySet: Boolean(apiKey),
      providerKeyStatus: getProviderKeyStatus(config),
      // FR-12 AI 伙伴预设
      skills: config.skills ?? [],
      activeSkill: config.activeSkill ?? '',
    });
  });

  // GET /api/ai/presets：返回 LLM 预设列表，供前端渲染快捷选择按钮。
  app.get('/api/ai/presets', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } }, preHandler: guards.requireAuth }, async (_request, reply) => {
    return reply.send({ presets: LLM_PRESETS });
  });

  // 脱敏 API Key：**** 开头表示前端回传的脱敏值，视为未修改
  function sanitizeApiKey(raw: string | undefined): string | undefined { // NOSONAR - S7721
    if (raw === undefined) return undefined;
    return raw.startsWith('****') ? undefined : raw;
  }

  // 同步 adapter 运行时实例，避免切换预设后 baseUrl/model 不匹配
  function syncAdapterConfig(
    adapter: EngineAdapter | undefined,
    merged: Awaited<ReturnType<typeof saveAiConfig>>,
    activeSkill?: string,
  ): void {
    if (!adapter || !Object.hasOwn(adapter, 'updateConfig') || typeof adapter.updateConfig !== 'function') return;
    const effectiveKey = getEffectiveApiKey(merged);
    const skillUpdates: Record<string, unknown> = {
      provider: merged.llm.provider,
      baseUrl: merged.llm.baseUrl,
      model: merged.llm.model,
      apiKey: effectiveKey,
    };
    if (activeSkill !== undefined) {
      skillUpdates.activeSkill = activeSkill || '';
      const activePreset = merged.skills?.find((s) => s.id === activeSkill);
      skillUpdates.systemPrompt = activePreset?.systemPrompt ?? '';
      skillUpdates.scope = activePreset?.scope ?? 'all';
      skillUpdates.outputFormat = activePreset?.outputFormat ?? '';
      if (activePreset?.model) {
        skillUpdates.model = activePreset.model;
      }
    }
    adapter.updateConfig(skillUpdates as Parameters<typeof adapter.updateConfig>[0]);
  }

  // PUT /api/ai/config：保存 AI 配置到 config.json。
  // apiKey 处理逻辑：
  //   - 以 **** 开头的值视为未修改（脱敏回传），跳过更新
  //   - 空字符串表示清除 Key
  //   - 其他值视为新 Key，写入 config.json
  // 多 key 持久化（预设切换场景）：
  //   - 请求体可携带 apiKeyRef（新 provider 对应的环境变量名）
  //   - saveAiConfig 内部检测 provider 变化时自动迁移 apiKey 到 apiKeys[旧provider] 并恢复 apiKeys[新provider]
  //   - 响应附带 providerKeyStatus 让前端即时展示各 provider 配置状态
  app.put('/api/ai/config', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      provider?: string;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      apiKeyRef?: string;
      // FR-12 AI 伙伴预设
      activeSkill?: string;
      skills?: import('../types.js').SkillPreset[];
      systemPrompt?: string;
      scope?: import('../types.js').SkillPreset['scope'];
      outputFormat?: string;
    };

    if (!body) {
      return void reply.code(400).send({ error: '请求体为空' });
    }

    const apiKey = sanitizeApiKey(body.apiKey);
    const updates: Record<string, string | undefined> = {};
    if (body.provider !== undefined) updates.provider = body.provider;
    if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl;
    if (body.model !== undefined) updates.model = body.model;
    if (apiKey !== undefined) updates.apiKey = apiKey;
    if (body.apiKeyRef !== undefined) updates.apiKeyRef = body.apiKeyRef;

    try {
      const merged = await saveAiConfig(updates as Parameters<typeof saveAiConfig>[0]);
      const effectiveKey = getEffectiveApiKey(merged);

      // FR-12 skills 持久化与热加载
      if (body.skills !== undefined || body.activeSkill !== undefined) {
        const cfg = await saveSkillsConfig(body.skills, body.activeSkill);
        merged.skills = cfg.skills;
        merged.activeSkill = cfg.activeSkill;
      }

      syncAdapterConfig(adapter, merged, body.activeSkill);
      return void reply.send({
        ok: true,
        config: {
          provider: merged.llm.provider,
          baseUrl: merged.llm.baseUrl,
          model: merged.llm.model,
          apiKeyRef: merged.llm.apiKeyRef,
          apiKeyMasked: maskApiKey(effectiveKey),
          apiKeySet: Boolean(effectiveKey),
          providerKeyStatus: getProviderKeyStatus(merged),
          skills: merged.skills ?? [],
          activeSkill: merged.activeSkill ?? '',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return void reply.code(500).send({ error: msg });
    }
  });

  // POST /api/ai/reset-config：恢复 LLM 配置到出厂默认值。
  // 为什么需要：用户误改配置后可一键恢复，避免手动编辑 config.json。
  // 仅重置 llm 字段，其他配置保持不变；同步 adapter 运行时实例。
  app.post('/api/ai/reset-config', { preHandler: guards.requireAdmin }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const merged = await resetAiConfig();
      const effectiveKey = getEffectiveApiKey(merged);
      // 落盘后同步 adapter 运行时实例，确保下次请求使用恢复后的配置
      if (adapter && typeof adapter.updateConfig === 'function') {
        adapter.updateConfig({
          provider: merged.llm.provider,
          baseUrl: merged.llm.baseUrl,
          model: merged.llm.model,
          apiKey: effectiveKey,
        });
      }
      return void reply.send({
        ok: true,
        config: {
          provider: merged.llm.provider,
          baseUrl: merged.llm.baseUrl,
          model: merged.llm.model,
          apiKeyRef: merged.llm.apiKeyRef,
          apiKeyMasked: maskApiKey(effectiveKey),
          apiKeySet: Boolean(effectiveKey),
          providerKeyStatus: getProviderKeyStatus(merged),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return void reply.code(500).send({ error: msg });
    }
  });

  // POST /api/ai/test-connection：测试 LLM 连接是否可用。
  // 使用 OpenAI 兼容协议发送最小化请求（max_tokens=5），超时 15s。
  // 鉴权：requireAuth（与 /api/ai/models、/api/ai/web-search/test 一致）。测试连接只做连通性自检，
  //   不写入任何配置，也不把服务端密钥返显给前端（key 仅在服务端 fetch 内使用）；
  //   而「配置 → AI 服务」为 BYOK 每用户独立密钥，任何登录用户都需能测试自己保存的 Key，
  //   故普通用户也应可用，不能用 requireAdmin 拦截（否则 user 角色会报 403「无权限访问该资源」）。
  app.post('/api/ai/test-connection', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, preHandler: guards.requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      baseUrl?: string;
      model?: string;
      apiKey?: string;
    } ?? {};

    const config = await loadConfig();

    // 确定测试参数：优先使用请求体中的值（用户可能未保存就测试），其次用 config.json
    const baseUrl = (body.baseUrl || config.llm.baseUrl).trim();
    const model = (body.model || config.llm.model).trim();

    // API Key：仅使用请求体传入的真实 Key（BYOK 每用户独立密钥）。
    // 为何不再回落服务端/环境变量 key：测试连接与问答口径必须一致，
    //   否则「user 已配置、guest 未配置」时，guest 也会借服务端共享 key 测通，
    //   造成"测试通过却问答失败"的误导。未配置的用户应明确得到"请配置自己的 API Key"，
    //   而非借用共享额度测通（问答本就强 BYOK，服务端 key 不为其提供额度）。
    const rawKey = body.apiKey && !body.apiKey.startsWith('****') ? body.apiKey : '';
    const apiKey: string = rawKey;

    if (!apiKey && !baseUrl.includes('localhost')) {
      return void reply.send({
        ok: false,
        detail: 'API Key 未设置：测试连接按个人 BYOK 密钥校验（与问答口径一致），请在「配置 → AI 服务」填写你自己的 API Key 后再测试',
      });
    }

    // 构造 OpenAI 兼容端点 URL
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return void reply.send({ ok: false, detail: formatHttpError(res.status, errText) });
      }

      const data = await res.json();
      return void reply.send({
        ok: true,
        model: data.model || model,
        detail: '连接成功',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      // AbortError 转换为更友好的超时提示
      const detail = err instanceof Error && err.name === 'AbortError'
        ? '连接超时（>15s），请检查 baseUrl 或网络'
        : msg;
      return void reply.send({ ok: false, detail });
    } finally {
      clearTimeout(timeout);
    }
  });

  // POST /api/ai/models：根据 API Base URL + API Key 自动获取服务商可用模型列表。
  // 入参（均可选）：{ baseUrl?, apiKey?, provider? }
  //   - 缺省回退服务端 config.llm（baseUrl/provider）；apiKey 回退 getEffectiveApiKey。
  //   - apiKey 以 **** 开头视为脱敏回传，不覆盖（沿用服务端/环境变量 key）。
  // 为什么需要：让用户不必手填 model 字符串，直接从服务商 /models 拉取真实清单选择（FR：AI 服务自动获取模型列表）。
  // 兼容性：OpenAI 兼容返回 { data:[{id}] }；Ollama 原生返回 { models:[{name}] }；归一化为 [{id}]。
  // 失败（网络/鉴权/不支持）返回 { ok:false, detail } 而非 500，前端可友好提示并回退手工输入。
  // 缓存：按 baseUrl|provider 内存缓存 5 分钟，避免每次展开下拉都打外部 API。
  app.post('/api/ai/models', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, preHandler: guards.requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { baseUrl?: string; apiKey?: string; provider?: string };

    const config = await loadConfig();
    const baseUrl = (body.baseUrl || config.llm.baseUrl || '').trim().replace(/\/+$/, '');
    const provider = (body.provider || config.llm.provider || '').trim();
    const rawKey = body.apiKey && !body.apiKey.startsWith('****') ? body.apiKey : undefined;
    const apiKey = rawKey || getEffectiveApiKey(config);

    if (!baseUrl) {
      return void reply.send({ ok: false, detail: '缺少 baseUrl，请先在 AI 服务中配置 API Base URL' });
    }

    // 命中缓存（与 key 无关：可用模型清单不依赖具体 key）
    const cacheKey = `${baseUrl}|${provider}`;
    const cached = modelsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) {
      return void reply.send({ ok: true, models: cached.models, cached: true, provider });
    }

    const url = baseUrl + '/models';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        clearTimeout(timeout);
        return void reply.send({ ok: false, detail: formatHttpError(res.status, errText) });
      }
      const json = await res.json().catch(() => null);
      clearTimeout(timeout);
      const models = normalizeModels(json);
      if (models.length === 0) {
        return void reply.send({ ok: false, detail: '服务商未返回模型列表（可能不支持 /models 接口）' });
      }
      modelsCache.set(cacheKey, { at: Date.now(), models });
      return void reply.send({ ok: true, models, cached: false, provider });
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      // AbortError 转换为更友好的超时提示
      const detail = err instanceof Error && err.name === 'AbortError'
        ? '获取模型列表超时（>15s），请检查 baseUrl 或网络'
        : msg;
      return void reply.send({ ok: false, detail });
    }
  });

  // §5.2 GET /api/ai/web-search：读取联网搜索配置，API Key 脱敏。
  // 为什么需要：前端 Config 页面需要展示当前配置状态，决定是否启用 web_search 工具。
  app.get('/api/ai/web-search', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } }, preHandler: guards.requireAuth }, async (_request, reply) => {
    const config = await loadConfig();
    const ws = config.webSearch;
    if (!ws) {
      return void reply.send({ enabled: false });
    }
    // 实际生效的 apiKey 优先级：config.json.webSearch.apiKey > process.env[apiKeyRef]
    const effectiveKey = ws.apiKey || process.env[ws.apiKeyRef] || '';
    return void reply.send({
      enabled: true,
      provider: ws.provider,
      apiKeyRef: ws.apiKeyRef,
      apiKeyMasked: maskApiKey(effectiveKey),
      apiKeySet: Boolean(effectiveKey),
      maxResults: ws.maxResults ?? 5,
    });
  });

  // §5.2 PUT /api/ai/web-search：保存联网搜索配置并同步 adapter 运行时。
  // 为什么需要同步 adapter：query workflow 通过 adapter.webSearchConfig 读取配置，
  // 落盘后必须同步内存实例，否则需重启服务才生效。
  app.put('/api/ai/web-search', { preHandler: guards.requireAdmin }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      provider?: 'tavily' | 'bing';
      apiKey?: string;
      maxResults?: number;
    };

    if (!body) {
      return void reply.code(400).send({ error: '请求体为空' });
    }

    try {
      const merged = await saveWebSearchConfig({
        provider: body.provider,
        apiKey: body.apiKey,
        maxResults: body.maxResults,
      });
      const ws = merged.webSearch!;
      const effectiveKey = ws.apiKey || process.env[ws.apiKeyRef] || '';
      // 同步 adapter 运行时实例，避免落盘后内存配置陈旧
      if (adapter && typeof adapter.updateConfig === 'function') {
        adapter.updateConfig({ webSearchConfig: ws } as { webSearchConfig: typeof ws });
      }
      return void reply.send({
        ok: true,
        config: {
          provider: ws.provider,
          apiKeyRef: ws.apiKeyRef,
          apiKeyMasked: maskApiKey(effectiveKey),
          apiKeySet: Boolean(effectiveKey),
          maxResults: ws.maxResults ?? 5,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return void reply.code(500).send({ error: msg });
    }
  });

  // §5.2 POST /api/ai/web-search/test：测试联网搜索（搜索引擎）连接是否可用。
  // 入参（均可选）：{ provider?, apiKey?, maxResults? }
  //   - 缺省回退服务端 config.webSearch（provider/maxResults）；apiKey 回退服务端/环境变量 key。
  //   - apiKey 以 **** 开头视为脱敏回传，不覆盖（沿用服务端/环境变量 key）。
  // 为什么需要：让用户不必先保存就能校验 Key + 网络，提前暴露「Key 无效 / 超时 / 区域不可用」等问题（FR：搜索引擎连接测试）。
  // 鉴权：requireAuth（与 /api/ai/models 一致）——搜索引擎为 BYOK 本地配置，登录用户即可测试自己的 Key。
  // 不抛 500：缺 Key / 鉴权失败 / 超时统一返回 { ok:false, detail }，前端友好提示。
  app.post('/api/ai/web-search/test', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, preHandler: guards.requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { provider?: 'tavily' | 'bing'; apiKey?: string; maxResults?: number };

    const config = await loadConfig();
    const ws = config.webSearch;

    const provider = body.provider || ws?.provider || 'tavily';
    const maxResults = body.maxResults || ws?.maxResults || 5;

    // API Key 解析：请求体新值（非脱敏）> 服务端 config.webSearch.apiKey > 环境变量[apiKeyRef]
    let apiKey: string;
    if (body.apiKey && !body.apiKey.startsWith('****')) {
      apiKey = body.apiKey;
    } else {
      apiKey = (ws?.apiKey || (ws?.apiKeyRef ? process.env[ws.apiKeyRef] : '')) || '';
    }

    const result = await testWebSearchConnection({ provider, apiKey, maxResults });
    return void reply.send(result);
  });

  // 图像生成（生图）连接测试：验证生图服务连通性。
  // 入参（可选）：
  //   - imageConfig：前端 BYOK 透传的用户生图配置（baseUrl/apiKey/model/size 等），优先生效；
  //     用于测试"用户自己的 key/模型"连通性（BYOK 兼容，测试口径与真实生成 generateImage 一致）。
  //   - baseUrl / imageModel：兼容旧调用的裸字段覆盖（对服务端 media.agnes 做临时验证）。
  // 缺省：回退服务端 media.agnes 的连通性自检。
  // 鉴权：requireAuth——登录用户即可校验自己的生图配置（不暴露明文密钥）。
  app.post('/api/ai/image/test', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, preHandler: guards.requireAuth }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const body = (_request.body ?? {}) as {
      imageConfig?: import('../types.js').MediaImageUserConfig;
      baseUrl?: string;
      imageModel?: string;
    };
    const config = await loadConfig();
    const media = config.media;
    if (!media) {
      return void reply.send({ ok: false, detail: '服务端未配置 media.agnes（生图服务）' });
    }
    let overridden;
    if (body.imageConfig && (body.imageConfig.apiKey || body.imageConfig.model)) {
      // 用户 BYOK 配置优先：复用 applyImageOverride 保证与真实生成相同覆盖语义
      overridden = applyImageOverride(media, body.imageConfig);
    } else {
      // 兼容旧调用：仅覆盖 baseUrl/imageModel，其余沿用服务端配置
      overridden = {
        ...media,
        agnes: {
          ...media.agnes,
          ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
          ...(body.imageModel ? { imageModel: body.imageModel } : {}),
        },
      };
    }
    const result = await testImageGeneration(overridden, config);
    return void reply.send(result);
  });
}

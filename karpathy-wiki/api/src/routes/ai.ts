import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveAiConfig, saveWebSearchConfig, resetAiConfig, getEffectiveApiKey, maskApiKey, getProviderKeyStatus } from '../config.js';
import type { EngineAdapter, LlmPreset } from '../types.js';

// 模块加载时一次性读取 LLM 预设列表，避免每次请求都读盘。
// 为什么外置到 llm-presets.json：厂商预设（baseUrl/model/apiKeyRef）会随厂商更新迭代，
//   抽到独立文件后用户/运维可直接编辑 llm-presets.json 增删预设，无需改源码。
// 路径解析与 config.ts 的 getConfigPath 同模式：
//   1. 基于 import.meta.url 派生（与 CWD 解耦，开发模式 CWD 可能是项目根或子包目录）
//   2. pnpm --filter 启动时符号链接可能导致 import.meta.url 指向非预期位置，故提供多候选路径 fallback
//   3. pkg 打包模式 fallback 到 CWD
function resolvePresetsPath(): string {
  // 本文件源码位置 api/src/routes/ai.ts，回退两级到 api/llm-presets.json
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  // pkg 打包模式：与 exe 同级
  const isPackaged = !!(process as NodeJS.Process & { pkg?: unknown }).pkg;

  // 候选路径列表（按优先级），单次初始化避免多次 push（S7778）：
  // 1. 源码位置回退两级
  // 2. 开发模式 CWD fallback：pnpm --filter 启动时 import.meta.url 可能解析到符号链接，
  //    此时尝试从 CWD 出发查找（CWD 可能是 api/ 或项目根）
  // 3. pkg 打包模式：与 exe 同级（条件包含）
  const candidates: string[] = [
    path.resolve(srcDir, '../..', 'llm-presets.json'),
    path.resolve(process.cwd(), 'llm-presets.json'),
    path.resolve(process.cwd(), 'api', 'llm-presets.json'),
    ...(isPackaged ? [path.resolve(process.cwd(), 'llm-presets.json')] : []),
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

// AI 服务路由：提供 LLM 配置的读取、保存与连接测试。
// 参考 17_xianyu 项目 AI 服务模块设计，适配本项目的 Fastify + config.json 架构。
//   GET  /api/ai/config           读取 AI 配置（API Key 脱敏）
//   PUT  /api/ai/config           保存 AI 配置到 config.json + 同步 adapter 运行时
//   POST /api/ai/reset-config     恢复 LLM 配置到出厂默认值 + 同步 adapter 运行时
//   GET  /api/ai/presets          返回 LLM 预设列表（从 llm-presets.json 读取）
//   POST /api/ai/test-connection  测试 LLM 连接（OpenAI 兼容协议）
//   GET  /api/ai/web-search       读取联网搜索配置
//   PUT  /api/ai/web-search       保存联网搜索配置 + 同步 adapter 运行时
export function registerAiRoute(app: FastifyInstance, adapter?: EngineAdapter) {

  // GET /api/ai/config：返回当前 AI 配置，API Key 脱敏。
  // 脱敏策略：返回 ****xxxx 格式，前端回传此值视为未修改。
  // providerKeyStatus：按 provider 索引的 key 配置状态表，前端切换预设时展示各 provider 是否已配置 key。
  //   为什么需要：用户切换预设时需感知目标 provider 是否已配置过 key，避免重复输入。
  app.get('/api/ai/config', async (_request, reply) => {
    const config = await loadConfig();
    const apiKey = getEffectiveApiKey(config);
    const maskedKey = maskApiKey(apiKey);

    return reply.send({
      provider: config.llm.provider,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      apiKeyRef: config.llm.apiKeyRef,
      apiKeyMasked: maskedKey,
      apiKeySet: Boolean(apiKey),
      providerKeyStatus: getProviderKeyStatus(config),
    });
  });

  // GET /api/ai/presets：返回 LLM 预设列表，供前端渲染快捷选择按钮。
  app.get('/api/ai/presets', async (_request, reply) => {
    return reply.send({ presets: LLM_PRESETS });
  });

  // PUT /api/ai/config：保存 AI 配置到 config.json。
  // apiKey 处理逻辑：
  //   - 以 **** 开头的值视为未修改（脱敏回传），跳过更新
  //   - 空字符串表示清除 Key
  //   - 其他值视为新 Key，写入 config.json
  // 多 key 持久化（预设切换场景）：
  //   - 请求体可携带 apiKeyRef（新 provider 对应的环境变量名）
  //   - saveAiConfig 内部检测 provider 变化时自动迁移 apiKey 到 apiKeys[旧provider] 并恢复 apiKeys[新provider]
  //   - 响应附带 providerKeyStatus 让前端即时展示各 provider 配置状态
  app.put('/api/ai/config', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      provider?: string;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      apiKeyRef?: string;
    };

    if (!body) {
      return reply.code(400).send({ error: '请求体为空' });
    }

    // 脱敏值检测：**** 开头表示前端回传的脱敏值，视为未修改
    let apiKey: string | undefined;
    if (body.apiKey !== undefined) {
      if (body.apiKey.startsWith('****')) {
        apiKey = undefined; // 不修改
      } else {
        apiKey = body.apiKey; // 新值或空串（清除）
      }
    }

    const updates: {
      provider?: string;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      apiKeyRef?: string;
    } = {};
    if (body.provider !== undefined) updates.provider = body.provider;
    if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl;
    if (body.model !== undefined) updates.model = body.model;
    if (apiKey !== undefined) updates.apiKey = apiKey;
    if (body.apiKeyRef !== undefined) updates.apiKeyRef = body.apiKeyRef;

    try {
      const merged = await saveAiConfig(updates);
      const effectiveKey = getEffectiveApiKey(merged);
      // 落盘后同步 adapter 运行时实例，避免切换预设后 baseUrl/model 不匹配导致 400
      // 为什么需要：adapter 在启动时创建，不重新读取 config.json，需手动同步
      if (adapter && typeof adapter.updateConfig === 'function') {
        adapter.updateConfig({
          provider: merged.llm.provider,
          baseUrl: merged.llm.baseUrl,
          model: merged.llm.model,
          apiKey: effectiveKey,
        });
      }
      return reply.send({
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
      return reply.code(500).send({ error: msg });
    }
  });

  // POST /api/ai/reset-config：恢复 LLM 配置到出厂默认值。
  // 为什么需要：用户误改配置后可一键恢复，避免手动编辑 config.json。
  // 仅重置 llm 字段，其他配置保持不变；同步 adapter 运行时实例。
  app.post('/api/ai/reset-config', async (_request: FastifyRequest, reply: FastifyReply) => {
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
      return reply.send({
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
      return reply.code(500).send({ error: msg });
    }
  });

  // POST /api/ai/test-connection：测试 LLM 连接是否可用。
  // 使用 OpenAI 兼容协议发送最小化请求（max_tokens=5），超时 15s。
  app.post('/api/ai/test-connection', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      baseUrl?: string;
      model?: string;
      apiKey?: string;
    } ?? {};

    const config = await loadConfig();

    // 确定测试参数：优先使用请求体中的值（用户可能未保存就测试），其次用 config.json
    const baseUrl = (body.baseUrl || config.llm.baseUrl).trim();
    const model = (body.model || config.llm.model).trim();

    // API Key 解析：请求体新值 > config.json > 环境变量
    let apiKey: string;
    if (body.apiKey && !body.apiKey.startsWith('****')) {
      apiKey = body.apiKey;
    } else {
      apiKey = getEffectiveApiKey(config);
    }

    if (!apiKey && !baseUrl.includes('localhost')) {
      return reply.send({
        ok: false,
        detail: 'API Key 未设置，请先配置 API Key 或设置环境变量 ' + config.llm.apiKeyRef,
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
        return reply.send({ ok: false, detail: formatHttpError(res.status, errText) });
      }

      const data = await res.json();
      return reply.send({
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
      return reply.send({ ok: false, detail });
    } finally {
      clearTimeout(timeout);
    }
  });

  // §5.2 GET /api/ai/web-search：读取联网搜索配置，API Key 脱敏。
  // 为什么需要：前端 Config 页面需要展示当前配置状态，决定是否启用 web_search 工具。
  app.get('/api/ai/web-search', async (_request, reply) => {
    const config = await loadConfig();
    const ws = config.webSearch;
    if (!ws) {
      return reply.send({ enabled: false });
    }
    // 实际生效的 apiKey 优先级：config.json.webSearch.apiKey > process.env[apiKeyRef]
    const effectiveKey = ws.apiKey || process.env[ws.apiKeyRef] || '';
    return reply.send({
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
  app.put('/api/ai/web-search', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      provider?: 'tavily' | 'bing';
      apiKey?: string;
      maxResults?: number;
    };

    if (!body) {
      return reply.code(400).send({ error: '请求体为空' });
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
      return reply.send({
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
      return reply.code(500).send({ error: msg });
    }
  });
}

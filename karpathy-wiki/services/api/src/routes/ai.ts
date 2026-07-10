import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig, saveAiConfig, getEffectiveApiKey, maskApiKey } from '../config.js';

// AI 服务路由：提供 LLM 配置的读取、保存与连接测试。
// 参考 17_xianyu 项目 AI 服务模块设计，适配本项目的 Fastify + config.json 架构。
//   GET  /api/ai/config           读取 AI 配置（API Key 脱敏）
//   PUT  /api/ai/config           保存 AI 配置到 config.json
//   GET  /api/ai/presets          返回 LLM 预设列表
//   POST /api/ai/test-connection  测试 LLM 连接（OpenAI 兼容协议）
export function registerAiRoute(app: FastifyInstance) {
  // LLM 预设列表：统一 OpenAI 兼容协议，前端可一键切换。
  // 为什么需要：降低用户配置成本，常见厂商预填 baseUrl/model/apiKeyRef。
  const LLM_PRESETS = [
    {
      key: 'openai',
      label: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKeyRef: 'OPENAI_API_KEY',
      apiKeyUrl: 'https://platform.openai.com/api-keys',
    },
    {
      key: 'deepseek',
      label: 'DeepSeek',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKeyRef: 'DEEPSEEK_KEY',
      apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    },
    {
      key: 'glm',
      label: '智谱 GLM',
      provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-flash',
      apiKeyRef: 'GLM_KEY',
      apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    },
    {
      key: 'qwen',
      label: '通义千问',
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      apiKeyRef: 'DASHSCOPE_API_KEY',
      apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    },
    {
      key: 'moonshot',
      label: 'Moonshot',
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k',
      apiKeyRef: 'MOONSHOT_API_KEY',
      apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    },
    {
      key: 'doubao',
      label: '豆包',
      provider: 'doubao',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-pro-32k',
      apiKeyRef: 'ARK_API_KEY',
      apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    },
    {
      key: 'ollama',
      label: 'Ollama 本地',
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
      apiKeyRef: 'OLLAMA_API_KEY',
      apiKeyUrl: '',
    },
  ];

  // GET /api/ai/config：返回当前 AI 配置，API Key 脱敏。
  // 脱敏策略：返回 ****xxxx 格式，前端回传此值视为未修改。
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
  app.put('/api/ai/config', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      provider?: string;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
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
    } = {};
    if (body.provider !== undefined) updates.provider = body.provider;
    if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl;
    if (body.model !== undefined) updates.model = body.model;
    if (apiKey !== undefined) updates.apiKey = apiKey;

    try {
      const merged = await saveAiConfig(updates);
      const effectiveKey = getEffectiveApiKey(merged);
      return reply.send({
        ok: true,
        config: {
          provider: merged.llm.provider,
          baseUrl: merged.llm.baseUrl,
          model: merged.llm.model,
          apiKeyRef: merged.llm.apiKeyRef,
          apiKeyMasked: maskApiKey(effectiveKey),
          apiKeySet: Boolean(effectiveKey),
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
        let detail = `API 返回 ${res.status}`;
        // 提取错误信息中的 message 字段（OpenAI 兼容协议的错误格式）
        try {
          const errJson = JSON.parse(errText);
          if (errJson.error?.message) {
            detail += ': ' + errJson.error.message;
          }
        } catch {
          if (errText) detail += ': ' + errText.slice(0, 200);
        }
        return reply.send({ ok: false, detail });
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
}

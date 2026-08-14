/**
 * init-deepseek-config.mjs
 * ---------------------------------------------------------------------------
 * 为 Karpathy-Wiki「AI 服务」初始化 DeepSeek 预设模型的连接配置。
 *
 * 写入目标：api/config.json 的 `llm` 段（服务端默认连接配置）+
 *           `llm.apiKeys.deepseek`（按 provider 分桶的密钥表）。
 *
 * 设计要点（对应需求「包含必要的错误处理以应对密钥或地址无效」）：
 *   1. baseUrl 合法性校验：必须是有效 URL，且必须为 https（DeepSeek 公网端点）。
 *   2. API Key 解析与格式校验：真实密钥优先级为
 *        CLI --api-key > 环境变量 DEEPSEEK_API_KEY > 现有 config.llm.apiKeys.deepseek
 *      注意：用户在需求里写的 `deepseek-v4-flash` 是「模型名」而非密钥，
 *            且并非 DeepSeek 官方模型（官方为 deepseek-chat / deepseek-reasoner）。
 *            本脚本**不会**把该字符串当密钥写入，否则必然 401。
 *   3. 连通性 + 鉴权探测（--check）：向 {baseUrl}/chat/completions 发一次
 *      非流式 max_tokens:1 探测。按 HTTP 状态码区分故障：
 *        - 网络层异常 / DNS / 超时  → 地址无效 / 不可达
 *        - 401 / 403                → 密钥无效或无权访问
 *        - 404 / 400（model 错）    → 模型名无效（deepseek-v4-flash 即属此类）
 *   4. 所有文件 IO / JSON 解析 / 校验均 try/catch，抛出带可操作提示的错误。
 *
 * 用法：
 *   node scripts/init-deepseek-config.mjs                # 默认 --dry-run，仅预览不落盘
 *   node scripts/init-deepseek-config.mjs --apply        # 真实写入 config.json
 *   node scripts/init-deepseek-config.mjs --apply --check # 写入前先做连通性+鉴权探测
 *   node scripts/init-deepseek-config.mjs --model deepseek-reasoner --api-key sk-xxx
 *
 * 说明：本脚本直接改 config.json；若后端已在运行，配置在进程内可能被缓存，
 *       改完后需重启后端（或经 PUT /api/ai/config 热更新）才能对服务端默认配置生效。
 *       CLI / 网页端走 BYOK（每次请求体带 llmConfig），不受此处服务端默认值影响。
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 解析到 api/config.json（scripts 在 karpathy-wiki 下，config 在 api 下）
const CONFIG_PATH = path.resolve(SCRIPT_DIR, '..', 'api', 'config.json');

// 用户在需求中给出的目标参数（model 字段沿用其字面意图；baseUrl / provider 直接落盘）
const TARGET = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  // 需求原文写的是 "deepseek-v4-flash"，但它实为模型名且非官方模型。
  // 这里默认用官方可用模型 deepseek-chat；如需其它模型用 --model 覆盖。
  model: 'deepseek-chat',
  apiKeyRef: 'DEEPSEEK_KEY', // 与 llm-presets.json 中 deepseek 预设的 apiKeyRef 对齐
};

const args = new Set(process.argv.slice(2));
const DRY_RUN = !args.has('--apply');
const DO_CHECK = args.has('--check');
const modelOverride = extractFlag('--model');
const apiKeyOverride = extractFlag('--api-key');
if (modelOverride) TARGET.model = modelOverride;

function extractFlag(name) {
  const i = process.argv.findIndex((a) => a === name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

// ---------- 校验工具 ----------
class ConfigError extends Error {}

function validateBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError(`baseUrl 不是合法 URL：${baseUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new ConfigError(`baseUrl 必须使用 https（DeepSeek 公网端点），当前为：${url.protocol}//`);
  }
  if (!url.hostname) {
    throw new ConfigError(`baseUrl 缺少主机名：${baseUrl}`);
  }
  return url;
}

function resolveApiKey(config) {
  // 优先级：CLI --api-key > 环境变量 > 现有 config.llm.apiKeys.deepseek
  if (apiKeyOverride && apiKeyOverride.trim()) {
    return apiKeyOverride.trim();
  }
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey && envKey.trim()) {
    return envKey.trim();
  }
  const existing = config?.llm?.apiKeys?.deepseek;
  if (existing && existing.trim()) {
    return existing.trim();
  }
  throw new ConfigError(
    '未找到可用的 DeepSeek API Key。请提供以下任一来源：\n' +
    '  - 命令行 --api-key sk-xxxx\n' +
    '  - 环境变量 DEEPSEEK_API_KEY\n' +
    '  - 现有 config.json 的 llm.apiKeys.deepseek\n' +
    '（注意：需求里的 "deepseek-v4-flash" 是模型名，不是密钥，不会被当作密钥使用）',
  );
}

function validateApiKeyFormat(apiKey) {
  // DeepSeek 真实密钥形如 sk-xxxx。非 sk- 前缀一律视为可疑并警告，但不强制阻断，
  // 因为部分自建网关可能用其它前缀；仅对明显像模型名的做强提示。
  if (!apiKey || apiKey.length < 8) {
    throw new ConfigError('API Key 长度异常（过短），疑似无效密钥');
  }
  if (apiKey.startsWith('sk-')) return { ok: true, warn: '' };
  const looksLikeModel = /^[a-z0-9-]+(chat|flash|mini|pro|reasoner|v\d)/i.test(apiKey);
  if (looksLikeModel) {
    throw new ConfigError(
      `提供的字符串 "${apiKey}" 看起来像「模型名」而非 API Key。` +
      `DeepSeek 真实密钥形如 sk-xxxx，请改用 --api-key 或环境变量提供。`,
    );
  }
  return { ok: true, warn: 'API Key 非 sk- 前缀，请确认你的接入点是否使用自定义前缀' };
}

// ---------- 连通性 + 鉴权探测 ----------
async function probeConnection(baseUrl, apiKey, model) {
  const url = new URL('/chat/completions', baseUrl).href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      return { ok: true, status: res.status, message: '连接与鉴权成功' };
    }
    const body = await res.text().catch(() => '');
    // 按状态码归类故障，对应「地址无效 / 密钥无效 / 模型无效」
    if (res.status === 401 || res.status === 403) {
      throw new ConfigError(`密钥无效或无权限（HTTP ${res.status}）。请检查 API Key。响应：${body.slice(0, 200)}`);
    }
    if (res.status === 404) {
      throw new ConfigError(`地址或路径无效（HTTP 404）。请确认 baseUrl 正确（应为 https://api.deepseek.com）。响应：${body.slice(0, 200)}`);
    }
    if (res.status === 400) {
      throw new ConfigError(`请求被拒（HTTP 400），多为模型名无效。当前 model="${model}" 非 DeepSeek 官方模型？响应：${body.slice(0, 200)}`);
    }
    throw new ConfigError(`探测返回非预期状态码 HTTP ${res.status}。响应：${body.slice(0, 200)}`);
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof ConfigError) throw err;
    if (err?.name === 'AbortError') {
      throw new ConfigError('连接超时（15s 无响应）：baseUrl 地址不可达或网络受限');
    }
    throw new ConfigError(`网络层错误（地址无效/不可达）：${err.message}`);
  }
}

// ---------- 主流程 ----------
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ConfigError(`未找到配置文件：${CONFIG_PATH}`);
    }
    throw new ConfigError(`读取/解析 config.json 失败：${err.message}`);
  }
}

function maskKey(k) {
  if (!k) return '(empty)';
  if (k.length <= 6) return '****';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

function buildMergedConfig(config, apiKey) {
  const merged = structuredClone(config);
  merged.llm = merged.llm ?? {};
  merged.llm.provider = TARGET.provider;
  merged.llm.baseUrl = TARGET.baseUrl;
  merged.llm.model = TARGET.model;
  merged.llm.apiKeyRef = TARGET.apiKeyRef;
  merged.llm.apiKey = apiKey;
  merged.llm.apiKeys = merged.llm.apiKeys ?? {};
  merged.llm.apiKeys.deepseek = apiKey;
  return merged;
}

function writeConfig(merged) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  } catch (err) {
    throw new ConfigError(`写入 config.json 失败：${err.message}`);
  }
}

async function main() {
  console.log('=== DeepSeek 连接配置初始化 ===');
  console.log(`配置文件: ${CONFIG_PATH}`);
  console.log(`模式:     ${DRY_RUN ? 'DRY-RUN（仅预览，不落盘）' : 'APPLY（写入 config.json）'}`);

  // 1. 校验 baseUrl
  validateBaseUrl(TARGET.baseUrl);
  console.log(`✔ baseUrl 校验通过: ${TARGET.baseUrl}`);

  // 2. 载入现有配置并解析真实密钥
  const config = loadConfig();
  const apiKey = resolveApiKey(config);

  // 3. 校验密钥格式
  const { warn } = validateApiKeyFormat(apiKey);
  console.log(`✔ API Key 解析成功: ${maskKey(apiKey)}`);
  if (warn) console.log(`  ⚠ ${warn}`);

  // 4. 组装目标配置
  const merged = buildMergedConfig(config, apiKey);

  // 5. 可选：连通性 + 鉴权探测
  if (DO_CHECK) {
    console.log('→ 执行连通性 + 鉴权探测（--check）...');
    const result = await probeConnection(TARGET.baseUrl, apiKey, TARGET.model);
    console.log(`✔ ${result.message}（HTTP ${result.status}）`);
  }

  // 6. 预览 / 写入
  console.log('\n--- 将写入的 llm 段 ---');
  console.log(JSON.stringify({
    provider: merged.llm.provider,
    baseUrl: merged.llm.baseUrl,
    model: merged.llm.model,
    apiKeyRef: merged.llm.apiKeyRef,
    apiKey: maskKey(merged.llm.apiKey),
    'apiKeys.deepseek': maskKey(merged.llm.apiKeys.deepseek),
  }, null, 2));

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] 未做任何修改。确认无误后加 --apply 真正写入。');
    return;
  }

  writeConfig(merged);
  console.log('\n✔ 已写入 config.json。若后端正在运行，请重启后端或经 PUT /api/ai/config 热更新以使服务端默认配置生效。');
}

main().catch((err) => {
  const msg = err instanceof ConfigError ? err.message : `未预期错误：${err?.stack || err}`;
  console.error(`\n✘ 初始化失败：\n${msg}`);
  process.exit(1);
});

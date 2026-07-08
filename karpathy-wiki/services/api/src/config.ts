import fs from 'fs/promises';
import path from 'path';
import type { AppConfig } from './types.js';

// 配置文件默认查找路径：CWD/config.json 或 services/api/config.json
const CONFIG_FILENAME = 'config.json';

// 默认配置（NPR-05-7 默认值清单）。
// vaultPath 默认 './vault'，host 'localhost'，port 3000。
function defaultConfig(): AppConfig {
  return {
    vaultPath: './vault',
    adapter: 'harness',
    llm: {
      provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-plus',
      apiKeyRef: 'GLM_KEY',
    },
    budget: { maxSteps: 20, tokenBudget: 50000 },
    server: { host: 'localhost', port: 3000 },
    localOnly: false,
    healthCheck: { staleDays: 30 },
  };
}

// 从 config.json 加载配置，合并默认值。
// apiKeyRef 仅存环境变量名，API Key 在使用方通过 process.env[apiKeyRef] 读取（M-7）。
export async function loadConfig(): Promise<AppConfig> {
  const defaults = defaultConfig();
  const candidates = [
    path.resolve(process.cwd(), CONFIG_FILENAME),
    path.resolve(process.cwd(), 'services', 'api', CONFIG_FILENAME),
  ];

  let raw: string | null = null;
  for (const p of candidates) {
    try {
      raw = await fs.readFile(p, 'utf8');
      break;
    } catch {
      // 继续尝试下一个候选路径
    }
  }

  if (!raw) {
    return defaults;
  }

  let parsed: Partial<AppConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<AppConfig>;
  } catch {
    return defaults;
  }

  // 浅合并嵌套对象，避免下层数据丢失
  return {
    ...defaults,
    ...parsed,
    llm: { ...defaults.llm, ...parsed.llm },
    budget: { ...defaults.budget, ...parsed.budget },
    server: { ...defaults.server, ...parsed.server },
    healthCheck: { ...defaults.healthCheck, ...parsed.healthCheck },
  };
}

// §12.3-7 配置热加载：重新读取 config.json 并返回新配置。
// 热加载作用域：llm.model/budget/healthCheck.staleDays 可即时生效（运行时参数）。
// 需重启生效项：adapter/vaultPath/server（涉及实例重建或端口绑定）。
// 调用方需自行判断哪些字段可热更新。
export async function reloadConfig(): Promise<AppConfig> {
  return loadConfig();
}

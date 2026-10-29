// 配置「生效方式」单一可信源（T02467 / PRD §10 C1 / REQ-032）
// ------------------------------------------------------------------
// 为什么需要：此前「改了配置到底要不要重启」散落在三处且互不自洽——
//   1) POST /api/config/reload 硬编码 requireRestart: ['adapter','vaultPath','server','llm.provider','llm.baseUrl']
//   2) PUT /api/config/batch 硬编码 ['multipart.fileSize']
//   3) PUT /api/config/logging 硬编码 ['pino.level']
//   而前端 Config.vue 只在保存后的 toast 里拼一句「需重启服务才完全生效」，
//   用户在改任何一个字段之前都无法预判代价（PRD C1：三套生效路径并存且不可预判，P0）。
//
// 本模块把「字段 → 生效方式 → 原因」收敛为一份登记表：
//   - 路由响应（requireRestart / restartHints）由登记表派生，不再各写各的；
//   - GET /api/config/effects 把同一份登记表交给前端渲染字段旁徽标与页顶「待重启」汇总。
//
// 两条修改路径必须分开说（这是 C1 里最容易含糊的地方）：
//   effect  —— 在配置中心界面上保存这一项时，运行时什么时候用新值：instant 即时 / restart 需重启。
//   viaFile —— 绕过界面、直接编辑 config.json 时：reload 点「热加载配置」即可 / restart 仍需重启。
//   例：maxSteps 界面上保存会同步 adapter（instant），但手改 config.json 只落盘，
//       得点热加载才会被运行时读到（viaFile=reload）——两条路径都要标得出来。

export type ConfigEffect = 'instant' | 'restart';
// 直接编辑文件这条路径上的生效方式：
//   instant —— 这个配置本身就是那份文件（SCHEMA.md / Prompt 模板），写完下一次读取就是新值，没有「热加载」这一步；
//   reload  —— 改 config.json 只落盘，需点「热加载配置」才会被运行时读到；
//   restart —— 无论改文件还是热加载，都得重启。
export type ConfigFileEffect = 'instant' | 'reload' | 'restart';

/** 一条字段级生效登记 */
export interface ConfigEffectItem {
  /** 稳定标识，前后端共用（也是页顶「待重启清单」的持久化标识） */
  key: string;
  /** 面向用户的中文名称（不出现裸技术词） */
  label: string;
  effect: ConfigEffect;
  viaFile: ConfigFileEffect;
  /** 所属配置 tab，与前端 configTabs.ts 的 tab name 对齐 */
  tab: string;
  /** 人话说明：为什么是这个生效方式 / 改了会有什么后果 */
  reason: string;
  /**
   * 该登记项在 config.json 里的真实路径（默认与 key 相同）。
   * 只有「登记名与存储路径不一致」时才需要写：例如单文件上限，界面语义是框架的
   * multipart 限制（key=multipart.fileSize），落盘字段是 batch.maxFileSizeMb。
   * changedRestartKeys() 靠它做导入前后的逐字段比对。
   */
  configPath?: string;
}

/**
 * 字段生效登记表。
 * 新增配置项时在此登记，禁止在路由里另写硬编码数组（否则页顶汇总会漏项）。
 */
export const CONFIG_EFFECT_ITEMS: readonly ConfigEffectItem[] = [
  // ===== 界面保存也救不了、必须重启的字段（同时手改文件也需重启）=====
  {
    key: 'adapter',
    label: '编译引擎',
    effect: 'restart',
    viaFile: 'restart',
    tab: 'config',
    reason: '引擎实例在服务端启动时创建，换引擎要重启进程才会用新实例编译。',
  },
  {
    key: 'vaultPath',
    label: 'Vault 路径',
    effect: 'restart',
    viaFile: 'restart',
    tab: 'config',
    reason: '知识库目录在启动时绑定，改后需重启，否则仍在读写旧目录。',
  },
  {
    key: 'server.host',
    label: '监听地址',
    effect: 'restart',
    viaFile: 'restart',
    tab: 'config',
    reason: '监听地址在启动时绑定，改后需重启才会在新地址上提供服务。',
  },
  {
    key: 'server.port',
    label: '服务端口',
    effect: 'restart',
    viaFile: 'restart',
    tab: 'config',
    reason: '端口在启动时占用，改后需重启；重启期间本地地址与已分享链接都会变化。',
  },
  {
    key: 'llm.provider',
    label: '模型服务商（共享）',
    effect: 'restart',
    viaFile: 'restart',
    tab: 'config',
    reason: '服务商决定客户端类型，共享配置切换后需重启；个人「AI 服务」私有配置不受此限制。',
  },
  {
    key: 'llm.baseUrl',
    label: 'API 地址（共享）',
    effect: 'restart',
    viaFile: 'restart',
    tab: 'config',
    reason: '共享配置的 API 地址在客户端创建时写入，改后需重启（个人私有配置即时生效）。',
  },
  {
    key: 'multipart.fileSize',
    label: '单文件上限（MB）',
    effect: 'restart',
    viaFile: 'restart',
    tab: 'config',
    configPath: 'batch.maxFileSizeMb',
    reason: '上传大小限制在框架注册时固定，改后需重启才能真正放开；调小不影响已上传文件。',
  },
  {
    key: 'logging.level',
    label: '日志级别',
    effect: 'restart',
    viaFile: 'restart',
    tab: 'config',
    reason: '日志器在启动时创建，级别改后需重启；调成 debug 会显著增加日志量。',
  },
  {
    key: 'localOnly',
    label: '本地调试模式',
    effect: 'restart',
    viaFile: 'restart',
    tab: 'config',
    reason: '该模式在启动时注进认证模块，决定默认口令提示与首登强制改密；改后需重启才切换。',
  },
  {
    key: 'llm.apiKeyRef',
    label: '共享 API Key（环境变量）',
    effect: 'restart',
    viaFile: 'restart',
    tab: 'config',
    reason: 'Key 从进程环境变量读取，而环境变量在启动时固定；换 Key 或换变量名都需重启（个人私有 Key 不受影响）。',
  },

  // ===== 界面保存即时生效，手改 config.json 需点「热加载配置」=====
  {
    key: 'llm.model',
    label: '模型名称',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'config',
    reason: '在本页保存后立即用于下一次调用；直接改 config.json 则要点「热加载配置」。',
  },
  {
    key: 'budget.maxSteps',
    label: '最大步数',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'config',
    reason: '保存即同步运行时；直接改 config.json 需点「热加载配置」。调大会增加单次消耗。',
  },
  {
    key: 'budget.tokenBudget',
    label: 'Token 预算',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'config',
    reason: '保存即同步运行时；直接改 config.json 需点「热加载配置」。调小可能中途截断。',
  },
  {
    key: 'healthCheck.staleDays',
    label: '过期阈值（天）',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'config',
    reason: '保存即同步运行时；直接改 config.json 需点「热加载配置」。只影响体检判定，不改动页面内容。',
  },

  // ===== 即时生效 =====
  {
    key: 'enableSubAgents',
    label: '子智能体（多步 Agent）',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'config',
    reason: '开关保存后立即注册/注销，下一次问答即按新设置执行。',
  },
  {
    key: 'logging.enableRequestLog',
    label: '记录请求日志',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'config',
    reason: '请求钩子每次运行时读取该开关，保存后下一条请求即生效。',
  },
  {
    key: 'batch.allowedExtensions',
    label: '允许的扩展名',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'config',
    reason: '投递时在服务端逐项校验，保存后下一次投递即按新清单放行或拒绝。',
  },
  {
    key: 'batch.maxBatchSize',
    label: '最大批量数',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'config',
    reason: '批量入队时读取，保存后下一次投递即生效。',
  },
  {
    key: 'mcp',
    label: '对外 MCP 端点',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'mcp',
    reason: '端点每次被调用时读取配置，保存后外部 Agent 下一次连接即用新配置（已连上的需重连）。',
  },
  {
    key: 'schema',
    label: 'SCHEMA 规范',
    effect: 'instant',
    viaFile: 'instant',
    tab: 'schema',
    reason: '保存即写入 SCHEMA.md，下一次编译读取新规范；已生成的页面不会自动重写。',
  },
  {
    key: 'prompts',
    label: 'Prompt 模板',
    effect: 'instant',
    viaFile: 'instant',
    tab: 'prompts',
    reason: '保存即落盘，下一次 AI 调用使用新模板。',
  },
  {
    key: 'sharedAi',
    label: '共享 AI（生图/视频）',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'sharedAi',
    reason: '服务端每次生成时读取，保存后下一次生成即生效。',
  },
  {
    key: 'ai',
    label: '个人 AI 服务（私有 Key）',
    effect: 'instant',
    viaFile: 'instant',
    tab: 'ai',
    reason: '保存在本浏览器，下一次提问/编译即按此配置；只影响当前用户，不写入服务端配置。',
  },
  {
    key: 'tools',
    label: '工具配置',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'tools',
    reason: '保存后落盘并刷新运行时缓存，下一次调用工具即生效。',
  },
  {
    key: 'tts',
    label: '朗读设置',
    effect: 'instant',
    viaFile: 'instant',
    tab: 'tts',
    reason: '保存在本浏览器，下次点击朗读立即使用新的音色与语速。',
  },
  {
    key: 'theme',
    label: '界面主题',
    effect: 'instant',
    viaFile: 'instant',
    tab: 'theme',
    reason: '切换后立即应用，只影响当前浏览器。',
  },
  {
    key: 'qq',
    label: 'QQ 聊天记录导入',
    effect: 'instant',
    viaFile: 'reload',
    tab: 'qq',
    reason: '保存在服务端配置，下一次导入即按新设置解析。',
  },
  // 注：「数据迁移」不是一个配置字段，而是批量覆盖多个字段的操作，因此不进本登记表；
  // 它导入后哪些字段需重启，由界面按 restartKeys() 汇总提示（页顶待重启清单同样来源此处）。
];

/** 按 key 查登记项 */
export function findEffectItem(key: string): ConfigEffectItem | undefined {
  return CONFIG_EFFECT_ITEMS.find((item) => item.key === key);
}

/** 界面保存后仍需重启的字段（保存响应 requireRestart 的唯一来源） */
export function restartKeys(): string[] {
  return CONFIG_EFFECT_ITEMS.filter((item) => item.effect === 'restart').map((item) => item.key);
}

/**
 * 把一次保存里「实际改动的请求体字段」映射为需重启 key 列表。
 * @param changedKeys 请求体里出现过的字段名（maxFileSizeMb / level 等）
 * @param map 字段名 → 登记 key 的映射（由各路由声明，登记表保持与界面一致）
 */
export function restartKeysForChange(
  changedKeys: readonly string[],
  map: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  for (const field of changedKeys) {
    const key = map[field];
    if (!key) continue;
    const item = findEffectItem(key);
    if (item?.effect === 'restart' && !out.includes(key)) out.push(key);
  }
  return out;
}

/** requireRestart 响应里附带的可读条目（前端据此直接渲染，不必再查表） */
export interface RestartHint {
  key: string;
  label: string;
  reason: string;
}

export function restartHints(keys: readonly string[]): RestartHint[] {
  const out: RestartHint[] = [];
  for (const key of keys) {
    const item = findEffectItem(key);
    if (item) out.push({ key: item.key, label: item.label, reason: item.reason });
  }
  return out;
}

/** 按点分路径读配置值；路径不存在的中间节点为 null/非对象时返回 undefined（不抛错） */
function readPath(config: unknown, path: string): unknown {
  let current: unknown = config;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 登记项在 config.json 里的真实路径（未声明 configPath 时即 key 本身） */
export function configPathOf(key: string): string | undefined {
  const item = findEffectItem(key);
  return item ? item.configPath ?? item.key : undefined;
}

/**
 * 保存前读旧值只为判断「这个字段真的改了吗」。
 * 读不到（配置损坏 / 并发写失败）时保守返回 true —— 宁可多提示一次重启，也不静默漏提示。
 * @param before 保存前的配置（null 表示没读到）
 * @param key 登记表 key（如 multipart.fileSize）
 * @param next 请求体里准备写入的新值
 */
export function valueChangedForConfigKey(before: unknown, key: string, next: unknown): boolean {
  if (before === null || before === undefined) return true;
  const path = configPathOf(key);
  if (!path) return true;
  return JSON.stringify(readPath(before, path)) !== JSON.stringify(next);
}

/**
 * 比对两份配置，返回「界面保存仍需重启」且值确实发生变化的登记项 key。
 * 为什么需要：数据迁移（POST /api/config/import）一次可能覆盖十几个字段，
 * 只回「applied=N」用户无从知道要不要重启。逐字段比登记表而不是猜。
 * 任一侧读不到时保守返回全部需重启 key（不静默报「不用重启」）。
 */
export function changedRestartKeys(before: unknown, after: unknown): string[] {
  if (before === null || before === undefined || after === null || after === undefined) {
    return restartKeys();
  }
  const out: string[] = [];
  for (const item of CONFIG_EFFECT_ITEMS) {
    if (item.effect !== 'restart') continue;
    const path = item.configPath ?? item.key;
    if (JSON.stringify(readPath(before, path)) !== JSON.stringify(readPath(after, path))) out.push(item.key);
  }
  return out;
}

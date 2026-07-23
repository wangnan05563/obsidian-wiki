<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ThemeSwitcher from '../components/ThemeSwitcher.vue';
import type { ConfigData, SchemaContent, ReloadResult, SchemaCommit, DiffLine, AiConfig, LlmPreset, AiTestResult, ToolsConfig } from '../types';
import { apiErrorMessage } from '../utils/apiError';
import { STORAGE_KEYS, presetStorageKey } from '../constants/storageKeys';

const activeTab = ref<'schema' | 'config' | 'ai' | 'theme' | 'tools'>('schema');
const config = ref<ConfigData | null>(null);
const schemaContent = ref<string>('');
const schemaBuffer = ref<string>('');
const editingSchema = ref(false);
const loadingSchema = ref(false);
const loadingConfig = ref(false);
const savingSchema = ref(false);
// §12.3-7 热加载状态
const reloading = ref(false);
const reloadResult = ref<ReloadResult | null>(null);

// §6.X SCHEMA 版本历史
const commits = ref<SchemaCommit[]>([]);
const gitEnabled = ref(false);
const loadingHistory = ref(false);
// 选中的对比基线 commit hash
const selectedFrom = ref<string>('');
// diff 结果
const diffLines = ref<DiffLine[]>([]);
const loadingDiff = ref(false);
const showDiff = ref(false);

// 加载 SCHEMA.md
async function loadSchema() {
  loadingSchema.value = true;
  try {
    const res = await fetch('/api/schema');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: SchemaContent = await res.json();
    schemaContent.value = data.content;
    schemaBuffer.value = data.content;
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载 SCHEMA 失败', err));
  } finally {
    loadingSchema.value = false;
  }
}

// §6.X 加载 SCHEMA 版本历史（git log）
async function loadHistory() {
  loadingHistory.value = true;
  try {
    const res = await fetch('/api/schema/history');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    commits.value = data.commits ?? [];
    gitEnabled.value = data.gitEnabled ?? false;
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载版本历史失败', err));
  } finally {
    loadingHistory.value = false;
  }
}

// §6.X 加载版本对比（git diff）
async function loadDiff() {
  if (!selectedFrom.value) return;
  loadingDiff.value = true;
  showDiff.value = true;
  try {
    const res = await fetch(`/api/schema/diff?from=${encodeURIComponent(selectedFrom.value)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    diffLines.value = data.lines ?? [];
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载版本对比失败', err));
    diffLines.value = [];
  } finally {
    loadingDiff.value = false;
  }
}

// 保存 SCHEMA.md
async function saveSchema() {
  savingSchema.value = true;
  try {
    const res = await fetch('/api/schema', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: schemaBuffer.value }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    ElMessage.success('SCHEMA 保存成功，下次编译/问答将使用新规范');
    schemaContent.value = schemaBuffer.value;
    editingSchema.value = false;
    // 保存后刷新版本历史
    await loadHistory();
  } catch (err) {
    ElMessage.error(apiErrorMessage('保存失败', err));
  } finally {
    savingSchema.value = false;
  }
}

// 取消编辑
function cancelEdit() {
  schemaBuffer.value = schemaContent.value;
  editingSchema.value = false;
}

// 提取为函数以避免模板中出现嵌套三元（S3358）
function diffLinePrefix(type: string): string {
  if (type === 'add') return '+';
  if (type === 'del') return '-';
  return ' ';
}

// 加载配置
async function loadConfig() {
  loadingConfig.value = true;
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    config.value = await res.json();
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载配置失败', err));
  } finally {
    loadingConfig.value = false;
  }
}

// provider 中文名
const PROVIDER_LABELS: Record<string, string> = {
  glm: '智谱 GLM',
  qwen: '通义千问',
  deepseek: 'DeepSeek',
};

// §12.3-7 热加载：重读 config.json 并即时应用到运行中的 adapter。
// 仅 model/budget/staleDays 即时生效，adapter/vaultPath/server 需重启进程。
async function reloadConfig() {
  reloading.value = true;
  try {
    const res = await fetch('/api/config/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    reloadResult.value = await res.json();
    ElMessage.success('配置已热加载');
    // 刷新展示，让用户看到应用后的值
    await loadConfig();
  } catch (err) {
    ElMessage.error(apiErrorMessage('热加载失败', err));
  } finally {
    reloading.value = false;
  }
}

// ===== AI 服务配置 =====

// AI 配置状态
const aiConfig = ref<AiConfig | null>(null);
const aiPresets = ref<LlmPreset[]>([]);
const loadingAi = ref(false);
const savingAi = ref(false);
const testingAi = ref(false);
const aiTestResult = ref<AiTestResult | null>(null);

// AI 表单（可编辑，与 aiConfig 分离，保存时才同步）
const aiForm = ref({
  provider: '',
  baseUrl: '',
  model: '',
  apiKey: '', // 脱敏值或新输入值
});

// 当前选中的预设 key（用于按预设持久化配置）
const selectedPresetKey = ref('');

// 表单 placeholder 从当前选中预设派生，避免硬编码 OpenAI 默认值。
// 为什么用 computed：切换预设时 aiForm.provider 变化自动重算 placeholder，
//   无需在 applyPreset/loadAiConfig 中手动同步。
const matchedPreset = computed(() =>
  aiPresets.value.find(p => p.provider === aiForm.value.provider)
);
const aiBaseUrlPlaceholder = computed(() => matchedPreset.value?.baseUrl ?? '请输入 API Base URL');
const aiModelPlaceholder = computed(() => matchedPreset.value?.model ?? '请输入模型名称');

// 按预设持久化非敏感 UI 状态（baseUrl/model）到 localStorage。
// 为什么不存 apiKey：apiKey 明文存 localStorage 与后端 config.json 形成双轨，
// 两者独立变化会导致状态不一致。apiKey 唯一权威源为后端 config.json。
// 切换预设时 apiKey 从后端读取脱敏值返显，明文 key 仅用户输入时短暂存在内存。
// presetStorageKey 函数已从 constants/storageKeys.ts 导入，此处不再重复定义。

interface PresetConfigCache {
  baseUrl: string;
  model: string;
}

function loadPresetCache(presetKey: string): PresetConfigCache | null {
  const raw = localStorage.getItem(presetStorageKey(presetKey));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PresetConfigCache> & { apiKey?: string };
      // 兼容旧格式（含 apiKey 字段）：忽略 apiKey，仅取 baseUrl/model
      return {
        baseUrl: parsed.baseUrl ?? '',
        model: parsed.model ?? '',
      };
    } catch {
      // 损坏数据忽略
    }
  }
  return null;
}

function savePresetCache(presetKey: string, cache: PresetConfigCache): void {
  localStorage.setItem(presetStorageKey(presetKey), JSON.stringify(cache));
}

function clearAllPresetCache(): void {
  // 清除所有 llmPresetConfig:* 和遗留的 apiKey:* 条目（旧格式迁移清理）
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.startsWith(STORAGE_KEYS.LLM_PRESET_CONFIG_PREFIX) || k.startsWith('apiKey:'))) {
      keysToRemove.push(k);
    }
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));
}

// 加载 AI 配置
async function loadAiConfig() {
  loadingAi.value = true;
  try {
    const res = await fetch('/api/ai/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: AiConfig = await res.json();
    aiConfig.value = data;
    // 表单初始化为当前配置，apiKey 显示脱敏值
    aiForm.value = {
      provider: data.provider,
      baseUrl: data.baseUrl,
      model: data.model,
      apiKey: data.apiKeyMasked || '',
    };
    // 根据当前 provider 匹配预设 key，用于后续按预设持久化
    const matched = aiPresets.value.find(p => p.provider === data.provider);
    selectedPresetKey.value = matched?.key ?? '';
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载 AI 配置失败', err));
  } finally {
    loadingAi.value = false;
  }
}

// 加载 LLM 预设列表
async function loadPresets() {
  try {
    const res = await fetch('/api/ai/presets');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    aiPresets.value = data.presets ?? [];
  } catch {
    // 预设加载失败不阻断，用户可手动输入
  }
}

// 应用预设：切换标签时返显该预设上次保存的 baseUrl/model。
// apiKey 不从 localStorage 缓存读取，而是从后端 config.json 读取当前脱敏值。
// 为什么切换时同步后端：后端 config.json 只有一份全局配置，
//   切换预设后需同步到后端，确保 Query 页面等使用当前预设的配置。
//   不传 apiKey：后端收到 undefined 表示保留现有 key，避免切换预设清空 key。
async function applyPreset(preset: LlmPreset) {
  selectedPresetKey.value = preset.key;
  const cache = loadPresetCache(preset.key);
  aiForm.value.provider = preset.provider;
  // 有缓存则用缓存的 baseUrl/model（用户可能修改过），否则用预设默认值
  aiForm.value.baseUrl = cache?.baseUrl || preset.baseUrl;
  aiForm.value.model = cache?.model || preset.model;

  // 后台同步到后端 config.json（不传 apiKey，保留现有 key）
  try {
    const res = await fetch('/api/ai/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: preset.provider,
        baseUrl: aiForm.value.baseUrl,
        model: aiForm.value.model,
        // 不传 apiKey：后端收到 undefined 表示不修改现有 key
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) {
        aiConfig.value = data.config;
        // 从后端返回的脱敏值回填表单 apiKey
        aiForm.value.apiKey = data.config.apiKeyMasked || '';
      }
    }
  } catch {
    // 同步失败不阻断切换，用户可手动点"保存配置"
  }

  ElMessage.success(`已切换到 ${preset.label} 预设`);
}

// 保存 AI 配置
async function saveAiConfig() {
  if (!aiForm.value.baseUrl.trim()) {
    ElMessage.warning('请填写 API Base URL');
    return;
  }
  if (!aiForm.value.model.trim()) {
    ElMessage.warning('请填写模型名称');
    return;
  }

  savingAi.value = true;
  try {
    const res = await fetch('/api/ai/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: aiForm.value.provider,
        baseUrl: aiForm.value.baseUrl,
        model: aiForm.value.model,
        apiKey: aiForm.value.apiKey,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      aiConfig.value = data.config;
      // 保存成功后按预设持久化非敏感 UI 状态（baseUrl/model）到 localStorage。
      // 为什么不存 apiKey：apiKey 唯一权威源为后端 config.json，避免双轨不一致。
      if (selectedPresetKey.value) {
        savePresetCache(selectedPresetKey.value, {
          baseUrl: aiForm.value.baseUrl,
          model: aiForm.value.model,
        });
      }
      // 保存后更新表单 apiKey 为脱敏值
      aiForm.value.apiKey = data.config.apiKeyMasked || '';
      ElMessage.success('AI 配置保存成功');
    } else {
      throw new Error(data.error || '保存失败');
    }
  } catch (err) {
    ElMessage.error(apiErrorMessage('保存失败', err));
  } finally {
    savingAi.value = false;
  }
}

// 恢复初始配置：调用后端重置接口，恢复出厂默认 LLM 配置。
// 为什么需要：用户误改配置后可一键恢复，避免手动编辑 config.json。
// 同时清除 localStorage 中的预设缓存，确保前端状态与后端一致。
const resettingAi = ref(false);
async function resetAiConfig() {
  try {
    await ElMessageBox.confirm(
      '确定恢复 LLM 配置到出厂默认值吗？此操作将重置 provider/baseUrl/model/apiKey，且不可撤销。',
      '恢复初始配置',
      { confirmButtonText: '确定恢复', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    // 用户取消
    return;
  }

  resettingAi.value = true;
  try {
    const res = await fetch('/api/ai/reset-config', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      aiConfig.value = data.config;
      aiForm.value = {
        provider: data.config.provider,
        baseUrl: data.config.baseUrl,
        model: data.config.model,
        apiKey: data.config.apiKeyMasked || '',
      };
      // 重置当前选中预设 key
      const matched = aiPresets.value.find(p => p.provider === data.config.provider);
      selectedPresetKey.value = matched?.key ?? '';
      // 清除 localStorage 中所有预设缓存，避免恢复后又被旧缓存覆盖
      clearAllPresetCache();
      aiTestResult.value = null;
      ElMessage.success('已恢复到出厂默认配置');
    } else {
      throw new Error(data.error || '恢复失败');
    }
  } catch (err) {
    ElMessage.error(apiErrorMessage('恢复初始配置失败', err));
  } finally {
    resettingAi.value = false;
  }
}

// 测试 LLM 连接
async function testConnection() {
  testingAi.value = true;
  aiTestResult.value = null;
  try {
    const res = await fetch('/api/ai/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: aiForm.value.baseUrl,
        model: aiForm.value.model,
        apiKey: aiForm.value.apiKey,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // 使用局部变量收窄类型，避免 ref 在 await 后被认为可能为 null
    const result: AiTestResult = await res.json();
    aiTestResult.value = result;
    if (result.ok) {
      ElMessage.success('连接测试成功');
    } else {
      ElMessage.warning('连接测试失败');
    }
  } catch (err) {
    aiTestResult.value = { ok: false, detail: (err as Error).message };
    ElMessage.error(apiErrorMessage('测试失败', err));
  } finally {
    testingAi.value = false;
  }
}

// 格式化测试结果文本（计算属性避免模板中类型收窄问题）
const testResultText = computed(() => {
  const r = aiTestResult.value;
  if (!r) return '';
  return r.ok ? `连接成功（模型: ${r.model || '未知'}）` : r.detail;
});

// 测试结果图标：成功/失败返回不同字符，避免 S3923（两分支返回相同值）
const testResultIcon = computed(() => {
  const r = aiTestResult.value;
  if (!r) return '';
  return r.ok ? '✓' : '✗';
});

// ===== 联网搜索配置 =====
// §5.2 webSearch 配置状态：与 LLM 配置独立，用户可单独启用/禁用联网搜索
const webSearchForm = ref({
  provider: 'tavily' as 'tavily' | 'bing',
  apiKey: '',
  maxResults: 5,
});
const webSearchStatus = ref<{
  enabled: boolean;
  apiKeySet: boolean;
  apiKeyMasked: string;
  apiKeyRef: string;
} | null>(null);
const loadingWebSearch = ref(false);
const savingWebSearch = ref(false);

// 联网搜索 provider 中文标签
const WEB_SEARCH_PROVIDERS: Array<{ value: 'tavily' | 'bing'; label: string; apiKeyUrl: string }> = [
  { value: 'tavily', label: 'Tavily', apiKeyUrl: 'https://tavily.com' },
  { value: 'bing', label: 'Bing', apiKeyUrl: 'https://www.microsoft.com/bing/apis' },
];

async function loadWebSearchConfig() {
  loadingWebSearch.value = true;
  try {
    const res = await fetch('/api/ai/web-search');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.enabled) {
      webSearchForm.value.provider = data.provider;
      webSearchForm.value.apiKey = data.apiKeyMasked || '';
      webSearchForm.value.maxResults = data.maxResults ?? 5;
      webSearchStatus.value = {
        enabled: true,
        apiKeySet: data.apiKeySet,
        apiKeyMasked: data.apiKeyMasked || '',
        apiKeyRef: data.apiKeyRef,
      };
    } else {
      webSearchStatus.value = { enabled: false, apiKeySet: false, apiKeyMasked: '', apiKeyRef: 'TAVILY_API_KEY' };
    }
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载联网搜索配置失败', err));
  } finally {
    loadingWebSearch.value = false;
  }
}

async function saveWebSearchConfig() {
  savingWebSearch.value = true;
  try {
    const res = await fetch('/api/ai/web-search', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: webSearchForm.value.provider,
        apiKey: webSearchForm.value.apiKey,
        maxResults: webSearchForm.value.maxResults,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      const cfg = data.config;
      webSearchStatus.value = {
        enabled: true,
        apiKeySet: cfg.apiKeySet,
        apiKeyMasked: cfg.apiKeyMasked || '',
        apiKeyRef: cfg.apiKeyRef,
      };
      // 保存后表单 apiKey 显示脱敏值
      webSearchForm.value.apiKey = cfg.apiKeyMasked || '';
      webSearchForm.value.provider = cfg.provider;
      webSearchForm.value.maxResults = cfg.maxResults ?? 5;
      ElMessage.success('联网搜索配置保存成功');
    } else {
      throw new Error(data.error || '保存失败');
    }
  } catch (err) {
    ElMessage.error(apiErrorMessage('保存失败', err));
  } finally {
    savingWebSearch.value = false;
  }
}

// ===== 高级配置：运行参数 / 健康检查 / 批量编译 / 日志 =====
// 这些表单补全 config.json 已有但前端缺失的编辑入口，降低用户配置门槛。
// 表单初始值从 GET /api/config 派生，保存时调用 PUT /api/config/{子资源} 落盘。

// 运行参数表单（maxSteps / tokenBudget）
// tokenBudget 默认值与后端 config.json 保持一致（200000），避免回显前显示旧值
const budgetForm = ref({ maxSteps: 20, tokenBudget: 200000 });
const savingBudget = ref(false);

// 健康检查表单（staleDays）
const healthCheckForm = ref({ staleDays: 30 });
const savingHealthCheck = ref(false);

// 批量编译表单（allowedExtensions 逗号分隔输入 + maxBatchSize + maxFileSizeMb）
const batchForm = ref({
  allowedExtensionsText: 'md, txt, pdf, html, json',
  maxBatchSize: 20,
  maxFileSizeMb: 10,
});
const savingBatch = ref(false);

// 日志表单（level / enableRequestLog）
const loggingForm = ref({ level: 'info', enableRequestLog: true });
const savingLogging = ref(false);

// 日志级别可选项（与后端 pino logger 级别对齐）
const LOG_LEVEL_OPTIONS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

// 从 GET /api/config 返回值派生 4 个表单的初始值
function syncAdvancedFormsFromConfig(cfg: ConfigData): void {
  budgetForm.value.maxSteps = cfg.budget.maxSteps;
  budgetForm.value.tokenBudget = cfg.budget.tokenBudget;
  healthCheckForm.value.staleDays = cfg.healthCheck.staleDays;
  batchForm.value.allowedExtensionsText = cfg.batch.allowedExtensions.join(', ');
  batchForm.value.maxBatchSize = cfg.batch.maxBatchSize;
  batchForm.value.maxFileSizeMb = cfg.batch.maxFileSizeMb;
  loggingForm.value.level = cfg.logging.level;
  loggingForm.value.enableRequestLog = cfg.logging.enableRequestLog;
}

// 保存运行参数
async function saveBudget() {
  if (!Number.isInteger(budgetForm.value.maxSteps) || budgetForm.value.maxSteps < 1) {
    ElMessage.warning('最大步数必须为正整数');
    return;
  }
  if (!Number.isInteger(budgetForm.value.tokenBudget) || budgetForm.value.tokenBudget < 1) {
    ElMessage.warning('Token 预算必须为正整数');
    return;
  }
  savingBudget.value = true;
  try {
    const res = await fetch('/api/config/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxSteps: budgetForm.value.maxSteps,
        tokenBudget: budgetForm.value.tokenBudget,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      // 同步本地 config 引用，避免只读展示与编辑表单不一致
      if (config.value) {
        config.value.budget = data.config;
      }
      ElMessage.success('运行参数保存成功');
    } else {
      throw new Error(data.error || '保存失败');
    }
  } catch (err) {
    ElMessage.error(apiErrorMessage('保存运行参数失败', err));
  } finally {
    savingBudget.value = false;
  }
}

// 保存健康检查配置
async function saveHealthCheck() {
  if (!Number.isInteger(healthCheckForm.value.staleDays) || healthCheckForm.value.staleDays < 1) {
    ElMessage.warning('过期阈值必须为正整数（天）');
    return;
  }
  savingHealthCheck.value = true;
  try {
    const res = await fetch('/api/config/health-check', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staleDays: healthCheckForm.value.staleDays }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      if (config.value) {
        config.value.healthCheck = data.config;
      }
      ElMessage.success('健康检查配置保存成功');
    } else {
      throw new Error(data.error || '保存失败');
    }
  } catch (err) {
    ElMessage.error(apiErrorMessage('保存健康检查配置失败', err));
  } finally {
    savingHealthCheck.value = false;
  }
}

// 保存批量编译配置
async function saveBatch() {
  // 解析逗号分隔的扩展名列表
  const extensions = batchForm.value.allowedExtensionsText
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(e => e.length > 0);
  if (extensions.length === 0) {
    ElMessage.warning('请至少填写一个允许的扩展名');
    return;
  }
  if (!Number.isInteger(batchForm.value.maxBatchSize) || batchForm.value.maxBatchSize < 1) {
    ElMessage.warning('最大批量数必须为正整数');
    return;
  }
  if (!Number.isInteger(batchForm.value.maxFileSizeMb) || batchForm.value.maxFileSizeMb < 1) {
    ElMessage.warning('单文件大小上限必须为正整数（MB）');
    return;
  }
  savingBatch.value = true;
  try {
    const res = await fetch('/api/config/batch', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowedExtensions: extensions,
        maxBatchSize: batchForm.value.maxBatchSize,
        maxFileSizeMb: batchForm.value.maxFileSizeMb,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      if (config.value) {
        config.value.batch = data.config;
      }
      // 同步表单的 allowedExtensionsText 为标准化后的值
      batchForm.value.allowedExtensionsText = data.config.allowedExtensions.join(', ');
      const msg = data.requireRestart?.length
        ? `批量编译配置保存成功（提示：${data.requireRestart.join(', ')} 需重启服务才完全生效）`
        : '批量编译配置保存成功';
      ElMessage.success(msg);
    } else {
      throw new Error(data.error || '保存失败');
    }
  } catch (err) {
    ElMessage.error(apiErrorMessage('保存批量编译配置失败', err));
  } finally {
    savingBatch.value = false;
  }
}

// 保存日志配置
async function saveLogging() {
  if (!LOG_LEVEL_OPTIONS.includes(loggingForm.value.level)) {
    ElMessage.warning(`日志级别必须为: ${LOG_LEVEL_OPTIONS.join(', ')}`);
    return;
  }
  savingLogging.value = true;
  try {
    const res = await fetch('/api/config/logging', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: loggingForm.value.level,
        enableRequestLog: loggingForm.value.enableRequestLog,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      if (config.value) {
        config.value.logging = data.config;
      }
      const msg = data.requireRestart?.length
        ? `日志配置保存成功（提示：${data.requireRestart.join(', ')} 需重启服务才完全生效）`
        : '日志配置保存成功';
      ElMessage.success(msg);
    } else {
      throw new Error(data.error || '保存失败');
    }
  } catch (err) {
    ElMessage.error(apiErrorMessage('保存日志配置失败', err));
  } finally {
    savingLogging.value = false;
  }
}

// ===== 工具配置：MCP / CLI / 场景路由 =====
// 需求 4：AI 问答支持技能、MCP、CLI 等可配置化调用，根据场景自动调用。
// 表单与后端 GET/PUT /api/tools/config 对齐，保存时调用 PUT 落盘 + adapter 热加载。

// 工具配置表单：深拷贝后端 ToolsConfig，避免编辑过程直接污染原对象
const toolsForm = ref<ToolsConfig>({
  mcpServers: [],
  cliTools: [],
  scenes: [],
  routerMode: 'auto',
});
const loadingTools = ref(false);
const savingTools = ref(false);
const testingCli = ref(false);
const cliTestResult = ref<{ ok: boolean; output?: string; error?: string } | null>(null);

// 路由模式可选项
const ROUTER_MODE_OPTIONS: Array<{ value: 'keyword' | 'auto'; label: string; desc: string }> = [
  { value: 'auto', label: '自动', desc: 'LLM 自主决策调用所有启用工具（推荐）' },
  { value: 'keyword', label: '关键词', desc: '根据问题关键词匹配场景规则启用对应工具' },
];

// MCP transport 可选项
const MCP_TRANSPORT_OPTIONS: Array<{ value: 'stdio' | 'sse' | 'http'; label: string }> = [
  { value: 'stdio', label: 'stdio（子进程）' },
  { value: 'sse', label: 'sse（流式）' },
  { value: 'http', label: 'http（请求）' },
];

// 新增空白 MCP 服务器条目
function addMcpServer(): void {
  toolsForm.value.mcpServers.push({
    name: `mcp-server-${toolsForm.value.mcpServers.length + 1}`,
    transport: 'stdio',
    command: '',
    args: [],
    url: '',
    env: {},
    enabled: true,
  });
}

// 删除指定 MCP 服务器条目
function removeMcpServer(idx: number): void {
  toolsForm.value.mcpServers.splice(idx, 1);
}

// 新增空白 CLI 工具条目
function addCliTool(): void {
  toolsForm.value.cliTools.push({
    name: `cli-tool-${toolsForm.value.cliTools.length + 1}`,
    command: '',
    argsTemplate: '',
    description: '',
    timeoutMs: 30000,
    enabled: true,
  });
}

// 删除指定 CLI 工具条目
function removeCliTool(idx: number): void {
  toolsForm.value.cliTools.splice(idx, 1);
}

// 新增空白场景规则条目
function addScene(): void {
  toolsForm.value.scenes.push({
    name: `scene-${toolsForm.value.scenes.length + 1}`,
    keywords: [],
    tools: [],
    enabled: true,
  });
}

// 删除指定场景规则条目
function removeScene(idx: number): void {
  toolsForm.value.scenes.splice(idx, 1);
}

// 加载工具配置
async function loadToolsConfig(): Promise<void> {
  loadingTools.value = true;
  try {
    const res = await fetch('/api/tools/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: ToolsConfig = await res.json();
    // 深拷贝避免编辑过程污染原对象
    toolsForm.value = {
      mcpServers: (data.mcpServers ?? []).map(s => ({ ...s, args: [...(s.args ?? [])], env: s.env ? { ...s.env } : undefined })),
      cliTools: (data.cliTools ?? []).map(t => ({ ...t })),
      scenes: (data.scenes ?? []).map(sc => ({ ...sc, keywords: [...sc.keywords], tools: [...sc.tools] })),
      routerMode: data.routerMode ?? 'auto',
    };
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载工具配置失败', err));
  } finally {
    loadingTools.value = false;
  }
}

// 保存工具配置
async function saveToolsConfig(): Promise<void> {
  // 校验 MCP 服务器条目名称唯一且非空
  const mcpNames = toolsForm.value.mcpServers.map(s => s.name.trim());
  if (mcpNames.some(n => !n)) {
    ElMessage.warning('MCP 服务器名称不能为空');
    return;
  }
  if (new Set(mcpNames).size !== mcpNames.length) {
    ElMessage.warning('MCP 服务器名称不能重复');
    return;
  }
  // 校验 CLI 工具名称唯一且非空
  const cliNames = toolsForm.value.cliTools.map(t => t.name.trim());
  if (cliNames.some(n => !n)) {
    ElMessage.warning('CLI 工具名称不能为空');
    return;
  }
  if (new Set(cliNames).size !== cliNames.length) {
    ElMessage.warning('CLI 工具名称不能重复');
    return;
  }
  // 校验 stdio MCP 必须填 command
  const stdioMissingCmd = toolsForm.value.mcpServers.find(s => s.enabled && s.transport === 'stdio' && !s.command?.trim());
  if (stdioMissingCmd) {
    ElMessage.warning(`MCP 服务器 "${stdioMissingCmd.name}" 为 stdio 模式但未填写 command`);
    return;
  }
  // 校验 sse/http MCP 必须填 url
  const remoteMissingUrl = toolsForm.value.mcpServers.find(s => s.enabled && (s.transport === 'sse' || s.transport === 'http') && !s.url?.trim());
  if (remoteMissingUrl) {
    ElMessage.warning(`MCP 服务器 "${remoteMissingUrl.name}" 为 ${remoteMissingUrl.transport} 模式但未填写 url`);
    return;
  }

  savingTools.value = true;
  try {
    const res = await fetch('/api/tools/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toolsForm.value),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      ElMessage.success('工具配置保存成功，下次问答将使用新配置');
    } else {
      throw new Error(data.error || '保存失败');
    }
  } catch (err) {
    ElMessage.error(apiErrorMessage('保存工具配置失败', err));
  } finally {
    savingTools.value = false;
  }
}

// 测试 CLI 工具执行（用第一条启用的 CLI 工具的 command 作为冒烟测试）
async function testCliTool(idx: number): Promise<void> {
  const entry = toolsForm.value.cliTools[idx];
  if (!entry) return;
  testingCli.value = true;
  cliTestResult.value = null;
  try {
    const res = await fetch('/api/tools/test-cli', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: entry.command,
        argsTemplate: entry.argsTemplate ?? '',
        timeoutMs: entry.timeoutMs ?? 30000,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cliTestResult.value = {
      ok: data.ok === true,
      output: data.output,
      error: data.error,
    };
    if (data.ok) {
      ElMessage.success(`CLI 工具 "${entry.name}" 执行成功`);
    } else {
      ElMessage.warning(`CLI 工具 "${entry.name}" 执行失败：${data.error ?? '未知错误'}`);
    }
  } catch (err) {
    cliTestResult.value = { ok: false, error: (err as Error).message };
    ElMessage.error(apiErrorMessage('CLI 测试失败', err));
  } finally {
    testingCli.value = false;
  }
}

onMounted(async () => {
  loadSchema();
  // loadConfig 完成后同步派生 4 个高级表单的初始值
  await loadConfig();
  if (config.value) {
    syncAdvancedFormsFromConfig(config.value);
  }
  loadHistory();
  // 先加载预设列表，loadAiConfig 依赖 aiPresets 匹配当前 provider
  await loadPresets();
  loadAiConfig();
  loadWebSearchConfig();
  loadToolsConfig();
});
</script>

<template>
  <div class="config-page">
    <div class="glass-card config-card">
      <!-- 不对称装饰块：旋转青蓝渐变 -->
      <div class="card-deco"></div>

      <div class="config-head">
        <div class="head-text">
          <span class="head-tag">// CONTROL PANEL</span>
          <h2 class="head-title grad-text">配置中心</h2>
          <p class="head-tip">编辑页面规范 SCHEMA.md 与查看系统配置</p>
        </div>
      </div>

      <el-tabs v-model="activeTab" class="config-tabs">
        <!-- SCHEMA 编辑器 -->
        <el-tab-pane label="SCHEMA 规范" name="schema">
          <div class="schema-section">
            <div class="action-bar">
              <span class="section-desc">页面规范文件，控制 AI 编译时的页面结构与约束</span>
              <div class="actions">
                <el-button v-if="!editingSchema" size="small" class="neon-btn" @click="editingSchema = true">
                  编辑
                </el-button>
                <template v-else>
                  <el-button size="small" class="neon-btn-primary" :loading="savingSchema" @click="saveSchema">
                    保存
                  </el-button>
                  <el-button size="small" class="neon-btn" @click="cancelEdit">取消</el-button>
                </template>
              </div>
            </div>
      <div v-if="loadingSchema" class="section-loading">// 加载中…</div>

            <el-input
              v-else-if="editingSchema"
              v-model="schemaBuffer"
              type="textarea"
              :rows="24"
              resize="none"
              class="schema-editor"
            />

            <pre v-else class="schema-view">{{ schemaContent }}</pre>

            <!-- §6.X 版本历史（Git log） -->
            <div class="history-section">
              <div class="history-head">
                <span class="section-desc">// 版本历史（Git）</span>
                <el-button size="small" class="neon-btn" text :loading="loadingHistory" @click="loadHistory">刷新</el-button>
              </div>
      <div v-if="!gitEnabled" class="history-disabled">
                Vault 未启用 Git，无法查看版本历史。在 Vault 目录执行 <code>git init</code> 即可启用。
              </div>
      <div v-else-if="commits.length === 0" class="history-empty">? 暂无提交记录</div>
      <div v-else class="commit-list">
                <div
                  v-for="c in commits"
                  :key="c.hash"
                  class="commit-item"
                  :class="{ selected: selectedFrom === c.hash }"
                  @click="selectedFrom = c.hash"
                >
                  <div class="commit-hash">{{ c.hash.slice(0, 8) }}</div>
      <div class="commit-info">
                    <div class="commit-message">{{ c.message }}</div>
      <div class="commit-meta">{{ c.author }} · {{ c.date }}</div>
                  </div>
                </div>
              </div>

              <!-- 版本对比 -->
              <div v-if="gitEnabled && commits.length > 0" class="diff-section">
                <div class="diff-bar">
                  <span class="section-desc">
                    对比：{{ selectedFrom ? selectedFrom.slice(0, 8) : '选择基线' }} → HEAD
                  </span>
                  <el-button
                    size="small"
                    class="neon-btn-primary"
                    :disabled="!selectedFrom"
                    :loading="loadingDiff"
                    @click="loadDiff"
                  >
                    对比
                  </el-button>
                </div>
      <div v-if="showDiff && !loadingDiff" class="diff-result">
                  <div v-if="diffLines.length === 0" class="diff-empty">? 无差异</div>
      <div v-else class="diff-lines">
                    <div
                      v-for="(line, idx) in diffLines"
                      :key="idx"
                      class="diff-line"
                      :class="line.type"
                    >
                      <span class="line-prefix">
                        {{ diffLinePrefix(line.type) }}
                      </span>
                      <span class="line-content">{{ line.content }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- 系统配置 -->
        <el-tab-pane label="系统配置" name="config">
          <div class="config-section">
            <!-- §12.3-7 热加载操作栏 -->
            <div class="reload-bar">
              <span class="section-desc">修改 config.json 后点击热加载，无需重启服务即可应用运行时参数</span>
              <el-button size="small" class="neon-btn-primary" :loading="reloading" @click="reloadConfig">
                热加载配置
              </el-button>
            </div>

            <!-- 热加载结果反馈 -->
            <div v-if="reloadResult" class="reload-result">
              <div class="reload-applied">
                <strong>已应用：</strong>
                <span class="applied-tag">model: {{ reloadResult.applied.model }}</span>
                <span class="applied-tag">maxSteps: {{ reloadResult.applied.maxSteps }}</span>
                <span class="applied-tag">tokenBudget: {{ reloadResult.applied.tokenBudget }}</span>
                <span class="applied-tag">staleDays: {{ reloadResult.applied.staleDays }}</span>
              </div>
      <div v-if="reloadResult.requireRestart.length > 0" class="reload-warn">
                ? 以下字段变更需重启服务才能生效：{{ reloadResult.requireRestart.join(', ') }}
              </div>
            </div>
      <div v-if="loadingConfig" class="section-loading">// 加载中…</div>
      <div v-else-if="config" class="config-grid">
              <!-- LLM 配置 -->
              <div class="config-block hover-glow">
                <h3 class="block-title"><span class="block-bracket">[</span> LLM 模型 <span class="block-bracket">]</span></h3>
                <div class="config-row">
                  <span class="config-label">服务商</span>
                  <span class="config-value">{{ PROVIDER_LABELS[config.llm.provider] || config.llm.provider }}</span>
                </div>
      <div class="config-row">
                  <span class="config-label">模型</span>
                  <span class="config-value">{{ config.llm.model }}</span>
                </div>
      <div class="config-row">
                  <span class="config-label">API 地址</span>
                  <span class="config-value">{{ config.llm.baseUrl }}</span>
                </div>
      <div class="config-row">
                  <span class="config-label">API Key</span>
                  <span class="config-value">
                    <span :class="['key-status', config.llm.apiKeySet ? 'set' : 'unset']">
                      {{ config.llm.apiKeySet ? '已设置' : '未设置' }}
                    </span>
                    <code class="env-name">{{ config.llm.apiKeyRef }}</code>
                  </span>
                </div>
              </div>

              <!-- 运行参数 -->
              <div class="config-block hover-glow">
                <h3 class="block-title"><span class="block-bracket">[</span> 运行参数 <span class="block-bracket">]</span></h3>
                <div class="config-row">
                  <span class="config-label">引擎</span>
                  <span class="config-value">{{ config.adapter }}</span>
                </div>
      <div class="config-row">
                  <span class="config-label">最大步数</span>
                  <span class="config-value">{{ config.budget.maxSteps }}</span>
                </div>
      <div class="config-row">
                  <span class="config-label">Token 预算</span>
                  <span class="config-value">{{ config.budget.tokenBudget }}</span>
                </div>
      <div class="config-row">
                  <span class="config-label">本地模式</span>
                  <span class="config-value">{{ config.localOnly ? '开启' : '关闭' }}</span>
                </div>
              </div>

              <!-- 服务配置 -->
              <div class="config-block hover-glow">
                <h3 class="block-title"><span class="block-bracket">[</span> 服务 <span class="block-bracket">]</span></h3>
                <div class="config-row">
                  <span class="config-label">监听地址</span>
                  <span class="config-value">{{ config.server.host }}</span>
                </div>
      <div class="config-row">
                  <span class="config-label">端口</span>
                  <span class="config-value">{{ config.server.port }}</span>
                </div>
      <div class="config-row">
                  <span class="config-label">Vault 路径</span>
                  <span class="config-value">{{ config.vaultPath }}</span>
                </div>
      <div class="config-row">
                  <span class="config-label">过期阈值</span>
                  <span class="config-value">{{ config.healthCheck.staleDays }} 天</span>
                </div>
              </div>

              <!-- API Key 提示 -->
              <div v-if="!config.llm.apiKeySet" class="key-warning">
                <div class="warning-icon">?</div>
      <div class="warning-text">
                  <strong>API Key 未设置</strong>
                  <p>请设置环境变量 <code>{{ config.llm.apiKeyRef }}</code> 后重启服务，否则编译与问答将返回 401 错误。</p>
                </div>
              </div>
            </div>

            <!-- 高级配置编辑区：补全 budget/healthCheck/batch/logging 的前端编辑入口 -->
            <div class="advanced-config">
              <div class="section-header">
                <span class="section-desc">// 高级配置（编辑后即时生效，无需手动改 config.json）</span>
              </div>

              <!-- 运行参数编辑 -->
              <div class="config-block hover-glow">
                <h3 class="block-title"><span class="block-bracket">[</span> 运行参数 <span class="block-bracket">]</span></h3>
                <div class="form-row">
                  <label class="form-label" for="cfg-max-steps">最大步数</label>
                  <el-input
                    id="cfg-max-steps"
                    v-model.number="budgetForm.maxSteps"
                    type="number"
                    :min="1"
                    :max="100"
                    class="form-input"
                  />
                </div>
                <div class="form-row">
                  <label class="form-label" for="cfg-token-budget">Token 预算</label>
                  <el-input
                    id="cfg-token-budget"
                    v-model.number="budgetForm.tokenBudget"
                    type="number"
                    :min="1000"
                    :step="1000"
                    class="form-input"
                  />
                </div>
                <div class="ai-actions">
                  <el-button class="neon-btn-primary" :loading="savingBudget" @click="saveBudget">
                    保存
                  </el-button>
                </div>
              </div>

              <!-- 健康检查编辑 -->
              <div class="config-block hover-glow">
                <h3 class="block-title"><span class="block-bracket">[</span> 健康检查 <span class="block-bracket">]</span></h3>
                <div class="form-row">
                  <label class="form-label" for="cfg-stale-days">过期阈值（天）</label>
                  <el-input
                    id="cfg-stale-days"
                    v-model.number="healthCheckForm.staleDays"
                    type="number"
                    :min="1"
                    :max="365"
                    class="form-input"
                  />
                </div>
                <div class="ai-actions">
                  <el-button class="neon-btn-primary" :loading="savingHealthCheck" @click="saveHealthCheck">
                    保存
                  </el-button>
                </div>
              </div>

              <!-- 批量编译编辑 -->
              <div class="config-block hover-glow">
                <h3 class="block-title"><span class="block-bracket">[</span> 批量编译 <span class="block-bracket">]</span></h3>
                <div class="form-row">
                  <label class="form-label" for="cfg-allowed-exts">允许的扩展名</label>
                  <el-input
                    id="cfg-allowed-exts"
                    v-model="batchForm.allowedExtensionsText"
                    placeholder="md, txt, pdf, html, json"
                    class="form-input"
                  />
                </div>
                <div class="form-row">
                  <label class="form-label" for="cfg-max-batch">最大批量数</label>
                  <el-input
                    id="cfg-max-batch"
                    v-model.number="batchForm.maxBatchSize"
                    type="number"
                    :min="1"
                    :max="100"
                    class="form-input"
                  />
                </div>
                <div class="form-row">
                  <label class="form-label" for="cfg-max-file-size">单文件上限（MB）</label>
                  <el-input
                    id="cfg-max-file-size"
                    v-model.number="batchForm.maxFileSizeMb"
                    type="number"
                    :min="1"
                    :max="100"
                    class="form-input"
                  />
                </div>
                <div class="ai-actions">
                  <el-button class="neon-btn-primary" :loading="savingBatch" @click="saveBatch">
                    保存
                  </el-button>
                </div>
              </div>

              <!-- 日志配置编辑 -->
              <div class="config-block hover-glow">
                <h3 class="block-title"><span class="block-bracket">[</span> 日志 <span class="block-bracket">]</span></h3>
                <div class="form-row">
                  <label class="form-label" for="cfg-log-level">日志级别</label>
                  <el-select
                    id="cfg-log-level"
                    v-model="loggingForm.level"
                    class="form-input"
                  >
                    <el-option
                      v-for="lvl in LOG_LEVEL_OPTIONS"
                      :key="lvl"
                      :label="lvl"
                      :value="lvl"
                    />
                  </el-select>
                </div>
                <div class="form-row">
                  <label class="form-label" for="cfg-req-log">记录请求日志</label>
                  <el-switch
                    id="cfg-req-log"
                    v-model="loggingForm.enableRequestLog"
                  />
                </div>
                <div class="ai-actions">
                  <el-button class="neon-btn-primary" :loading="savingLogging" @click="saveLogging">
                    保存
                  </el-button>
                </div>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- AI 服务配置 -->
        <el-tab-pane label="AI 服务" name="ai">
          <div class="ai-section">
            <!-- 预设快捷选择 -->
            <div class="preset-bar">
              <span class="section-desc">// LLM 预设</span>
              <div class="preset-tags">
                <span
                  v-for="preset in aiPresets"
                  :key="preset.key"
                  class="preset-tag"
                  :class="{ active: aiForm.provider === preset.provider }"
                  @click="applyPreset(preset)"
                >
                  {{ preset.label }}
                </span>
              </div>
            </div>
      <div v-if="loadingAi" class="section-loading">// 加载中…</div>
      <div v-else class="ai-form">
              <!-- 配置表单 -->
              <div class="config-block hover-glow">
                <h3 class="block-title"><span class="block-bracket">[</span> 模型配置 <span class="block-bracket">]</span></h3>
                <div class="form-row">
                  <label class="form-label" for="ai-base-url">API Base URL</label>
                  <el-input
                    id="ai-base-url"
                    v-model="aiForm.baseUrl"
                    placeholder="https://api.openai.com/v1"
                    class="form-input"
                  />
                </div>
      <div class="form-row">
                  <label class="form-label" for="ai-api-key">API Key</label>
                  <el-input
                    id="ai-api-key"
                    v-model="aiForm.apiKey"
                    type="password"
                    show-password
                    placeholder="输入 API Key（****表示已设置）"
                    class="form-input"
                  />
                </div>
      <div class="form-row">
                  <label class="form-label" for="ai-model">模型</label>
                  <el-input
                    id="ai-model"
                    v-model="aiForm.model"
                    :placeholder="aiModelPlaceholder"
                    class="form-input"
                  />
                </div>
              </div>

              <!-- 操作按钮 -->
              <div class="ai-actions">
                <el-button class="neon-btn" :loading="testingAi" @click="testConnection">
                  测试连接
                </el-button>
                <el-button class="neon-btn-primary" :loading="savingAi" @click="saveAiConfig">
                  保存配置
                </el-button>
                <el-button
                  class="neon-btn"
                  :loading="resettingAi"
                  @click="resetAiConfig"
                  style="margin-left: auto;"
                >
                  恢复初始配置
                </el-button>
              </div>

              <!-- 测试结果 -->
              <div v-if="aiTestResult" class="test-result" :class="{ ok: aiTestResult.ok, fail: !aiTestResult.ok }">
                <span class="result-icon">{{ testResultIcon }}</span>
                <span class="result-text">{{ testResultText }}</span>
              </div>

              <!-- 当前状态摘要 -->
              <div v-if="aiConfig" class="ai-status">
                <div class="status-row">
                  <span class="status-label">当前状态</span>
                  <span class="status-value">
                    <span :class="['key-status', aiConfig.apiKeySet ? 'set' : 'unset']">
                      {{ aiConfig.apiKeySet ? 'Key 已设置' : 'Key 未设置' }}
                    </span>
                    <span v-if="aiConfig.apiKeyMasked" class="masked-key">{{ aiConfig.apiKeyMasked }}</span>
                  </span>
                </div>
      <div v-if="!aiConfig.apiKeySet" class="key-hint">
                  <span class="hint-icon">?</span>
                  <span>请配置 API Key 或设置环境变量 <code>{{ aiConfig.apiKeyRef }}</code></span>
                </div>
              </div>
            </div>

            <!-- §5.2 联网搜索配置：与 LLM 配置独立，支持 tavily/bing 两个 provider -->
            <div class="web-search-section">
              <div class="section-header">
                <span class="section-desc">// 联网搜索</span>
                <span v-if="webSearchStatus" :class="['key-status', webSearchStatus.apiKeySet ? 'set' : 'unset']">
                  {{ webSearchStatus.apiKeySet ? '已启用' : '未配置 Key' }}
                </span>
              </div>
      <div v-if="loadingWebSearch" class="section-loading">// 加载中…</div>
      <div v-else class="ai-form">
                <div class="config-block hover-glow">
                  <h3 class="block-title"><span class="block-bracket">[</span> 搜索引擎 <span class="block-bracket">]</span></h3>
                  <div class="form-row">
                    <label class="form-label" for="ws-provider">Provider</label>
                    <div class="preset-tags" id="ws-provider">
                      <span
                        v-for="p in WEB_SEARCH_PROVIDERS"
                        :key="p.value"
                        class="preset-tag"
                        :class="{ active: webSearchForm.provider === p.value }"
                        @click="webSearchForm.provider = p.value"
                      >{{ p.label }}</span>
                    </div>
                  </div>
      <div class="form-row">
                    <label class="form-label" for="ws-api-key">API Key</label>
                    <el-input
                      id="ws-api-key"
                      v-model="webSearchForm.apiKey"
                      type="password"
                      show-password
                      placeholder="输入联网搜索 API Key"
                      class="form-input"
                    />
                  </div>
      <div class="form-row">
                    <label class="form-label" for="ws-max-results">最大结果数</label>
                    <el-input
                      id="ws-max-results"
                      v-model.number="webSearchForm.maxResults"
                      type="number"
                      :min="1"
                      :max="20"
                      class="form-input"
                    />
                  </div>
                </div>
      <div class="ai-actions">
                  <el-button class="neon-btn-primary" :loading="savingWebSearch" @click="saveWebSearchConfig">
                    保存配置
                  </el-button>
                </div>
      <div v-if="webSearchStatus && !webSearchStatus.apiKeySet" class="key-hint">
                  <span class="hint-icon">?</span>
                  <span>未配置 API Key 时，知识库问答点击"联网搜索"将仅使用本地知识库。请配置 <code>{{ webSearchStatus.apiKeyRef }}</code></span>
                </div>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- 工具配置：MCP / CLI / 场景路由 -->
        <el-tab-pane label="工具配置" name="tools">
          <div class="tools-section">
            <div class="section-header">
              <span class="section-desc">// 扩展工具（MCP / CLI / 场景路由）</span>
              <span class="section-hint">配置 AI 问答可调用的外部工具，根据场景自动启用</span>
            </div>

            <div v-if="loadingTools" class="section-loading">// 加载中…</div>
            <div v-else class="tools-form">
              <!-- 路由模式 -->
              <div class="config-block hover-glow">
                <h3 class="block-title"><span class="block-bracket">[</span> 路由模式 <span class="block-bracket">]</span></h3>
                <div class="form-row">
                  <span class="form-label">模式</span>
                  <div class="preset-tags" role="radiogroup" aria-label="路由模式">
                    <span
                      v-for="m in ROUTER_MODE_OPTIONS"
                      :key="m.value"
                      class="preset-tag"
                      :class="{ active: toolsForm.routerMode === m.value }"
                      @click="toolsForm.routerMode = m.value"
                    >{{ m.label }}</span>
                  </div>
                </div>
                <div class="router-desc">
                  {{ ROUTER_MODE_OPTIONS.find(m => m.value === toolsForm.routerMode)?.desc }}
                </div>
              </div>

              <!-- MCP 服务器配置 -->
              <div class="config-block hover-glow">
                <div class="block-header">
                  <h3 class="block-title"><span class="block-bracket">[</span> MCP 服务器 <span class="block-bracket">]</span></h3>
                  <el-button size="small" class="neon-btn" @click="addMcpServer">+ 新增</el-button>
                </div>
                <div v-if="toolsForm.mcpServers.length === 0" class="empty-hint">
                  暂无 MCP 服务器配置。点击 "新增" 添加。
                </div>
                <div v-else class="entry-list">
                  <div v-for="(server, idx) in toolsForm.mcpServers" :key="idx" class="entry-item">
                    <div class="entry-row">
                      <el-input
                        v-model="server.name"
                        placeholder="服务器名称（唯一）"
                        class="form-input entry-name"
                      />
                      <el-select v-model="server.transport" class="form-input entry-transport" placeholder="传输方式">
                        <el-option
                          v-for="t in MCP_TRANSPORT_OPTIONS"
                          :key="t.value"
                          :label="t.label"
                          :value="t.value"
                        />
                      </el-select>
                      <el-switch v-model="server.enabled" />
                      <el-button size="small" class="neon-btn-danger" @click="removeMcpServer(idx)">删除</el-button>
                    </div>
                    <div v-if="server.transport === 'stdio'" class="entry-row">
                      <el-input
                        v-model="server.command"
                        placeholder="command（如 npx）"
                        class="form-input"
                      />
                      <el-input
                        :model-value="server.args?.join(' ') ?? ''"
                        placeholder="args（空格分隔）"
                        class="form-input"
                        @update:model-value="(val: string) => server.args = val.split(/\s+/).filter(Boolean)"
                      />
                    </div>
                    <div v-else class="entry-row">
                      <el-input
                        v-model="server.url"
                        placeholder="url（如 https://example.com/mcp）"
                        class="form-input"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <!-- CLI 工具配置 -->
              <div class="config-block hover-glow">
                <div class="block-header">
                  <h3 class="block-title"><span class="block-bracket">[</span> CLI 工具 <span class="block-bracket">]</span></h3>
                  <el-button size="small" class="neon-btn" @click="addCliTool">+ 新增</el-button>
                </div>
                <div v-if="toolsForm.cliTools.length === 0" class="empty-hint">
                  暂无 CLI 工具配置。仅白名单命令可执行（如 ping/nslookup/whoami 等）。
                </div>
                <div v-else class="entry-list">
                  <div v-for="(tool, idx) in toolsForm.cliTools" :key="idx" class="entry-item">
                    <div class="entry-row">
                      <el-input
                        v-model="tool.name"
                        placeholder="工具名称（唯一）"
                        class="form-input entry-name"
                      />
                      <el-input
                        v-model="tool.command"
                        placeholder="command（如 ping）"
                        class="form-input"
                      />
                      <el-switch v-model="tool.enabled" />
                      <el-button size="small" class="neon-btn-danger" @click="removeCliTool(idx)">删除</el-button>
                    </div>
                    <div class="entry-row">
                      <el-input
                        v-model="tool.argsTemplate"
                        placeholder='argsTemplate（如 "{host} -n 4"，{host} 为占位符）'
                        class="form-input"
                      />
                      <el-input
                        v-model.number="tool.timeoutMs"
                        type="number"
                        :min="1000"
                        :step="1000"
                        placeholder="超时（ms）"
                        class="form-input entry-timeout"
                      />
                    </div>
                    <div class="entry-row">
                      <el-input
                        v-model="tool.description"
                        placeholder="工具描述（供 LLM 决策使用）"
                        class="form-input"
                      />
                      <el-button
                        size="small"
                        class="neon-btn"
                        :loading="testingCli"
                        @click="testCliTool(idx)"
                      >测试</el-button>
                    </div>
                  </div>
                </div>
                <div v-if="cliTestResult" class="cli-test-result" :class="{ ok: cliTestResult.ok, fail: !cliTestResult.ok }">
                  <pre v-if="cliTestResult.output">{{ cliTestResult.output }}</pre>
                  <pre v-if="cliTestResult.error" class="error-output">{{ cliTestResult.error }}</pre>
                </div>
              </div>

              <!-- 场景规则配置（仅在 keyword 模式下生效） -->
              <div class="config-block hover-glow" :class="{ disabled: toolsForm.routerMode !== 'keyword' }">
                <div class="block-header">
                  <h3 class="block-title"><span class="block-bracket">[</span> 场景规则 <span class="block-bracket">]</span></h3>
                  <el-button size="small" class="neon-btn" :disabled="toolsForm.routerMode !== 'keyword'" @click="addScene">+ 新增</el-button>
                </div>
                <div v-if="toolsForm.routerMode !== 'keyword'" class="empty-hint">
                  场景规则仅在「关键词」路由模式下生效。切换到关键词模式后可配置规则。
                </div>
                <div v-else-if="toolsForm.scenes.length === 0" class="empty-hint">
                  暂无场景规则。点击 "新增" 添加（关键词命中时启用对应工具）。
                </div>
                <div v-else class="entry-list">
                  <div v-for="(scene, idx) in toolsForm.scenes" :key="idx" class="entry-item">
                    <div class="entry-row">
                      <el-input
                        v-model="scene.name"
                        placeholder="场景名称（如 network_diag）"
                        class="form-input entry-name"
                      />
                      <el-switch v-model="scene.enabled" />
                      <el-button size="small" class="neon-btn-danger" @click="removeScene(idx)">删除</el-button>
                    </div>
                    <div class="entry-row">
                      <el-input
                        :model-value="scene.keywords.join(', ')"
                        placeholder='关键词（逗号分隔，如 "ping, 网络, 延迟"）'
                        class="form-input"
                        @update:model-value="(val: string) => scene.keywords = val.split(',').map(k => k.trim()).filter(Boolean)"
                      />
                    </div>
                    <div class="entry-row">
                      <el-input
                        :model-value="scene.tools.join(', ')"
                        placeholder='工具名（逗号分隔，如 "ping, nslookup"）'
                        class="form-input"
                        @update:model-value="(val: string) => scene.tools = val.split(',').map(t => t.trim()).filter(Boolean)"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <!-- 保存按钮 -->
              <div class="ai-actions">
                <el-button class="neon-btn-primary" :loading="savingTools" @click="saveToolsConfig">
                  保存工具配置
                </el-button>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="界面主题" name="theme">
          <section class="theme-section">
            <div class="theme-copy">
              <span class="section-tag">// APPEARANCE</span>
              <h3>选择界面主题</h3>
              <p>主题会立即应用并自动保存，下次打开仍保持当前选择。</p>
            </div>
            <ThemeSwitcher embedded />
          </section>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<style scoped>
.config-page {
  display: flex;
  flex-direction: column;
}

.config-card {
  position: relative;
  padding: 24px 28px;
  overflow: hidden;
}

/* 不对称装饰块：旋转青蓝渐变 */
.card-deco {
  position: absolute;
  bottom: -50px;
  right: -40px;
  width: 220px;
  height: 220px;
  background: var(--grad-cool);
  filter: blur(60px);
  opacity: 0.3;
  transform: rotate(-18deg);
  border-radius: 50%;
  pointer-events: none;
  z-index: 0;
}

.config-head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.head-text {
  flex: 1;
}

.head-tag {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--neon-cyan);
  text-transform: uppercase;
  margin-bottom: 2px;
}

.head-title {
  margin: 0 0 2px;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 12px;
}

/* Tab 标签霓虹化 */
.config-tabs {
  position: relative;
  z-index: 1;
}

.config-tabs :deep(.el-tabs__item) {
  font-family: var(--font-mono);
  letter-spacing: 0.05em;
  color: var(--text-soft) !important;
}

.config-tabs :deep(.el-tabs__item.is-active) {
  color: var(--neon-cyan) !important;
  text-shadow: 0 0 8px var(--accent-cyan-a50);
}

.config-tabs :deep(.el-tabs__active-bar) {
  background: var(--grad-neon);
  height: 2px;
}

.config-tabs :deep(.el-tabs__nav-wrap::after) {
  background-color: var(--accent-purple-a15);
}

.theme-section {
  display: grid;
  grid-template-columns: minmax(220px, 0.7fr) minmax(320px, 1.3fr);
  gap: 24px;
  align-items: start;
  padding: 22px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
}

.theme-copy h3 {
  margin: 8px 0;
  color: var(--text-bright);
}

.theme-copy p {
  margin: 0;
  color: var(--text-soft);
  line-height: 1.7;
}

.section-tag {
  color: var(--neon-cyan);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
}

@media (max-width: 760px) {
  .theme-section {
    grid-template-columns: 1fr;
  }
}

.schema-section,
.config-section {
  min-height: 400px;
}

.action-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-desc {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  letter-spacing: 0.02em;
}

.actions {
  display: flex;
  gap: 8px;
}

/* 霓虹按钮：透明底 */
.neon-btn {
  background: var(--bg-glass) !important;
  border: 1px solid var(--accent-purple-a40) !important;
  color: var(--text-bright) !important;
  font-family: var(--font-mono) !important;
  letter-spacing: 0.05em;
  transition: all 0.3s ease !important;
}

.neon-btn:hover:not(.is-disabled) {
  border-color: var(--neon-cyan) !important;
  box-shadow: var(--glow-cyan) !important;
  color: var(--neon-cyan) !important;
}

/* 主按钮：渐变填充 */
.neon-btn-primary {
  background: var(--grad-fire) !important;
  border: none !important;
  color: var(--text-bright) !important;
  font-family: var(--font-mono) !important;
  font-weight: 700;
  letter-spacing: 0.05em;
  transition: all 0.3s ease !important;
}

.neon-btn-primary:hover:not(.is-disabled) {
  box-shadow: var(--glow-magenta) !important;
  transform: translateY(-1px);
}

.section-loading {
  text-align: center;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
  padding: 60px 0;
  letter-spacing: 0.1em;
}

/* SCHEMA 编辑器：暗色背景 + 霓虹边框 */
.schema-editor :deep(.el-textarea__inner) {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.8;
  background: var(--bg-scene) !important;
  color: var(--text-bright) !important;
  border: 1px solid var(--accent-cyan-a25) !important;
  border-radius: var(--radius-input) !important;
}

.schema-editor :deep(.el-textarea__inner):focus {
  border-color: var(--neon-cyan) !important;
  box-shadow: 0 0 16px var(--accent-cyan-a30) !important;
}

.schema-view {
  margin: 0;
  padding: 18px 24px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-base);
  font-family: var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 500px;
  overflow-y: auto;
}

.config-grid {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.config-block {
  padding: 18px 22px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
  transition: all 0.3s ease;
}

.block-title {
  margin: 0 0 14px;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.05em;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--accent-cyan-a20);
}

.block-bracket {
  color: var(--neon-cyan);
  text-shadow: 0 0 8px var(--accent-cyan-a50);
}

.config-row {
  display: flex;
  padding: 6px 0;
  font-size: 13px;
}

.config-label {
  width: 120px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}

.config-value {
  color: var(--text-base);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
}

.key-status {
  padding: 2px 12px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  border: 1px solid;
}

.key-status.set {
  background: var(--accent-cyan-a15);
  border-color: var(--accent-cyan-a50);
  color: var(--neon-cyan);
}

.key-status.unset {
  background: var(--accent-pink-a15);
  border-color: var(--accent-pink-a50);
  color: var(--neon-magenta);
  box-shadow: 0 0 10px var(--accent-pink-a30);
}

.env-name {
  padding: 2px 10px;
  background: var(--accent-purple-a12);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 6px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--neon-purple);
}

.key-warning {
  display: flex;
  gap: 14px;
  padding: 16px 20px;
  background: linear-gradient(135deg, var(--accent-pink-a18), var(--accent-pink-a05));
  border: 1px solid var(--accent-pink-a40);
  border-radius: var(--radius-card);
  box-shadow: 0 0 24px var(--accent-pink-a15);
}

.warning-icon {
  font-size: 26px;
  color: var(--neon-magenta);
  text-shadow: 0 0 12px var(--neon-magenta);
}

.warning-text strong {
  color: var(--neon-magenta);
  font-family: var(--font-mono);
  font-size: 14px;
  letter-spacing: 0.04em;
}

.warning-text p {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-base);
  line-height: 1.6;
  font-family: var(--font-mono);
}

.warning-text code {
  padding: 2px 8px;
  background: var(--accent-cyan-a12);
  border: 1px solid var(--accent-cyan-a30);
  border-radius: 6px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--neon-cyan);
}

.reload-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding: 12px 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
}

.reload-result {
  margin-bottom: 16px;
  padding: 14px 18px;
  background: linear-gradient(135deg, var(--accent-cyan-a12), var(--accent-cyan-a03));
  border: 1px solid var(--accent-cyan-a35);
  border-radius: var(--radius-card);
}

.reload-applied {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-base);
}

.reload-applied strong {
  color: var(--neon-cyan);
}

.applied-tag {
  padding: 2px 12px;
  background: var(--accent-cyan-a10);
  border: 1px solid var(--accent-cyan-a30);
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--neon-cyan);
}

.reload-warn {
  margin-top: 10px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--neon-magenta);
}

/* §6.X 版本历史与 diff */
.history-section {
  margin-top: 20px;
  padding: 16px 20px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
}

.history-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.history-disabled {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
  padding: 10px 0;
  line-height: 1.7;
}

.history-disabled code {
  padding: 2px 8px;
  background: var(--accent-purple-a12);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-purple);
}

.history-empty {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--neon-lime);
  padding: 10px 0;
}

.commit-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
}

.commit-item {
  display: flex;
  gap: 12px;
  padding: 9px 12px;
  background: var(--accent-purple-a06);
  border: 1px solid var(--accent-purple-a20);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.25s ease;
}

.commit-item:hover {
  background: var(--accent-cyan-a10);
  border-color: var(--accent-cyan-a35);
  transform: translateX(4px);
}

.commit-item.selected {
  background: var(--accent-pink-a12);
  border-color: var(--accent-pink-a50);
  box-shadow: 0 0 12px var(--accent-pink-a25);
}

.commit-hash {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--neon-cyan);
  background: var(--accent-cyan-a10);
  border: 1px solid var(--accent-cyan-a25);
  padding: 2px 8px;
  border-radius: 6px;
  flex-shrink: 0;
  align-self: flex-start;
}

.commit-info {
  flex: 1;
  min-width: 0;
}

.commit-message {
  font-size: 13px;
  color: var(--text-base);
  margin-bottom: 2px;
}

.commit-meta {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-dim);
}

.diff-section {
  margin-top: 16px;
}

.diff-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.diff-result {
  padding: 12px 16px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: 10px;
  max-height: 300px;
  overflow-y: auto;
}

.diff-empty {
  text-align: center;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--neon-lime);
  padding: 16px 0;
}

.diff-lines {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.diff-line {
  display: flex;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}

.diff-line.add {
  background: var(--accent-cyan-a12);
}

.diff-line.del {
  background: var(--accent-pink-a12);
}

.line-prefix {
  width: 22px;
  text-align: center;
  flex-shrink: 0;
  font-weight: 700;
}

.diff-line.add .line-prefix {
  color: var(--neon-cyan);
}

.diff-line.del .line-prefix {
  color: var(--neon-magenta);
}

.line-content {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-base);
}

/* ===== AI 服务配置样式 ===== */
.ai-section {
  min-height: 400px;
}

.preset-bar {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 18px;
  padding: 14px 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
}

.preset-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex: 1;
}

.preset-tag {
  padding: 4px 14px;
  background: var(--accent-purple-a06);
  border: 1px solid var(--accent-purple-a30);
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-soft);
  cursor: pointer;
  transition: all 0.25s ease;
  letter-spacing: 0.03em;
}

.preset-tag:hover {
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
  background: var(--accent-cyan-a10);
  box-shadow: var(--glow-cyan);
}

.preset-tag.active {
  background: var(--accent-cyan-a15);
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
  box-shadow: 0 0 12px var(--accent-cyan-a30);
}

.ai-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 0;
}

.form-label {
  width: 120px;
  flex-shrink: 0;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.form-input {
  flex: 1;
}

.form-input :deep(.el-input__wrapper) {
  background: var(--bg-scene) !important;
  border: 1px solid var(--accent-purple-a30) !important;
  border-radius: var(--radius-input) !important;
  box-shadow: none !important;
  transition: all 0.3s ease !important;
}

.form-input :deep(.el-input__wrapper:hover) {
  border-color: var(--neon-cyan) !important;
}

.form-input :deep(.el-input__wrapper.is-focus) {
  border-color: var(--neon-cyan) !important;
  box-shadow: 0 0 12px var(--accent-cyan-a30) !important;
}

.form-input :deep(.el-input__inner) {
  color: var(--text-bright) !important;
  font-family: var(--font-mono) !important;
  font-size: 13px !important;
}

.ai-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.test-result {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-radius: var(--radius-card);
  font-family: var(--font-mono);
  font-size: 13px;
}

.test-result.ok {
  background: linear-gradient(135deg, var(--accent-cyan-a12), var(--accent-cyan-a03));
  border: 1px solid var(--accent-cyan-a35);
  color: var(--neon-cyan);
}

.test-result.fail {
  background: linear-gradient(135deg, var(--accent-pink-a12), var(--accent-pink-a03));
  border: 1px solid var(--accent-pink-a35);
  color: var(--neon-magenta);
}

.result-icon {
  font-size: 18px;
  font-weight: 900;
  text-shadow: 0 0 10px currentColor;
}

.ai-status {
  padding: 14px 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
}

.status-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}

.status-label {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.status-value {
  display: flex;
  align-items: center;
  gap: 8px;
}

.masked-key {
  padding: 2px 10px;
  background: var(--accent-purple-a12);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 6px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--neon-purple);
}

.key-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--neon-magenta);
  font-family: var(--font-mono);
}

.hint-icon {
  font-size: 16px;
}

.key-hint code {
  padding: 2px 8px;
  background: var(--accent-cyan-a12);
  border: 1px solid var(--accent-cyan-a30);
  border-radius: 6px;
  font-size: 11px;
  color: var(--neon-cyan);
}

/* §5.2 联网搜索配置区块 */
.web-search-section {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
}

/* 工具配置区块标题：与现有 config-block 分隔，含描述与提示 */
.section-hint {
  font-size: 12px;
  color: var(--text-soft);
  margin-left: auto;
}

/* 危险按钮：删除条目使用 */
.neon-btn-danger {
  background: var(--bg-glass) !important;
  border: 1px solid var(--accent-magenta-a40) !important;
  color: var(--text-bright) !important;
  font-family: var(--font-mono) !important;
  letter-spacing: 0.05em;
  transition: all 0.3s ease !important;
}

.neon-btn-danger:hover:not(.is-disabled) {
  border-color: var(--neon-magenta) !important;
  color: var(--neon-magenta) !important;
}

/* 区块标题栏：标题 + 操作按钮横向排列 */
.block-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

/* 条目列表：多个 MCP/CLI/Scene 配置项垂直堆叠 */
.entry-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.entry-item {
  padding: 12px;
  border: 1px dashed var(--accent-cyan-a25);
  border-radius: 10px;
  background: var(--bg-scene);
}

/* 条目内一行：多个输入框 + 开关 + 按钮横向排列，自动换行 */
.entry-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.entry-row:last-child {
  margin-bottom: 0;
}

.entry-name {
  flex: 1 1 160px;
  min-width: 140px;
}

.entry-transport {
  flex: 0 0 160px;
}

.entry-timeout {
  flex: 0 0 140px;
}

/* 空状态提示 */
.empty-hint {
  color: var(--text-dim);
  font-size: 12px;
  padding: 16px;
  text-align: center;
  border: 1px dashed var(--accent-cyan-a20);
  border-radius: 8px;
}

/* 路由模式说明文本 */
.router-desc {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-soft);
  padding-left: 4px;
}

/* CLI 测试结果输出 */
.cli-test-result {
  margin-top: 12px;
  padding: 10px;
  border-radius: 8px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-cyan-a25);
  font-family: var(--font-mono);
  font-size: 12px;
  max-height: 240px;
  overflow-y: auto;
}

.cli-test-result pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.cli-test-result.ok {
  border-color: var(--accent-cyan-a40);
}

.cli-test-result.fail {
  border-color: var(--accent-magenta-a40);
}

.cli-test-result .error-output {
  color: var(--neon-magenta);
}

/* 禁用态：场景规则在非 keyword 模式下灰显 */
.config-block.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.config-block.disabled .block-header {
  pointer-events: none;
}
</style>

<script setup lang="ts">
import { API_BASE } from '../utils/apiBase';
import { ref, computed, reactive, onMounted, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Check, Close } from '@element-plus/icons-vue';
import ThemeSwitcher from '../components/ThemeSwitcher.vue';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import type { ConfigData, SchemaContent, ReloadResult, SchemaCommit, DiffLine, AiConfig, LlmPreset, AiTestResult, ToolsConfig, McpServerEntry, QqConfigData, PromptFile, PromptTestRunEvent } from '../types';
import { apiErrorMessage } from '../utils/apiError';
import { STORAGE_KEYS, presetStorageKey } from '../constants/storageKeys';
import { consumeSSE } from '../utils/sse';

const activeTab = ref<'schema' | 'config' | 'ai' | 'theme' | 'tools' | 'qq' | 'prompts'>('schema');
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
    const res = await fetch(`${API_BASE}/schema`);
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
    const res = await fetch(`${API_BASE}/schema/history`);
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
    const res = await fetch(`${API_BASE}/schema/diff?from=${encodeURIComponent(selectedFrom.value)}`);
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
    const res = await fetch(`${API_BASE}/schema`, {
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
    const res = await fetch(`${API_BASE}/config`);
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
    const res = await fetch(`${API_BASE}/config/reload`, {
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
    const res = await fetch(`${API_BASE}/ai/config`);
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
    const res = await fetch(`${API_BASE}/ai/presets`);
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
//   携带 apiKeyRef：预设切换时同步环境变量名，后端据此更新 apiKeyRef 字段。
//   后端检测 provider 变化时自动迁移当前 apiKey 到 apiKeys[旧provider]，并从 apiKeys[新provider] 恢复 key。
async function applyPreset(preset: LlmPreset) {
  selectedPresetKey.value = preset.key;
  const cache = loadPresetCache(preset.key);
  aiForm.value.provider = preset.provider;
  // 有缓存则用缓存的 baseUrl/model（用户可能修改过），否则用预设默认值
  aiForm.value.baseUrl = cache?.baseUrl || preset.baseUrl;
  aiForm.value.model = cache?.model || preset.model;

  // 后台同步到后端 config.json（不传 apiKey，保留现有 key；携带 apiKeyRef 同步环境变量名）
  try {
    const res = await fetch(`${API_BASE}/ai/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: preset.provider,
        baseUrl: aiForm.value.baseUrl,
        model: aiForm.value.model,
        apiKeyRef: preset.apiKeyRef,
        // 不传 apiKey：后端收到 undefined + provider 变更时自动从 apiKeys 表恢复对应 key
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) {
        aiConfig.value = data.config;
        // 从后端返回的脱敏值回填表单 apiKey（可能是旧 provider 保存的 key，或新 provider 恢复的 key）
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
    const res = await fetch(`${API_BASE}/ai/config`, {
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
    const res = await fetch(`${API_BASE}/ai/reset-config`, { method: 'POST' });
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
    const res = await fetch(`${API_BASE}/ai/test-connection`, {
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

// 测试结果图标已迁移至模板内 el-icon（Check/Close），原 testResultIcon computed 已废弃删除

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
    const res = await fetch(`${API_BASE}/ai/web-search`);
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
    const res = await fetch(`${API_BASE}/ai/web-search`, {
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
  maxBatchSize: 50,
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
    const res = await fetch(`${API_BASE}/config/budget`, {
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
    const res = await fetch(`${API_BASE}/config/health-check`, {
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
    const res = await fetch(`${API_BASE}/config/batch`, {
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
    const res = await fetch(`${API_BASE}/config/logging`, {
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
    const res = await fetch(`${API_BASE}/tools/config`);
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
  // JSON 模式下保存前先应用 JSON 到表单，避免用户编辑的 JSON 未 parse 就保存
  // 为什么需要：用户可能编辑 JSON 后直接点保存，未点"应用 JSON"按钮，此时 JSON 文本与表单状态不一致
  if (mcpEditMode.value === 'json') {
    if (!applyMcpJsonToForm()) {
      ElMessage.warning(mcpJsonError.value || 'JSON 解析失败，请修正后再保存');
      return;
    }
  }
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
    const res = await fetch(`${API_BASE}/tools/config`, {
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
    const res = await fetch(`${API_BASE}/tools/test-cli`, {
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

// ===== MCP JSON 编辑模式 =====
// 需求 2：双模式 UI——保留表单模式 + 新增 JSON 编辑模式（Claude Desktop 格式兼容）。
// 为什么需要：JSON 模式便于批量导入/导出 MCP 配置，支持复杂场景（多 server、env 注入），
//   且与 Claude Desktop 配置格式兼容，用户可直接复用现有配置文件。
// JSON 格式（Claude Desktop 兼容）：
//   { "mcpServers": { "name": { "command": "npx", "args": ["-y", "xxx"], "env": { "KEY": "val" } } } }
// 表单格式（项目内部）：McpServerEntry[]（含 transport/enabled/timeoutMs 等扩展字段）
// 转换策略：JSON 模式仅编辑 stdio 类型 MCP（Claude Desktop 格式不支持 sse/http），
//   表单模式保留全部字段编辑能力；切换模式时双向同步 stdio server 配置。

// MCP 配置编辑模式：'form' 表单模式 | 'json' JSON 编辑模式
const mcpEditMode = ref<'form' | 'json'>('form');
// JSON 编辑器内容（字符串，保存时 parse 为对象）
const mcpJsonText = ref('');
// JSON 解析错误提示（空串表示无错误）
const mcpJsonError = ref('');

// 将表单中的 MCP 服务器列表序列化为 Claude Desktop 格式 JSON 字符串
// 为什么仅序列化 stdio：Claude Desktop 格式不支持 sse/http，非 stdio 配置在 JSON 模式下不可见
// 为什么过滤 enabled=false：Claude Desktop 格式无 enabled 字段，禁用的 server 不写入 JSON
function serializeMcpToJson(servers: McpServerEntry[]): string {
  const mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  for (const s of servers) {
    // 仅序列化 stdio 类型且 enabled 的 server，保持 JSON 与 Claude Desktop 格式一致
    if (s.transport === 'stdio' && s.enabled && s.command?.trim()) {
      mcpServers[s.name] = {
        command: s.command,
        ...(s.args && s.args.length > 0 ? { args: s.args } : {}),
        ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
      };
    }
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

// 切换到 JSON 模式时从表单状态生成 JSON 文本
function switchToMcpJsonMode(): void {
  mcpJsonText.value = serializeMcpToJson(toolsForm.value.mcpServers);
  mcpJsonError.value = '';
  mcpEditMode.value = 'json';
}

// 切换回表单模式时尝试 parse JSON 并合并到表单
// 为什么用 try/catch 包裹 JSON.parse：用户可能正在编辑 JSON（语法不完整），parse 失败时给出友好提示而非阻断
function switchToMcpFormMode(): void {
  applyMcpJsonToForm();
  mcpEditMode.value = 'form';
}

// 解析 JSON 文本并合并到表单的 mcpServers 数组
// 合并策略：
//   1. JSON 中的 server 按 name 合并到表单（覆盖同名 stdio server 的 command/args/env）
//   2. 表单中已有的 sse/http server 保持不变（JSON 模式不编辑这些类型）
//   3. JSON 中新增的 server 追加到表单末尾，transport 默认 stdio，enabled 默认 true
function applyMcpJsonToForm(): boolean {
  mcpJsonError.value = '';
  const text = mcpJsonText.value.trim();
  if (!text) {
    // 空文本视为清空所有 stdio server
    toolsForm.value.mcpServers = toolsForm.value.mcpServers.filter(s => s.transport !== 'stdio');
    return true;
  }
  let parsed: { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    mcpJsonError.value = `JSON 解析失败：${(err as Error).message}`;
    return false;
  }
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
    mcpJsonError.value = 'JSON 格式错误：缺少 mcpServers 字段或不是对象';
    return false;
  }
  // 保留非 stdio server，清空 stdio server 后从 JSON 重建
  // 为什么重建而非合并：JSON 是权威源，表单中 stdio server 的增删应以 JSON 为准
  const nonStdioServers = toolsForm.value.mcpServers.filter(s => s.transport !== 'stdio');
  const newStdioServers: McpServerEntry[] = [];
  for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
    if (!cfg?.command) {
      mcpJsonError.value = `服务器 "${name}" 缺少 command 字段`;
      return false;
    }
    newStdioServers.push({
      name,
      transport: 'stdio',
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
      enabled: true,
    });
  }
  toolsForm.value.mcpServers = [...nonStdioServers, ...newStdioServers];
  return true;
}

// JSON 模式下点击"应用 JSON"按钮：解析 JSON 并校验，成功后提示用户可切换回表单模式或直接保存
function applyMcpJson(): void {
  if (applyMcpJsonToForm()) {
    ElMessage.success('JSON 已解析并应用到表单，切换到表单模式可查看详情');
  } else {
    ElMessage.warning(mcpJsonError.value || 'JSON 解析失败');
  }
}

// ============================================================
// QQ 导入子系统配置（noise_rules/privacy_patterns/extract_model 等）
// ============================================================

// 噪声规则元信息：NR-1~NR-6 的中文描述，便于前端表单展示
// 为什么独立常量而非后端返回：规则 ID 是稳定契约，描述文案属于 UI 层关注点
const NOISE_RULE_META: Array<{ key: string; label: string }> = [
  { key: 'NR-1', label: '过滤系统通知（入群/退群/红包等）' },
  { key: 'NR-2', label: '过滤纯表情/图片消息' },
  { key: 'NR-3', label: '过滤连续短消息（≤3 字）' },
  { key: 'NR-4', label: '合并同一人连续发言' },
  { key: 'NR-5', label: '过滤 URL 占比过高的消息' },
  { key: 'NR-6', label: '过滤@全体/@机器人触发消息' },
];

// 脱敏规则元信息：key 与后端 privacy_patterns 对齐
const PRIVACY_PATTERN_META: Array<{ key: string; label: string; placeholder: string }> = [
  { key: 'phone', label: '手机号', placeholder: '1[3-9]\\d{9}' },
  { key: 'id_card', label: '身份证号', placeholder: '\\d{17}[\\dXx]' },
  { key: 'email', label: '邮箱', placeholder: '[\\w.-]+@[\\w.-]+\\.\\w+' },
  { key: 'card', label: '银行卡号', placeholder: '\\d{16,19}' },
  { key: 'qq', label: 'QQ 号', placeholder: '(?<=QQ|扣扣|qq号|企鹅)\\s*[0-9]{5,11}' },
];

const qqConfig = reactive<QqConfigData>({
  noise_rules: {},
  privacy_patterns: {},
  max_batch_size: 20,
  chunk_threshold: 200,
  extract_model: '',
  extract_base_url: '',
  extract_token_budget: 50000,
});
const loadingQqConfig = ref(false);
const savingQqConfig = ref(false);
const patternValidation = computed(() => {
  const result: Record<string, boolean | null> = {};
  for (const p of PRIVACY_PATTERN_META) {
    const input = qqConfig.privacy_patterns[p.key];
    if (!input || !input.trim()) { result[p.key] = null; }
    else { try { new RegExp(input); result[p.key] = true; } catch { result[p.key] = false; } }
  }
  return result;
});
const qqConfigDirty = ref(false);
let _qqConfigInitial = '';

// 深度监听 qqConfig 变化，与初始快照对比判断是否脏
watch(() => qqConfig, () => {
  if (!_qqConfigInitial) return;
  qqConfigDirty.value = JSON.stringify(qqConfig) !== _qqConfigInitial;
}, { deep: true });

async function loadQqConfig() {
  loadingQqConfig.value = true;
  try {
    const res = await fetch(`${API_BASE}/qq-ingest/config`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const qq = data.qq as QqConfigData;
    // 逐字段赋值而非 Object.assign：reactive 需保留引用才能触发响应式更新
    qqConfig.noise_rules = { ...qq.noise_rules };
    qqConfig.privacy_patterns = { ...qq.privacy_patterns };
    qqConfig.max_batch_size = qq.max_batch_size;
    qqConfig.chunk_threshold = qq.chunk_threshold;
    qqConfig.extract_model = qq.extract_model;
    qqConfig.extract_base_url = qq.extract_base_url;
    qqConfig.extract_token_budget = qq.extract_token_budget;
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载 QQ 配置失败', err));
  } finally {
    loadingQqConfig.value = false;
    _qqConfigInitial = JSON.stringify(qqConfig);
  }
}

async function saveQqConfigForm() {
  // 前端预校验：privacy_patterns 是用户自定义正则，提交前 try/catch 编译防止后端运行时崩溃
  for (const [key, pattern] of Object.entries(qqConfig.privacy_patterns)) {
    if (!pattern) continue;
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern);
    } catch (err) {
      ElMessage.error(`脱敏正则「${key}」无效：${(err as Error).message}`);
      return;
    }
  }
  // 数值字段范围校验
  if (qqConfig.max_batch_size < 1 || qqConfig.max_batch_size > 200) {
    ElMessage.warning('批量上限应在 1~200 之间');
    return;
  }
  if (qqConfig.chunk_threshold < 50 || qqConfig.chunk_threshold > 2000) {
    ElMessage.warning('分块阈值应在 50~2000 之间');
    return;
  }
  if (qqConfig.extract_token_budget < 0 || qqConfig.extract_token_budget > 1000000) {
    ElMessage.warning('Token 预算应在 0~1000000 之间（0 表示回退全局）');
    return;
  }

  savingQqConfig.value = true;
  try {
    const res = await fetch(`${API_BASE}/qq-ingest/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qq: qqConfig }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    ElMessage.success('QQ 配置保存成功');
    _qqConfigInitial = JSON.stringify(qqConfig);
    qqConfigDirty.value = false;
  } catch (err) {
    ElMessage.error(apiErrorMessage('保存 QQ 配置失败', err));
  } finally {
    savingQqConfig.value = false;
  }
}

function resetQqConfig() {
  ElMessageBox.confirm('确认重置 QQ 配置为默认值？', '重置确认', { type: 'warning' })
    .then(() => {
      // 重置为 SRS §6.2 默认值
      qqConfig.noise_rules = Object.fromEntries(NOISE_RULE_META.map((r) => [r.key, true]));
      qqConfig.privacy_patterns = Object.fromEntries(
        PRIVACY_PATTERN_META.map((p) => [p.key, p.placeholder.replace(/\\\\/g, '\\')]),
      );
      qqConfig.max_batch_size = 20;
      qqConfig.chunk_threshold = 200;
      qqConfig.extract_model = 'glm-4-plus';
      qqConfig.extract_base_url = '';
      qqConfig.extract_token_budget = 50000;
      ElMessage.info('已重置为默认值（需点击保存才生效）');
    })
    .catch(() => { /* 用户取消 */ });
}

// ============================================================
// FR-14-2 Prompt IDE：编辑 prompts/*.md + 即时预览 + 试运行
// AC-14-4: 编辑 prompts/compile.md 等并即时预览渲染结果
// AC-14-5: 输入测试资料，执行 compile 一次，查看输出
// ============================================================

const promptFiles = ref<PromptFile[]>([]);
const currentPromptName = ref<string>('');
const promptContent = ref<string>('');
// 保存时的原始内容：用于脏检测（编辑器内容与已保存内容对比）
const promptContentSaved = ref<string>('');
const loadingPrompts = ref(false);
const savingPrompt = ref(false);

// 试运行状态
const testInput = ref<string>('');
const testRunning = ref(false);
const testEvents = ref<PromptTestRunEvent[]>([]);
const testPages = ref<Array<{ path: string; title: string }>>([]);
const testError = ref<string | null>(null);
let testAbortController: AbortController | null = null;

// 当前选中的 prompt 元信息（用于显示 label/description）
const currentPromptMeta = computed<PromptFile | null>(() =>
  promptFiles.value.find((p) => p.name === currentPromptName.value) ?? null,
);

// 编辑器内容是否脏（未保存）
const promptDirty = computed(() => promptContent.value !== promptContentSaved.value);

// 加载 prompt 文件列表
async function loadPromptList(): Promise<void> {
  loadingPrompts.value = true;
  try {
    const res = await fetch(`${API_BASE}/prompts`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    promptFiles.value = data.prompts ?? [];
    // 默认选中第一个 prompt（compile.md 优先，便于试运行）
    if (promptFiles.value.length > 0 && !currentPromptName.value) {
      const compile = promptFiles.value.find((p) => p.name === 'compile.md');
      await selectPrompt(compile?.name ?? promptFiles.value[0].name);
    }
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载 prompt 列表失败', err));
    promptFiles.value = [];
  } finally {
    loadingPrompts.value = false;
  }
}

// 切换选中的 prompt 文件
async function selectPrompt(name: string): Promise<void> {
  if (testRunning.value) {
    ElMessage.warning('试运行进行中，请先停止再切换 prompt');
    return;
  }
  if (promptDirty.value) {
    try {
      await ElMessageBox.confirm('当前 prompt 有未保存的修改，确定放弃？', '未保存更改', { type: 'warning' });
    } catch { return; }
  }
  currentPromptName.value = name;
  try {
    const res = await fetch(`${API_BASE}/prompts/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    promptContent.value = data.content ?? '';
    promptContentSaved.value = data.content ?? '';
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载 prompt 内容失败', err));
    promptContent.value = '';
    promptContentSaved.value = '';
  }
}

// 保存当前编辑的 prompt 文件
async function savePrompt(): Promise<void> {
  if (!currentPromptName.value) return;
  savingPrompt.value = true;
  try {
    const res = await fetch(`${API_BASE}/prompts/${encodeURIComponent(currentPromptName.value)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: promptContent.value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    promptContentSaved.value = promptContent.value;
    ElMessage.success('Prompt 已保存，下次 compile/query 将使用新内容');
  } catch (err) {
    ElMessage.error(apiErrorMessage('保存 prompt 失败', err));
  } finally {
    savingPrompt.value = false;
  }
}

// 试运行：用编辑器中的 prompt 执行 compile，SSE 流式接收结果
async function runTest(): Promise<void> {
  if (!currentPromptName.value) return;
  if (currentPromptName.value !== 'compile.md') {
    ElMessage.warning('当前仅支持 compile.md 的试运行');
    return;
  }
  if (!testInput.value.trim()) {
    ElMessage.warning('请输入测试资料');
    return;
  }
  if (promptDirty.value) {
    ElMessage.warning('请先保存 prompt 修改后再试运行（试运行读取已保存的 prompt 文件）');
    return;
  }

  // 重置状态
  testEvents.value = [];
  testPages.value = [];
  testError.value = null;
  testRunning.value = true;
  testAbortController = new AbortController();

  try {
    const res = await fetch(`${API_BASE}/prompts/test-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        promptName: currentPromptName.value,
        promptContent: promptContent.value,
        testInput: testInput.value,
      }),
      signal: testAbortController.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    // 消费 SSE 流：按事件类型路由到对应状态
    await consumeSSE(
      res,
      (eventType: string, parsed: PromptTestRunEvent) => {
        if (eventType === 'progress' || eventType === 'page' || eventType === 'done') {
          testEvents.value.push(parsed);
          // 收集生成的页面
          if (eventType === 'page' && parsed.data?.path && parsed.data?.title) {
            testPages.value.push({
              path: parsed.data.path,
              title: parsed.data.title,
            });
          }
        } else if (eventType === 'error') {
          testError.value = parsed.message || '试运行出错';
          testEvents.value.push(parsed);
        }
      },
      testAbortController.signal,
    );
    if (!testError.value) {
      ElMessage.success(`试运行完成，共生成 ${testPages.value.length} 个页面`);
    }
  } catch (err: unknown) {
    // AbortError 是用户主动停止的正常路径，不显示错误
    if ((err as Error).name === 'AbortError') return;
    testError.value = (err as Error).message;
    ElMessage.error(apiErrorMessage('试运行失败', err));
  } finally {
    testRunning.value = false;
    testAbortController = null;
  }
}

// 停止试运行
function stopTest(): void {
  if (testAbortController) {
    testAbortController.abort();
    testRunning.value = false;
  }
}

// 清空试运行结果
function clearTestResult(): void {
  testEvents.value = [];
  testPages.value = [];
  testError.value = null;
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
  loadQqConfig();
  // FR-14-2 Prompt IDE：加载 prompt 文件列表，与其它配置并行加载
  // 为什么放在 onMounted 而非 watch activeTab：避免切换 tab 时首次加载延迟，影响用户体验
  loadPromptList();
});
</script>

<template>
  <div class="config-page">
    <div class="glass-card config-card">
      <!-- 不对称装饰块：旋转青蓝渐变 -->
      <div class="card-deco"></div>

      <div class="config-head">
        <div class="head-text">
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
                    :max="1000"
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
                    :max="1024"
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
                <el-icon class="result-icon"><component :is="aiTestResult.ok ? Check : Close" /></el-icon>
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
                  <!-- 模式切换：表单模式 / JSON 编辑模式 -->
                  <div class="mcp-mode-switch">
                    <span
                      class="preset-tag"
                      :class="{ active: mcpEditMode === 'form' }"
                      @click="mcpEditMode === 'json' && switchToMcpFormMode()"
                    >表单模式</span>
                    <span
                      class="preset-tag"
                      :class="{ active: mcpEditMode === 'json' }"
                      @click="mcpEditMode === 'form' && switchToMcpJsonMode()"
                    >JSON 模式</span>
                  </div>
                </div>

                <!-- 表单模式：逐条编辑 MCP 服务器 -->
                <template v-if="mcpEditMode === 'form'">
                  <div class="block-header sub-header">
                    <el-button size="small" class="neon-btn" @click="addMcpServer">+ 新增</el-button>
                  </div>
                  <div v-if="toolsForm.mcpServers.length === 0" class="empty-hint">
                    暂无 MCP 服务器配置。点击 "新增" 添加，或切换到 JSON 模式批量导入。
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
                </template>

                <!-- JSON 模式：Claude Desktop 兼容格式批量编辑 -->
                <template v-else>
                  <div class="mcp-json-hint">
                    Claude Desktop 兼容格式，仅编辑 stdio 类型服务器。格式示例：
                    <pre class="mcp-json-example">{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": { "FIRECRAWL_API_KEY": "fc-xxx" }
    }
  }
}</pre>
                  </div>
                  <el-input
                    v-model="mcpJsonText"
                    type="textarea"
                    :rows="14"
                    resize="none"
                    class="mcp-json-editor"
                    placeholder='{"mcpServers": {}}'
                  />
                  <div v-if="mcpJsonError" class="mcp-json-error">
                    <span class="hint-icon">!</span>
                    <span>{{ mcpJsonError }}</span>
                  </div>
                  <div class="mcp-json-actions">
                    <el-button size="small" class="neon-btn-primary" @click="applyMcpJson">应用 JSON</el-button>
                    <el-button size="small" class="neon-btn" @click="switchToMcpFormMode">切换到表单模式</el-button>
                  </div>
                </template>
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

        <el-tab-pane label="QQ 导入" name="qq">
          <section v-loading="loadingQqConfig" class="qq-section">
            <div class="section-header">
              <div>
                <span class="section-tag">// QQ INGEST</span>
                <h3>QQ 聊天记录导入配置</h3>
                <p>配置噪声过滤规则、PII 脱敏正则与抽取模型参数。</p>
              </div>
              <el-button size="small" @click="resetQqConfig">重置默认</el-button>
            </div>

            <!-- 噪声过滤规则：NR-1~NR-6 开关 -->
            <div class="qq-block">
              <h4 class="block-title">噪声过滤规则</h4>
              <div class="noise-rules">
                <div
                  v-for="rule in NOISE_RULE_META"
                  :key="rule.key"
                  class="noise-rule-item"
                >
                  <el-switch
                    v-model="qqConfig.noise_rules[rule.key]"
                  />
                  <span class="rule-label">
                    <code>{{ rule.key }}</code> {{ rule.label }}
                  </span>
                </div>
              </div>
            </div>

            <!-- PII 脱敏正则 -->
            <div class="qq-block">
              <h4 class="block-title">
                PII 脱敏正则
                <span class="block-hint">（留空禁用该类脱敏，正则错误将阻塞流水线）</span>
              </h4>
              <div class="privacy-patterns">
                <div
                  v-for="p in PRIVACY_PATTERN_META"
                  :key="p.key"
                  class="pattern-row"
                >
                  <label class="pattern-label">{{ p.label }}</label>
                  <el-input
                    v-model="qqConfig.privacy_patterns[p.key]"
                    :placeholder="p.placeholder"
                    size="small"
                    class="pattern-input"
                    :class="{
                      'pattern-valid': patternValidation[p.key] === true,
                      'pattern-invalid': patternValidation[p.key] === false
                    }"
                  />
                  <span v-if="patternValidation[p.key] === true" class="pattern-status valid" title="regex valid">OK</span>
                  <span v-else-if="patternValidation[p.key] === false" class="pattern-status invalid" title="regex syntax error">ERR</span>
                </div>
              </div>
            </div>

            <!-- 抽取模型参数 -->
            <div class="qq-block">
              <h4 class="block-title">抽取模型参数</h4>
              <div class="extract-grid">
                <div class="form-row">
                  <label>抽取模型</label>
                  <el-input
                    v-model="qqConfig.extract_model"
                    placeholder="glm-4-plus"
                    size="small"
                  />
                </div>
                <div class="form-row">
                  <label>抽取 baseUrl</label>
                  <el-input
                    v-model="qqConfig.extract_base_url"
                    placeholder="留空则回退到全局 llm.baseUrl"
                    size="small"
                  />
                </div>
                <div class="form-row">
                  <label>Token 预算</label>
                  <el-input-number
                    v-model="qqConfig.extract_token_budget"
                    :min="0"
                    :max="1000000"
                    :step="10000"
                    size="small"
                  />
                  <span class="form-hint">0 表示回退全局 budget.tokenBudget</span>
                </div>
              </div>
            </div>

            <!-- 批量与分块参数 -->
            <div class="qq-block">
              <h4 class="block-title">批量与分块参数</h4>
              <div class="extract-grid">
                <div class="form-row">
                  <label>批量上限</label>
                  <el-input-number
                    v-model="qqConfig.max_batch_size"
                    :min="1"
                    :max="200"
                    size="small"
                  />
                  <span class="form-hint">单次批量编译的最大文件数</span>
                </div>
                <div class="form-row">
                  <label>分块阈值</label>
                  <el-input-number
                    v-model="qqConfig.chunk_threshold"
                    :min="50"
                    :max="2000"
                    :step="50"
                    size="small"
                  />
                  <span class="form-hint">长文本按消息条数分块</span>
                </div>
              </div>
            </div>

            <div class="qq-actions">
              <span v-if="qqConfigDirty" class="dirty-indicator">CHANGED</span>
              <el-button
                type="primary"
                :loading="savingQqConfig"
                :disabled="!qqConfigDirty"
                @click="saveQqConfigForm"
              >保存 QQ 配置</el-button>
            </div>
          </section>
        </el-tab-pane>

        <!-- FR-14-2 Prompt IDE：编辑 prompts/*.md + 即时预览 + 试运行 -->
        <!-- AC-14-4: 编辑 prompts/compile.md 等并即时预览渲染结果 -->
        <!-- AC-14-5: 输入测试资料，执行 compile 一次，查看输出 -->
        <el-tab-pane label="Prompt IDE" name="prompts">
          <div class="prompt-ide-section">
            <!-- 左侧：prompt 文件列表 -->
            <div class="prompt-list-container">
              <div class="section-header">
                <span class="section-desc">// Prompt 文件列表</span>
              </div>
              <div v-if="loadingPrompts" class="section-loading">// 加载中…</div>
              <div v-else-if="promptFiles.length === 0" class="section-empty">
                暂无可用 prompt 文件
              </div>
              <div v-else class="prompt-list">
                <div
                  v-for="file in promptFiles"
                  :key="file.name"
                  class="prompt-item"
                  :class="{ active: currentPromptName === file.name }"
                  @click="selectPrompt(file.name)"
                >
                  <div class="prompt-label">{{ file.label }}</div>
                  <div class="prompt-desc">{{ file.description }}</div>
                </div>
              </div>
            </div>

            <!-- 中间：编辑器 -->
            <div class="prompt-editor-container">
              <div class="action-bar">
                <div class="prompt-meta">
                  <h3 class="prompt-title">{{ currentPromptMeta?.label || '未选择' }}</h3>
                  <p class="prompt-desc">{{ currentPromptMeta?.description || '请从左侧选择一个 prompt 文件' }}</p>
                </div>
                <div class="actions">
                  <span v-if="promptDirty" class="dirty-indicator">CHANGED</span>
                  <el-button
                    size="small"
                    class="neon-btn"
                    :loading="savingPrompt"
                    @click="savePrompt"
                    :disabled="!currentPromptName || !promptDirty"
                  >保存</el-button>
                </div>
              </div>

              <div v-if="!currentPromptName" class="editor-placeholder">
                请从左侧选择一个 prompt 文件进行编辑
              </div>
              <el-input
                v-else
                v-model="promptContent"
                type="textarea"
                :rows="16"
                resize="none"
                class="schema-editor"
                placeholder="prompt 内容"
              />
            </div>

            <!-- 右侧：预览 -->
            <div class="prompt-preview-container">
              <div class="action-bar">
                <span class="section-desc">// 预览</span>
              </div>
              <div class="preview-content">
                <MarkdownRenderer :content="promptContent" />
              </div>
            </div>

            <!-- 底部：试运行 -->
            <div class="test-run-section">
              <div class="section-header">
                <span class="section-desc">// 试运行（仅 compile.md）</span>
                <div class="test-actions">
                  <el-button
                    size="small"
                    class="neon-btn"
                    @click="clearTestResult"
                    :disabled="testEvents.length === 0 && testPages.length === 0 && !testError"
                  >清空结果</el-button>
                  <el-button
                    size="small"
                    class="neon-btn-primary"
                    :loading="testRunning"
                    @click="testRunning ? stopTest() : runTest()"
                    :disabled="!currentPromptName || currentPromptName !== 'compile.md'"
                  >{{ testRunning ? '停止' : '开始试运行' }}</el-button>
                </div>
              </div>

              <el-input
                v-model="testInput"
                type="textarea"
                :rows="4"
                resize="none"
                class="test-input"
                placeholder="输入测试资料（将作为原始内容传入 compile）"
                :disabled="testRunning"
              />

              <div class="test-results">
                <div v-if="testError" class="test-error">{{ testError }}</div>
                <div v-else-if="testRunning" class="test-running">运行中...</div>
                <div v-else-if="testEvents.length === 0 && testPages.length === 0" class="test-empty">
                  试运行结果将显示在这里
                </div>
                <div v-else>
                  <div class="test-events">
                    <div v-for="(event, idx) in testEvents" :key="idx" class="event-item">
                      <div class="event-step">{{ event.step }}</div>
                      <div class="event-message">{{ event.message }}</div>
                    </div>
                  </div>

                  <div v-if="testPages.length > 0" class="test-pages">
                    <div class="pages-title">生成页面：</div>
                    <div class="pages-list">
                      <div v-for="page in testPages" :key="page.path" class="page-item">
                        {{ page.title }} ({{ page.path }})
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
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

/* 子标题栏：仅含操作按钮的次级标题栏（如 MCP 表单模式下的"新增"按钮行） */
.sub-header {
  margin-bottom: 10px;
}

/* MCP 模式切换标签组 */
.mcp-mode-switch {
  display: flex;
  gap: 6px;
}

/* MCP JSON 编辑器提示文本 */
.mcp-json-hint {
  font-size: 12px;
  color: var(--text-soft);
  margin-bottom: 10px;
  line-height: 1.6;
}

.mcp-json-example {
  margin-top: 8px;
  padding: 10px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  overflow-x: auto;
}

.mcp-json-editor {
  font-family: var(--font-mono);
  font-size: 12px;
}

.mcp-json-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 8px 10px;
  background: var(--accent-magenta-a10);
  border: 1px solid var(--accent-magenta-a30);
  border-radius: 6px;
  color: var(--neon-magenta);
  font-size: 12px;
}

.mcp-json-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
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

/* ============================================================
 * QQ 导入配置 Tab 样式
 * 复用现有 CSS 变量保持视觉一致
 * ============================================================ */

.qq-section {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 8px 4px;
}

.qq-section .section-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding-bottom: 14px;
  border-bottom: 1px dashed var(--accent-purple-a20);
}

.qq-section .section-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--neon-cyan);
  letter-spacing: 2px;
  display: block;
  margin-bottom: 4px;
}

.qq-section h3 {
  margin: 0 0 4px;
  font-family: var(--font-display);
  font-size: 18px;
  color: var(--text-bright);
}

.qq-section p {
  margin: 0;
  font-size: 12px;
  color: var(--text-soft);
}

.qq-block {
  padding: 16px 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a15);
  border-radius: var(--radius-card);
}

.block-title {
  margin: 0 0 14px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
  font-family: var(--font-display);
}

.block-hint {
  font-size: 11px;
  color: var(--text-dim);
  font-weight: 400;
  font-family: var(--font-mono);
}

/* 噪声规则列表 */
.noise-rules {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.noise-rule-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: var(--accent-purple-a05);
  border: 1px solid var(--accent-purple-a15);
  border-radius: 8px;
}

.rule-label {
  font-size: 12px;
  color: var(--text-base);
}

.rule-label code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-cyan);
  background: var(--accent-cyan-a10);
  padding: 2px 6px;
  border-radius: 4px;
  margin-right: 6px;
}

/* 脱敏正则表单 */
.privacy-patterns {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pattern-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pattern-label {
  width: 80px;
  font-size: 12px;
  color: var(--text-base);
  flex-shrink: 0;
}

.pattern-input {
  flex: 1;
}

.pattern-input :deep(.el-input__inner) {
  font-family: var(--font-mono);
  font-size: 12px;
}

/* 抽取模型参数表单 */
.extract-grid {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.form-row label {
  width: 110px;
  font-size: 12px;
  color: var(--text-base);
  flex-shrink: 0;
}

.form-row .el-input,
.form-row .el-input-number {
  width: 240px;
  flex-shrink: 0;
}

.form-hint {
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.qq-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 8px;
  border-top: 1px dashed var(--accent-purple-a20);
  gap: 10px;
  align-items: center;
}

/* 脏表单指示器 */
.dirty-indicator {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-magenta);
  padding: 4px 10px;
  background: var(--accent-pink-a10);
  border: 1px solid var(--accent-pink-a30);
  border-radius: var(--radius-pill);
  letter-spacing: 0.03em;
}

/* 正则校验状态指示器 */
.pattern-status {
  flex-shrink: 0;
  width: 24px;
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  font-family: var(--font-mono);
}
.pattern-status.valid { color: var(--neon-cyan); }
.pattern-status.invalid { color: var(--neon-pink); }

.pattern-input.pattern-valid :deep(.el-input__inner) {
  border-color: var(--accent-cyan-a50) !important;
  box-shadow: 0 0 4px var(--accent-cyan-a20) !important;
}
.pattern-input.pattern-invalid :deep(.el-input__inner) {
  border-color: var(--accent-pink-a50) !important;
  box-shadow: 0 0 4px var(--accent-pink-a30) !important;
}

/* ============================================================
   FR-14-2 Prompt IDE 样式
   为什么用 CSS 变量：遵循项目硬约束（主题切换适配）
   布局：左列表 + 中编辑器 + 右预览 三栏 grid，底部试运行跨三列
   ============================================================ */

.prompt-ide-section {
  display: grid;
  grid-template-columns: 240px 1fr 1fr;
  grid-template-rows: auto auto;
  gap: 16px;
  margin-top: 8px;
}

.prompt-list-container,
.prompt-editor-container,
.prompt-preview-container {
  background: var(--bg-card);
  border: var(--border-glass);
  border-radius: var(--radius-input);
  padding: 14px 16px;
  backdrop-filter: var(--blur);
  min-height: 420px;
  max-height: 600px;
  overflow-y: auto;
}

.prompt-list-container {
  display: flex;
  flex-direction: column;
}

.test-run-section {
  grid-column: 1 / -1;
  background: var(--bg-card);
  border: var(--border-glass);
  border-radius: var(--radius-input);
  padding: 14px 16px;
  backdrop-filter: var(--blur);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border-glass);
}

.section-loading,
.section-empty {
  padding: 24px 8px;
  color: var(--text-soft);
  font-size: 13px;
  text-align: center;
}

.prompt-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.prompt-item {
  padding: 10px 12px;
  border-radius: var(--radius-input);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.2s ease;
}

.prompt-item:hover {
  background: var(--accent-cyan-a10);
  border-color: var(--accent-cyan-a30);
}

.prompt-item.active {
  background: var(--accent-purple-a20);
  border-color: var(--accent-purple-a50);
}

.prompt-item .prompt-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-base);
  margin-bottom: 4px;
}

.prompt-item .prompt-desc {
  font-size: 11px;
  color: var(--text-soft);
  line-height: 1.4;
}

.prompt-editor-container .action-bar,
.prompt-preview-container .action-bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border-glass);
}

.prompt-meta {
  flex: 1;
  min-width: 0;
}

.prompt-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
  margin: 0 0 4px 0;
}

.prompt-editor-container .prompt-desc,
.prompt-preview-container .prompt-desc {
  font-size: 12px;
  color: var(--text-soft);
  margin: 0;
  line-height: 1.4;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.editor-placeholder {
  padding: 48px 16px;
  text-align: center;
  color: var(--text-soft);
  font-size: 13px;
}

.preview-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-base);
  overflow-y: auto;
  max-height: 500px;
}

.test-actions {
  display: flex;
  gap: 8px;
}

.test-input {
  margin-bottom: 12px;
}

.test-results {
  min-height: 80px;
  padding: 12px;
  background: var(--bg-scene);
  border-radius: var(--radius-input);
  border: var(--border-glass);
  font-size: 13px;
}

.test-error {
  color: var(--neon-pink);
  padding: 8px;
  background: var(--accent-pink-a10);
  border-radius: var(--radius-input);
}

.test-running {
  color: var(--neon-cyan);
  padding: 8px;
}

.test-empty {
  color: var(--text-soft);
  text-align: center;
  padding: 16px;
}

.test-events {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.event-item {
  padding: 8px 10px;
  background: var(--bg-card);
  border-left: 3px solid var(--accent-cyan-a50);
  border-radius: var(--radius-input);
  font-size: 12px;
}

.event-step {
  font-weight: 600;
  color: var(--text-base);
  margin-bottom: 2px;
}

.event-message {
  color: var(--text-soft);
  line-height: 1.4;
}

.test-pages {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-glass);
}

.pages-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-base);
  margin-bottom: 6px;
}

.pages-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.page-item {
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text-soft);
  background: var(--bg-card);
  border-radius: var(--radius-input);
}
</style>

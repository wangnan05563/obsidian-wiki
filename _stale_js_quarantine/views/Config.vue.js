/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { API_BASE } from '../utils/apiBase';
import { ref, computed, reactive, onMounted, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Check, Close } from '@element-plus/icons-vue';
import ThemeSwitcher from '../components/ThemeSwitcher.vue';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import { apiErrorMessage } from '../utils/apiError';
import { STORAGE_KEYS, presetStorageKey } from '../constants/storageKeys';
import { consumeSSE } from '../utils/sse';
const activeTab = ref('schema');
const config = ref(null);
const schemaContent = ref('');
const schemaBuffer = ref('');
const editingSchema = ref(false);
const loadingSchema = ref(false);
const loadingConfig = ref(false);
const savingSchema = ref(false);
// §12.3-7 热加载状态
const reloading = ref(false);
const reloadResult = ref(null);
// §6.X SCHEMA 版本历史
const commits = ref([]);
const gitEnabled = ref(false);
const loadingHistory = ref(false);
// 选中的对比基线 commit hash
const selectedFrom = ref('');
// diff 结果
const diffLines = ref([]);
const loadingDiff = ref(false);
const showDiff = ref(false);
// 加载 SCHEMA.md
async function loadSchema() {
    loadingSchema.value = true;
    try {
        const res = await fetch(`${API_BASE}/schema`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        schemaContent.value = data.content;
        schemaBuffer.value = data.content;
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('加载 SCHEMA 失败', err));
    }
    finally {
        loadingSchema.value = false;
    }
}
// §6.X 加载 SCHEMA 版本历史（git log）
async function loadHistory() {
    loadingHistory.value = true;
    try {
        const res = await fetch(`${API_BASE}/schema/history`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        commits.value = data.commits ?? [];
        gitEnabled.value = data.gitEnabled ?? false;
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('加载版本历史失败', err));
    }
    finally {
        loadingHistory.value = false;
    }
}
// §6.X 加载版本对比（git diff）
async function loadDiff() {
    if (!selectedFrom.value)
        return;
    loadingDiff.value = true;
    showDiff.value = true;
    try {
        const res = await fetch(`${API_BASE}/schema/diff?from=${encodeURIComponent(selectedFrom.value)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        diffLines.value = data.lines ?? [];
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('加载版本对比失败', err));
        diffLines.value = [];
    }
    finally {
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
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('保存失败', err));
    }
    finally {
        savingSchema.value = false;
    }
}
// 取消编辑
function cancelEdit() {
    schemaBuffer.value = schemaContent.value;
    editingSchema.value = false;
}
// 提取为函数以避免模板中出现嵌套三元（S3358）
function diffLinePrefix(type) {
    if (type === 'add')
        return '+';
    if (type === 'del')
        return '-';
    return ' ';
}
// 加载配置
async function loadConfig() {
    loadingConfig.value = true;
    try {
        const res = await fetch(`${API_BASE}/config`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        config.value = await res.json();
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('加载配置失败', err));
    }
    finally {
        loadingConfig.value = false;
    }
}
// provider 中文名
const PROVIDER_LABELS = {
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
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        reloadResult.value = await res.json();
        ElMessage.success('配置已热加载');
        // 刷新展示，让用户看到应用后的值
        await loadConfig();
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('热加载失败', err));
    }
    finally {
        reloading.value = false;
    }
}
// ===== AI 服务配置 =====
// AI 配置状态
const aiConfig = ref(null);
const aiPresets = ref([]);
const loadingAi = ref(false);
const savingAi = ref(false);
const testingAi = ref(false);
const aiTestResult = ref(null);
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
const matchedPreset = computed(() => aiPresets.value.find(p => p.provider === aiForm.value.provider));
const aiBaseUrlPlaceholder = computed(() => matchedPreset.value?.baseUrl ?? '请输入 API Base URL');
const aiModelPlaceholder = computed(() => matchedPreset.value?.model ?? '请输入模型名称');
function loadPresetCache(presetKey) {
    const raw = localStorage.getItem(presetStorageKey(presetKey));
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            // 兼容旧格式（含 apiKey 字段）：忽略 apiKey，仅取 baseUrl/model
            return {
                baseUrl: parsed.baseUrl ?? '',
                model: parsed.model ?? '',
            };
        }
        catch {
            // 损坏数据忽略
        }
    }
    return null;
}
function savePresetCache(presetKey, cache) {
    localStorage.setItem(presetStorageKey(presetKey), JSON.stringify(cache));
}
function clearAllPresetCache() {
    // 清除所有 llmPresetConfig:* 和遗留的 apiKey:* 条目（旧格式迁移清理）
    const keysToRemove = [];
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
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
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
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('加载 AI 配置失败', err));
    }
    finally {
        loadingAi.value = false;
    }
}
// 加载 LLM 预设列表
async function loadPresets() {
    try {
        const res = await fetch(`${API_BASE}/ai/presets`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        aiPresets.value = data.presets ?? [];
    }
    catch {
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
async function applyPreset(preset) {
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
    }
    catch {
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
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
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
        }
        else {
            throw new Error(data.error || '保存失败');
        }
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('保存失败', err));
    }
    finally {
        savingAi.value = false;
    }
}
// 恢复初始配置：调用后端重置接口，恢复出厂默认 LLM 配置。
// 为什么需要：用户误改配置后可一键恢复，避免手动编辑 config.json。
// 同时清除 localStorage 中的预设缓存，确保前端状态与后端一致。
const resettingAi = ref(false);
async function resetAiConfig() {
    try {
        await ElMessageBox.confirm('确定恢复 LLM 配置到出厂默认值吗？此操作将重置 provider/baseUrl/model/apiKey，且不可撤销。', '恢复初始配置', { confirmButtonText: '确定恢复', cancelButtonText: '取消', type: 'warning' });
    }
    catch {
        // 用户取消
        return;
    }
    resettingAi.value = true;
    try {
        const res = await fetch(`${API_BASE}/ai/reset-config`, { method: 'POST' });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
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
        }
        else {
            throw new Error(data.error || '恢复失败');
        }
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('恢复初始配置失败', err));
    }
    finally {
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
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        // 使用局部变量收窄类型，避免 ref 在 await 后被认为可能为 null
        const result = await res.json();
        aiTestResult.value = result;
        if (result.ok) {
            ElMessage.success('连接测试成功');
        }
        else {
            ElMessage.warning('连接测试失败');
        }
    }
    catch (err) {
        aiTestResult.value = { ok: false, detail: err.message };
        ElMessage.error(apiErrorMessage('测试失败', err));
    }
    finally {
        testingAi.value = false;
    }
}
// 格式化测试结果文本（计算属性避免模板中类型收窄问题）
const testResultText = computed(() => {
    const r = aiTestResult.value;
    if (!r)
        return '';
    return r.ok ? `连接成功（模型: ${r.model || '未知'}）` : r.detail;
});
// 测试结果图标已迁移至模板内 el-icon（Check/Close），原 testResultIcon computed 已废弃删除
// ===== 联网搜索配置 =====
// §5.2 webSearch 配置状态：与 LLM 配置独立，用户可单独启用/禁用联网搜索
const webSearchForm = ref({
    provider: 'tavily',
    apiKey: '',
    maxResults: 5,
});
const webSearchStatus = ref(null);
const loadingWebSearch = ref(false);
const savingWebSearch = ref(false);
// 联网搜索 provider 中文标签
const WEB_SEARCH_PROVIDERS = [
    { value: 'tavily', label: 'Tavily', apiKeyUrl: 'https://tavily.com' },
    { value: 'bing', label: 'Bing', apiKeyUrl: 'https://www.microsoft.com/bing/apis' },
];
async function loadWebSearchConfig() {
    loadingWebSearch.value = true;
    try {
        const res = await fetch(`${API_BASE}/ai/web-search`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
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
        }
        else {
            webSearchStatus.value = { enabled: false, apiKeySet: false, apiKeyMasked: '', apiKeyRef: 'TAVILY_API_KEY' };
        }
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('加载联网搜索配置失败', err));
    }
    finally {
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
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
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
        }
        else {
            throw new Error(data.error || '保存失败');
        }
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('保存失败', err));
    }
    finally {
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
function syncAdvancedFormsFromConfig(cfg) {
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
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.ok) {
            // 同步本地 config 引用，避免只读展示与编辑表单不一致
            if (config.value) {
                config.value.budget = data.config;
            }
            ElMessage.success('运行参数保存成功');
        }
        else {
            throw new Error(data.error || '保存失败');
        }
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('保存运行参数失败', err));
    }
    finally {
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
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.ok) {
            if (config.value) {
                config.value.healthCheck = data.config;
            }
            ElMessage.success('健康检查配置保存成功');
        }
        else {
            throw new Error(data.error || '保存失败');
        }
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('保存健康检查配置失败', err));
    }
    finally {
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
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
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
        }
        else {
            throw new Error(data.error || '保存失败');
        }
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('保存批量编译配置失败', err));
    }
    finally {
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
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.ok) {
            if (config.value) {
                config.value.logging = data.config;
            }
            const msg = data.requireRestart?.length
                ? `日志配置保存成功（提示：${data.requireRestart.join(', ')} 需重启服务才完全生效）`
                : '日志配置保存成功';
            ElMessage.success(msg);
        }
        else {
            throw new Error(data.error || '保存失败');
        }
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('保存日志配置失败', err));
    }
    finally {
        savingLogging.value = false;
    }
}
// ===== 工具配置：MCP / CLI / 场景路由 =====
// 需求 4：AI 问答支持技能、MCP、CLI 等可配置化调用，根据场景自动调用。
// 表单与后端 GET/PUT /api/tools/config 对齐，保存时调用 PUT 落盘 + adapter 热加载。
// 工具配置表单：深拷贝后端 ToolsConfig，避免编辑过程直接污染原对象
const toolsForm = ref({
    mcpServers: [],
    cliTools: [],
    scenes: [],
    routerMode: 'auto',
});
const loadingTools = ref(false);
const savingTools = ref(false);
const testingCli = ref(false);
const cliTestResult = ref(null);
// 路由模式可选项
const ROUTER_MODE_OPTIONS = [
    { value: 'auto', label: '自动', desc: 'LLM 自主决策调用所有启用工具（推荐）' },
    { value: 'keyword', label: '关键词', desc: '根据问题关键词匹配场景规则启用对应工具' },
];
// MCP transport 可选项
const MCP_TRANSPORT_OPTIONS = [
    { value: 'stdio', label: 'stdio（子进程）' },
    { value: 'sse', label: 'sse（流式）' },
    { value: 'http', label: 'http（请求）' },
];
// 新增空白 MCP 服务器条目
function addMcpServer() {
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
function removeMcpServer(idx) {
    toolsForm.value.mcpServers.splice(idx, 1);
}
// 新增空白 CLI 工具条目
function addCliTool() {
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
function removeCliTool(idx) {
    toolsForm.value.cliTools.splice(idx, 1);
}
// 新增空白场景规则条目
function addScene() {
    toolsForm.value.scenes.push({
        name: `scene-${toolsForm.value.scenes.length + 1}`,
        keywords: [],
        tools: [],
        enabled: true,
    });
}
// 删除指定场景规则条目
function removeScene(idx) {
    toolsForm.value.scenes.splice(idx, 1);
}
// 加载工具配置
async function loadToolsConfig() {
    loadingTools.value = true;
    try {
        const res = await fetch(`${API_BASE}/tools/config`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // 深拷贝避免编辑过程污染原对象
        toolsForm.value = {
            mcpServers: (data.mcpServers ?? []).map(s => ({ ...s, args: [...(s.args ?? [])], env: s.env ? { ...s.env } : undefined })),
            cliTools: (data.cliTools ?? []).map(t => ({ ...t })),
            scenes: (data.scenes ?? []).map(sc => ({ ...sc, keywords: [...sc.keywords], tools: [...sc.tools] })),
            routerMode: data.routerMode ?? 'auto',
        };
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('加载工具配置失败', err));
    }
    finally {
        loadingTools.value = false;
    }
}
// 保存工具配置
async function saveToolsConfig() {
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
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.ok) {
            ElMessage.success('工具配置保存成功，下次问答将使用新配置');
        }
        else {
            throw new Error(data.error || '保存失败');
        }
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('保存工具配置失败', err));
    }
    finally {
        savingTools.value = false;
    }
}
// 测试 CLI 工具执行（用第一条启用的 CLI 工具的 command 作为冒烟测试）
async function testCliTool(idx) {
    const entry = toolsForm.value.cliTools[idx];
    if (!entry)
        return;
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
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        cliTestResult.value = {
            ok: data.ok === true,
            output: data.output,
            error: data.error,
        };
        if (data.ok) {
            ElMessage.success(`CLI 工具 "${entry.name}" 执行成功`);
        }
        else {
            ElMessage.warning(`CLI 工具 "${entry.name}" 执行失败：${data.error ?? '未知错误'}`);
        }
    }
    catch (err) {
        cliTestResult.value = { ok: false, error: err.message };
        ElMessage.error(apiErrorMessage('CLI 测试失败', err));
    }
    finally {
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
const mcpEditMode = ref('form');
// JSON 编辑器内容（字符串，保存时 parse 为对象）
const mcpJsonText = ref('');
// JSON 解析错误提示（空串表示无错误）
const mcpJsonError = ref('');
// 将表单中的 MCP 服务器列表序列化为 Claude Desktop 格式 JSON 字符串
// 为什么仅序列化 stdio：Claude Desktop 格式不支持 sse/http，非 stdio 配置在 JSON 模式下不可见
// 为什么过滤 enabled=false：Claude Desktop 格式无 enabled 字段，禁用的 server 不写入 JSON
function serializeMcpToJson(servers) {
    const mcpServers = {};
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
function switchToMcpJsonMode() {
    mcpJsonText.value = serializeMcpToJson(toolsForm.value.mcpServers);
    mcpJsonError.value = '';
    mcpEditMode.value = 'json';
}
// 切换回表单模式时尝试 parse JSON 并合并到表单
// 为什么用 try/catch 包裹 JSON.parse：用户可能正在编辑 JSON（语法不完整），parse 失败时给出友好提示而非阻断
function switchToMcpFormMode() {
    applyMcpJsonToForm();
    mcpEditMode.value = 'form';
}
// 解析 JSON 文本并合并到表单的 mcpServers 数组
// 合并策略：
//   1. JSON 中的 server 按 name 合并到表单（覆盖同名 stdio server 的 command/args/env）
//   2. 表单中已有的 sse/http server 保持不变（JSON 模式不编辑这些类型）
//   3. JSON 中新增的 server 追加到表单末尾，transport 默认 stdio，enabled 默认 true
function applyMcpJsonToForm() {
    mcpJsonError.value = '';
    const text = mcpJsonText.value.trim();
    if (!text) {
        // 空文本视为清空所有 stdio server
        toolsForm.value.mcpServers = toolsForm.value.mcpServers.filter(s => s.transport !== 'stdio');
        return true;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (err) {
        mcpJsonError.value = `JSON 解析失败：${err.message}`;
        return false;
    }
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
        mcpJsonError.value = 'JSON 格式错误：缺少 mcpServers 字段或不是对象';
        return false;
    }
    // 保留非 stdio server，清空 stdio server 后从 JSON 重建
    // 为什么重建而非合并：JSON 是权威源，表单中 stdio server 的增删应以 JSON 为准
    const nonStdioServers = toolsForm.value.mcpServers.filter(s => s.transport !== 'stdio');
    const newStdioServers = [];
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
function applyMcpJson() {
    if (applyMcpJsonToForm()) {
        ElMessage.success('JSON 已解析并应用到表单，切换到表单模式可查看详情');
    }
    else {
        ElMessage.warning(mcpJsonError.value || 'JSON 解析失败');
    }
}
// ============================================================
// QQ 导入子系统配置（noise_rules/privacy_patterns/extract_model 等）
// ============================================================
// 噪声规则元信息：NR-1~NR-6 的中文描述，便于前端表单展示
// 为什么独立常量而非后端返回：规则 ID 是稳定契约，描述文案属于 UI 层关注点
const NOISE_RULE_META = [
    { key: 'NR-1', label: '过滤系统通知（入群/退群/红包等）' },
    { key: 'NR-2', label: '过滤纯表情/图片消息' },
    { key: 'NR-3', label: '过滤连续短消息（≤3 字）' },
    { key: 'NR-4', label: '合并同一人连续发言' },
    { key: 'NR-5', label: '过滤 URL 占比过高的消息' },
    { key: 'NR-6', label: '过滤@全体/@机器人触发消息' },
];
// 脱敏规则元信息：key 与后端 privacy_patterns 对齐
const PRIVACY_PATTERN_META = [
    { key: 'phone', label: '手机号', placeholder: '1[3-9]\\d{9}' },
    { key: 'id_card', label: '身份证号', placeholder: '\\d{17}[\\dXx]' },
    { key: 'email', label: '邮箱', placeholder: '[\\w.-]+@[\\w.-]+\\.\\w+' },
    { key: 'card', label: '银行卡号', placeholder: '\\d{16,19}' },
    { key: 'qq', label: 'QQ 号', placeholder: '(?<=QQ|扣扣|qq号|企鹅)\\s*[0-9]{5,11}' },
];
const qqConfig = reactive({
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
    const result = {};
    for (const p of PRIVACY_PATTERN_META) {
        const input = qqConfig.privacy_patterns[p.key];
        if (!input || !input.trim()) {
            result[p.key] = null;
        }
        else {
            try {
                new RegExp(input);
                result[p.key] = true;
            }
            catch {
                result[p.key] = false;
            }
        }
    }
    return result;
});
const qqConfigDirty = ref(false);
let _qqConfigInitial = '';
// 深度监听 qqConfig 变化，与初始快照对比判断是否脏
watch(() => qqConfig, () => {
    if (!_qqConfigInitial)
        return;
    qqConfigDirty.value = JSON.stringify(qqConfig) !== _qqConfigInitial;
}, { deep: true });
async function loadQqConfig() {
    loadingQqConfig.value = true;
    try {
        const res = await fetch(`${API_BASE}/qq-ingest/config`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const qq = data.qq;
        // 逐字段赋值而非 Object.assign：reactive 需保留引用才能触发响应式更新
        qqConfig.noise_rules = { ...qq.noise_rules };
        qqConfig.privacy_patterns = { ...qq.privacy_patterns };
        qqConfig.max_batch_size = qq.max_batch_size;
        qqConfig.chunk_threshold = qq.chunk_threshold;
        qqConfig.extract_model = qq.extract_model;
        qqConfig.extract_base_url = qq.extract_base_url;
        qqConfig.extract_token_budget = qq.extract_token_budget;
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('加载 QQ 配置失败', err));
    }
    finally {
        loadingQqConfig.value = false;
        _qqConfigInitial = JSON.stringify(qqConfig);
    }
}
async function saveQqConfigForm() {
    // 前端预校验：privacy_patterns 是用户自定义正则，提交前 try/catch 编译防止后端运行时崩溃
    for (const [key, pattern] of Object.entries(qqConfig.privacy_patterns)) {
        if (!pattern)
            continue;
        try {
            // eslint-disable-next-line no-new
            new RegExp(pattern);
        }
        catch (err) {
            ElMessage.error(`脱敏正则「${key}」无效：${err.message}`);
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
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('保存 QQ 配置失败', err));
    }
    finally {
        savingQqConfig.value = false;
    }
}
function resetQqConfig() {
    ElMessageBox.confirm('确认重置 QQ 配置为默认值？', '重置确认', { type: 'warning' })
        .then(() => {
        // 重置为 SRS §6.2 默认值
        qqConfig.noise_rules = Object.fromEntries(NOISE_RULE_META.map((r) => [r.key, true]));
        qqConfig.privacy_patterns = Object.fromEntries(PRIVACY_PATTERN_META.map((p) => [p.key, p.placeholder.replace(/\\\\/g, '\\')]));
        qqConfig.max_batch_size = 20;
        qqConfig.chunk_threshold = 200;
        qqConfig.extract_model = 'glm-4-plus';
        qqConfig.extract_base_url = '';
        qqConfig.extract_token_budget = 50000;
        ElMessage.info('已重置为默认值（需点击保存才生效）');
    })
        .catch(() => { });
}
// ============================================================
// FR-14-2 Prompt IDE：编辑 prompts/*.md + 即时预览 + 试运行
// AC-14-4: 编辑 prompts/compile.md 等并即时预览渲染结果
// AC-14-5: 输入测试资料，执行 compile 一次，查看输出
// ============================================================
const promptFiles = ref([]);
const currentPromptName = ref('');
const promptContent = ref('');
// 保存时的原始内容：用于脏检测（编辑器内容与已保存内容对比）
const promptContentSaved = ref('');
const loadingPrompts = ref(false);
const savingPrompt = ref(false);
// 试运行状态
const testInput = ref('');
const testRunning = ref(false);
const testEvents = ref([]);
const testPages = ref([]);
const testError = ref(null);
let testAbortController = null;
// 当前选中的 prompt 元信息（用于显示 label/description）
const currentPromptMeta = computed(() => promptFiles.value.find((p) => p.name === currentPromptName.value) ?? null);
// 编辑器内容是否脏（未保存）
const promptDirty = computed(() => promptContent.value !== promptContentSaved.value);
// 加载 prompt 文件列表
async function loadPromptList() {
    loadingPrompts.value = true;
    try {
        const res = await fetch(`${API_BASE}/prompts`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        promptFiles.value = data.prompts ?? [];
        // 默认选中第一个 prompt（compile.md 优先，便于试运行）
        if (promptFiles.value.length > 0 && !currentPromptName.value) {
            const compile = promptFiles.value.find((p) => p.name === 'compile.md');
            await selectPrompt(compile?.name ?? promptFiles.value[0].name);
        }
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('加载 prompt 列表失败', err));
        promptFiles.value = [];
    }
    finally {
        loadingPrompts.value = false;
    }
}
// 切换选中的 prompt 文件
async function selectPrompt(name) {
    if (testRunning.value) {
        ElMessage.warning('试运行进行中，请先停止再切换 prompt');
        return;
    }
    if (promptDirty.value) {
        try {
            await ElMessageBox.confirm('当前 prompt 有未保存的修改，确定放弃？', '未保存更改', { type: 'warning' });
        }
        catch {
            return;
        }
    }
    currentPromptName.value = name;
    try {
        const res = await fetch(`${API_BASE}/prompts/${encodeURIComponent(name)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        promptContent.value = data.content ?? '';
        promptContentSaved.value = data.content ?? '';
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('加载 prompt 内容失败', err));
        promptContent.value = '';
        promptContentSaved.value = '';
    }
}
// 保存当前编辑的 prompt 文件
async function savePrompt() {
    if (!currentPromptName.value)
        return;
    savingPrompt.value = true;
    try {
        const res = await fetch(`${API_BASE}/prompts/${encodeURIComponent(currentPromptName.value)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: promptContent.value }),
        });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        promptContentSaved.value = promptContent.value;
        ElMessage.success('Prompt 已保存，下次 compile/query 将使用新内容');
    }
    catch (err) {
        ElMessage.error(apiErrorMessage('保存 prompt 失败', err));
    }
    finally {
        savingPrompt.value = false;
    }
}
// 试运行：用编辑器中的 prompt 执行 compile，SSE 流式接收结果
async function runTest() {
    if (!currentPromptName.value)
        return;
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
        await consumeSSE(res, (eventType, parsed) => {
            if (eventType === 'progress' || eventType === 'page' || eventType === 'done') {
                testEvents.value.push(parsed);
                // 收集生成的页面
                if (eventType === 'page' && parsed.data?.path && parsed.data?.title) {
                    testPages.value.push({
                        path: parsed.data.path,
                        title: parsed.data.title,
                    });
                }
            }
            else if (eventType === 'error') {
                testError.value = parsed.message || '试运行出错';
                testEvents.value.push(parsed);
            }
        }, testAbortController.signal);
        if (!testError.value) {
            ElMessage.success(`试运行完成，共生成 ${testPages.value.length} 个页面`);
        }
    }
    catch (err) {
        // AbortError 是用户主动停止的正常路径，不显示错误
        if (err.name === 'AbortError')
            return;
        testError.value = err.message;
        ElMessage.error(apiErrorMessage('试运行失败', err));
    }
    finally {
        testRunning.value = false;
        testAbortController = null;
    }
}
// 停止试运行
function stopTest() {
    if (testAbortController) {
        testAbortController.abort();
        testRunning.value = false;
    }
}
// 清空试运行结果
function clearTestResult() {
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
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['config-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['config-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['el-tabs__item']} */ ;
/** @type {__VLS_StyleScopedClasses['config-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['config-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-copy']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-section']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['is-disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['schema-editor']} */ ;
/** @type {__VLS_StyleScopedClasses['el-textarea__inner']} */ ;
/** @type {__VLS_StyleScopedClasses['key-status']} */ ;
/** @type {__VLS_StyleScopedClasses['key-status']} */ ;
/** @type {__VLS_StyleScopedClasses['warning-text']} */ ;
/** @type {__VLS_StyleScopedClasses['warning-text']} */ ;
/** @type {__VLS_StyleScopedClasses['reload-applied']} */ ;
/** @type {__VLS_StyleScopedClasses['history-disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-item']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-item']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line']} */ ;
/** @type {__VLS_StyleScopedClasses['add']} */ ;
/** @type {__VLS_StyleScopedClasses['line-prefix']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line']} */ ;
/** @type {__VLS_StyleScopedClasses['del']} */ ;
/** @type {__VLS_StyleScopedClasses['line-prefix']} */ ;
/** @type {__VLS_StyleScopedClasses['preset-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['preset-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['el-input__wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['el-input__wrapper']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['test-result']} */ ;
/** @type {__VLS_StyleScopedClasses['test-result']} */ ;
/** @type {__VLS_StyleScopedClasses['key-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-danger']} */ ;
/** @type {__VLS_StyleScopedClasses['is-disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-row']} */ ;
/** @type {__VLS_StyleScopedClasses['cli-test-result']} */ ;
/** @type {__VLS_StyleScopedClasses['cli-test-result']} */ ;
/** @type {__VLS_StyleScopedClasses['ok']} */ ;
/** @type {__VLS_StyleScopedClasses['cli-test-result']} */ ;
/** @type {__VLS_StyleScopedClasses['fail']} */ ;
/** @type {__VLS_StyleScopedClasses['cli-test-result']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['block-header']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-section']} */ ;
/** @type {__VLS_StyleScopedClasses['section-header']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-section']} */ ;
/** @type {__VLS_StyleScopedClasses['section-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-section']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-section']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['rule-label']} */ ;
/** @type {__VLS_StyleScopedClasses['pattern-input']} */ ;
/** @type {__VLS_StyleScopedClasses['el-input__inner']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['pattern-status']} */ ;
/** @type {__VLS_StyleScopedClasses['pattern-status']} */ ;
/** @type {__VLS_StyleScopedClasses['pattern-input']} */ ;
/** @type {__VLS_StyleScopedClasses['el-input__inner']} */ ;
/** @type {__VLS_StyleScopedClasses['pattern-input']} */ ;
/** @type {__VLS_StyleScopedClasses['el-input__inner']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-list-container']} */ ;
/** @type {__VLS_StyleScopedClasses['section-header']} */ ;
/** @type {__VLS_StyleScopedClasses['section-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-item']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-item']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-item']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-editor-container']} */ ;
/** @type {__VLS_StyleScopedClasses['action-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-preview-container']} */ ;
/** @type {__VLS_StyleScopedClasses['action-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-editor-container']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-preview-container']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-page" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "glass-card config-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-deco" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "head-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({
    ...{ class: "head-title grad-text" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "head-tip" },
});
const __VLS_0 = {}.ElTabs;
/** @type {[typeof __VLS_components.ElTabs, typeof __VLS_components.elTabs, typeof __VLS_components.ElTabs, typeof __VLS_components.elTabs, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    modelValue: (__VLS_ctx.activeTab),
    ...{ class: "config-tabs" },
}));
const __VLS_2 = __VLS_1({
    modelValue: (__VLS_ctx.activeTab),
    ...{ class: "config-tabs" },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
const __VLS_4 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
    label: "SCHEMA 规范",
    name: "schema",
}));
const __VLS_6 = __VLS_5({
    label: "SCHEMA 规范",
    name: "schema",
}, ...__VLS_functionalComponentArgsRest(__VLS_5));
__VLS_7.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "schema-section" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "action-bar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "actions" },
});
if (!__VLS_ctx.editingSchema) {
    const __VLS_8 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn" },
    }));
    const __VLS_10 = __VLS_9({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
    let __VLS_12;
    let __VLS_13;
    let __VLS_14;
    const __VLS_15 = {
        onClick: (...[$event]) => {
            if (!(!__VLS_ctx.editingSchema))
                return;
            __VLS_ctx.editingSchema = true;
        }
    };
    __VLS_11.slots.default;
    var __VLS_11;
}
else {
    const __VLS_16 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn-primary" },
        loading: (__VLS_ctx.savingSchema),
    }));
    const __VLS_18 = __VLS_17({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn-primary" },
        loading: (__VLS_ctx.savingSchema),
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
    let __VLS_20;
    let __VLS_21;
    let __VLS_22;
    const __VLS_23 = {
        onClick: (__VLS_ctx.saveSchema)
    };
    __VLS_19.slots.default;
    var __VLS_19;
    const __VLS_24 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn" },
    }));
    const __VLS_26 = __VLS_25({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_25));
    let __VLS_28;
    let __VLS_29;
    let __VLS_30;
    const __VLS_31 = {
        onClick: (__VLS_ctx.cancelEdit)
    };
    __VLS_27.slots.default;
    var __VLS_27;
}
if (__VLS_ctx.loadingSchema) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-loading" },
    });
}
else if (__VLS_ctx.editingSchema) {
    const __VLS_32 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
        modelValue: (__VLS_ctx.schemaBuffer),
        type: "textarea",
        rows: (24),
        resize: "none",
        ...{ class: "schema-editor" },
    }));
    const __VLS_34 = __VLS_33({
        modelValue: (__VLS_ctx.schemaBuffer),
        type: "textarea",
        rows: (24),
        resize: "none",
        ...{ class: "schema-editor" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_33));
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({
        ...{ class: "schema-view" },
    });
    (__VLS_ctx.schemaContent);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "history-section" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "history-head" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
const __VLS_36 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    text: true,
    loading: (__VLS_ctx.loadingHistory),
}));
const __VLS_38 = __VLS_37({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    text: true,
    loading: (__VLS_ctx.loadingHistory),
}, ...__VLS_functionalComponentArgsRest(__VLS_37));
let __VLS_40;
let __VLS_41;
let __VLS_42;
const __VLS_43 = {
    onClick: (__VLS_ctx.loadHistory)
};
__VLS_39.slots.default;
var __VLS_39;
if (!__VLS_ctx.gitEnabled) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "history-disabled" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
}
else if (__VLS_ctx.commits.length === 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "history-empty" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "commit-list" },
    });
    for (const [c] of __VLS_getVForSourceType((__VLS_ctx.commits))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onClick: (...[$event]) => {
                    if (!!(!__VLS_ctx.gitEnabled))
                        return;
                    if (!!(__VLS_ctx.commits.length === 0))
                        return;
                    __VLS_ctx.selectedFrom = c.hash;
                } },
            key: (c.hash),
            ...{ class: "commit-item" },
            ...{ class: ({ selected: __VLS_ctx.selectedFrom === c.hash }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "commit-hash" },
        });
        (c.hash.slice(0, 8));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "commit-info" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "commit-message" },
        });
        (c.message);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "commit-meta" },
        });
        (c.author);
        (c.date);
    }
}
if (__VLS_ctx.gitEnabled && __VLS_ctx.commits.length > 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "diff-section" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "diff-bar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "section-desc" },
    });
    (__VLS_ctx.selectedFrom ? __VLS_ctx.selectedFrom.slice(0, 8) : '选择基线');
    const __VLS_44 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn-primary" },
        disabled: (!__VLS_ctx.selectedFrom),
        loading: (__VLS_ctx.loadingDiff),
    }));
    const __VLS_46 = __VLS_45({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn-primary" },
        disabled: (!__VLS_ctx.selectedFrom),
        loading: (__VLS_ctx.loadingDiff),
    }, ...__VLS_functionalComponentArgsRest(__VLS_45));
    let __VLS_48;
    let __VLS_49;
    let __VLS_50;
    const __VLS_51 = {
        onClick: (__VLS_ctx.loadDiff)
    };
    __VLS_47.slots.default;
    var __VLS_47;
    if (__VLS_ctx.showDiff && !__VLS_ctx.loadingDiff) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "diff-result" },
        });
        if (__VLS_ctx.diffLines.length === 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "diff-empty" },
            });
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "diff-lines" },
            });
            for (const [line, idx] of __VLS_getVForSourceType((__VLS_ctx.diffLines))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (idx),
                    ...{ class: "diff-line" },
                    ...{ class: (line.type) },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "line-prefix" },
                });
                (__VLS_ctx.diffLinePrefix(line.type));
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "line-content" },
                });
                (line.content);
            }
        }
    }
}
var __VLS_7;
const __VLS_52 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({
    label: "系统配置",
    name: "config",
}));
const __VLS_54 = __VLS_53({
    label: "系统配置",
    name: "config",
}, ...__VLS_functionalComponentArgsRest(__VLS_53));
__VLS_55.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-section" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "reload-bar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
const __VLS_56 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.reloading),
}));
const __VLS_58 = __VLS_57({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.reloading),
}, ...__VLS_functionalComponentArgsRest(__VLS_57));
let __VLS_60;
let __VLS_61;
let __VLS_62;
const __VLS_63 = {
    onClick: (__VLS_ctx.reloadConfig)
};
__VLS_59.slots.default;
var __VLS_59;
if (__VLS_ctx.reloadResult) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "reload-result" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "reload-applied" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "applied-tag" },
    });
    (__VLS_ctx.reloadResult.applied.model);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "applied-tag" },
    });
    (__VLS_ctx.reloadResult.applied.maxSteps);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "applied-tag" },
    });
    (__VLS_ctx.reloadResult.applied.tokenBudget);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "applied-tag" },
    });
    (__VLS_ctx.reloadResult.applied.staleDays);
    if (__VLS_ctx.reloadResult.requireRestart.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "reload-warn" },
        });
        (__VLS_ctx.reloadResult.requireRestart.join(', '));
    }
}
if (__VLS_ctx.loadingConfig) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-loading" },
    });
}
else if (__VLS_ctx.config) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-block hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.PROVIDER_LABELS[__VLS_ctx.config.llm.provider] || __VLS_ctx.config.llm.provider);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.llm.model);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.llm.baseUrl);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: (['key-status', __VLS_ctx.config.llm.apiKeySet ? 'set' : 'unset']) },
    });
    (__VLS_ctx.config.llm.apiKeySet ? '已设置' : '未设置');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({
        ...{ class: "env-name" },
    });
    (__VLS_ctx.config.llm.apiKeyRef);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-block hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.adapter);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.budget.maxSteps);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.budget.tokenBudget);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.localOnly ? '开启' : '关闭');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-block hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.server.host);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.server.port);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.vaultPath);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "config-value" },
    });
    (__VLS_ctx.config.healthCheck.staleDays);
    if (!__VLS_ctx.config.llm.apiKeySet) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "key-warning" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "warning-icon" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "warning-text" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
        (__VLS_ctx.config.llm.apiKeyRef);
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "advanced-config" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "section-header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-block hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "block-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "block-bracket" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "block-bracket" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "form-label" },
    for: "cfg-max-steps",
});
const __VLS_64 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({
    id: "cfg-max-steps",
    modelValue: (__VLS_ctx.budgetForm.maxSteps),
    modelModifiers: { number: true, },
    type: "number",
    min: (1),
    max: (100),
    ...{ class: "form-input" },
}));
const __VLS_66 = __VLS_65({
    id: "cfg-max-steps",
    modelValue: (__VLS_ctx.budgetForm.maxSteps),
    modelModifiers: { number: true, },
    type: "number",
    min: (1),
    max: (100),
    ...{ class: "form-input" },
}, ...__VLS_functionalComponentArgsRest(__VLS_65));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "form-label" },
    for: "cfg-token-budget",
});
const __VLS_68 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_69 = __VLS_asFunctionalComponent(__VLS_68, new __VLS_68({
    id: "cfg-token-budget",
    modelValue: (__VLS_ctx.budgetForm.tokenBudget),
    modelModifiers: { number: true, },
    type: "number",
    min: (1000),
    step: (1000),
    ...{ class: "form-input" },
}));
const __VLS_70 = __VLS_69({
    id: "cfg-token-budget",
    modelValue: (__VLS_ctx.budgetForm.tokenBudget),
    modelModifiers: { number: true, },
    type: "number",
    min: (1000),
    step: (1000),
    ...{ class: "form-input" },
}, ...__VLS_functionalComponentArgsRest(__VLS_69));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "ai-actions" },
});
const __VLS_72 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_73 = __VLS_asFunctionalComponent(__VLS_72, new __VLS_72({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.savingBudget),
}));
const __VLS_74 = __VLS_73({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.savingBudget),
}, ...__VLS_functionalComponentArgsRest(__VLS_73));
let __VLS_76;
let __VLS_77;
let __VLS_78;
const __VLS_79 = {
    onClick: (__VLS_ctx.saveBudget)
};
__VLS_75.slots.default;
var __VLS_75;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-block hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "block-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "block-bracket" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "block-bracket" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "form-label" },
    for: "cfg-stale-days",
});
const __VLS_80 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_81 = __VLS_asFunctionalComponent(__VLS_80, new __VLS_80({
    id: "cfg-stale-days",
    modelValue: (__VLS_ctx.healthCheckForm.staleDays),
    modelModifiers: { number: true, },
    type: "number",
    min: (1),
    max: (365),
    ...{ class: "form-input" },
}));
const __VLS_82 = __VLS_81({
    id: "cfg-stale-days",
    modelValue: (__VLS_ctx.healthCheckForm.staleDays),
    modelModifiers: { number: true, },
    type: "number",
    min: (1),
    max: (365),
    ...{ class: "form-input" },
}, ...__VLS_functionalComponentArgsRest(__VLS_81));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "ai-actions" },
});
const __VLS_84 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_85 = __VLS_asFunctionalComponent(__VLS_84, new __VLS_84({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.savingHealthCheck),
}));
const __VLS_86 = __VLS_85({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.savingHealthCheck),
}, ...__VLS_functionalComponentArgsRest(__VLS_85));
let __VLS_88;
let __VLS_89;
let __VLS_90;
const __VLS_91 = {
    onClick: (__VLS_ctx.saveHealthCheck)
};
__VLS_87.slots.default;
var __VLS_87;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-block hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "block-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "block-bracket" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "block-bracket" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "form-label" },
    for: "cfg-allowed-exts",
});
const __VLS_92 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_93 = __VLS_asFunctionalComponent(__VLS_92, new __VLS_92({
    id: "cfg-allowed-exts",
    modelValue: (__VLS_ctx.batchForm.allowedExtensionsText),
    placeholder: "md, txt, pdf, html, json",
    ...{ class: "form-input" },
}));
const __VLS_94 = __VLS_93({
    id: "cfg-allowed-exts",
    modelValue: (__VLS_ctx.batchForm.allowedExtensionsText),
    placeholder: "md, txt, pdf, html, json",
    ...{ class: "form-input" },
}, ...__VLS_functionalComponentArgsRest(__VLS_93));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "form-label" },
    for: "cfg-max-batch",
});
const __VLS_96 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_97 = __VLS_asFunctionalComponent(__VLS_96, new __VLS_96({
    id: "cfg-max-batch",
    modelValue: (__VLS_ctx.batchForm.maxBatchSize),
    modelModifiers: { number: true, },
    type: "number",
    min: (1),
    max: (1000),
    ...{ class: "form-input" },
}));
const __VLS_98 = __VLS_97({
    id: "cfg-max-batch",
    modelValue: (__VLS_ctx.batchForm.maxBatchSize),
    modelModifiers: { number: true, },
    type: "number",
    min: (1),
    max: (1000),
    ...{ class: "form-input" },
}, ...__VLS_functionalComponentArgsRest(__VLS_97));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "form-label" },
    for: "cfg-max-file-size",
});
const __VLS_100 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_101 = __VLS_asFunctionalComponent(__VLS_100, new __VLS_100({
    id: "cfg-max-file-size",
    modelValue: (__VLS_ctx.batchForm.maxFileSizeMb),
    modelModifiers: { number: true, },
    type: "number",
    min: (1),
    max: (1024),
    ...{ class: "form-input" },
}));
const __VLS_102 = __VLS_101({
    id: "cfg-max-file-size",
    modelValue: (__VLS_ctx.batchForm.maxFileSizeMb),
    modelModifiers: { number: true, },
    type: "number",
    min: (1),
    max: (1024),
    ...{ class: "form-input" },
}, ...__VLS_functionalComponentArgsRest(__VLS_101));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "ai-actions" },
});
const __VLS_104 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_105 = __VLS_asFunctionalComponent(__VLS_104, new __VLS_104({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.savingBatch),
}));
const __VLS_106 = __VLS_105({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.savingBatch),
}, ...__VLS_functionalComponentArgsRest(__VLS_105));
let __VLS_108;
let __VLS_109;
let __VLS_110;
const __VLS_111 = {
    onClick: (__VLS_ctx.saveBatch)
};
__VLS_107.slots.default;
var __VLS_107;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "config-block hover-glow" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "block-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "block-bracket" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "block-bracket" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "form-label" },
    for: "cfg-log-level",
});
const __VLS_112 = {}.ElSelect;
/** @type {[typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, ]} */ ;
// @ts-ignore
const __VLS_113 = __VLS_asFunctionalComponent(__VLS_112, new __VLS_112({
    id: "cfg-log-level",
    modelValue: (__VLS_ctx.loggingForm.level),
    ...{ class: "form-input" },
}));
const __VLS_114 = __VLS_113({
    id: "cfg-log-level",
    modelValue: (__VLS_ctx.loggingForm.level),
    ...{ class: "form-input" },
}, ...__VLS_functionalComponentArgsRest(__VLS_113));
__VLS_115.slots.default;
for (const [lvl] of __VLS_getVForSourceType((__VLS_ctx.LOG_LEVEL_OPTIONS))) {
    const __VLS_116 = {}.ElOption;
    /** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
    // @ts-ignore
    const __VLS_117 = __VLS_asFunctionalComponent(__VLS_116, new __VLS_116({
        key: (lvl),
        label: (lvl),
        value: (lvl),
    }));
    const __VLS_118 = __VLS_117({
        key: (lvl),
        label: (lvl),
        value: (lvl),
    }, ...__VLS_functionalComponentArgsRest(__VLS_117));
}
var __VLS_115;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "form-label" },
    for: "cfg-req-log",
});
const __VLS_120 = {}.ElSwitch;
/** @type {[typeof __VLS_components.ElSwitch, typeof __VLS_components.elSwitch, ]} */ ;
// @ts-ignore
const __VLS_121 = __VLS_asFunctionalComponent(__VLS_120, new __VLS_120({
    id: "cfg-req-log",
    modelValue: (__VLS_ctx.loggingForm.enableRequestLog),
}));
const __VLS_122 = __VLS_121({
    id: "cfg-req-log",
    modelValue: (__VLS_ctx.loggingForm.enableRequestLog),
}, ...__VLS_functionalComponentArgsRest(__VLS_121));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "ai-actions" },
});
const __VLS_124 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_125 = __VLS_asFunctionalComponent(__VLS_124, new __VLS_124({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.savingLogging),
}));
const __VLS_126 = __VLS_125({
    ...{ 'onClick': {} },
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.savingLogging),
}, ...__VLS_functionalComponentArgsRest(__VLS_125));
let __VLS_128;
let __VLS_129;
let __VLS_130;
const __VLS_131 = {
    onClick: (__VLS_ctx.saveLogging)
};
__VLS_127.slots.default;
var __VLS_127;
var __VLS_55;
const __VLS_132 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_133 = __VLS_asFunctionalComponent(__VLS_132, new __VLS_132({
    label: "AI 服务",
    name: "ai",
}));
const __VLS_134 = __VLS_133({
    label: "AI 服务",
    name: "ai",
}, ...__VLS_functionalComponentArgsRest(__VLS_133));
__VLS_135.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "ai-section" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "preset-bar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "preset-tags" },
});
for (const [preset] of __VLS_getVForSourceType((__VLS_ctx.aiPresets))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ onClick: (...[$event]) => {
                __VLS_ctx.applyPreset(preset);
            } },
        key: (preset.key),
        ...{ class: "preset-tag" },
        ...{ class: ({ active: __VLS_ctx.aiForm.provider === preset.provider }) },
    });
    (preset.label);
}
if (__VLS_ctx.loadingAi) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-loading" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "ai-form" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-block hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "form-label" },
        for: "ai-base-url",
    });
    const __VLS_136 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_137 = __VLS_asFunctionalComponent(__VLS_136, new __VLS_136({
        id: "ai-base-url",
        modelValue: (__VLS_ctx.aiForm.baseUrl),
        placeholder: "https://api.openai.com/v1",
        ...{ class: "form-input" },
    }));
    const __VLS_138 = __VLS_137({
        id: "ai-base-url",
        modelValue: (__VLS_ctx.aiForm.baseUrl),
        placeholder: "https://api.openai.com/v1",
        ...{ class: "form-input" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_137));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "form-label" },
        for: "ai-api-key",
    });
    const __VLS_140 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_141 = __VLS_asFunctionalComponent(__VLS_140, new __VLS_140({
        id: "ai-api-key",
        modelValue: (__VLS_ctx.aiForm.apiKey),
        type: "password",
        showPassword: true,
        placeholder: "输入 API Key（****表示已设置）",
        ...{ class: "form-input" },
    }));
    const __VLS_142 = __VLS_141({
        id: "ai-api-key",
        modelValue: (__VLS_ctx.aiForm.apiKey),
        type: "password",
        showPassword: true,
        placeholder: "输入 API Key（****表示已设置）",
        ...{ class: "form-input" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_141));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "form-label" },
        for: "ai-model",
    });
    const __VLS_144 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_145 = __VLS_asFunctionalComponent(__VLS_144, new __VLS_144({
        id: "ai-model",
        modelValue: (__VLS_ctx.aiForm.model),
        placeholder: (__VLS_ctx.aiModelPlaceholder),
        ...{ class: "form-input" },
    }));
    const __VLS_146 = __VLS_145({
        id: "ai-model",
        modelValue: (__VLS_ctx.aiForm.model),
        placeholder: (__VLS_ctx.aiModelPlaceholder),
        ...{ class: "form-input" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_145));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "ai-actions" },
    });
    const __VLS_148 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_149 = __VLS_asFunctionalComponent(__VLS_148, new __VLS_148({
        ...{ 'onClick': {} },
        ...{ class: "neon-btn" },
        loading: (__VLS_ctx.testingAi),
    }));
    const __VLS_150 = __VLS_149({
        ...{ 'onClick': {} },
        ...{ class: "neon-btn" },
        loading: (__VLS_ctx.testingAi),
    }, ...__VLS_functionalComponentArgsRest(__VLS_149));
    let __VLS_152;
    let __VLS_153;
    let __VLS_154;
    const __VLS_155 = {
        onClick: (__VLS_ctx.testConnection)
    };
    __VLS_151.slots.default;
    var __VLS_151;
    const __VLS_156 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_157 = __VLS_asFunctionalComponent(__VLS_156, new __VLS_156({
        ...{ 'onClick': {} },
        ...{ class: "neon-btn-primary" },
        loading: (__VLS_ctx.savingAi),
    }));
    const __VLS_158 = __VLS_157({
        ...{ 'onClick': {} },
        ...{ class: "neon-btn-primary" },
        loading: (__VLS_ctx.savingAi),
    }, ...__VLS_functionalComponentArgsRest(__VLS_157));
    let __VLS_160;
    let __VLS_161;
    let __VLS_162;
    const __VLS_163 = {
        onClick: (__VLS_ctx.saveAiConfig)
    };
    __VLS_159.slots.default;
    var __VLS_159;
    const __VLS_164 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_165 = __VLS_asFunctionalComponent(__VLS_164, new __VLS_164({
        ...{ 'onClick': {} },
        ...{ class: "neon-btn" },
        loading: (__VLS_ctx.resettingAi),
        ...{ style: {} },
    }));
    const __VLS_166 = __VLS_165({
        ...{ 'onClick': {} },
        ...{ class: "neon-btn" },
        loading: (__VLS_ctx.resettingAi),
        ...{ style: {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_165));
    let __VLS_168;
    let __VLS_169;
    let __VLS_170;
    const __VLS_171 = {
        onClick: (__VLS_ctx.resetAiConfig)
    };
    __VLS_167.slots.default;
    var __VLS_167;
    if (__VLS_ctx.aiTestResult) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "test-result" },
            ...{ class: ({ ok: __VLS_ctx.aiTestResult.ok, fail: !__VLS_ctx.aiTestResult.ok }) },
        });
        const __VLS_172 = {}.ElIcon;
        /** @type {[typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, typeof __VLS_components.ElIcon, typeof __VLS_components.elIcon, ]} */ ;
        // @ts-ignore
        const __VLS_173 = __VLS_asFunctionalComponent(__VLS_172, new __VLS_172({
            ...{ class: "result-icon" },
        }));
        const __VLS_174 = __VLS_173({
            ...{ class: "result-icon" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_173));
        __VLS_175.slots.default;
        const __VLS_176 = ((__VLS_ctx.aiTestResult.ok ? __VLS_ctx.Check : __VLS_ctx.Close));
        // @ts-ignore
        const __VLS_177 = __VLS_asFunctionalComponent(__VLS_176, new __VLS_176({}));
        const __VLS_178 = __VLS_177({}, ...__VLS_functionalComponentArgsRest(__VLS_177));
        var __VLS_175;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "result-text" },
        });
        (__VLS_ctx.testResultText);
    }
    if (__VLS_ctx.aiConfig) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "ai-status" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "status-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "status-label" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "status-value" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (['key-status', __VLS_ctx.aiConfig.apiKeySet ? 'set' : 'unset']) },
        });
        (__VLS_ctx.aiConfig.apiKeySet ? 'Key 已设置' : 'Key 未设置');
        if (__VLS_ctx.aiConfig.apiKeyMasked) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "masked-key" },
            });
            (__VLS_ctx.aiConfig.apiKeyMasked);
        }
        if (!__VLS_ctx.aiConfig.apiKeySet) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "key-hint" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "hint-icon" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
            (__VLS_ctx.aiConfig.apiKeyRef);
        }
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "web-search-section" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "section-header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
if (__VLS_ctx.webSearchStatus) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: (['key-status', __VLS_ctx.webSearchStatus.apiKeySet ? 'set' : 'unset']) },
    });
    (__VLS_ctx.webSearchStatus.apiKeySet ? '已启用' : '未配置 Key');
}
if (__VLS_ctx.loadingWebSearch) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-loading" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "ai-form" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-block hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "form-label" },
        for: "ws-provider",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "preset-tags" },
        id: "ws-provider",
    });
    for (const [p] of __VLS_getVForSourceType((__VLS_ctx.WEB_SEARCH_PROVIDERS))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loadingWebSearch))
                        return;
                    __VLS_ctx.webSearchForm.provider = p.value;
                } },
            key: (p.value),
            ...{ class: "preset-tag" },
            ...{ class: ({ active: __VLS_ctx.webSearchForm.provider === p.value }) },
        });
        (p.label);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "form-label" },
        for: "ws-api-key",
    });
    const __VLS_180 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_181 = __VLS_asFunctionalComponent(__VLS_180, new __VLS_180({
        id: "ws-api-key",
        modelValue: (__VLS_ctx.webSearchForm.apiKey),
        type: "password",
        showPassword: true,
        placeholder: "输入联网搜索 API Key",
        ...{ class: "form-input" },
    }));
    const __VLS_182 = __VLS_181({
        id: "ws-api-key",
        modelValue: (__VLS_ctx.webSearchForm.apiKey),
        type: "password",
        showPassword: true,
        placeholder: "输入联网搜索 API Key",
        ...{ class: "form-input" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_181));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "form-label" },
        for: "ws-max-results",
    });
    const __VLS_184 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_185 = __VLS_asFunctionalComponent(__VLS_184, new __VLS_184({
        id: "ws-max-results",
        modelValue: (__VLS_ctx.webSearchForm.maxResults),
        modelModifiers: { number: true, },
        type: "number",
        min: (1),
        max: (20),
        ...{ class: "form-input" },
    }));
    const __VLS_186 = __VLS_185({
        id: "ws-max-results",
        modelValue: (__VLS_ctx.webSearchForm.maxResults),
        modelModifiers: { number: true, },
        type: "number",
        min: (1),
        max: (20),
        ...{ class: "form-input" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_185));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "ai-actions" },
    });
    const __VLS_188 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_189 = __VLS_asFunctionalComponent(__VLS_188, new __VLS_188({
        ...{ 'onClick': {} },
        ...{ class: "neon-btn-primary" },
        loading: (__VLS_ctx.savingWebSearch),
    }));
    const __VLS_190 = __VLS_189({
        ...{ 'onClick': {} },
        ...{ class: "neon-btn-primary" },
        loading: (__VLS_ctx.savingWebSearch),
    }, ...__VLS_functionalComponentArgsRest(__VLS_189));
    let __VLS_192;
    let __VLS_193;
    let __VLS_194;
    const __VLS_195 = {
        onClick: (__VLS_ctx.saveWebSearchConfig)
    };
    __VLS_191.slots.default;
    var __VLS_191;
    if (__VLS_ctx.webSearchStatus && !__VLS_ctx.webSearchStatus.apiKeySet) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "key-hint" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "hint-icon" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
        (__VLS_ctx.webSearchStatus.apiKeyRef);
    }
}
var __VLS_135;
const __VLS_196 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_197 = __VLS_asFunctionalComponent(__VLS_196, new __VLS_196({
    label: "工具配置",
    name: "tools",
}));
const __VLS_198 = __VLS_197({
    label: "工具配置",
    name: "tools",
}, ...__VLS_functionalComponentArgsRest(__VLS_197));
__VLS_199.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "tools-section" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "section-header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-hint" },
});
if (__VLS_ctx.loadingTools) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-loading" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "tools-form" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-block hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "form-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "form-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "preset-tags" },
        role: "radiogroup",
        'aria-label': "路由模式",
    });
    for (const [m] of __VLS_getVForSourceType((__VLS_ctx.ROUTER_MODE_OPTIONS))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loadingTools))
                        return;
                    __VLS_ctx.toolsForm.routerMode = m.value;
                } },
            key: (m.value),
            ...{ class: "preset-tag" },
            ...{ class: ({ active: __VLS_ctx.toolsForm.routerMode === m.value }) },
        });
        (m.label);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "router-desc" },
    });
    (__VLS_ctx.ROUTER_MODE_OPTIONS.find(m => m.value === __VLS_ctx.toolsForm.routerMode)?.desc);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-block hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "block-header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "mcp-mode-switch" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.loadingTools))
                    return;
                __VLS_ctx.mcpEditMode === 'json' && __VLS_ctx.switchToMcpFormMode();
            } },
        ...{ class: "preset-tag" },
        ...{ class: ({ active: __VLS_ctx.mcpEditMode === 'form' }) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.loadingTools))
                    return;
                __VLS_ctx.mcpEditMode === 'form' && __VLS_ctx.switchToMcpJsonMode();
            } },
        ...{ class: "preset-tag" },
        ...{ class: ({ active: __VLS_ctx.mcpEditMode === 'json' }) },
    });
    if (__VLS_ctx.mcpEditMode === 'form') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "block-header sub-header" },
        });
        const __VLS_200 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_201 = __VLS_asFunctionalComponent(__VLS_200, new __VLS_200({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "neon-btn" },
        }));
        const __VLS_202 = __VLS_201({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "neon-btn" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_201));
        let __VLS_204;
        let __VLS_205;
        let __VLS_206;
        const __VLS_207 = {
            onClick: (__VLS_ctx.addMcpServer)
        };
        __VLS_203.slots.default;
        var __VLS_203;
        if (__VLS_ctx.toolsForm.mcpServers.length === 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "empty-hint" },
            });
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "entry-list" },
            });
            for (const [server, idx] of __VLS_getVForSourceType((__VLS_ctx.toolsForm.mcpServers))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (idx),
                    ...{ class: "entry-item" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "entry-row" },
                });
                const __VLS_208 = {}.ElInput;
                /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
                // @ts-ignore
                const __VLS_209 = __VLS_asFunctionalComponent(__VLS_208, new __VLS_208({
                    modelValue: (server.name),
                    placeholder: "服务器名称（唯一）",
                    ...{ class: "form-input entry-name" },
                }));
                const __VLS_210 = __VLS_209({
                    modelValue: (server.name),
                    placeholder: "服务器名称（唯一）",
                    ...{ class: "form-input entry-name" },
                }, ...__VLS_functionalComponentArgsRest(__VLS_209));
                const __VLS_212 = {}.ElSelect;
                /** @type {[typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, ]} */ ;
                // @ts-ignore
                const __VLS_213 = __VLS_asFunctionalComponent(__VLS_212, new __VLS_212({
                    modelValue: (server.transport),
                    ...{ class: "form-input entry-transport" },
                    placeholder: "传输方式",
                }));
                const __VLS_214 = __VLS_213({
                    modelValue: (server.transport),
                    ...{ class: "form-input entry-transport" },
                    placeholder: "传输方式",
                }, ...__VLS_functionalComponentArgsRest(__VLS_213));
                __VLS_215.slots.default;
                for (const [t] of __VLS_getVForSourceType((__VLS_ctx.MCP_TRANSPORT_OPTIONS))) {
                    const __VLS_216 = {}.ElOption;
                    /** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
                    // @ts-ignore
                    const __VLS_217 = __VLS_asFunctionalComponent(__VLS_216, new __VLS_216({
                        key: (t.value),
                        label: (t.label),
                        value: (t.value),
                    }));
                    const __VLS_218 = __VLS_217({
                        key: (t.value),
                        label: (t.label),
                        value: (t.value),
                    }, ...__VLS_functionalComponentArgsRest(__VLS_217));
                }
                var __VLS_215;
                const __VLS_220 = {}.ElSwitch;
                /** @type {[typeof __VLS_components.ElSwitch, typeof __VLS_components.elSwitch, ]} */ ;
                // @ts-ignore
                const __VLS_221 = __VLS_asFunctionalComponent(__VLS_220, new __VLS_220({
                    modelValue: (server.enabled),
                }));
                const __VLS_222 = __VLS_221({
                    modelValue: (server.enabled),
                }, ...__VLS_functionalComponentArgsRest(__VLS_221));
                const __VLS_224 = {}.ElButton;
                /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
                // @ts-ignore
                const __VLS_225 = __VLS_asFunctionalComponent(__VLS_224, new __VLS_224({
                    ...{ 'onClick': {} },
                    size: "small",
                    ...{ class: "neon-btn-danger" },
                }));
                const __VLS_226 = __VLS_225({
                    ...{ 'onClick': {} },
                    size: "small",
                    ...{ class: "neon-btn-danger" },
                }, ...__VLS_functionalComponentArgsRest(__VLS_225));
                let __VLS_228;
                let __VLS_229;
                let __VLS_230;
                const __VLS_231 = {
                    onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loadingTools))
                            return;
                        if (!(__VLS_ctx.mcpEditMode === 'form'))
                            return;
                        if (!!(__VLS_ctx.toolsForm.mcpServers.length === 0))
                            return;
                        __VLS_ctx.removeMcpServer(idx);
                    }
                };
                __VLS_227.slots.default;
                var __VLS_227;
                if (server.transport === 'stdio') {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                        ...{ class: "entry-row" },
                    });
                    const __VLS_232 = {}.ElInput;
                    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
                    // @ts-ignore
                    const __VLS_233 = __VLS_asFunctionalComponent(__VLS_232, new __VLS_232({
                        modelValue: (server.command),
                        placeholder: "command（如 npx）",
                        ...{ class: "form-input" },
                    }));
                    const __VLS_234 = __VLS_233({
                        modelValue: (server.command),
                        placeholder: "command（如 npx）",
                        ...{ class: "form-input" },
                    }, ...__VLS_functionalComponentArgsRest(__VLS_233));
                    const __VLS_236 = {}.ElInput;
                    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
                    // @ts-ignore
                    const __VLS_237 = __VLS_asFunctionalComponent(__VLS_236, new __VLS_236({
                        ...{ 'onUpdate:modelValue': {} },
                        modelValue: (server.args?.join(' ') ?? ''),
                        placeholder: "args（空格分隔）",
                        ...{ class: "form-input" },
                    }));
                    const __VLS_238 = __VLS_237({
                        ...{ 'onUpdate:modelValue': {} },
                        modelValue: (server.args?.join(' ') ?? ''),
                        placeholder: "args（空格分隔）",
                        ...{ class: "form-input" },
                    }, ...__VLS_functionalComponentArgsRest(__VLS_237));
                    let __VLS_240;
                    let __VLS_241;
                    let __VLS_242;
                    const __VLS_243 = {
                        'onUpdate:modelValue': ((val) => server.args = val.split(/\s+/).filter(Boolean))
                    };
                    var __VLS_239;
                }
                else {
                    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                        ...{ class: "entry-row" },
                    });
                    const __VLS_244 = {}.ElInput;
                    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
                    // @ts-ignore
                    const __VLS_245 = __VLS_asFunctionalComponent(__VLS_244, new __VLS_244({
                        modelValue: (server.url),
                        placeholder: "url（如 https://example.com/mcp）",
                        ...{ class: "form-input" },
                    }));
                    const __VLS_246 = __VLS_245({
                        modelValue: (server.url),
                        placeholder: "url（如 https://example.com/mcp）",
                        ...{ class: "form-input" },
                    }, ...__VLS_functionalComponentArgsRest(__VLS_245));
                }
            }
        }
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mcp-json-hint" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({
            ...{ class: "mcp-json-example" },
        });
        const __VLS_248 = {}.ElInput;
        /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
        // @ts-ignore
        const __VLS_249 = __VLS_asFunctionalComponent(__VLS_248, new __VLS_248({
            modelValue: (__VLS_ctx.mcpJsonText),
            type: "textarea",
            rows: (14),
            resize: "none",
            ...{ class: "mcp-json-editor" },
            placeholder: '{"mcpServers": {}}',
        }));
        const __VLS_250 = __VLS_249({
            modelValue: (__VLS_ctx.mcpJsonText),
            type: "textarea",
            rows: (14),
            resize: "none",
            ...{ class: "mcp-json-editor" },
            placeholder: '{"mcpServers": {}}',
        }, ...__VLS_functionalComponentArgsRest(__VLS_249));
        if (__VLS_ctx.mcpJsonError) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "mcp-json-error" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "hint-icon" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.mcpJsonError);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "mcp-json-actions" },
        });
        const __VLS_252 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_253 = __VLS_asFunctionalComponent(__VLS_252, new __VLS_252({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "neon-btn-primary" },
        }));
        const __VLS_254 = __VLS_253({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "neon-btn-primary" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_253));
        let __VLS_256;
        let __VLS_257;
        let __VLS_258;
        const __VLS_259 = {
            onClick: (__VLS_ctx.applyMcpJson)
        };
        __VLS_255.slots.default;
        var __VLS_255;
        const __VLS_260 = {}.ElButton;
        /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
        // @ts-ignore
        const __VLS_261 = __VLS_asFunctionalComponent(__VLS_260, new __VLS_260({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "neon-btn" },
        }));
        const __VLS_262 = __VLS_261({
            ...{ 'onClick': {} },
            size: "small",
            ...{ class: "neon-btn" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_261));
        let __VLS_264;
        let __VLS_265;
        let __VLS_266;
        const __VLS_267 = {
            onClick: (__VLS_ctx.switchToMcpFormMode)
        };
        __VLS_263.slots.default;
        var __VLS_263;
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-block hover-glow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "block-header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    const __VLS_268 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_269 = __VLS_asFunctionalComponent(__VLS_268, new __VLS_268({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn" },
    }));
    const __VLS_270 = __VLS_269({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_269));
    let __VLS_272;
    let __VLS_273;
    let __VLS_274;
    const __VLS_275 = {
        onClick: (__VLS_ctx.addCliTool)
    };
    __VLS_271.slots.default;
    var __VLS_271;
    if (__VLS_ctx.toolsForm.cliTools.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "empty-hint" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "entry-list" },
        });
        for (const [tool, idx] of __VLS_getVForSourceType((__VLS_ctx.toolsForm.cliTools))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (idx),
                ...{ class: "entry-item" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "entry-row" },
            });
            const __VLS_276 = {}.ElInput;
            /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
            // @ts-ignore
            const __VLS_277 = __VLS_asFunctionalComponent(__VLS_276, new __VLS_276({
                modelValue: (tool.name),
                placeholder: "工具名称（唯一）",
                ...{ class: "form-input entry-name" },
            }));
            const __VLS_278 = __VLS_277({
                modelValue: (tool.name),
                placeholder: "工具名称（唯一）",
                ...{ class: "form-input entry-name" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_277));
            const __VLS_280 = {}.ElInput;
            /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
            // @ts-ignore
            const __VLS_281 = __VLS_asFunctionalComponent(__VLS_280, new __VLS_280({
                modelValue: (tool.command),
                placeholder: "command（如 ping）",
                ...{ class: "form-input" },
            }));
            const __VLS_282 = __VLS_281({
                modelValue: (tool.command),
                placeholder: "command（如 ping）",
                ...{ class: "form-input" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_281));
            const __VLS_284 = {}.ElSwitch;
            /** @type {[typeof __VLS_components.ElSwitch, typeof __VLS_components.elSwitch, ]} */ ;
            // @ts-ignore
            const __VLS_285 = __VLS_asFunctionalComponent(__VLS_284, new __VLS_284({
                modelValue: (tool.enabled),
            }));
            const __VLS_286 = __VLS_285({
                modelValue: (tool.enabled),
            }, ...__VLS_functionalComponentArgsRest(__VLS_285));
            const __VLS_288 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_289 = __VLS_asFunctionalComponent(__VLS_288, new __VLS_288({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn-danger" },
            }));
            const __VLS_290 = __VLS_289({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn-danger" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_289));
            let __VLS_292;
            let __VLS_293;
            let __VLS_294;
            const __VLS_295 = {
                onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loadingTools))
                        return;
                    if (!!(__VLS_ctx.toolsForm.cliTools.length === 0))
                        return;
                    __VLS_ctx.removeCliTool(idx);
                }
            };
            __VLS_291.slots.default;
            var __VLS_291;
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "entry-row" },
            });
            const __VLS_296 = {}.ElInput;
            /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
            // @ts-ignore
            const __VLS_297 = __VLS_asFunctionalComponent(__VLS_296, new __VLS_296({
                modelValue: (tool.argsTemplate),
                placeholder: 'argsTemplate（如 "{host} -n 4"，{host} 为占位符）',
                ...{ class: "form-input" },
            }));
            const __VLS_298 = __VLS_297({
                modelValue: (tool.argsTemplate),
                placeholder: 'argsTemplate（如 "{host} -n 4"，{host} 为占位符）',
                ...{ class: "form-input" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_297));
            const __VLS_300 = {}.ElInput;
            /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
            // @ts-ignore
            const __VLS_301 = __VLS_asFunctionalComponent(__VLS_300, new __VLS_300({
                modelValue: (tool.timeoutMs),
                modelModifiers: { number: true, },
                type: "number",
                min: (1000),
                step: (1000),
                placeholder: "超时（ms）",
                ...{ class: "form-input entry-timeout" },
            }));
            const __VLS_302 = __VLS_301({
                modelValue: (tool.timeoutMs),
                modelModifiers: { number: true, },
                type: "number",
                min: (1000),
                step: (1000),
                placeholder: "超时（ms）",
                ...{ class: "form-input entry-timeout" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_301));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "entry-row" },
            });
            const __VLS_304 = {}.ElInput;
            /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
            // @ts-ignore
            const __VLS_305 = __VLS_asFunctionalComponent(__VLS_304, new __VLS_304({
                modelValue: (tool.description),
                placeholder: "工具描述（供 LLM 决策使用）",
                ...{ class: "form-input" },
            }));
            const __VLS_306 = __VLS_305({
                modelValue: (tool.description),
                placeholder: "工具描述（供 LLM 决策使用）",
                ...{ class: "form-input" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_305));
            const __VLS_308 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_309 = __VLS_asFunctionalComponent(__VLS_308, new __VLS_308({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn" },
                loading: (__VLS_ctx.testingCli),
            }));
            const __VLS_310 = __VLS_309({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn" },
                loading: (__VLS_ctx.testingCli),
            }, ...__VLS_functionalComponentArgsRest(__VLS_309));
            let __VLS_312;
            let __VLS_313;
            let __VLS_314;
            const __VLS_315 = {
                onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loadingTools))
                        return;
                    if (!!(__VLS_ctx.toolsForm.cliTools.length === 0))
                        return;
                    __VLS_ctx.testCliTool(idx);
                }
            };
            __VLS_311.slots.default;
            var __VLS_311;
        }
    }
    if (__VLS_ctx.cliTestResult) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "cli-test-result" },
            ...{ class: ({ ok: __VLS_ctx.cliTestResult.ok, fail: !__VLS_ctx.cliTestResult.ok }) },
        });
        if (__VLS_ctx.cliTestResult.output) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({});
            (__VLS_ctx.cliTestResult.output);
        }
        if (__VLS_ctx.cliTestResult.error) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.pre, __VLS_intrinsicElements.pre)({
                ...{ class: "error-output" },
            });
            (__VLS_ctx.cliTestResult.error);
        }
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "config-block hover-glow" },
        ...{ class: ({ disabled: __VLS_ctx.toolsForm.routerMode !== 'keyword' }) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "block-header" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
        ...{ class: "block-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "block-bracket" },
    });
    const __VLS_316 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_317 = __VLS_asFunctionalComponent(__VLS_316, new __VLS_316({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn" },
        disabled: (__VLS_ctx.toolsForm.routerMode !== 'keyword'),
    }));
    const __VLS_318 = __VLS_317({
        ...{ 'onClick': {} },
        size: "small",
        ...{ class: "neon-btn" },
        disabled: (__VLS_ctx.toolsForm.routerMode !== 'keyword'),
    }, ...__VLS_functionalComponentArgsRest(__VLS_317));
    let __VLS_320;
    let __VLS_321;
    let __VLS_322;
    const __VLS_323 = {
        onClick: (__VLS_ctx.addScene)
    };
    __VLS_319.slots.default;
    var __VLS_319;
    if (__VLS_ctx.toolsForm.routerMode !== 'keyword') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "empty-hint" },
        });
    }
    else if (__VLS_ctx.toolsForm.scenes.length === 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "empty-hint" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "entry-list" },
        });
        for (const [scene, idx] of __VLS_getVForSourceType((__VLS_ctx.toolsForm.scenes))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (idx),
                ...{ class: "entry-item" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "entry-row" },
            });
            const __VLS_324 = {}.ElInput;
            /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
            // @ts-ignore
            const __VLS_325 = __VLS_asFunctionalComponent(__VLS_324, new __VLS_324({
                modelValue: (scene.name),
                placeholder: "场景名称（如 network_diag）",
                ...{ class: "form-input entry-name" },
            }));
            const __VLS_326 = __VLS_325({
                modelValue: (scene.name),
                placeholder: "场景名称（如 network_diag）",
                ...{ class: "form-input entry-name" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_325));
            const __VLS_328 = {}.ElSwitch;
            /** @type {[typeof __VLS_components.ElSwitch, typeof __VLS_components.elSwitch, ]} */ ;
            // @ts-ignore
            const __VLS_329 = __VLS_asFunctionalComponent(__VLS_328, new __VLS_328({
                modelValue: (scene.enabled),
            }));
            const __VLS_330 = __VLS_329({
                modelValue: (scene.enabled),
            }, ...__VLS_functionalComponentArgsRest(__VLS_329));
            const __VLS_332 = {}.ElButton;
            /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
            // @ts-ignore
            const __VLS_333 = __VLS_asFunctionalComponent(__VLS_332, new __VLS_332({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn-danger" },
            }));
            const __VLS_334 = __VLS_333({
                ...{ 'onClick': {} },
                size: "small",
                ...{ class: "neon-btn-danger" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_333));
            let __VLS_336;
            let __VLS_337;
            let __VLS_338;
            const __VLS_339 = {
                onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loadingTools))
                        return;
                    if (!!(__VLS_ctx.toolsForm.routerMode !== 'keyword'))
                        return;
                    if (!!(__VLS_ctx.toolsForm.scenes.length === 0))
                        return;
                    __VLS_ctx.removeScene(idx);
                }
            };
            __VLS_335.slots.default;
            var __VLS_335;
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "entry-row" },
            });
            const __VLS_340 = {}.ElInput;
            /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
            // @ts-ignore
            const __VLS_341 = __VLS_asFunctionalComponent(__VLS_340, new __VLS_340({
                ...{ 'onUpdate:modelValue': {} },
                modelValue: (scene.keywords.join(', ')),
                placeholder: '关键词（逗号分隔，如 "ping, 网络, 延迟"）',
                ...{ class: "form-input" },
            }));
            const __VLS_342 = __VLS_341({
                ...{ 'onUpdate:modelValue': {} },
                modelValue: (scene.keywords.join(', ')),
                placeholder: '关键词（逗号分隔，如 "ping, 网络, 延迟"）',
                ...{ class: "form-input" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_341));
            let __VLS_344;
            let __VLS_345;
            let __VLS_346;
            const __VLS_347 = {
                'onUpdate:modelValue': ((val) => scene.keywords = val.split(',').map(k => k.trim()).filter(Boolean))
            };
            var __VLS_343;
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "entry-row" },
            });
            const __VLS_348 = {}.ElInput;
            /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
            // @ts-ignore
            const __VLS_349 = __VLS_asFunctionalComponent(__VLS_348, new __VLS_348({
                ...{ 'onUpdate:modelValue': {} },
                modelValue: (scene.tools.join(', ')),
                placeholder: '工具名（逗号分隔，如 "ping, nslookup"）',
                ...{ class: "form-input" },
            }));
            const __VLS_350 = __VLS_349({
                ...{ 'onUpdate:modelValue': {} },
                modelValue: (scene.tools.join(', ')),
                placeholder: '工具名（逗号分隔，如 "ping, nslookup"）',
                ...{ class: "form-input" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_349));
            let __VLS_352;
            let __VLS_353;
            let __VLS_354;
            const __VLS_355 = {
                'onUpdate:modelValue': ((val) => scene.tools = val.split(',').map(t => t.trim()).filter(Boolean))
            };
            var __VLS_351;
        }
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "ai-actions" },
    });
    const __VLS_356 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_357 = __VLS_asFunctionalComponent(__VLS_356, new __VLS_356({
        ...{ 'onClick': {} },
        ...{ class: "neon-btn-primary" },
        loading: (__VLS_ctx.savingTools),
    }));
    const __VLS_358 = __VLS_357({
        ...{ 'onClick': {} },
        ...{ class: "neon-btn-primary" },
        loading: (__VLS_ctx.savingTools),
    }, ...__VLS_functionalComponentArgsRest(__VLS_357));
    let __VLS_360;
    let __VLS_361;
    let __VLS_362;
    const __VLS_363 = {
        onClick: (__VLS_ctx.saveToolsConfig)
    };
    __VLS_359.slots.default;
    var __VLS_359;
}
var __VLS_199;
const __VLS_364 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_365 = __VLS_asFunctionalComponent(__VLS_364, new __VLS_364({
    label: "界面主题",
    name: "theme",
}));
const __VLS_366 = __VLS_365({
    label: "界面主题",
    name: "theme",
}, ...__VLS_functionalComponentArgsRest(__VLS_365));
__VLS_367.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "theme-section" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "theme-copy" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-tag" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
/** @type {[typeof ThemeSwitcher, ]} */ ;
// @ts-ignore
const __VLS_368 = __VLS_asFunctionalComponent(ThemeSwitcher, new ThemeSwitcher({
    embedded: true,
}));
const __VLS_369 = __VLS_368({
    embedded: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_368));
var __VLS_367;
const __VLS_371 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_372 = __VLS_asFunctionalComponent(__VLS_371, new __VLS_371({
    label: "QQ 导入",
    name: "qq",
}));
const __VLS_373 = __VLS_372({
    label: "QQ 导入",
    name: "qq",
}, ...__VLS_functionalComponentArgsRest(__VLS_372));
__VLS_374.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "qq-section" },
});
__VLS_asFunctionalDirective(__VLS_directives.vLoading)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.loadingQqConfig) }, null, null);
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "section-header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-tag" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
const __VLS_375 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_376 = __VLS_asFunctionalComponent(__VLS_375, new __VLS_375({
    ...{ 'onClick': {} },
    size: "small",
}));
const __VLS_377 = __VLS_376({
    ...{ 'onClick': {} },
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_376));
let __VLS_379;
let __VLS_380;
let __VLS_381;
const __VLS_382 = {
    onClick: (__VLS_ctx.resetQqConfig)
};
__VLS_378.slots.default;
var __VLS_378;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "qq-block" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({
    ...{ class: "block-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "noise-rules" },
});
for (const [rule] of __VLS_getVForSourceType((__VLS_ctx.NOISE_RULE_META))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: (rule.key),
        ...{ class: "noise-rule-item" },
    });
    const __VLS_383 = {}.ElSwitch;
    /** @type {[typeof __VLS_components.ElSwitch, typeof __VLS_components.elSwitch, ]} */ ;
    // @ts-ignore
    const __VLS_384 = __VLS_asFunctionalComponent(__VLS_383, new __VLS_383({
        modelValue: (__VLS_ctx.qqConfig.noise_rules[rule.key]),
    }));
    const __VLS_385 = __VLS_384({
        modelValue: (__VLS_ctx.qqConfig.noise_rules[rule.key]),
    }, ...__VLS_functionalComponentArgsRest(__VLS_384));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "rule-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.code, __VLS_intrinsicElements.code)({});
    (rule.key);
    (rule.label);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "qq-block" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({
    ...{ class: "block-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "block-hint" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "privacy-patterns" },
});
for (const [p] of __VLS_getVForSourceType((__VLS_ctx.PRIVACY_PATTERN_META))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: (p.key),
        ...{ class: "pattern-row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "pattern-label" },
    });
    (p.label);
    const __VLS_387 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_388 = __VLS_asFunctionalComponent(__VLS_387, new __VLS_387({
        modelValue: (__VLS_ctx.qqConfig.privacy_patterns[p.key]),
        placeholder: (p.placeholder),
        size: "small",
        ...{ class: "pattern-input" },
        ...{ class: ({
                'pattern-valid': __VLS_ctx.patternValidation[p.key] === true,
                'pattern-invalid': __VLS_ctx.patternValidation[p.key] === false
            }) },
    }));
    const __VLS_389 = __VLS_388({
        modelValue: (__VLS_ctx.qqConfig.privacy_patterns[p.key]),
        placeholder: (p.placeholder),
        size: "small",
        ...{ class: "pattern-input" },
        ...{ class: ({
                'pattern-valid': __VLS_ctx.patternValidation[p.key] === true,
                'pattern-invalid': __VLS_ctx.patternValidation[p.key] === false
            }) },
    }, ...__VLS_functionalComponentArgsRest(__VLS_388));
    if (__VLS_ctx.patternValidation[p.key] === true) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "pattern-status valid" },
            title: "regex valid",
        });
    }
    else if (__VLS_ctx.patternValidation[p.key] === false) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "pattern-status invalid" },
            title: "regex syntax error",
        });
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "qq-block" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({
    ...{ class: "block-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "extract-grid" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
const __VLS_391 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_392 = __VLS_asFunctionalComponent(__VLS_391, new __VLS_391({
    modelValue: (__VLS_ctx.qqConfig.extract_model),
    placeholder: "glm-4-plus",
    size: "small",
}));
const __VLS_393 = __VLS_392({
    modelValue: (__VLS_ctx.qqConfig.extract_model),
    placeholder: "glm-4-plus",
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_392));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
const __VLS_395 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_396 = __VLS_asFunctionalComponent(__VLS_395, new __VLS_395({
    modelValue: (__VLS_ctx.qqConfig.extract_base_url),
    placeholder: "留空则回退到全局 llm.baseUrl",
    size: "small",
}));
const __VLS_397 = __VLS_396({
    modelValue: (__VLS_ctx.qqConfig.extract_base_url),
    placeholder: "留空则回退到全局 llm.baseUrl",
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_396));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
const __VLS_399 = {}.ElInputNumber;
/** @type {[typeof __VLS_components.ElInputNumber, typeof __VLS_components.elInputNumber, ]} */ ;
// @ts-ignore
const __VLS_400 = __VLS_asFunctionalComponent(__VLS_399, new __VLS_399({
    modelValue: (__VLS_ctx.qqConfig.extract_token_budget),
    min: (0),
    max: (1000000),
    step: (10000),
    size: "small",
}));
const __VLS_401 = __VLS_400({
    modelValue: (__VLS_ctx.qqConfig.extract_token_budget),
    min: (0),
    max: (1000000),
    step: (10000),
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_400));
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "form-hint" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "qq-block" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({
    ...{ class: "block-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "extract-grid" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
const __VLS_403 = {}.ElInputNumber;
/** @type {[typeof __VLS_components.ElInputNumber, typeof __VLS_components.elInputNumber, ]} */ ;
// @ts-ignore
const __VLS_404 = __VLS_asFunctionalComponent(__VLS_403, new __VLS_403({
    modelValue: (__VLS_ctx.qqConfig.max_batch_size),
    min: (1),
    max: (200),
    size: "small",
}));
const __VLS_405 = __VLS_404({
    modelValue: (__VLS_ctx.qqConfig.max_batch_size),
    min: (1),
    max: (200),
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_404));
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "form-hint" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "form-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
const __VLS_407 = {}.ElInputNumber;
/** @type {[typeof __VLS_components.ElInputNumber, typeof __VLS_components.elInputNumber, ]} */ ;
// @ts-ignore
const __VLS_408 = __VLS_asFunctionalComponent(__VLS_407, new __VLS_407({
    modelValue: (__VLS_ctx.qqConfig.chunk_threshold),
    min: (50),
    max: (2000),
    step: (50),
    size: "small",
}));
const __VLS_409 = __VLS_408({
    modelValue: (__VLS_ctx.qqConfig.chunk_threshold),
    min: (50),
    max: (2000),
    step: (50),
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_408));
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "form-hint" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "qq-actions" },
});
if (__VLS_ctx.qqConfigDirty) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "dirty-indicator" },
    });
}
const __VLS_411 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_412 = __VLS_asFunctionalComponent(__VLS_411, new __VLS_411({
    ...{ 'onClick': {} },
    type: "primary",
    loading: (__VLS_ctx.savingQqConfig),
    disabled: (!__VLS_ctx.qqConfigDirty),
}));
const __VLS_413 = __VLS_412({
    ...{ 'onClick': {} },
    type: "primary",
    loading: (__VLS_ctx.savingQqConfig),
    disabled: (!__VLS_ctx.qqConfigDirty),
}, ...__VLS_functionalComponentArgsRest(__VLS_412));
let __VLS_415;
let __VLS_416;
let __VLS_417;
const __VLS_418 = {
    onClick: (__VLS_ctx.saveQqConfigForm)
};
__VLS_414.slots.default;
var __VLS_414;
var __VLS_374;
const __VLS_419 = {}.ElTabPane;
/** @type {[typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, typeof __VLS_components.ElTabPane, typeof __VLS_components.elTabPane, ]} */ ;
// @ts-ignore
const __VLS_420 = __VLS_asFunctionalComponent(__VLS_419, new __VLS_419({
    label: "Prompt IDE",
    name: "prompts",
}));
const __VLS_421 = __VLS_420({
    label: "Prompt IDE",
    name: "prompts",
}, ...__VLS_functionalComponentArgsRest(__VLS_420));
__VLS_422.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "prompt-ide-section" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "prompt-list-container" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "section-header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
if (__VLS_ctx.loadingPrompts) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-loading" },
    });
}
else if (__VLS_ctx.promptFiles.length === 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "section-empty" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "prompt-list" },
    });
    for (const [file] of __VLS_getVForSourceType((__VLS_ctx.promptFiles))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loadingPrompts))
                        return;
                    if (!!(__VLS_ctx.promptFiles.length === 0))
                        return;
                    __VLS_ctx.selectPrompt(file.name);
                } },
            key: (file.name),
            ...{ class: "prompt-item" },
            ...{ class: ({ active: __VLS_ctx.currentPromptName === file.name }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "prompt-label" },
        });
        (file.label);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "prompt-desc" },
        });
        (file.description);
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "prompt-editor-container" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "action-bar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "prompt-meta" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({
    ...{ class: "prompt-title" },
});
(__VLS_ctx.currentPromptMeta?.label || '未选择');
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "prompt-desc" },
});
(__VLS_ctx.currentPromptMeta?.description || '请从左侧选择一个 prompt 文件');
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "actions" },
});
if (__VLS_ctx.promptDirty) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "dirty-indicator" },
    });
}
const __VLS_423 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_424 = __VLS_asFunctionalComponent(__VLS_423, new __VLS_423({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.savingPrompt),
    disabled: (!__VLS_ctx.currentPromptName || !__VLS_ctx.promptDirty),
}));
const __VLS_425 = __VLS_424({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    loading: (__VLS_ctx.savingPrompt),
    disabled: (!__VLS_ctx.currentPromptName || !__VLS_ctx.promptDirty),
}, ...__VLS_functionalComponentArgsRest(__VLS_424));
let __VLS_427;
let __VLS_428;
let __VLS_429;
const __VLS_430 = {
    onClick: (__VLS_ctx.savePrompt)
};
__VLS_426.slots.default;
var __VLS_426;
if (!__VLS_ctx.currentPromptName) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "editor-placeholder" },
    });
}
else {
    const __VLS_431 = {}.ElInput;
    /** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
    // @ts-ignore
    const __VLS_432 = __VLS_asFunctionalComponent(__VLS_431, new __VLS_431({
        modelValue: (__VLS_ctx.promptContent),
        type: "textarea",
        rows: (16),
        resize: "none",
        ...{ class: "schema-editor" },
        placeholder: "prompt 内容",
    }));
    const __VLS_433 = __VLS_432({
        modelValue: (__VLS_ctx.promptContent),
        type: "textarea",
        rows: (16),
        resize: "none",
        ...{ class: "schema-editor" },
        placeholder: "prompt 内容",
    }, ...__VLS_functionalComponentArgsRest(__VLS_432));
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "prompt-preview-container" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "action-bar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "preview-content" },
});
/** @type {[typeof MarkdownRenderer, ]} */ ;
// @ts-ignore
const __VLS_435 = __VLS_asFunctionalComponent(MarkdownRenderer, new MarkdownRenderer({
    content: (__VLS_ctx.promptContent),
}));
const __VLS_436 = __VLS_435({
    content: (__VLS_ctx.promptContent),
}, ...__VLS_functionalComponentArgsRest(__VLS_435));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "test-run-section" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "section-header" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "section-desc" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "test-actions" },
});
const __VLS_438 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_439 = __VLS_asFunctionalComponent(__VLS_438, new __VLS_438({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    disabled: (__VLS_ctx.testEvents.length === 0 && __VLS_ctx.testPages.length === 0 && !__VLS_ctx.testError),
}));
const __VLS_440 = __VLS_439({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn" },
    disabled: (__VLS_ctx.testEvents.length === 0 && __VLS_ctx.testPages.length === 0 && !__VLS_ctx.testError),
}, ...__VLS_functionalComponentArgsRest(__VLS_439));
let __VLS_442;
let __VLS_443;
let __VLS_444;
const __VLS_445 = {
    onClick: (__VLS_ctx.clearTestResult)
};
__VLS_441.slots.default;
var __VLS_441;
const __VLS_446 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_447 = __VLS_asFunctionalComponent(__VLS_446, new __VLS_446({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.testRunning),
    disabled: (!__VLS_ctx.currentPromptName || __VLS_ctx.currentPromptName !== 'compile.md'),
}));
const __VLS_448 = __VLS_447({
    ...{ 'onClick': {} },
    size: "small",
    ...{ class: "neon-btn-primary" },
    loading: (__VLS_ctx.testRunning),
    disabled: (!__VLS_ctx.currentPromptName || __VLS_ctx.currentPromptName !== 'compile.md'),
}, ...__VLS_functionalComponentArgsRest(__VLS_447));
let __VLS_450;
let __VLS_451;
let __VLS_452;
const __VLS_453 = {
    onClick: (...[$event]) => {
        __VLS_ctx.testRunning ? __VLS_ctx.stopTest() : __VLS_ctx.runTest();
    }
};
__VLS_449.slots.default;
(__VLS_ctx.testRunning ? '停止' : '开始试运行');
var __VLS_449;
const __VLS_454 = {}.ElInput;
/** @type {[typeof __VLS_components.ElInput, typeof __VLS_components.elInput, ]} */ ;
// @ts-ignore
const __VLS_455 = __VLS_asFunctionalComponent(__VLS_454, new __VLS_454({
    modelValue: (__VLS_ctx.testInput),
    type: "textarea",
    rows: (4),
    resize: "none",
    ...{ class: "test-input" },
    placeholder: "输入测试资料（将作为原始内容传入 compile）",
    disabled: (__VLS_ctx.testRunning),
}));
const __VLS_456 = __VLS_455({
    modelValue: (__VLS_ctx.testInput),
    type: "textarea",
    rows: (4),
    resize: "none",
    ...{ class: "test-input" },
    placeholder: "输入测试资料（将作为原始内容传入 compile）",
    disabled: (__VLS_ctx.testRunning),
}, ...__VLS_functionalComponentArgsRest(__VLS_455));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "test-results" },
});
if (__VLS_ctx.testError) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "test-error" },
    });
    (__VLS_ctx.testError);
}
else if (__VLS_ctx.testRunning) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "test-running" },
    });
}
else if (__VLS_ctx.testEvents.length === 0 && __VLS_ctx.testPages.length === 0) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "test-empty" },
    });
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "test-events" },
    });
    for (const [event, idx] of __VLS_getVForSourceType((__VLS_ctx.testEvents))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (idx),
            ...{ class: "event-item" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "event-step" },
        });
        (event.step);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "event-message" },
        });
        (event.message);
    }
    if (__VLS_ctx.testPages.length > 0) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "test-pages" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "pages-title" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "pages-list" },
        });
        for (const [page] of __VLS_getVForSourceType((__VLS_ctx.testPages))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                key: (page.path),
                ...{ class: "page-item" },
            });
            (page.title);
            (page.path);
        }
    }
}
var __VLS_422;
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['config-page']} */ ;
/** @type {__VLS_StyleScopedClasses['glass-card']} */ ;
/** @type {__VLS_StyleScopedClasses['config-card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-deco']} */ ;
/** @type {__VLS_StyleScopedClasses['config-head']} */ ;
/** @type {__VLS_StyleScopedClasses['head-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-title']} */ ;
/** @type {__VLS_StyleScopedClasses['grad-text']} */ ;
/** @type {__VLS_StyleScopedClasses['head-tip']} */ ;
/** @type {__VLS_StyleScopedClasses['config-tabs']} */ ;
/** @type {__VLS_StyleScopedClasses['schema-section']} */ ;
/** @type {__VLS_StyleScopedClasses['action-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['section-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['schema-editor']} */ ;
/** @type {__VLS_StyleScopedClasses['schema-view']} */ ;
/** @type {__VLS_StyleScopedClasses['history-section']} */ ;
/** @type {__VLS_StyleScopedClasses['history-head']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['history-disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['history-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-list']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-item']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-hash']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-info']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-message']} */ ;
/** @type {__VLS_StyleScopedClasses['commit-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-section']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-result']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-lines']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-line']} */ ;
/** @type {__VLS_StyleScopedClasses['line-prefix']} */ ;
/** @type {__VLS_StyleScopedClasses['line-content']} */ ;
/** @type {__VLS_StyleScopedClasses['config-section']} */ ;
/** @type {__VLS_StyleScopedClasses['reload-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['reload-result']} */ ;
/** @type {__VLS_StyleScopedClasses['reload-applied']} */ ;
/** @type {__VLS_StyleScopedClasses['applied-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['applied-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['applied-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['applied-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['reload-warn']} */ ;
/** @type {__VLS_StyleScopedClasses['section-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['config-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['env-name']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['config-row']} */ ;
/** @type {__VLS_StyleScopedClasses['config-label']} */ ;
/** @type {__VLS_StyleScopedClasses['config-value']} */ ;
/** @type {__VLS_StyleScopedClasses['key-warning']} */ ;
/** @type {__VLS_StyleScopedClasses['warning-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['warning-text']} */ ;
/** @type {__VLS_StyleScopedClasses['advanced-config']} */ ;
/** @type {__VLS_StyleScopedClasses['section-header']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['ai-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['ai-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['ai-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['ai-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['ai-section']} */ ;
/** @type {__VLS_StyleScopedClasses['preset-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['preset-tags']} */ ;
/** @type {__VLS_StyleScopedClasses['preset-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['section-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['ai-form']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['ai-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['test-result']} */ ;
/** @type {__VLS_StyleScopedClasses['result-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['result-text']} */ ;
/** @type {__VLS_StyleScopedClasses['ai-status']} */ ;
/** @type {__VLS_StyleScopedClasses['status-row']} */ ;
/** @type {__VLS_StyleScopedClasses['status-label']} */ ;
/** @type {__VLS_StyleScopedClasses['status-value']} */ ;
/** @type {__VLS_StyleScopedClasses['masked-key']} */ ;
/** @type {__VLS_StyleScopedClasses['key-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['hint-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['web-search-section']} */ ;
/** @type {__VLS_StyleScopedClasses['section-header']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['section-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['ai-form']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['preset-tags']} */ ;
/** @type {__VLS_StyleScopedClasses['preset-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['ai-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['key-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['hint-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tools-section']} */ ;
/** @type {__VLS_StyleScopedClasses['section-header']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['section-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['section-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['tools-form']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-label']} */ ;
/** @type {__VLS_StyleScopedClasses['preset-tags']} */ ;
/** @type {__VLS_StyleScopedClasses['preset-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['router-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-header']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['mcp-mode-switch']} */ ;
/** @type {__VLS_StyleScopedClasses['preset-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['preset-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['block-header']} */ ;
/** @type {__VLS_StyleScopedClasses['sub-header']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-list']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-item']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-name']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-transport']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-danger']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['mcp-json-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['mcp-json-example']} */ ;
/** @type {__VLS_StyleScopedClasses['mcp-json-editor']} */ ;
/** @type {__VLS_StyleScopedClasses['mcp-json-error']} */ ;
/** @type {__VLS_StyleScopedClasses['hint-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['mcp-json-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-header']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-list']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-item']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-name']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-danger']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-timeout']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['cli-test-result']} */ ;
/** @type {__VLS_StyleScopedClasses['error-output']} */ ;
/** @type {__VLS_StyleScopedClasses['config-block']} */ ;
/** @type {__VLS_StyleScopedClasses['hover-glow']} */ ;
/** @type {__VLS_StyleScopedClasses['block-header']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['block-bracket']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-list']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-item']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-name']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-danger']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-input']} */ ;
/** @type {__VLS_StyleScopedClasses['ai-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-section']} */ ;
/** @type {__VLS_StyleScopedClasses['theme-copy']} */ ;
/** @type {__VLS_StyleScopedClasses['section-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-section']} */ ;
/** @type {__VLS_StyleScopedClasses['section-header']} */ ;
/** @type {__VLS_StyleScopedClasses['section-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-block']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['noise-rules']} */ ;
/** @type {__VLS_StyleScopedClasses['noise-rule-item']} */ ;
/** @type {__VLS_StyleScopedClasses['rule-label']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-block']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['block-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['privacy-patterns']} */ ;
/** @type {__VLS_StyleScopedClasses['pattern-row']} */ ;
/** @type {__VLS_StyleScopedClasses['pattern-label']} */ ;
/** @type {__VLS_StyleScopedClasses['pattern-input']} */ ;
/** @type {__VLS_StyleScopedClasses['pattern-status']} */ ;
/** @type {__VLS_StyleScopedClasses['valid']} */ ;
/** @type {__VLS_StyleScopedClasses['pattern-status']} */ ;
/** @type {__VLS_StyleScopedClasses['invalid']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-block']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['extract-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-block']} */ ;
/** @type {__VLS_StyleScopedClasses['block-title']} */ ;
/** @type {__VLS_StyleScopedClasses['extract-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['form-row']} */ ;
/** @type {__VLS_StyleScopedClasses['form-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['qq-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['dirty-indicator']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-ide-section']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-list-container']} */ ;
/** @type {__VLS_StyleScopedClasses['section-header']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['section-loading']} */ ;
/** @type {__VLS_StyleScopedClasses['section-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-list']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-item']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-label']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-editor-container']} */ ;
/** @type {__VLS_StyleScopedClasses['action-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-title']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
/** @type {__VLS_StyleScopedClasses['dirty-indicator']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['editor-placeholder']} */ ;
/** @type {__VLS_StyleScopedClasses['schema-editor']} */ ;
/** @type {__VLS_StyleScopedClasses['prompt-preview-container']} */ ;
/** @type {__VLS_StyleScopedClasses['action-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['preview-content']} */ ;
/** @type {__VLS_StyleScopedClasses['test-run-section']} */ ;
/** @type {__VLS_StyleScopedClasses['section-header']} */ ;
/** @type {__VLS_StyleScopedClasses['section-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['test-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['neon-btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['test-input']} */ ;
/** @type {__VLS_StyleScopedClasses['test-results']} */ ;
/** @type {__VLS_StyleScopedClasses['test-error']} */ ;
/** @type {__VLS_StyleScopedClasses['test-running']} */ ;
/** @type {__VLS_StyleScopedClasses['test-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['test-events']} */ ;
/** @type {__VLS_StyleScopedClasses['event-item']} */ ;
/** @type {__VLS_StyleScopedClasses['event-step']} */ ;
/** @type {__VLS_StyleScopedClasses['event-message']} */ ;
/** @type {__VLS_StyleScopedClasses['test-pages']} */ ;
/** @type {__VLS_StyleScopedClasses['pages-title']} */ ;
/** @type {__VLS_StyleScopedClasses['pages-list']} */ ;
/** @type {__VLS_StyleScopedClasses['page-item']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Check: Check,
            Close: Close,
            ThemeSwitcher: ThemeSwitcher,
            MarkdownRenderer: MarkdownRenderer,
            activeTab: activeTab,
            config: config,
            schemaContent: schemaContent,
            schemaBuffer: schemaBuffer,
            editingSchema: editingSchema,
            loadingSchema: loadingSchema,
            loadingConfig: loadingConfig,
            savingSchema: savingSchema,
            reloading: reloading,
            reloadResult: reloadResult,
            commits: commits,
            gitEnabled: gitEnabled,
            loadingHistory: loadingHistory,
            selectedFrom: selectedFrom,
            diffLines: diffLines,
            loadingDiff: loadingDiff,
            showDiff: showDiff,
            loadHistory: loadHistory,
            loadDiff: loadDiff,
            saveSchema: saveSchema,
            cancelEdit: cancelEdit,
            diffLinePrefix: diffLinePrefix,
            PROVIDER_LABELS: PROVIDER_LABELS,
            reloadConfig: reloadConfig,
            aiConfig: aiConfig,
            aiPresets: aiPresets,
            loadingAi: loadingAi,
            savingAi: savingAi,
            testingAi: testingAi,
            aiTestResult: aiTestResult,
            aiForm: aiForm,
            aiModelPlaceholder: aiModelPlaceholder,
            applyPreset: applyPreset,
            saveAiConfig: saveAiConfig,
            resettingAi: resettingAi,
            resetAiConfig: resetAiConfig,
            testConnection: testConnection,
            testResultText: testResultText,
            webSearchForm: webSearchForm,
            webSearchStatus: webSearchStatus,
            loadingWebSearch: loadingWebSearch,
            savingWebSearch: savingWebSearch,
            WEB_SEARCH_PROVIDERS: WEB_SEARCH_PROVIDERS,
            saveWebSearchConfig: saveWebSearchConfig,
            budgetForm: budgetForm,
            savingBudget: savingBudget,
            healthCheckForm: healthCheckForm,
            savingHealthCheck: savingHealthCheck,
            batchForm: batchForm,
            savingBatch: savingBatch,
            loggingForm: loggingForm,
            savingLogging: savingLogging,
            LOG_LEVEL_OPTIONS: LOG_LEVEL_OPTIONS,
            saveBudget: saveBudget,
            saveHealthCheck: saveHealthCheck,
            saveBatch: saveBatch,
            saveLogging: saveLogging,
            toolsForm: toolsForm,
            loadingTools: loadingTools,
            savingTools: savingTools,
            testingCli: testingCli,
            cliTestResult: cliTestResult,
            ROUTER_MODE_OPTIONS: ROUTER_MODE_OPTIONS,
            MCP_TRANSPORT_OPTIONS: MCP_TRANSPORT_OPTIONS,
            addMcpServer: addMcpServer,
            removeMcpServer: removeMcpServer,
            addCliTool: addCliTool,
            removeCliTool: removeCliTool,
            addScene: addScene,
            removeScene: removeScene,
            saveToolsConfig: saveToolsConfig,
            testCliTool: testCliTool,
            mcpEditMode: mcpEditMode,
            mcpJsonText: mcpJsonText,
            mcpJsonError: mcpJsonError,
            switchToMcpJsonMode: switchToMcpJsonMode,
            switchToMcpFormMode: switchToMcpFormMode,
            applyMcpJson: applyMcpJson,
            NOISE_RULE_META: NOISE_RULE_META,
            PRIVACY_PATTERN_META: PRIVACY_PATTERN_META,
            qqConfig: qqConfig,
            loadingQqConfig: loadingQqConfig,
            savingQqConfig: savingQqConfig,
            patternValidation: patternValidation,
            qqConfigDirty: qqConfigDirty,
            saveQqConfigForm: saveQqConfigForm,
            resetQqConfig: resetQqConfig,
            promptFiles: promptFiles,
            currentPromptName: currentPromptName,
            promptContent: promptContent,
            loadingPrompts: loadingPrompts,
            savingPrompt: savingPrompt,
            testInput: testInput,
            testRunning: testRunning,
            testEvents: testEvents,
            testPages: testPages,
            testError: testError,
            currentPromptMeta: currentPromptMeta,
            promptDirty: promptDirty,
            selectPrompt: selectPrompt,
            savePrompt: savePrompt,
            runTest: runTest,
            stopTest: stopTest,
            clearTestResult: clearTestResult,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */

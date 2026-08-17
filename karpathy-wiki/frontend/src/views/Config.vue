<script setup lang="ts">
import { API_BASE } from '../utils/apiBase';
import { ref, computed, reactive, onMounted, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Check, Close } from '@element-plus/icons-vue';
import ThemeSwitcher from '../components/ThemeSwitcher.vue';
import MarkdownRenderer from '../components/MarkdownRenderer.vue';
import type { ConfigData, SchemaContent, ReloadResult, SchemaCommit, DiffLine, AiConfig, LlmPreset, AiTestResult, ToolsConfig, McpServerEntry, QqConfigData, PromptFile, PromptTestRunEvent } from '../types';
import { apiErrorMessage } from '../utils/apiError';
import { consumeSSE } from '../utils/sse';
import { useAuthStore } from '../stores/auth';
import { useTtsStore } from '../stores/tts';
import { useModelStore } from '../stores/model';
import { AUTO_MODEL } from '../utils/autoModel';
import { DEFAULT_TTS_CONFIG } from '../services/ttsConfig';
// 按用户维度隔离的 AI/搜索/工具配置读写层（BYOK：密钥仅存客户端本地，按 userId 命名空间隔离）
// 多模型（按 LLM 预设）独立配置：每个预设各自保存 provider/baseUrl/model/apiKey。
import {
  loadAiUserConfigMap,
  loadAiUserConfigForPreset,
  saveAiUserConfigForPreset,
  saveAiUserConfigMap,
  loadSearchUserConfig,
  saveSearchUserConfig,
  loadToolsUserConfig,
  saveToolsUserConfig,
  DEFAULT_AI_USER_CONFIG,
  type AiUserConfig,
} from '../services/userConfig';

const activeTab = ref<'schema' | 'config' | 'ai' | 'tts' | 'theme' | 'tools' | 'qq' | 'prompts'>('schema');
const config = ref<ConfigData | null>(null);

// ===== 朗读设置（按用户维度隔离）=====
// 配置由 useTtsStore 统一管理，store 内部按当前登录用户（authStore.user.id）读取/写入本地存储，
// 不同用户命名空间隔离（见 stores/tts.ts + services/ttsConfig.ts）。
const ttsStore = useTtsStore();
const authStore = useAuthStore();
// 模型 store：提供 fetchModels（按 baseUrl+apiKey 拉取服务商真实模型清单）+ 状态
const modelStore = useModelStore();
// 是否为管理员：用于 Config 内敏感 tab（SCHEMA/系统配置/AI 服务/工具/QQ/Prompt）的二次拦截，
// 仅管理员可见可改；「朗读设置」「界面主题」为个人偏好，对所有登录用户开放。
// 注意：authStore.isAdmin 经 Pinia 已解包为 boolean，这里用 computed 重新包一层以便模板 v-if 与脚本 .value 统一。
const isAdmin = computed(() => authStore.isAdmin);

// Edge 神经语音可用音色列表（与后端 EDGE_TTS_VOICES 一致，与 MessageToolbar 保持一致）
const edgeVoices = [
  { shortName: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女·温婉）' },
  { shortName: 'zh-CN-YunyangNeural', label: '云扬（男·播报）' },
  { shortName: 'zh-CN-XiaoyiNeural', label: '晓伊（女·甜美）' },
  { shortName: 'zh-CN-YunxiNeural', label: '云希（男·沉稳）' },
  { shortName: 'zh-CN-XiaochenNeural', label: '晓辰（女·知性）' },
  { shortName: 'zh-CN-YunfengNeural', label: '云枫（男·低沉）' },
  { shortName: 'zh-CN-XiaohanNeural', label: '晓涵（女·温暖）' },
  { shortName: 'zh-CN-YunhaoNeural', label: '云皓（男·活力）' },
  { shortName: 'zh-CN-XiaomengNeural', label: '晓梦（女·清新）' },
  { shortName: 'zh-CN-YunzeNeural', label: '云泽（男·儒雅）' },
];

// 说话风格（提升拟人度，对应后端 ALLOWED_STYLES 白名单子集）
const ttsStyles = [
  { value: 'general', label: '标准' },
  { value: 'narration-relaxed', label: '轻松讲述' },
  { value: 'chat', label: '闲聊' },
  { value: 'newscast', label: '新闻播报' },
  { value: 'newscast-casual', label: '轻松新闻' },
  { value: 'empathetic', label: '共情' },
  { value: 'calm', label: '平静' },
  { value: 'gentle', label: '温柔' },
  { value: 'cheerful', label: '欢快' },
  { value: 'serious', label: '严肃' },
];

// 恢复朗读设置为默认值
function resetTtsConfig(): void {
  ttsStore.setProvider(DEFAULT_TTS_CONFIG.provider);
  ttsStore.setVoice(DEFAULT_TTS_CONFIG.voice);
  ttsStore.setStyle(DEFAULT_TTS_CONFIG.style);
  ttsStore.setRate(DEFAULT_TTS_CONFIG.rate);
  ttsStore.setVolume(DEFAULT_TTS_CONFIG.volume);
  ttsStore.setPitch(DEFAULT_TTS_CONFIG.pitch);
}
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
    const res = await authStore.authFetch(`${API_BASE}/schema`);
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
    const res = await authStore.authFetch(`${API_BASE}/schema/history`);
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
    const res = await authStore.authFetch(`${API_BASE}/schema/diff?from=${encodeURIComponent(selectedFrom.value)}`);
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
    const res = await authStore.authFetch(`${API_BASE}/schema`, {
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
    const res = await authStore.authFetch(`${API_BASE}/config`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    config.value = data;
    // 子智能体开关初始状态与服务端保持一致
    subAgentsEnabled.value = Boolean(data.enableSubAgents);
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
    const res = await authStore.authFetch(`${API_BASE}/config/reload`, {
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

// 按预设持久化：每个 LLM 预设独立保存完整配置（含 apiKey）到按用户命名空间的映射表
// （services/userConfig 的 AiUserConfigMap），切换预设时加载对应预设的已保存配置，
// 实现「各模型 API Key 互不干扰、随模型切换正确返显」。映射表为单一权威源，
// 不再另用 localStorage 缓存（避免双轨不一致）。

// 当前用户 id（未登录视为 guest 命名空间）；用于按用户隔离读写本地配置。
const currentUserId = computed(() => authStore.user?.id || 'guest');

// 本地脱敏：仅展示末 4 位，避免明文泄露（与后端 maskSensitive 行为保持一致）。
function maskLocal(key: string): string {
  if (!key) return '';
  if (key.length <= 4) return '*'.repeat(key.length);
  return key.slice(-4).padStart(key.length, '*');
}

// 加载 AI 配置（按用户隔离的本地存储，不再读取服务端共享 config.json）
async function loadAiConfig() {
  loadingAi.value = true;
  try {
    // 初始编辑目标：优先「当前问答选中的预设」（若该预设存在），否则第一个「已保存」的预设，
    // 否则第一个预设，否则空（自定义）。这样用户在问答页切到某预设后打开本页，直接看到该预设的
    // 已保存配置，避免默认打开到别的（常为空的）预设而误以为"配置丢失/未返显"。
    const map = await loadAiUserConfigMap(currentUserId.value);
    const savedKeys = aiPresets.value.map(p => p.key).filter(k => map[k]);
    const activeKey = modelStore.selectedPresetKey;
    const initialKey =
      (activeKey && activeKey !== AUTO_MODEL && aiPresets.value.some(p => p.key === activeKey)
        ? activeKey
        : savedKeys[0]) ?? aiPresets.value[0]?.key ?? '';
    selectedPresetKey.value = initialKey;
    // 传入initialKey对应的预设模板：无保存槽且无 legacy 时将以该预设模板为默认值，
    // 与上方高亮的 selectedPresetKey 标签保持一致（避免首次打开表单停在全局 GLM 默认）。
    const initialPreset = aiPresets.value.find(p => p.key === initialKey);
    const byok = await loadAiUserConfigForPreset(currentUserId.value, initialKey, initialPreset);
    // 回退到服务端配置：浏览器本地 BYOK 未保存（如重新编译/更换访问源后本地槽位丢失），
    // 或已保存但 apiKey 为空（槽位存在但密钥丢失）时，用 /api/ai/config 的服务端配置兜底，
    // 避免「API Key 未返显 / 配置丢失」的错觉。
    // 用户真正保存过完整 BYOK（initialKey 在 savedKeys 中 且 apiKey 非空）时仍以 BYOK 为准。
    let cfg = byok;
    const hasSavedByok = savedKeys.includes(initialKey);
    const hasApiKey = Boolean(byok?.apiKey?.trim());
    if (!hasSavedByok || !hasApiKey) {
      try {
        const res = await authStore.authFetch(`${API_BASE}/ai/config`);
        if (res.ok) {
          const srv = await res.json();
          // 仅补缺：BYOK 已有的字段不覆盖（用户本地值优先）；空字段用服务端基线填充
          cfg = {
            provider: cfg.provider || srv.provider,
            baseUrl: cfg.baseUrl || srv.baseUrl,
            model: cfg.model || srv.model,
            // 服务端密钥仅回显脱敏值（**** 开头），保存时按「未修改」处理，不暴露明文
            apiKey: cfg.apiKey?.trim() ? cfg.apiKey : (srv.apiKeyMasked || ''),
          };
        }
      } catch {
        // 服务端不可达时沿用本地 BYOK / 预设默认值，不阻断页面渲染
      }
    }
    aiForm.value = {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: cfg.apiKey,
    };
    // 本地派生状态摘要（原 aiConfig 来自服务端，现在由本地配置派生，空时回退服务端）
    aiConfig.value = deriveAiSummary(cfg);
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载 AI 配置失败', err));
  } finally {
    loadingAi.value = false;
  }
}

// 由 AiUserConfig 派生本地状态摘要（含本地脱敏 apiKeyMasked）
function deriveAiSummary(cfg: AiUserConfig): AiConfig {
  return {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKeyRef: '',
    apiKeyMasked: cfg.apiKey ? maskLocal(cfg.apiKey) : '',
    apiKeySet: Boolean(cfg.apiKey),
  };
}

// 加载 LLM 预设列表
async function loadPresets() {
  try {
    const res = await authStore.authFetch(`${API_BASE}/ai/presets`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    aiPresets.value = data.presets ?? [];
  } catch {
    // 预设加载失败不阻断，用户可手动输入
  }
}

// 应用预设：切换标签时加载「该预设已保存」的完整配置（含 API Key），实现按模型独立返显。
// 优先用持久化的按预设槽位；无保存记录则回退预设模板默认值（首次使用，API Key 留空由用户填写）。
// 这是修复「切换模型 API Key 不跟随返显」的关键：apiKey 随预设一并加载，而非保留上一个表单内容。
async function applyPreset(preset: LlmPreset) {
  selectedPresetKey.value = preset.key;
  const cfg = await loadAiUserConfigForPreset(currentUserId.value, preset.key, preset);
  aiForm.value = {
    // 已保存过则取保存值；未保存则回退预设模板默认值
    provider: cfg.provider || preset.provider,
    baseUrl: cfg.baseUrl || preset.baseUrl,
    model: cfg.model || preset.model,
    apiKey: cfg.apiKey, // 该预设已保存的密钥（未保存则为空，由用户填写）
  };
  aiConfig.value = deriveAiSummary(aiForm.value);
  // 清空上一预设残留的「服务商可用模型」清单：否则下拉会因模型名不匹配当前预设而显示空白，
  // 造成"模型没返显/配置丢失"的错觉（aiForm.model 文本输入框始终是真实来源）。
  modelStore.availableModels = [];
  ElMessage.success(`已切到 ${preset.label}（请确认或填写你的 API Key）`);
}

// 保存 AI 配置（按用户隔离写入本地 IndexedDB 映射表的「当前预设」槽位，不回传服务端）
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
    // 安全校验：selectedPresetKey 必须是一个真实存在的预设 key，否则 saveAiUserConfigForPreset
    // 会把配置写入 LEGACY 兼容槽（而非预设槽），导致之后切换预设读不到、表现为"配置丢失"。
    // 空/非法时回退到第一个预设，确保始终落到正确的预设槽位。
    const targetKey =
      selectedPresetKey.value && aiPresets.value.some(p => p.key === selectedPresetKey.value)
        ? selectedPresetKey.value
        : (aiPresets.value[0]?.key ?? '');
    await saveAiUserConfigForPreset(currentUserId.value, targetKey, {
      provider: aiForm.value.provider,
      baseUrl: aiForm.value.baseUrl,
      model: aiForm.value.model,
      // 服务端兜底回显的是脱敏值（**** 开头）；用户未改直接保存时不能把脱敏串当真实密钥写入本地，
      // 否则污染本地 BYOK 槽、后续问答下发无效密钥。脱敏值按"未修改/沿用服务端"处理 → 存空（继承服务端基线）。
      apiKey: aiForm.value.apiKey.startsWith('****') ? '' : aiForm.value.apiKey,
    });
    // 更新本地派生状态摘要
    aiConfig.value = deriveAiSummary(aiForm.value);
    const label = targetKey ? `模型 ${targetKey}` : '当前模型';
    ElMessage.success(`AI 配置已保存到本地（${label}，仅当前账户可见）`);
  } catch (err) {
    ElMessage.error(apiErrorMessage('保存失败', err));
  } finally {
    savingAi.value = false;
  }
}

// 恢复初始配置：将当前账户所有模型的本地 AI 配置重置为默认值（仅影响当前用户，不影响他人）。
const resettingAi = ref(false);
async function resetAiConfig() {
  try {
    await ElMessageBox.confirm(
      '确定将当前账户的 AI 配置恢复为默认值吗？此操作清空你本地所有模型的 provider/baseUrl/model/apiKey，不影响其他账户。',
      '恢复初始配置',
      { confirmButtonText: '确定恢复', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    // 用户取消
    return;
  }

  resettingAi.value = true;
  try {
    // 清空整张按预设映射表（含兼容槽），等同于恢复初始配置
    await saveAiUserConfigMap(currentUserId.value, {});
    const def = { ...DEFAULT_AI_USER_CONFIG };
    selectedPresetKey.value = aiPresets.value[0]?.key ?? '';
    aiForm.value = { ...def };
    aiConfig.value = deriveAiSummary(def);
    aiTestResult.value = null;
    ElMessage.success('已恢复当前账户默认配置');
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
    const res = await authStore.authFetch(`${API_BASE}/ai/test-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: aiForm.value.baseUrl,
        model: aiForm.value.model,
        // 脱敏值（**** 开头）非真实密钥，发送前清空，避免用掩码串探测连接（后端 BYOK 需真实 key）；与 fetchModelList 口径一致。
        apiKey: aiForm.value.apiKey.startsWith('****') ? '' : aiForm.value.apiKey,
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

// 按 API Base URL + API Key 自动获取服务商可用模型列表（FR：AI 服务自动获取模型）。
// 优先用表单当前的 baseUrl（必填）；apiKey 若为脱敏值 **** 则清空（后端回退服务端 key），
// 否则用用户本地真实 key。拉取成功后 models 落入 modelStore.availableModels 供下拉选择。
async function fetchModelList() {
  if (!aiForm.value.baseUrl.trim()) {
    ElMessage.warning('请先填写 API Base URL');
    return;
  }
  const ok = await modelStore.fetchModels({
    baseUrl: aiForm.value.baseUrl,
    apiKey: aiForm.value.apiKey.startsWith('****') ? '' : aiForm.value.apiKey,
    provider: aiForm.value.provider,
  });
  if (ok) {
    ElMessage.success(`已获取 ${modelStore.availableModels.length} 个可用模型，可从下方列表选取`);
  } else {
    ElMessage.warning(modelStore.modelsError || '获取模型列表失败');
  }
}

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
const testingWebSearch = ref(false);
// 联网搜索（搜索引擎）连接测试结果：复用 { ok, detail } 形态，与 AI 测试一致
const webSearchTestResult = ref<{ ok: boolean; detail: string; count?: number } | null>(null);

// 联网搜索 provider 中文标签
const WEB_SEARCH_PROVIDERS: Array<{ value: 'tavily' | 'bing'; label: string; apiKeyUrl: string }> = [
  { value: 'tavily', label: 'Tavily', apiKeyUrl: 'https://tavily.com' },
  { value: 'bing', label: 'Bing', apiKeyUrl: 'https://www.microsoft.com/bing/apis' },
];

async function loadWebSearchConfig() {
  loadingWebSearch.value = true;
  try {
    const cfg = await loadSearchUserConfig(currentUserId.value);
    webSearchForm.value = {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      maxResults: cfg.maxResults ?? 5,
    };
    webSearchStatus.value = {
      enabled: Boolean(cfg.apiKey),
      apiKeySet: Boolean(cfg.apiKey),
      apiKeyMasked: cfg.apiKey ? maskLocal(cfg.apiKey) : '',
      apiKeyRef: '',
    };
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载联网搜索配置失败', err));
  } finally {
    loadingWebSearch.value = false;
  }
}

async function saveWebSearchConfig() {
  savingWebSearch.value = true;
  try {
    await saveSearchUserConfig(currentUserId.value, {
      provider: webSearchForm.value.provider,
      apiKey: webSearchForm.value.apiKey,
      maxResults: webSearchForm.value.maxResults,
    });
    webSearchStatus.value = {
      enabled: Boolean(webSearchForm.value.apiKey),
      apiKeySet: Boolean(webSearchForm.value.apiKey),
      apiKeyMasked: webSearchForm.value.apiKey ? maskLocal(webSearchForm.value.apiKey) : '',
      apiKeyRef: '',
    };
    ElMessage.success('联网搜索配置已保存到本地（仅当前账户可见）');
  } catch (err) {
    ElMessage.error(apiErrorMessage('保存失败', err));
  } finally {
    savingWebSearch.value = false;
  }
}

// 测试联网搜索（搜索引擎）连接：向后端 /api/ai/web-search/test 发送当前表单的 provider/apiKey/maxResults，
// 由后端真实打一次对应服务商验证 Key + 网络可用性。前端不持久化即可先验连接。
async function testWebSearchConnection() {
  if (!webSearchForm.value.apiKey.trim()) {
    ElMessage.warning('请先填写搜索引擎 API Key');
    return;
  }
  testingWebSearch.value = true;
  webSearchTestResult.value = null;
  try {
    const res = await authStore.authFetch(`${API_BASE}/ai/web-search/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: webSearchForm.value.provider,
        apiKey: webSearchForm.value.apiKey,
        maxResults: webSearchForm.value.maxResults,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = (await res.json()) as { ok: boolean; detail: string; count?: number };
    webSearchTestResult.value = result;
    if (result.ok) {
      ElMessage.success('搜索引擎连接测试成功');
    } else {
      ElMessage.warning('搜索引擎连接测试失败');
    }
  } catch (err) {
    webSearchTestResult.value = { ok: false, detail: (err as Error).message };
    ElMessage.error(apiErrorMessage('测试失败', err));
  } finally {
    testingWebSearch.value = false;
  }
}

// 搜索引擎测试结果文本（计算属性，避免模板类型收窄问题）
const webSearchTestText = computed(() => {
  const r = webSearchTestResult.value;
  if (!r) return '';
  return r.ok ? `连接成功（返回 ${r.count ?? 0} 条结果）` : r.detail;
});

// ===== 图像生成（生图）连接测试 =====
// 媒体配置为服务端统一配置（非 BYOK），不区分账户；仅做连通性自检，不持久化。
const testingImageGen = ref(false);
const imageGenTestResult = ref<{ ok: boolean; detail: string; model?: string } | null>(null);

async function testImageGenConnection() {
  testingImageGen.value = true;
  imageGenTestResult.value = null;
  try {
    const res = await authStore.authFetch(`${API_BASE}/ai/image/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = (await res.json()) as { ok: boolean; detail: string; model?: string };
    imageGenTestResult.value = result;
    if (result.ok) {
      ElMessage.success('图像生成连接测试成功');
    } else {
      ElMessage.warning('图像生成连接测试失败');
    }
  } catch (err) {
    imageGenTestResult.value = { ok: false, detail: (err as Error).message };
    ElMessage.error(apiErrorMessage('测试失败', err));
  } finally {
    testingImageGen.value = false;
  }
}

// 生图测试结果文本
const imageGenTestText = computed(() => {
  const r = imageGenTestResult.value;
  if (!r) return '';
  return r.ok ? `连接成功${r.model ? `（模型 ${r.model}）` : ''}` : r.detail;
});

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

// 子智能体（多步 Agent）开关：与后端 config.enableSubAgents 对齐。
// 实时切换：开关变化即 PUT /api/config/sub-agents，下次问答即可委派 researcher 子智能体。
const subAgentsEnabled = ref(false);
const savingSubAgents = ref(false);

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
    const res = await authStore.authFetch(`${API_BASE}/config/budget`, {
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
    const res = await authStore.authFetch(`${API_BASE}/config/health-check`, {
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
    const res = await authStore.authFetch(`${API_BASE}/config/batch`, {
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
    const res = await authStore.authFetch(`${API_BASE}/config/logging`, {
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

// 保存子智能体（多步 Agent）开关：实时切换，无需单独保存按钮。
// PUT /api/config/sub-agents 落盘 + 后端 adapter.updateConfig 热切换（下次问答即生效）。
async function saveSubAgents(enabled: boolean) {
  savingSubAgents.value = true;
  try {
    const res = await authStore.authFetch(`${API_BASE}/config/sub-agents`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      if (config.value) {
        config.value.enableSubAgents = data.enabled;
      }
      subAgentsEnabled.value = data.enabled;
      ElMessage.success(data.enabled ? '已开启子智能体（多步 Agent）' : '已关闭子智能体');
    } else {
      throw new Error(data.error || '保存失败');
    }
  } catch (err) {
    // 失败回滚开关状态，避免 UI 与后端不一致
    subAgentsEnabled.value = !enabled;
    ElMessage.error(apiErrorMessage('子智能体开关保存失败', err));
  } finally {
    savingSubAgents.value = false;
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

// 加载工具配置（按用户隔离的本地存储）
async function loadToolsConfig(): Promise<void> {
  loadingTools.value = true;
  try {
    const cfg = await loadToolsUserConfig(currentUserId.value);
    // 深拷贝避免编辑过程污染原对象
    toolsForm.value = {
      mcpServers: (cfg.mcpServers ?? []).map(s => ({ ...s, args: [...(s.args ?? [])], env: s.env ? { ...s.env } : undefined })),
      cliTools: (cfg.cliTools ?? []).map(t => ({ ...t })),
      scenes: (cfg.scenes ?? []).map(sc => ({ ...sc, keywords: [...sc.keywords], tools: [...sc.tools] })),
      routerMode: cfg.routerMode ?? 'auto',
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
    // 按用户隔离写入本地 IndexedDB，不回传服务端（每个用户使用自己配置的工具，互不干扰）
    await saveToolsUserConfig(currentUserId.value, toolsForm.value);
    ElMessage.success('工具配置已保存到本地（仅当前账户可见），下次问答将使用新配置');
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
    const res = await authStore.authFetch(`${API_BASE}/tools/test-cli`, {
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
    const res = await authStore.authFetch(`${API_BASE}/qq-ingest/config`);
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
    const res = await authStore.authFetch(`${API_BASE}/qq-ingest/config`, {
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
    const res = await authStore.authFetch(`${API_BASE}/prompts`);
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
    const res = await authStore.authFetch(`${API_BASE}/prompts/${encodeURIComponent(name)}`);
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
    const res = await authStore.authFetch(`${API_BASE}/prompts/${encodeURIComponent(currentPromptName.value)}`, {
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
    const res = await authStore.authFetch(`${API_BASE}/prompts/test-run`, {
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
  // 个人配置（AI 服务 / 搜索引擎 / 工具）按用户隔离存储在本地，对所有登录用户加载与展示；
  // 不再依赖服务端共享 config.json，避免越权与多余请求，且各用户配置互不可见。
  // 先加载预设列表，loadAiConfig 依赖 aiPresets 匹配当前 provider
  await loadPresets();
  loadAiConfig();
  loadWebSearchConfig();
  loadToolsConfig();
  if (!isAdmin.value) {
    // 非管理员：跳过敏感 admin 接口（SCHEMA/系统配置/历史/QQ/Prompt），默认落到「朗读设置」tab
    activeTab.value = 'tts';
    return;
  }
  loadSchema();
  // loadConfig 完成后同步派生 4 个高级表单的初始值
  await loadConfig();
  if (config.value) {
    syncAdvancedFormsFromConfig(config.value);
  }
  loadHistory();
  loadQqConfig();
  // FR-14-2 Prompt IDE：加载 prompt 文件列表，与其它配置并行加载
  // 为什么放在 onMounted 而非 watch activeTab：避免切换 tab 时首次加载延迟，影响用户体验
  loadPromptList();
});

// 进入 AI 服务 tab 时，若当前 selectedPresetKey 为空/非法（如 aiPresets 晚于 loadAiConfig 加载、
// 或用户在问答页切换预设后才打开本页），自动重新选中有效预设，避免以空 key 保存而误入 LEGACY 槽。
// 仅在 selectedPresetKey 无效时重选，不覆盖用户已手动选中的预设，也不丢弃已填写的表单。
watch(activeTab, (tab) => {
  if (tab !== 'ai') return;
  const valid = selectedPresetKey.value && aiPresets.value.some(p => p.key === selectedPresetKey.value);
  if (valid) return;
  const activeKey = modelStore.selectedPresetKey;
  const fallback =
    (activeKey && activeKey !== AUTO_MODEL && aiPresets.value.some(p => p.key === activeKey)
      ? activeKey
      : aiPresets.value[0]?.key) ?? '';
  if (fallback && fallback !== selectedPresetKey.value) {
    void applyPreset(aiPresets.value.find(p => p.key === fallback)!);
  }
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
        <el-tab-pane v-if="isAdmin" label="SCHEMA 规范" name="schema">
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
        <el-tab-pane v-if="isAdmin" label="系统配置" name="config">
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

              <!-- 子智能体（多步 Agent）开关 -->
              <div class="config-block hover-glow">
                <h3 class="block-title"><span class="block-bracket">[</span> 子智能体（多步 Agent）<span class="block-bracket">]</span></h3>
                <div class="form-row form-row-inline">
                  <label class="form-label" for="cfg-sub-agents">启用 researcher 子智能体</label>
                  <el-switch
                    id="cfg-sub-agents"
                    v-model="subAgentsEnabled"
                    :loading="savingSubAgents"
                    active-text="开启"
                    inactive-text="关闭"
                    @change="saveSubAgents"
                  />
                </div>
                <p class="block-hint">
                  开启后，主问答可委派 <code>spawn_researcher</code> 子智能体在隔离上下文独立检索/研读知识库，返回聚焦结论后由父智能体综合作答。
                  实时生效，无需重启；配置持久化至 config.json。
                </p>
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

        <!-- AI 服务配置：按用户维度隔离，仅当前账户可见 -->
        <el-tab-pane label="AI 服务" name="ai">
          <div class="ai-section">
            <div class="section-header">
              <span class="section-desc">// AI 服务（LLM）</span>
              <span class="user-badge">当前账户：{{ authStore.user?.username || '游客' }}</span>
            </div>
            <div class="tts-note">
              以下配置仅对当前登录账户生效，按用户独立存储在本地并相互隔离；你的 API Key 仅存于本浏览器，
              每次问答使用你自己的密钥，避免与他人共用额度、互相限流。切换账户后此处显示各自独立的设置，互不可见。
            </div>
            <!-- 预设快捷选择 -->
            <div class="preset-bar">
              <span class="section-desc">// LLM 预设</span>
              <div class="preset-tags">
                <span
                  v-for="preset in aiPresets"
                  :key="preset.key"
                  class="preset-tag"
                  :class="{ active: selectedPresetKey === preset.key }"
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
                  <div class="model-input-row">
                    <el-input
                      id="ai-model"
                      v-model="aiForm.model"
                      :placeholder="aiModelPlaceholder"
                      class="form-input"
                    />
                    <el-button
                      class="neon-btn model-fetch-btn"
                      :loading="modelStore.modelsLoading"
                      @click="fetchModelList"
                    >
                      获取模型列表
                    </el-button>
                  </div>
                  <el-select
                    v-if="modelStore.availableModels.length"
                    :model-value="aiForm.model"
                    class="model-select"
                    placeholder="从服务商可用模型中选取"
                    filterable
                    @update:model-value="(v: string) => (aiForm.model = v)"
                  >
                    <el-option
                      v-for="m in modelStore.availableModels"
                      :key="m.id"
                      :label="m.id"
                      :value="m.id"
                    />
                  </el-select>
                  <p v-if="modelStore.modelsError" class="model-error">{{ modelStore.modelsError }}</p>
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
                  <span>请在本页面填写你的 API Key（仅保存在本浏览器，不会上传服务器）</span>
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
                  <el-button class="neon-btn" :loading="testingWebSearch" @click="testWebSearchConnection">
                    测试连接
                  </el-button>
                  <el-button class="neon-btn-primary" :loading="savingWebSearch" @click="saveWebSearchConfig">
                    保存配置
                  </el-button>
                </div>
                <!-- 搜索引擎连接测试结果 -->
                <div v-if="webSearchTestResult" class="test-result" :class="{ ok: webSearchTestResult.ok, fail: !webSearchTestResult.ok }">
                  <el-icon class="result-icon"><component :is="webSearchTestResult.ok ? Check : Close" /></el-icon>
                  <span class="result-text">{{ webSearchTestText }}</span>
                </div>
      <div v-if="webSearchStatus && !webSearchStatus.apiKeySet" class="key-hint">
                  <span class="hint-icon">?</span>
                  <span>未配置 API Key 时，知识库问答点击"联网搜索"将仅使用本地知识库。请在上方填写你的搜索引擎 Key（仅存本浏览器）</span>
                </div>
              </div>
            </div>

            <!-- 图像生成（生图）连接测试：媒体配置为服务端统一配置，非 BYOK，仅做连通性自检 -->
            <div class="web-search-section">
              <div class="section-header">
                <span class="section-desc">// 图像生成（生图）</span>
                <span class="key-status set">服务端统一配置</span>
              </div>
              <div class="config-block hover-glow">
                <h3 class="block-title"><span class="block-bracket">[</span> 生图服务 <span class="block-bracket">]</span></h3>
                <p class="key-hint">
                  <span class="hint-icon">i</span>
                  <span>生图模型与密钥由服务端统一配置（agnes-image-2.1-flash），不区分账户。点击下方「测试连接」可验证服务端生图 API 是否可用、网络是否通畅。</span>
                </p>
              </div>
              <div class="ai-actions">
                <el-button class="neon-btn" :loading="testingImageGen" @click="testImageGenConnection">
                  测试连接
                </el-button>
              </div>
              <div v-if="imageGenTestResult" class="test-result" :class="{ ok: imageGenTestResult.ok, fail: !imageGenTestResult.ok }">
                <el-icon class="result-icon"><component :is="imageGenTestResult.ok ? Check : Close" /></el-icon>
                <span class="result-text">{{ imageGenTestText }}</span>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- 朗读设置：按用户维度隔离，仅当前账户可见 -->
        <el-tab-pane label="朗读设置" name="tts">
          <div class="tts-config-section">
            <div class="section-header">
              <span class="section-desc">// 朗读偏好（TTS）</span>
              <span class="user-badge">当前账户：{{ authStore.user?.username || '游客' }}</span>
            </div>
            <div class="tts-note">
              以下配置仅对当前登录账户生效，按用户独立存储在本地并相互隔离；切换账户后此处显示各自独立的设置，互不可见。
            </div>

            <!-- 语音引擎 -->
            <div class="config-block hover-glow">
              <h3 class="block-title"><span class="block-bracket">[</span> 语音引擎 <span class="block-bracket">]</span></h3>
              <div class="form-row">
                <span class="form-label">引擎</span>
                <div class="preset-tags">
                  <span
                    class="preset-tag"
                    :class="{ active: ttsStore.providerName === 'edge' }"
                    @click="ttsStore.setProvider('edge')"
                  >神经语音（Edge）</span>
                  <span
                    class="preset-tag"
                    :class="{ active: ttsStore.providerName === 'browser' }"
                    @click="ttsStore.setProvider('browser')"
                  >浏览器原生</span>
                </div>
              </div>
            </div>

            <!-- 音色 -->
            <div v-if="ttsStore.providerName === 'edge'" class="config-block hover-glow">
              <h3 class="block-title"><span class="block-bracket">[</span> 音色 <span class="block-bracket">]</span></h3>
              <div class="voice-grid">
                <button
                  v-for="v in edgeVoices"
                  :key="v.shortName"
                  class="preset-tag"
                  :class="{ active: ttsStore.currentVoice === v.shortName }"
                  @click="ttsStore.setVoice(v.shortName)"
                >{{ v.label }}</button>
              </div>
            </div>

            <!-- 说话风格 -->
            <div v-if="ttsStore.providerName === 'edge'" class="config-block hover-glow">
              <h3 class="block-title"><span class="block-bracket">[</span> 说话风格 <span class="block-bracket">]</span></h3>
              <div class="voice-grid">
                <button
                  v-for="s in ttsStyles"
                  :key="s.value"
                  class="preset-tag"
                  :class="{ active: ttsStore.currentStyle === s.value }"
                  @click="ttsStore.setStyle(s.value)"
                >{{ s.label }}</button>
              </div>
            </div>

            <!-- 朗读微调：语速 / 音量 / 音调 -->
            <div v-if="ttsStore.providerName === 'edge'" class="config-block hover-glow">
              <h3 class="block-title"><span class="block-bracket">[</span> 朗读微调 <span class="block-bracket">]</span></h3>
              <div class="form-row slider-row">
                <span class="form-label">语速</span>
                <el-slider
                  :model-value="ttsStore.rate"
                  :min="0.5"
                  :max="2"
                  :step="0.05"
                  class="tts-slider"
                  @change="(v: number) => ttsStore.setRate(v)"
                />
                <span class="slider-val">{{ ttsStore.rate.toFixed(2) }}x</span>
              </div>
              <div class="form-row slider-row">
                <span class="form-label">音量</span>
                <el-slider
                  :model-value="ttsStore.currentVolume"
                  :min="-30"
                  :max="30"
                  :step="1"
                  class="tts-slider"
                  @change="(v: number) => ttsStore.setVolume(v)"
                />
                <span class="slider-val">{{ ttsStore.currentVolume >= 0 ? '+' : '' }}{{ ttsStore.currentVolume }}%</span>
              </div>
              <div class="form-row slider-row">
                <span class="form-label">音调</span>
                <el-slider
                  :model-value="ttsStore.currentPitch"
                  :min="-10"
                  :max="10"
                  :step="1"
                  class="tts-slider"
                  @change="(v: number) => ttsStore.setPitch(v)"
                />
                <span class="slider-val">{{ ttsStore.currentPitch >= 0 ? '+' : '' }}{{ ttsStore.currentPitch }}Hz</span>
              </div>
            </div>

            <div class="ai-actions">
              <el-button class="neon-btn" @click="resetTtsConfig">恢复默认</el-button>
            </div>
          </div>
        </el-tab-pane>

        <!-- 工具配置：MCP / CLI / 场景路由（按用户隔离） -->
        <el-tab-pane label="工具配置" name="tools">
          <div class="tools-section">
            <div class="section-header">
              <span class="section-desc">// 扩展工具（MCP / CLI / 场景路由）</span>
              <span class="user-badge">当前账户：{{ authStore.user?.username || '游客' }}</span>
            </div>
            <div class="tts-note">
              以下工具配置仅对当前登录账户生效，按用户独立存储在本地并相互隔离；切换账户后此处显示各自独立的设置，互不可见。
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

        <el-tab-pane v-if="isAdmin" label="QQ 导入" name="qq">
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
        <el-tab-pane v-if="isAdmin" label="Prompt IDE" name="prompts">
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

/* ===== 朗读设置（按用户维度隔离）样式 ===== */
.tts-config-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 360px;
}

.tts-note {
  margin: 0;
  padding: 10px 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-soft);
  background: var(--accent-purple-a06);
  border: 1px solid var(--accent-purple-a20);
  border-left: 3px solid var(--neon-cyan);
  border-radius: var(--radius-card);
}

.user-badge {
  padding: 3px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--neon-cyan);
  background: var(--accent-cyan-a10);
  border: 1px solid var(--accent-cyan-a30);
  border-radius: 999px;
  white-space: nowrap;
}

.voice-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 4px;
}

.slider-row {
  align-items: center;
}

.tts-slider {
  flex: 1;
  margin: 0 4px;
}

.slider-val {
  min-width: 56px;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-bright);
}

/* ===== AI 服务配置样式 ===== */
.ai-section {
  min-height: 400px;
}

/* 模型输入框 + 获取列表按钮 一行排列 */
.model-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.model-input-row .form-input {
  flex: 1;
}
.model-fetch-btn {
  flex: none;
  white-space: nowrap;
}
/* 服务商真实模型下拉：占满整行，可搜索 */
.model-select {
  width: 100%;
  margin-top: 8px;
}
.model-error {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--danger, #f56c6c);
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

.form-row-inline label {
  width: auto;
  flex-shrink: 1;
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

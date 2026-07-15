<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import RobotAvatar from '../components/RobotAvatar.vue';
import ThemeSwitcher from '../components/ThemeSwitcher.vue';
import type { ConfigData, SchemaContent, ReloadResult, SchemaCommit, DiffLine, AiConfig, LlmPreset, AiTestResult } from '../types';
import { apiErrorMessage } from '../utils/apiError';

const activeTab = ref<'schema' | 'config' | 'ai' | 'theme'>('schema');
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

// 按预设持久化完整配置到 localStorage。
// 为什么需要：切换预设标签时应返显该预设上次保存的 baseUrl/model/apiKey，
// 仅靠后端全局配置无法区分不同预设的历史值。
// 与 stores/model.ts 的 apiKey:${key} 保持兼容：保存时同步写入 apiKey 字段。
function presetStorageKey(presetKey: string): string {
  return `llmPresetConfig:${presetKey}`;
}

interface PresetConfigCache {
  baseUrl: string;
  model: string;
  apiKey: string; // 明文，与 model.ts 的 apiKey:${key} 一致
}

function loadPresetCache(presetKey: string): PresetConfigCache | null {
  const raw = localStorage.getItem(presetStorageKey(presetKey));
  if (raw) {
    try {
      return JSON.parse(raw) as PresetConfigCache;
    } catch {
      // 损坏数据忽略
    }
  }
  // 兼容 model.ts 旧存储：仅存了 apiKey:${key}
  const legacyApiKey = localStorage.getItem(`apiKey:${presetKey}`);
  return legacyApiKey ? { baseUrl: '', model: '', apiKey: legacyApiKey } : null;
}

function savePresetCache(presetKey: string, cache: PresetConfigCache): void {
  localStorage.setItem(presetStorageKey(presetKey), JSON.stringify(cache));
  // 同步写入 model.ts 读取的 key，保持两套机制一致
  if (cache.apiKey) {
    localStorage.setItem(`apiKey:${presetKey}`, cache.apiKey);
  } else {
    localStorage.removeItem(`apiKey:${presetKey}`);
  }
}

function clearAllPresetCache(): void {
  // 清除所有 llmPresetConfig:* 和 apiKey:* 条目
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.startsWith('llmPresetConfig:') || k.startsWith('apiKey:'))) {
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

// 应用预设：切换标签时返显该预设上次保存的 baseUrl/model/apiKey。
// 优先级：localStorage 按预设缓存 > 预设默认值（baseUrl/model）。
// 为什么切换时同步后端：后端 config.json 只有一份全局配置，
//   切换预设后需同步到后端，确保 Query 页面等使用当前预设的配置。
//   仅当该预设有缓存的 apiKey 时才同步，避免新预设空 apiKey 覆盖旧配置。
async function applyPreset(preset: LlmPreset) {
  selectedPresetKey.value = preset.key;
  const cache = loadPresetCache(preset.key);
  aiForm.value.provider = preset.provider;
  // 有缓存则用缓存的 baseUrl/model（用户可能修改过），否则用预设默认值
  aiForm.value.baseUrl = cache?.baseUrl || preset.baseUrl;
  aiForm.value.model = cache?.model || preset.model;
  // apiKey 优先用缓存明文；无缓存则留空让用户重新输入
  aiForm.value.apiKey = cache?.apiKey || '';

  // 后台同步到后端 config.json（不阻塞表单返显）
  // 为什么用明文 apiKey 判断：有缓存 key 说明该预设已配置过，应同步到后端
  if (cache?.apiKey) {
    try {
      const res = await fetch('/api/ai/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: preset.provider,
          baseUrl: aiForm.value.baseUrl,
          model: aiForm.value.model,
          // 发送明文 apiKey 让后端更新 config.json，确保后端配置与当前预设一致
          apiKey: cache.apiKey,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.ok) aiConfig.value = data.config;
      }
    } catch {
      // 同步失败不阻断切换，用户可手动点"保存配置"
    }
    // 同步后端后，表单 apiKey 保持明文不变（方便用户查看和测试连接）
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
      // 保存成功后按预设持久化当前配置到 localStorage。
      // 为什么在保存时持久化：此时配置已验证生效，下次切换该预设可直接返显。
      // apiKey 存储逻辑：
      //   - **** 开头是脱敏回传值（用户未修改），从 localStorage 取旧 key 保持不变
      //   - 非脱敏值（明文或空串）是用户主动输入，直接持久化
      //     其中空串表示用户清除 key，也需存空串而非取旧值
      let apiKeyToStore: string;
      if (aiForm.value.apiKey.startsWith('****')) {
        apiKeyToStore = loadPresetCache(selectedPresetKey.value)?.apiKey ?? '';
      } else {
        apiKeyToStore = aiForm.value.apiKey;
      }
      if (selectedPresetKey.value) {
        savePresetCache(selectedPresetKey.value, {
          baseUrl: aiForm.value.baseUrl,
          model: aiForm.value.model,
          apiKey: apiKeyToStore,
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

// 测试结果图标
const testResultIcon = computed(() => {
  const r = aiTestResult.value;
  return r?.ok ? '?' : '?';
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

onMounted(async () => {
  loadSchema();
  loadConfig();
  loadHistory();
  // 先加载预设列表，loadAiConfig 依赖 aiPresets 匹配当前 provider
  await loadPresets();
  loadAiConfig();
  loadWebSearchConfig();
});
</script>

<template>
  <div class="config-page">
    <div class="glass-card config-card">
      <!-- 不对称装饰块：旋转青蓝渐变 -->
      <div class="card-deco"></div>

      <div class="config-head">
        <RobotAvatar :size="56" />
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
                  <label class="form-label">API Base URL</label>
                  <el-input
                    v-model="aiForm.baseUrl"
                    placeholder="https://api.openai.com/v1"
                    class="form-input"
                  />
                </div>
                <div class="form-row">
                  <label class="form-label">API Key</label>
                  <el-input
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
                    placeholder="gpt-4o-mini"
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
                    <label class="form-label">Provider</label>
                    <div class="preset-tags">
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
                    <label class="form-label">API Key</label>
                    <el-input
                      v-model="webSearchForm.apiKey"
                      type="password"
                      show-password
                      placeholder="输入联网搜索 API Key"
                      class="form-input"
                    />
                  </div>
                  <div class="form-row">
                    <label class="form-label">最大结果数</label>
                    <el-input
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
  margin: 0 0 4px;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 13px;
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
</style>

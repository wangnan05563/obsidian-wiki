<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import RobotAvatar from '../components/RobotAvatar.vue';
import type { ConfigData, SchemaContent, ReloadResult, SchemaCommit, DiffLine } from '../types';

const activeTab = ref<'schema' | 'config'>('schema');
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
    ElMessage.error('加载 SCHEMA 失败：' + (err as Error).message);
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
    ElMessage.error('加载版本历史失败：' + (err as Error).message);
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
    ElMessage.error('加载版本对比失败：' + (err as Error).message);
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
    ElMessage.error('保存失败：' + (err as Error).message);
  } finally {
    savingSchema.value = false;
  }
}

// 取消编辑
function cancelEdit() {
  schemaBuffer.value = schemaContent.value;
  editingSchema.value = false;
}

// 加载配置
async function loadConfig() {
  loadingConfig.value = true;
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    config.value = await res.json();
  } catch (err) {
    ElMessage.error('加载配置失败：' + (err as Error).message);
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
    ElMessage.error('热加载失败：' + (err as Error).message);
  } finally {
    reloading.value = false;
  }
}

onMounted(() => {
  loadSchema();
  loadConfig();
  loadHistory();
});
</script>

<template>
  <div class="config-page">
    <div class="glass-card config-card">
      <div class="config-head">
        <RobotAvatar :size="56" />
        <div class="head-text">
          <h2 class="head-title">配置中心</h2>
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
                <el-button v-if="!editingSchema" size="small" type="primary" @click="editingSchema = true">
                  编辑
                </el-button>
                <template v-else>
                  <el-button size="small" type="primary" :loading="savingSchema" @click="saveSchema">
                    保存
                  </el-button>
                  <el-button size="small" @click="cancelEdit">取消</el-button>
                </template>
              </div>
            </div>

            <div v-if="loadingSchema" class="section-loading">加载中…</div>

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
                <span class="section-desc">版本历史（Git）</span>
                <el-button size="small" text :loading="loadingHistory" @click="loadHistory">刷新</el-button>
              </div>
              <div v-if="!gitEnabled" class="history-disabled">
                Vault 未启用 Git，无法查看版本历史。在 Vault 目录执行 <code>git init</code> 即可启用。
              </div>
              <div v-else-if="commits.length === 0" class="history-empty">暂无提交记录</div>
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
                    type="primary"
                    :disabled="!selectedFrom"
                    :loading="loadingDiff"
                    @click="loadDiff"
                  >
                    对比
                  </el-button>
                </div>
                <div v-if="showDiff && !loadingDiff" class="diff-result">
                  <div v-if="diffLines.length === 0" class="diff-empty">无差异</div>
                  <div v-else class="diff-lines">
                    <div
                      v-for="(line, idx) in diffLines"
                      :key="idx"
                      class="diff-line"
                      :class="line.type"
                    >
                      <span class="line-prefix">
                        {{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }}
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
              <el-button size="small" type="primary" :loading="reloading" @click="reloadConfig">
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
                以下字段变更需重启服务才能生效：{{ reloadResult.requireRestart.join(', ') }}
              </div>
            </div>

            <div v-if="loadingConfig" class="section-loading">加载中…</div>
            <div v-else-if="config" class="config-grid">
              <!-- LLM 配置 -->
              <div class="config-block">
                <h3 class="block-title">LLM 模型</h3>
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
              <div class="config-block">
                <h3 class="block-title">运行参数</h3>
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
              <div class="config-block">
                <h3 class="block-title">服务</h3>
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
                <div class="warning-icon">⚠️</div>
                <div class="warning-text">
                  <strong>API Key 未设置</strong>
                  <p>请设置环境变量 <code>{{ config.llm.apiKeyRef }}</code> 后重启服务，否则编译与问答将返回 401 错误。</p>
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
  padding: 24px 28px;
}

.config-head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.head-text {
  flex: 1;
}

.head-title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
}

.head-tip {
  margin: 0;
  color: var(--color-text-soft);
  font-size: 13px;
}

.config-tabs {
  --el-color-primary: var(--color-primary-deep);
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
  font-size: 13px;
  color: var(--color-text-soft);
}

.actions {
  display: flex;
  gap: 8px;
}

.section-loading {
  text-align: center;
  color: var(--color-text-soft);
  padding: 60px 0;
}

.schema-editor :deep(.el-textarea__inner) {
  font-family: 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.8;
}

.schema-view {
  margin: 0;
  padding: 18px 24px;
  background: rgba(74, 59, 71, 0.05);
  border-radius: var(--radius-card);
  font-size: 13px;
  line-height: 1.8;
  color: var(--color-text);
  font-family: 'Courier New', monospace;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 500px;
  overflow-y: auto;
}

.config-grid {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.config-block {
  padding: 18px 22px;
  background: rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-card);
}

.block-title {
  margin: 0 0 14px;
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text);
  padding-bottom: 8px;
  border-bottom: 2px solid var(--color-pink);
}

.config-row {
  display: flex;
  padding: 6px 0;
  font-size: 13px;
}

.config-label {
  width: 120px;
  color: var(--color-text-soft);
  flex-shrink: 0;
}

.config-value {
  color: var(--color-text);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
}

.key-status {
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
}

.key-status.set {
  background: var(--color-cyan);
  color: var(--color-text);
}

.key-status.unset {
  background: var(--color-error);
  color: #fff;
}

.env-name {
  padding: 2px 8px;
  background: var(--color-pink);
  border-radius: 6px;
  font-size: 12px;
  font-family: 'Courier New', monospace;
}

.key-warning {
  display: flex;
  gap: 14px;
  padding: 16px 20px;
  background: var(--color-yellow);
  border-radius: var(--radius-card);
}

.warning-icon {
  font-size: 28px;
}

.warning-text strong {
  color: var(--color-text);
  font-size: 14px;
}

.warning-text p {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--color-text);
  line-height: 1.6;
}

.warning-text code {
  padding: 2px 6px;
  background: rgba(255, 255, 255, 0.6);
  border-radius: 4px;
  font-size: 12px;
  font-family: 'Courier New', monospace;
}

.reload-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding: 12px 18px;
  background: rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-card);
}

.reload-result {
  margin-bottom: 16px;
  padding: 14px 18px;
  background: var(--color-cyan);
  border-radius: var(--radius-card);
}

.reload-applied {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--color-text);
}

.applied-tag {
  padding: 2px 10px;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 10px;
  font-size: 12px;
  font-family: 'Courier New', monospace;
}

.reload-warn {
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-text-soft);
}

/* §6.X 版本历史与 diff */
.history-section {
  margin-top: 20px;
  padding: 16px 20px;
  background: rgba(255, 255, 255, 0.4);
  border-radius: var(--radius-card);
}

.history-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.history-disabled {
  font-size: 13px;
  color: var(--color-text-soft);
  padding: 10px 0;
}

.history-disabled code {
  padding: 2px 6px;
  background: var(--color-pink);
  border-radius: 4px;
  font-family: 'Courier New', monospace;
  font-size: 12px;
}

.history-empty {
  font-size: 13px;
  color: var(--color-text-soft);
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
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.5);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.commit-item:hover {
  background: var(--color-cyan);
}

.commit-item.selected {
  background: var(--color-pink);
  border: 2px solid var(--color-primary);
}

.commit-hash {
  font-size: 11px;
  font-family: 'Courier New', monospace;
  color: var(--color-primary-deep);
  background: rgba(255, 255, 255, 0.7);
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
  color: var(--color-text);
  margin-bottom: 2px;
}

.commit-meta {
  font-size: 11px;
  color: var(--color-text-soft);
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
  background: rgba(74, 59, 71, 0.05);
  border-radius: 10px;
  max-height: 300px;
  overflow-y: auto;
}

.diff-empty {
  text-align: center;
  font-size: 13px;
  color: var(--color-text-soft);
  padding: 16px 0;
}

.diff-lines {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.diff-line {
  display: flex;
  font-family: 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
}

.diff-line.add {
  background: rgba(76, 175, 80, 0.15);
}

.diff-line.del {
  background: rgba(244, 67, 54, 0.15);
}

.line-prefix {
  width: 20px;
  text-align: center;
  flex-shrink: 0;
  font-weight: 700;
}

.diff-line.add .line-prefix {
  color: #4caf50;
}

.diff-line.del .line-prefix {
  color: #f44336;
}

.line-content {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--color-text);
}
</style>

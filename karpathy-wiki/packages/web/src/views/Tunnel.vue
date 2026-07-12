<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { TunnelStatus, TunnelConfigData, TunnelConfigBody, TunnelDownloadError } from '../types';

// 隧道运行状态与配置（从后端加载）
const status = ref<TunnelStatus | null>(null);
const config = ref<TunnelConfigData | null>(null);
const loading = ref(true);
const starting = ref(false);
const stopping = ref(false);
const saving = ref(false);

// 表单状态：独立于 config，保存后才同步
const formProvider = ref<'cloudflare' | 'cpolar'>('cloudflare');
const formAuthtoken = ref('');
const formPort = ref(0);
const formBinaryPath = ref('');
const formAutoStart = ref(false);

// 二进制下载失败时展示手动放置指引
const downloadError = ref<TunnelDownloadError | null>(null);

// 轮询定时器：运行中时每 3 秒查询状态（检测子进程崩溃）
let pollTimer: ReturnType<typeof setInterval> | null = null;

const PROVIDER_LABELS: Record<string, string> = {
  cloudflare: 'Cloudflare Tunnel',
  cpolar: 'cpolar（国内推荐）',
};

const PROVIDER_DESC: Record<string, string> = {
  cloudflare: '免注册，自动分配 trycloudflare 域名。大陆访问可能不稳定。',
  cpolar: '国内服务器稳定，需注册账号获取 authtoken。',
};

async function loadStatus() {
  try {
    const res = await fetch('/api/tunnel/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.value = await res.json();
  } catch (err) {
    // 静默失败：轮询时弹错误会刷屏，仅控制台记录
    console.error('加载隧道状态失败:', err);
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/tunnel/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: TunnelConfigData = await res.json();
    config.value = data;
    formProvider.value = data.provider;
    formPort.value = data.localPort;
    formBinaryPath.value = data.binaryPath;
    formAutoStart.value = data.autoStart;
    // authtoken 不回显明文，表单留空（空串=不修改）
    formAuthtoken.value = '';
  } catch (err) {
    ElMessage.error('加载配置失败：' + (err as Error).message);
  } finally {
    loading.value = false;
  }
}

async function startTunnel() {
  starting.value = true;
  downloadError.value = null;
  try {
    const res = await fetch('/api/tunnel/start', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      // 下载失败：渲染手动放置指引而非普通错误提示
      if (data.errorType === 'binary_download_failed') {
        downloadError.value = data as TunnelDownloadError;
      }
      throw new Error(data.detail || `HTTP ${res.status}`);
    }
    status.value = data as TunnelStatus;
    ElMessage.success('隧道已启动');
  } catch (err) {
    ElMessage.error('启动失败：' + (err as Error).message);
  } finally {
    starting.value = false;
  }
}

async function stopTunnel() {
  stopping.value = true;
  try {
    const res = await fetch('/api/tunnel/stop', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.value = await res.json();
    ElMessage.success('隧道已停止');
  } catch (err) {
    ElMessage.error('停止失败：' + (err as Error).message);
  } finally {
    stopping.value = false;
  }
}

async function saveConfig() {
  saving.value = true;
  try {
    const body: TunnelConfigBody = {
      provider: formProvider.value,
      localPort: formPort.value,
      cpolarAuthtoken: formAuthtoken.value,
      binaryPath: formBinaryPath.value,
      autoStart: formAutoStart.value,
    };
    const res = await fetch('/api/tunnel/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    ElMessage.success('配置已保存');
    await loadConfig();
  } catch (err) {
    ElMessage.error('保存失败：' + (err as Error).message);
  } finally {
    saving.value = false;
  }
}

function openUrl() {
  if (status.value?.publicUrl) {
    window.open(status.value.publicUrl, '_blank');
  }
}

async function copyUrl() {
  if (status.value?.publicUrl) {
    try {
      await navigator.clipboard.writeText(status.value.publicUrl);
      ElMessage.success('已复制到剪贴板');
    } catch {
      ElMessage.error('复制失败');
    }
  }
}

// 运行中时轮询状态，停止时清除（避免无意义请求）
watch(() => status.value?.status, (newStatus) => {
  if (newStatus === 'running') {
    if (!pollTimer) {
      pollTimer = setInterval(loadStatus, 3000);
    }
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});

onMounted(() => {
  loadStatus();
  loadConfig();
});

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
});
</script>

<template>
  <div class="tunnel-page" v-loading="loading">
    <!-- 状态卡片 -->
    <div class="glass-card">
      <h2 class="card-title">隧道状态</h2>
      <div class="status-row">
        <div class="status-item">
          <span class="row-label">运行状态</span>
          <el-tag :type="status?.status === 'running' ? 'success' : 'info'" effect="dark">
            {{ status?.status === 'running' ? '运行中' : '已停止' }}
          </el-tag>
        </div>
        <div class="status-item" v-if="status?.provider">
          <span class="row-label">Provider</span>
          <el-tag effect="plain">{{ PROVIDER_LABELS[status.provider] || status.provider }}</el-tag>
        </div>
      </div>
      <div class="url-item" v-if="status?.publicUrl">
        <span class="row-label">公网地址</span>
        <div class="url-box">
          <code class="url-text">{{ status.publicUrl }}</code>
          <div class="url-actions">
            <el-button size="small" @click="copyUrl">复制</el-button>
            <el-button size="small" type="primary" @click="openUrl">打开</el-button>
          </div>
        </div>
      </div>
      <div class="actions">
        <el-button
          type="primary"
          :loading="starting"
          :disabled="status?.status === 'running'"
          @click="startTunnel"
        >启动隧道</el-button>
        <el-button
          type="danger"
          :loading="stopping"
          :disabled="status?.status !== 'running'"
          @click="stopTunnel"
        >停止隧道</el-button>
      </div>
    </div>

    <!-- 下载失败指引 -->
    <div class="glass-card" v-if="downloadError">
      <el-alert type="error" :closable="false" show-icon>
        <template #title>二进制下载失败</template>
        <div class="download-error-detail">{{ downloadError.detail }}</div>
        <div class="manual-path">
          请手动下载并放置到：<code>{{ downloadError.manualPath }}</code>
        </div>
        <div class="download-links">
          <a
            v-for="url in downloadError.downloadUrls"
            :key="url"
            :href="url"
            target="_blank"
            class="download-link"
          >{{ url }}</a>
        </div>
      </el-alert>
    </div>

    <!-- 配置卡片 -->
    <div class="glass-card">
      <h2 class="card-title">穿透配置</h2>
      <div class="config-block">
        <div class="config-row">
          <label class="row-label">Provider</label>
          <div class="row-value">
            <el-select v-model="formProvider" placeholder="选择穿透服务">
              <el-option label="Cloudflare Tunnel（免注册）" value="cloudflare" />
              <el-option label="cpolar（国内推荐）" value="cpolar" />
            </el-select>
            <div class="hint">{{ PROVIDER_DESC[formProvider] }}</div>
          </div>
        </div>

        <div class="config-row" v-if="formProvider === 'cpolar'">
          <label class="row-label">Authtoken</label>
          <div class="row-value">
            <el-input
              v-model="formAuthtoken"
              type="password"
              show-password
              :placeholder="config?.cpolarAuthtokenConfigured ? '已配置，留空表示不修改' : '请输入 cpolar authtoken'"
            />
          </div>
        </div>

        <div class="config-row">
          <label class="row-label">本地端口</label>
          <div class="row-value">
            <el-input-number v-model="formPort" :min="0" :max="65535" controls-position="right" />
            <div class="hint">0 = 自动继承服务端口</div>
          </div>
        </div>

        <div class="config-row">
          <label class="row-label">二进制路径</label>
          <div class="row-value">
            <el-input v-model="formBinaryPath" placeholder="留空则自动下载到 data/ 目录" />
          </div>
        </div>

        <div class="config-row">
          <label class="row-label" for="tunnel-auto-start">开机自启</label>
          <div class="row-value">
            <el-switch id="tunnel-auto-start" v-model="formAutoStart" />
            <span class="hint">服务启动时自动建立隧道</span>
          </div>
        </div>
      </div>
      <div class="actions">
        <el-button type="primary" :loading="saving" @click="saveConfig">保存配置</el-button>
      </div>
    </div>

    <!-- 使用说明 -->
    <div class="glass-card">
      <h2 class="card-title">使用说明</h2>
      <ol class="usage-list">
        <li>选择 Provider（推荐 Cloudflare，免注册即用）</li>
        <li>如选 cpolar，需到官网注册获取 authtoken 并填入</li>
        <li>本地端口留 0 自动继承服务端口，或指定其他端口</li>
        <li>点击"保存配置"持久化到 config.json</li>
        <li>点击"启动隧道"建立穿透，获得公网 URL</li>
        <li>开机自启开启后，服务启动时自动建立隧道</li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.tunnel-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 玻璃态卡片：与项目赛博朋克主题一致 */
.glass-card {
  background: var(--bg-card, rgba(20, 20, 35, 0.6));
  backdrop-filter: blur(12px);
  border: 1px solid rgba(0, 245, 255, 0.15);
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

.card-title {
  font-family: var(--font-display, sans-serif);
  font-size: 18px;
  font-weight: 700;
  color: var(--neon-cyan, #00f5ff);
  margin: 0 0 16px 0;
  letter-spacing: 1px;
}

.status-row {
  display: flex;
  gap: 32px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.status-item,
.url-item {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.row-label {
  font-size: 13px;
  color: var(--text-soft, #aaa);
  min-width: 80px;
  font-weight: 600;
}

.url-box {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  flex-wrap: wrap;
}

.url-text {
  font-family: var(--font-mono, monospace);
  font-size: 14px;
  color: var(--neon-cyan, #00f5ff);
  background: rgba(0, 245, 255, 0.08);
  padding: 6px 12px;
  border-radius: 8px;
  word-break: break-all;
}

.url-actions {
  display: flex;
  gap: 8px;
}

.actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

.config-block {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.config-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.config-row .row-label {
  padding-top: 8px;
  min-width: 100px;
}

.row-value {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hint {
  font-size: 12px;
  color: var(--text-dim, #888);
  line-height: 1.5;
}

.usage-list {
  margin: 0;
  padding-left: 20px;
  color: var(--text-soft, #ccc);
  font-size: 13px;
  line-height: 2;
}

.download-error-detail {
  margin: 8px 0;
}

.manual-path {
  margin: 8px 0;
}

.manual-path code {
  font-family: var(--font-mono, monospace);
  background: rgba(255, 0, 110, 0.1);
  padding: 2px 8px;
  border-radius: 4px;
  color: var(--neon-pink, #ff006e);
  word-break: break-all;
}

.download-links {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.download-link {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--neon-cyan, #00f5ff);
  text-decoration: none;
  word-break: break-all;
}

.download-link:hover {
  text-decoration: underline;
}

/* 响应式：窄屏配置行堆叠 */
@media (max-width: 700px) {
  .config-row {
    flex-direction: column;
    gap: 8px;
  }
  .config-row .row-label {
    padding-top: 0;
  }
}
</style>

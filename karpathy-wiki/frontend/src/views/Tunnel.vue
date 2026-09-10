<script setup lang="ts">
import { API_BASE, apiFetch } from '../utils/apiBase';
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  CopyDocument, TopRight, VideoPlay, VideoPause, Link, RefreshRight, Close, Setting, MagicStick, Check, Key, CirclePlus, Connection,
} from '@element-plus/icons-vue';
import type {
  TunnelStatus,
  TunnelConfigData,
  TunnelConfigBody,
  TunnelDownloadError,
  TunnelAuthError,
  CloudflareLoginStartResult,
  CloudflareLoginStatusResult,
} from '../types';

// ===== 运行状态与配置 =====
const status = ref<TunnelStatus | null>(null);
const config = ref<TunnelConfigData | null>(null);
const loading = ref(true);
const starting = ref(false);
const stopping = ref(false);
const saving = ref(false);

// ===== 表单状态（独立于 config，保存后才同步）=====
const formProvider = ref<'cloudflare' | 'cpolar' | 'tailscale'>('cloudflare');
const formAuthtoken = ref('');
const formPort = ref(0);
const formBinaryPath = ref('');
const formAutoStart = ref(false);
const formTunnelMode = ref<'quick' | 'named'>('quick');

// ===== 错误状态 =====
// 二进制下载失败时展示手动放置指引
const downloadError = ref<TunnelDownloadError | null>(null);
// Tailscale Funnel 首次授权时展示授权向导
const authError = ref<TunnelAuthError | null>(null);

// ===== Named Tunnel 向导状态 =====
const wizardVisible = ref(false);
// el-steps 的 active 属性：0=login, 1=create, 2=route-dns
const wizardStep = ref(0);
const loginResult = ref<CloudflareLoginStartResult | null>(null);
const loginStatus = ref<CloudflareLoginStatusResult | null>(null);
const loginPolling = ref(false);
const wizardTunnelName = ref('');
const wizardHostname = ref('');
const creatingTunnel = ref(false);
const routingDns = ref(false);
let loginPollTimer: ReturnType<typeof setInterval> | null = null;

// ===== 运行状态轮询定时器 =====
// 运行中时每 3 秒查询状态（检测子进程崩溃）
let pollTimer: ReturnType<typeof setInterval> | null = null;

const PROVIDER_LABELS: Record<string, string> = {
  cloudflare: 'Cloudflare Tunnel',
  cpolar: 'cpolar（国内推荐）',
  tailscale: 'Tailscale Funnel（免费固定地址）',
};

const PROVIDER_DESC: Record<string, string> = {
  cloudflare: '免注册，自动分配 trycloudflare 域名。大陆访问可能不稳定。支持 Named Tunnel 固定域名。',
  cpolar: '国内服务器稳定，需注册账号获取 authtoken。',
  tailscale: '免费固定 ts.net 地址，需预装 Tailscale 并登录。首次启用需浏览器授权。',
};

async function loadStatus() {
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.value = await res.json();
  } catch (err) {
    // 静默失败：轮询时弹错误会刷屏，仅控制台记录
    console.error('加载隧道状态失败:', err);
  }
}

async function loadConfig() {
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/config`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: TunnelConfigData = await res.json();
    config.value = data;
    formProvider.value = data.provider;
    formPort.value = data.localPort;
    formBinaryPath.value = data.binaryPath;
    formAutoStart.value = data.autoStart;
    formTunnelMode.value = data.tunnelMode;
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
  authError.value = null;
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/start`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      // 下载失败：渲染手动放置指引而非普通错误提示
      if (data.errorType === 'binary_download_failed') {
        downloadError.value = data as TunnelDownloadError;
      }
      // Tailscale 首次授权：渲染授权向导
      if (data.errorType === 'tailscale_funnel_auth') {
        authError.value = data as TunnelAuthError;
      }
      throw new Error(data.detail || `HTTP ${res.status}`);
    }
    status.value = data as TunnelStatus;
    ElMessage.success('隧道已启动');
  } catch (err) {
    // 下载失败和授权错误已通过 UI 渲染，这里仅在非这两种情况时弹错误
    if (!downloadError.value && !authError.value) {
      ElMessage.error('启动失败：' + (err as Error).message);
    }
  } finally {
    starting.value = false;
  }
}

async function stopTunnel() {
  stopping.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/stop`, { method: 'POST' });
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
      tunnelMode: formTunnelMode.value,
    };
    const res = await apiFetch(`${API_BASE}/tunnel/config`, {
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

// 切换 Provider 时自动保存，避免用户以为切换了但后端仍用旧 provider 启动
// 为什么自动保存：provider 是关键配置，切换后必须同步到 config.json，
// 否则点击"启动隧道"时后端读 config.json 会用旧 provider，导致"选 Tailscale 却报 cloudflared 下载失败"
async function onProviderChange() {
  // 隧道运行中切换 provider：先停止当前隧道，避免旧 provider 继续占用
  if (status.value?.status === 'running') {
    try {
      await apiFetch(`${API_BASE}/tunnel/stop`, { method: 'POST' });
      await loadStatus();
      ElMessage.info('已停止当前隧道，请手动启动新 Provider');
    } catch {
      // stop 失败不阻塞保存
    }
  }
  await saveConfig();
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

// ===== Named Tunnel 向导方法 =====

function openWizard() {
  wizardVisible.value = true;
  wizardStep.value = 0;
  loginResult.value = null;
  loginStatus.value = null;
  wizardTunnelName.value = config.value?.tunnelName || '';
  wizardHostname.value = config.value?.hostname || '';
}

function closeWizard() {
  wizardVisible.value = false;
  stopLoginPolling();
}

function stopLoginPolling() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }
  loginPolling.value = false;
}

async function startLogin() {
  loginPolling.value = true;
  loginResult.value = null;
  loginStatus.value = null;
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/cloudflare/login`, { method: 'POST' });
    const data: CloudflareLoginStartResult = await res.json();
    loginResult.value = data;
    if (data.status === 'failed') {
      loginPolling.value = false;
      ElMessage.error(data.message);
      return;
    }
    // waiting 状态：启动轮询
    startLoginPolling();
  } catch (err) {
    loginPolling.value = false;
    ElMessage.error('启动授权失败：' + (err as Error).message);
  }
}

function startLoginPolling() {
  stopLoginPolling();
  loginPolling.value = true;
  // 每 2.5s 轮询 login 状态，直到 success 或 failed
  loginPollTimer = setInterval(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/tunnel/cloudflare/login/status`);
      const data: CloudflareLoginStatusResult = await res.json();
      loginStatus.value = data;
      if (data.status === 'success') {
        stopLoginPolling();
        ElMessage.success('授权成功，cert.pem 已生成');
        wizardStep.value = 1;
      } else if (data.status === 'failed') {
        stopLoginPolling();
        ElMessage.error(data.message);
      }
    } catch (err) {
      console.error('轮询 login 状态失败:', err);
    }
  }, 2500);
}

async function createTunnel() {
  if (!wizardTunnelName.value.trim()) {
    ElMessage.warning('请输入隧道名称');
    return;
  }
  creatingTunnel.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/cloudflare/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tunnelName: wizardTunnelName.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    ElMessage.success(data.message || '隧道创建成功');
    wizardStep.value = 2;
  } catch (err) {
    ElMessage.error('创建隧道失败：' + (err as Error).message);
  } finally {
    creatingTunnel.value = false;
  }
}

async function routeDns() {
  if (!wizardHostname.value.trim()) {
    ElMessage.warning('请输入固定域名');
    return;
  }
  routingDns.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/tunnel/cloudflare/route-dns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname: wizardHostname.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    ElMessage.success(data.message || 'DNS 路由配置成功');
    wizardVisible.value = false;
    // 刷新配置：后端已自动切换到 named 模式并持久化 hostname
    await loadConfig();
  } catch (err) {
    ElMessage.error('DNS 路由配置失败：' + (err as Error).message);
  } finally {
    routingDns.value = false;
  }
}

// ===== Tailscale 授权处理 =====

function openAuthUrl() {
  if (authError.value?.authUrl) {
    window.open(authError.value.authUrl, '_blank');
  }
}

function dismissAuthError() {
  authError.value = null;
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
  stopLoginPolling();
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
            <el-button size="small" :icon="CopyDocument" data-tip="复制-复制公网地址到剪贴板" @click="copyUrl" />
            <el-button size="small" type="primary" :icon="TopRight" data-tip="打开-在新标签页打开公网地址" @click="openUrl" />
          </div>
        </div>
      </div>
      <div class="actions">
        <!-- 启动/停止按钮带 :disabled；disabled 的原生按钮不触发 mouseover，故外包 span 承载 data-tip 保证悬浮提示仍显示 -->
        <span class="tunnel-action-wrap" data-tip="启动隧道-启动内网穿透，将本地知识库服务暴露到公网">
          <el-button
            type="primary"
            :icon="VideoPlay"
            :loading="starting"
            :disabled="status?.status === 'running'"
            @click="startTunnel"
          />
        </span>
        <span class="tunnel-action-wrap" data-tip="停止隧道-停止当前穿透隧道，断开公网访问">
          <el-button
            type="danger"
            :icon="VideoPause"
            :loading="stopping"
            :disabled="status?.status !== 'running'"
            @click="stopTunnel"
          />
        </span>
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

    <!-- Tailscale 授权向导 -->
    <div class="glass-card" v-if="authError">
      <el-alert type="warning" :closable="false" show-icon>
        <template #title>Tailscale Funnel 需要授权</template>
        <div class="auth-detail">{{ authError.detail }}</div>
        <div class="auth-actions">
          <el-button type="primary" size="small" :icon="Link" data-tip="打开授权-在浏览器中打开 Tailscale Funnel 授权页面" @click="openAuthUrl" />
          <el-button size="small" :icon="RefreshRight" data-tip="重新启动-完成授权后重新启动隧道" @click="startTunnel" />
          <el-button size="small" :icon="Close" data-tip="取消-关闭此授权错误提示" @click="dismissAuthError" />
        </div>
      </el-alert>
    </div>

    <!-- 配置卡片 -->
    <div class="glass-card">
      <h2 class="card-title">穿透配置</h2>
      <div class="config-block">
        <!-- Provider 选择 -->
        <div class="config-row">
          <label class="row-label" for="tunnel-provider">Provider</label>
          <div class="row-value">
            <el-select id="tunnel-provider" v-model="formProvider" placeholder="选择穿透服务" @change="onProviderChange">
              <el-option label="Cloudflare Tunnel（免注册）" value="cloudflare" />
              <el-option label="cpolar（国内推荐）" value="cpolar" />
              <el-option label="Tailscale Funnel（免费固定地址）" value="tailscale" />
            </el-select>
            <div class="hint">{{ PROVIDER_DESC[formProvider] }}</div>
          </div>
        </div>

        <!-- Cloudflare 模式切换 -->
        <div class="config-row" v-if="formProvider === 'cloudflare'">
          <label class="row-label" for="tunnel-mode">隧道模式</label>
          <div class="row-value">
            <el-radio-group id="tunnel-mode" v-model="formTunnelMode">
              <el-radio value="quick">Quick（临时域名，免注册）</el-radio>
              <el-radio value="named">Named（固定域名，需配置）</el-radio>
            </el-radio-group>
            <div class="hint" v-if="formTunnelMode === 'quick'">
              每次启动分配不同的 trycloudflare 域名，开箱即用
            </div>
            <div class="hint" v-else>
              使用固定域名，需通过向导配置 Cloudflare 账号 + 隧道 + DNS
            </div>
          </div>
        </div>

        <!-- Named Tunnel 配置状态 -->
        <div class="config-row" v-if="formProvider === 'cloudflare' && formTunnelMode === 'named'">
          <span class="row-label">固定域名</span>
          <div class="row-value">
            <div v-if="config?.tunnelId" class="named-config-info">
              <div class="info-line">
                <span class="info-label">隧道 ID：</span>
                <code>{{ config.tunnelId }}</code>
              </div>
              <div class="info-line" v-if="config?.hostname">
                <span class="info-label">固定域名：</span>
                <code>{{ config.hostname }}</code>
              </div>
              <el-button size="small" type="primary" :icon="Setting" data-tip="重新配置-重新运行 Cloudflare Named 隧道配置向导" @click="openWizard" />
            </div>
            <div v-else class="named-config-empty">
              <el-button size="small" type="primary" :icon="MagicStick" data-tip="配置向导-打开 Cloudflare Named 隧道三步配置向导（授权→创建→绑定域名）" @click="openWizard" />
              <span class="hint">三步配置：授权登录 → 创建隧道 → 绑定域名</span>
            </div>
          </div>
        </div>

        <!-- cpolar Authtoken -->
        <div class="config-row" v-if="formProvider === 'cpolar'">
          <label class="row-label" for="tunnel-authtoken">Authtoken</label>
          <div class="row-value">
            <el-input
              id="tunnel-authtoken"
              v-model="formAuthtoken"
              type="password"
              show-password
              :placeholder="config?.cpolarAuthtokenConfigured ? '已配置，留空表示不修改' : '请输入 cpolar authtoken'"
            />
          </div>
        </div>

        <!-- Tailscale 前置条件 -->
        <div class="config-row" v-if="formProvider === 'tailscale'">
          <span class="row-label">前置条件</span>
          <div class="row-value">
            <div class="hint">
              1. 需预装 Tailscale：<a href="https://tailscale.com/download/windows" target="_blank">下载地址</a><br>
              2. 打开 Tailscale 并登录账号<br>
              3. 启用 MagicDNS（管理后台默认启用）<br>
              4. 首次启动隧道时需在浏览器完成 Funnel 授权
            </div>
          </div>
        </div>

        <!-- 本地端口 -->
        <div class="config-row">
          <label class="row-label" for="tunnel-port">本地端口</label>
          <div class="row-value">
            <el-input-number id="tunnel-port" v-model="formPort" :min="0" :max="65535" controls-position="right" />
            <div class="hint">0 = 自动继承服务端口</div>
          </div>
        </div>

        <!-- 二进制路径（Tailscale 不需要，检测系统安装）-->
        <div class="config-row" v-if="formProvider !== 'tailscale'">
          <label class="row-label" for="tunnel-binary-path">二进制路径</label>
          <div class="row-value">
            <el-input id="tunnel-binary-path" v-model="formBinaryPath" placeholder="留空则自动下载到 data/ 目录" />
          </div>
        </div>

        <!-- 开机自启 -->
        <div class="config-row">
          <label class="row-label" for="tunnel-auto-start">开机自启</label>
          <div class="row-value">
            <el-switch id="tunnel-auto-start" v-model="formAutoStart" />
            <span class="hint">服务启动时自动建立隧道</span>
          </div>
        </div>
      </div>
      <div class="actions">
        <el-button type="primary" :icon="Check" data-tip="保存配置-持久化穿透配置（Provider / 隧道模式 / Authtoken / 开机自启）" :loading="saving" @click="saveConfig" />
      </div>
    </div>

    <!-- Named Tunnel 配置向导 -->
    <el-dialog
      v-model="wizardVisible"
      title="Cloudflare Named Tunnel 配置向导"
      width="600px"
      :close-on-click-modal="false"
      @close="closeWizard"
    >
      <el-steps :active="wizardStep" finish-status="success" align-center>
        <el-step title="授权登录" />
        <el-step title="创建隧道" />
        <el-step title="配置 DNS" />
      </el-steps>

      <!-- Step 0: 授权登录 -->
      <div class="wizard-step-content" v-if="wizardStep === 0">
        <div class="wizard-desc">
          点击"开始授权"后，cloudflared 会启动 OAuth 流程。在浏览器中完成 Cloudflare 账号授权后，系统会自动检测 cert.pem 生成并进入下一步。
        </div>
        <div class="wizard-actions">
          <el-button type="primary" :icon="Key" data-tip="授权登录-打开 Cloudflare OAuth 授权登录流程" :loading="loginPolling" @click="startLogin" />
        </div>
        <div class="wizard-login-status" v-if="loginResult">
          <el-alert
            :type="loginResult.status === 'failed' ? 'error' : 'info'"
            :closable="false"
            show-icon
          >
            <template #title>{{ loginResult.message }}</template>
            <div v-if="loginResult.authUrl" class="auth-url-box">
              <a :href="loginResult.authUrl" target="_blank" class="auth-url-link">{{ loginResult.authUrl }}</a>
            </div>
            <div v-if="loginResult.output" class="login-output">
              <pre>{{ loginResult.output }}</pre>
            </div>
          </el-alert>
        </div>
        <div class="wizard-login-status" v-if="loginStatus && loginPolling">
          <el-alert type="info" :closable="false" show-icon>
            <template #title>{{ loginStatus.message }}</template>
            <div class="polling-hint">正在等待授权完成...</div>
          </el-alert>
        </div>
      </div>

      <!-- Step 1: 创建隧道 -->
      <div class="wizard-step-content" v-if="wizardStep === 1">
        <div class="wizard-desc">
          输入一个隧道名称（如 my-wiki-tunnel），系统会创建命名隧道并生成 credentials 文件。
        </div>
        <el-input
          v-model="wizardTunnelName"
          placeholder="隧道名称（字母、数字、连字符）"
          :disabled="creatingTunnel"
        />
        <div class="wizard-actions">
          <el-button type="primary" :icon="CirclePlus" data-tip="创建隧道-创建命名隧道并生成 credentials 文件" :loading="creatingTunnel" @click="createTunnel" />
        </div>
      </div>

      <!-- Step 2: 配置 DNS -->
      <div class="wizard-step-content" v-if="wizardStep === 2">
        <div class="wizard-desc">
          输入你要绑定的固定域名（如 wiki.example.com）。该域名的 DNS 必须由 Cloudflare 管理。配置成功后会自动切换到 Named 模式。
        </div>
        <el-input
          v-model="wizardHostname"
          placeholder="固定域名（如 wiki.example.com）"
          :disabled="routingDns"
        />
        <div class="wizard-actions">
          <el-button type="primary" :icon="Connection" data-tip="配置DNS-为固定域名配置 Cloudflare DNS 解析并切换到 Named 模式" :loading="routingDns" @click="routeDns" />
        </div>
      </div>
    </el-dialog>

    <!-- 使用说明 -->
    <div class="glass-card">
      <h2 class="card-title">使用说明</h2>
      <ol class="usage-list">
        <li>选择 Provider：
          <ul>
            <li><b>Cloudflare</b>：免注册即用，Quick 模式开箱即用，Named 模式支持固定域名</li>
            <li><b>cpolar</b>：国内推荐，需注册获取 authtoken</li>
            <li><b>Tailscale</b>：免费固定 ts.net 地址，需预装 Tailscale</li>
          </ul>
        </li>
        <li>如选 cpolar，需到官网注册获取 authtoken 并填入</li>
        <li>如选 Cloudflare Named 模式，点击"开始配置向导"完成三步配置</li>
        <li>如选 Tailscale，确保已安装登录，首次启动需浏览器授权</li>
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
  border: 1px solid var(--accent-cyan-a15, rgba(0, 245, 255, 0.15));
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 8px 32px var(--accent-purple-a20, rgba(0, 0, 0, 0.3));
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
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
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

/* 包裹 disabled 按钮的容器：让图标按钮仍能水平对齐（disabled 原生按钮不触发 mouseover，data-tip 挂在此容器上） */
.tunnel-action-wrap {
  display: inline-flex;
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

.usage-list ul {
  margin: 4px 0;
  padding-left: 20px;
}

.download-error-detail {
  margin: 8px 0;
}

.manual-path {
  margin: 8px 0;
}

.manual-path code {
  font-family: var(--font-mono, monospace);
  background: var(--accent-pink-a10, rgba(255, 0, 110, 0.1));
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

/* Tailscale 授权向导 */
.auth-detail {
  margin: 8px 0;
}

.auth-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}

/* Named Tunnel 配置信息 */
.named-config-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-line {
  font-size: 13px;
  color: var(--text-soft, #ccc);
}

.info-line code {
  font-family: var(--font-mono, monospace);
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
  padding: 2px 8px;
  border-radius: 4px;
  color: var(--neon-cyan, #00f5ff);
  word-break: break-all;
}

.named-config-empty {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* 向导对话框内容 */
.wizard-step-content {
  padding: 20px 0;
}

.wizard-desc {
  font-size: 13px;
  color: var(--text-soft, #ccc);
  line-height: 1.6;
  margin-bottom: 16px;
}

.wizard-actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

.wizard-login-status {
  margin-top: 16px;
}

.auth-url-box {
  margin-top: 8px;
}

.auth-url-link {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--neon-cyan, #00f5ff);
  word-break: break-all;
}

.login-output pre {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-dim, #888);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow-y: auto;
}

.polling-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-dim, #888);
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

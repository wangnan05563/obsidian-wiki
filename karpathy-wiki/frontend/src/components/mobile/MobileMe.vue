<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useAuthStore } from '../../stores/auth';
import RobotAvatar from '../RobotAvatar.vue';
import {
  loadAiUserConfig,
  saveAiUserConfig,
  DEFAULT_AI_USER_CONFIG,
  type AiUserConfig,
} from '../../services/userConfig';

// 移动端「我的」页（SRS FR-ME）：用户资料 + BYOK（AI 服务密钥）配置 + 登出。
// BYOK 复用 services/userConfig 的 per-user IndexedDB 命名空间（密钥仅存本地，不落服务端）。
const authStore = useAuthStore();
const userId = computed(() => authStore.user?.id ?? '');

const cfg = ref<AiUserConfig>({ ...DEFAULT_AI_USER_CONFIG });
const providerOptions = ['glm', 'openai', 'deepseek', 'qwen', 'anthropic', 'custom'];

const saving = ref(false);
const saved = ref(false);
const loadError = ref('');

// BYOK 是否已配置：有非空 apiKey 即视为可用（问答将使用用户自有密钥）
const byokConfigured = computed(() =>
  !!cfg.value.apiKey && cfg.value.apiKey.trim().length > 0,
);

const roleLabel: Record<string, string> = {
  admin: '管理员',
  user: '用户',
  guest: '游客',
};

onMounted(async () => {
  if (!userId.value) return;
  try {
    cfg.value = await loadAiUserConfig(userId.value);
  } catch {
    loadError.value = '读取本地配置失败，将使用默认值';
  }
});

async function save() {
  if (!userId.value) return;
  saving.value = true;
  saved.value = false;
  try {
    // 传入纯对象副本：userConfig.saveUserConfig 内部会深拷贝剥离响应式代理
    await saveAiUserConfig(userId.value, { ...cfg.value });
    saved.value = true;
    setTimeout(() => (saved.value = false), 2000);
  } finally {
    saving.value = false;
  }
}

async function logout() {
  await authStore.logout();
  // 登录门由 MobileShell 监听 authStore.isLoggedIn 自动切回登录页
}
</script>

<template>
  <div class="mme-root">
    <!-- 用户资料卡 -->
    <section class="mme-profile glass-card">
      <RobotAvatar :size="56" />
      <div class="mme-profile-info">
        <div class="mme-username">{{ authStore.user?.username }}</div>
        <span class="mme-role" :class="`role-${authStore.user?.role}`">
          {{ roleLabel[authStore.user?.role ?? ''] ?? authStore.user?.role }}
        </span>
      </div>
    </section>

    <!-- BYOK（AI 服务密钥）配置 -->
    <section class="mme-card">
      <div class="mme-card-head">
        <h2 class="mme-card-title">AI 服务（BYOK）</h2>
        <span class="mme-status" :class="byokConfigured ? 'ok' : 'warn'">
          {{ byokConfigured ? '已配置' : '未配置' }}
        </span>
      </div>
      <p class="mme-card-desc">
        知识问答需使用你自己的 API Key（按需付费、额度隔离）。密钥仅保存在本机，不会上传服务器。
      </p>

      <div v-if="loadError" class="mme-warn-text">{{ loadError }}</div>

      <div class="mme-field">
        <label class="mme-label">服务商</label>
        <select v-model="cfg.provider" class="mme-input">
          <option v-for="p in providerOptions" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>

      <div class="mme-field">
        <label class="mme-label">Base URL</label>
        <input v-model="cfg.baseUrl" class="mme-input" type="text" placeholder="https://…" />
      </div>

      <div class="mme-field">
        <label class="mme-label">模型</label>
        <input v-model="cfg.model" class="mme-input" type="text" placeholder="如 glm-4-plus" />
      </div>

      <div class="mme-field">
        <label class="mme-label">API Key</label>
        <input v-model="cfg.apiKey" class="mme-input" type="password" placeholder="输入你的密钥" autocomplete="off" />
      </div>

      <button class="mme-save" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : (saved ? '已保存 ✓' : '保存配置') }}
      </button>
    </section>

    <button class="mme-logout" @click="logout">退出登录</button>
  </div>
</template>

<style scoped>
.mme-root {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-family: var(--font-body);
}

.glass-card,
.mme-card {
  background: var(--mg-bg);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: var(--mg-border);
  border-radius: 16px;
  box-shadow: var(--mg-highlight), var(--mg-shadow);
}

.mme-profile {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
}

.mme-profile-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.mme-username {
  font-family: var(--font-mono);
  font-size: 17px;
  font-weight: 700;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mme-role {
  align-self: flex-start;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 8px;
  letter-spacing: 0.5px;
}

.mme-role.role-admin {
  background: var(--accent-magenta-a20, rgba(255, 0, 110, 0.2));
  color: var(--neon-magenta);
  border: 1px solid var(--accent-magenta-a30, rgba(255, 0, 110, 0.3));
}

.mme-role.role-user {
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
  color: var(--neon-cyan);
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
}

.mme-role.role-guest {
  background: var(--accent-purple-a10, rgba(176, 38, 255, 0.1));
  color: var(--text-soft);
  border: 1px solid var(--accent-purple-a30, rgba(176, 38, 255, 0.3));
}

.mme-card {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mme-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mme-card-title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 800;
  margin: 0;
  color: var(--text-bright);
}

.mme-status {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 8px;
}

.mme-status.ok {
  background: rgba(0, 245, 255, 0.12);
  color: var(--neon-cyan);
  border: 1px solid var(--accent-cyan-a30, rgba(0, 245, 255, 0.3));
}

.mme-status.warn {
  background: rgba(255, 170, 0, 0.14);
  color: #ffb020;
  border: 1px solid rgba(255, 170, 0, 0.35);
}

.mme-card-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-soft);
  margin: 0;
}

.mme-warn-text {
  font-size: 12px;
  color: #ffb020;
}

.mme-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.mme-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-soft);
}

.mme-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 44px;
  padding: 10px 14px;
  font-size: 15px;
  color: var(--text-bright);
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--accent-purple-a30);
  box-shadow: var(--mg-highlight-soft);
  border-radius: 10px;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.mme-input:focus {
  border-color: var(--neon-cyan);
  box-shadow: 0 0 0 2px var(--accent-cyan-a08);
}

select.mme-input {
  background-image: linear-gradient(45deg, transparent 50%, var(--text-soft) 50%),
    linear-gradient(135deg, var(--text-soft) 50%, transparent 50%);
  background-position: calc(100% - 18px) center, calc(100% - 13px) center;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}

.mme-save {
  margin-top: 4px;
  min-height: 48px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #fff;
  background: var(--grad-fire);
  border: none;
  border-radius: 12px;
  cursor: pointer;
  transition: transform 0.2s ease, opacity 0.2s ease;
  box-shadow: 0 4px 16px var(--accent-pink-a30, rgba(255, 0, 110, 0.3));
}

.mme-save:hover:not(:disabled) {
  transform: translateY(-1px);
}

.mme-save:active:not(:disabled) {
  transform: scale(0.98);
}

.mme-save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.mme-logout {
  min-height: 48px;
  font-size: 15px;
  font-weight: 600;
  color: var(--neon-magenta);
  background: transparent;
  border: 1px solid var(--accent-pink-a30, rgba(255, 0, 110, 0.3));
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.25s ease;
}

.mme-logout:hover {
  background: var(--accent-pink-a10, rgba(255, 0, 110, 0.1));
}
</style>

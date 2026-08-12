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
import { useMobileTheme } from '../../composables/useMobileTheme';

// 移动端「我的」页（SRS FR-ME）：用户资料 + BYOK（AI 服务密钥）配置 + 登出。
// BYOK 复用 services/userConfig 的 per-user IndexedDB 命名空间（密钥仅存本地，不落服务端）。
const authStore = useAuthStore();
// 主题切换（毛玻璃 / 浅白）：与 MobileShell 共享模块级单例，切换即时联动并持久化
const { theme: mobileTheme, setTheme } = useMobileTheme();
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
    <section class="mme-profile">
      <RobotAvatar :size="56" />
      <div class="mme-profile-info">
        <div class="mme-username">{{ authStore.user?.username }}</div>
        <span class="mme-role" :class="`role-${authStore.user?.role}`">
          {{ roleLabel[authStore.user?.role ?? ''] ?? authStore.user?.role }}
        </span>
      </div>
    </section>

    <!-- 外观主题切换：毛玻璃 / 浅白（实时切换，localStorage 持久化）-->
    <section class="mme-theme">
      <div class="mme-theme-head">
        <h2 class="mme-card-title">外观主题</h2>
        <span class="mme-theme-hint">实时切换 · 下次记住</span>
      </div>
      <div class="mme-seg" role="group" aria-label="外观主题切换">
        <button
          class="mme-seg-item"
          :class="{ active: mobileTheme === 'glass' }"
          type="button"
          :aria-pressed="mobileTheme === 'glass'"
          @click="setTheme('glass')"
        >
          <span class="mme-seg-ico" aria-hidden="true">◈</span>毛玻璃
        </button>
        <button
          class="mme-seg-item"
          :class="{ active: mobileTheme === 'light' }"
          type="button"
          :aria-pressed="mobileTheme === 'light'"
          @click="setTheme('light')"
        >
          <span class="mme-seg-ico" aria-hidden="true">▢</span>浅白
        </button>
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
  color: var(--m-text, #111111);
}

.mme-profile,
.mme-card {
  background: var(--m-surface, #f5f6f8);
  border: 1px solid var(--m-border, #ececee);
  border-radius: 12px;
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
  font-size: 17px;
  font-weight: 700;
  color: var(--m-text, #111111);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mme-role {
  align-self: flex-start;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 6px;
  letter-spacing: 0.5px;
}

.mme-role.role-admin {
  background: rgba(15, 76, 129, 0.1);
  color: var(--m-primary, #0f4c81);
}

.mme-role.role-user {
  background: rgba(15, 76, 129, 0.06);
  color: var(--m-primary, #0f4c81);
}

.mme-role.role-guest {
  background: var(--m-border, #ececee);
  color: var(--m-muted, #777777);
}

.mme-card {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 外观主题切换分段控件（毛玻璃 / 浅白）*/
.mme-theme {
  padding: 16px;
  background: var(--m-surface, #f5f6f8);
  border: 1px solid var(--m-border, #ececee);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mme-theme-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.mme-theme-hint {
  font-size: 11px;
  color: var(--m-muted, #777777);
}

.mme-seg {
  display: flex;
  gap: 6px;
  padding: 4px;
  background: var(--m-fill, #eceef1);
  border-radius: 10px;
  box-sizing: border-box;
}

.mme-seg-item {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 40px;
  font-size: 14px;
  font-weight: 600;
  color: var(--m-text-2, #777777);
  background: transparent;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-family: var(--m-font);
  -webkit-tap-highlight-color: transparent;
  transition: background 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
}

.mme-seg-item.active {
  background: var(--m-primary-soft, rgba(21, 84, 209, 0.08));
  color: var(--m-primary, #0f4c81);
  box-shadow: var(--m-highlight-soft, 0 1px 3px rgba(0, 0, 0, 0.12));
}

.mme-seg-ico {
  font-size: 14px;
  line-height: 1;
}

.mme-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mme-card-title {
  font-size: 15px;
  font-weight: 700;
  margin: 0;
  color: var(--m-text, #111111);
}

.mme-status {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 6px;
}

.mme-status.ok {
  background: rgba(15, 76, 129, 0.1);
  color: var(--m-primary, #0f4c81);
}

.mme-status.warn {
  background: rgba(249, 171, 0, 0.12);
  color: #b76e00;
}

.mme-card-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--m-muted, #777777);
  margin: 0;
}

.mme-warn-text {
  font-size: 12px;
  color: #b76e00;
}

.mme-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.mme-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--m-muted, #777777);
}

.mme-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 44px;
  padding: 10px 14px;
  font-size: 15px;
  color: var(--m-text, #111111);
  background: #ffffff;
  border: 1px solid var(--m-border, #ececee);
  border-radius: 10px;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  transition: border-color 0.15s ease;
}

.mme-input:focus {
  border-color: var(--m-primary, #0f4c81);
}

.mme-input::placeholder {
  color: #aaaaaa;
}

select.mme-input {
  background-image:
    linear-gradient(45deg, transparent 50%, var(--m-muted, #777777) 50%),
    linear-gradient(135deg, var(--m-muted, #777777) 50%, transparent 50%);
  background-position: calc(100% - 18px) center, calc(100% - 13px) center;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}

.mme-save {
  margin-top: 4px;
  min-height: 46px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: #ffffff;
  background: var(--m-primary, #0f4c81);
  border: none;
  border-radius: 10px;
  cursor: pointer;
}

.mme-save:active:not(:disabled) {
  opacity: 0.92;
}

.mme-save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.mme-logout {
  min-height: 46px;
  font-size: 15px;
  font-weight: 600;
  color: #d93025;
  background: #ffffff;
  border: 1px solid var(--m-border, #ececee);
  border-radius: 10px;
  cursor: pointer;
}

.mme-logout:active {
  background: var(--m-surface, #f5f6f8);
}
</style>

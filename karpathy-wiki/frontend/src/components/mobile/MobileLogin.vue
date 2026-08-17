<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '../../stores/auth';
import RobotAvatar from '../RobotAvatar.vue';

// 移动端登录/注册页（SRS FR-AUTH）：复用 authStore.login / authStore.register。
// 登录/注册成功后 authStore.isLoggedIn 变 true，由 MobileShell 登录门自动切到主界面。
const authStore = useAuthStore();

// vite.config.ts 配置了 base: '/wiki/'，CSS 中不能直接用 import.meta，
// 故在脚本层计算 BASE_URL 再注入模板样式变量
const baseUrl = import.meta.env.BASE_URL;

const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const loading = ref(false);
const errorMsg = ref('');

async function submit() {
  if (!username.value.trim() || !password.value) {
    errorMsg.value = '请输入用户名和密码';
    return;
  }
  if (mode.value === 'register' && password.value !== confirmPassword.value) {
    errorMsg.value = '两次输入的密码不一致';
    return;
  }
  loading.value = true;
  errorMsg.value = '';
  try {
    let ok = false;
    if (mode.value === 'login') {
      ok = await authStore.login({ username: username.value.trim(), password: password.value });
    } else {
      ok = await authStore.register({
        username: username.value.trim(),
        password: password.value,
        confirmPassword: confirmPassword.value,
      });
    }
    if (!ok) {
      errorMsg.value = authStore.error || (mode.value === 'login' ? '登录失败' : '注册失败');
    }
  } finally {
    // 无论成功/失败/异常都复位 loading，避免卡在「处理中…」（state-machine-simplify-rule）
    loading.value = false;
  }
}

function toggleMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login';
  errorMsg.value = '';
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !loading.value) submit();
}
</script>

<template>
  <div
    class="mlogin-root"
    :style="{ '--login-bg': `url(${baseUrl}images/login/mobile-login-bg.jpg)` }"
  >
    <div class="mlogin-card">
      <div class="mlogin-brand">
        <RobotAvatar :size="56" />
        <h1 class="mlogin-title">AI 知识库</h1>
        <p class="mlogin-sub">{{ mode === 'login' ? '登录以继续使用' : '创建你的账户' }}</p>
      </div>

      <div class="mlogin-form">
        <input
          v-model="username"
          class="mlogin-input"
          type="text"
          inputmode="text"
          autocomplete="username"
          placeholder="用户名"
          :disabled="loading"
          @keydown="onKeydown"
        />
        <input
          v-model="password"
          class="mlogin-input"
          type="password"
          autocomplete="current-password"
          placeholder="密码"
          :disabled="loading"
          @keydown="onKeydown"
        />
        <input
          v-if="mode === 'register'"
          v-model="confirmPassword"
          class="mlogin-input"
          type="password"
          autocomplete="new-password"
          placeholder="确认密码"
          :disabled="loading"
          @keydown="onKeydown"
        />

        <div v-if="errorMsg" class="mlogin-error">{{ errorMsg }}</div>

        <button
          class="mlogin-btn"
          :disabled="loading || !username || !password"
          @click="submit"
        >
          {{ loading ? '处理中…' : (mode === 'login' ? '登 录' : '注 册') }}
        </button>

        <div class="mlogin-switch">
          {{ mode === 'login' ? '还没有账号？' : '已有账号？' }}
          <span class="mlogin-switch-link" @click="toggleMode">
            {{ mode === 'login' ? '去注册' : '去登录' }}
          </span>
        </div>

        <div v-if="mode === 'login'" class="mlogin-hint">
          <span>默认账户：</span>
          <code>admin/admin123</code>
          <code>user/user123</code>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mlogin-root {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 20px calc(24px + env(safe-area-inset-bottom, 0));
  background:
    linear-gradient(180deg, rgba(8, 12, 22, 0.42) 0%, rgba(6, 10, 18, 0.78) 100%),
    var(--login-bg, #070a12);
  background-size: cover;
  background-position: center;
  font-family: var(--font-body);
}

.mlogin-card {
  width: 100%;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 28px;
  padding: 34px 26px;
  background: rgba(18, 24, 38, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 22px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}

.mlogin-brand {
  text-align: center;
}

.mlogin-brand :deep(.cognition-icon) {
  margin: 0 auto 14px;
}

.mlogin-title {
  font-size: 26px;
  font-weight: 800;
  margin: 0 0 6px;
  color: #ffffff;
  letter-spacing: 0.5px;
}

.mlogin-sub {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.62);
  margin: 0;
}

.mlogin-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.mlogin-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 48px;
  padding: 12px 16px;
  font-size: 16px;
  color: #ffffff;
  background: rgba(255, 255, 255, 0.10);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  outline: none;
  transition: border-color 0.15s ease, background 0.15s ease;
  -webkit-appearance: none;
  appearance: none;
}

.mlogin-input::placeholder {
  color: rgba(255, 255, 255, 0.45);
}

.mlogin-input:focus {
  border-color: rgba(255, 255, 255, 0.42);
  background: rgba(255, 255, 255, 0.14);
}

.mlogin-input:disabled {
  opacity: 0.55;
}

.mlogin-input:-webkit-autofill,
.mlogin-input:-webkit-autofill:hover,
.mlogin-input:-webkit-autofill:focus {
  -webkit-text-fill-color: #ffffff;
  -webkit-box-shadow: 0 0 0px 1000px rgba(255, 255, 255, 0.10) inset;
  transition: background-color 5000s ease-in-out 0s;
}

.mlogin-error {
  padding: 10px 12px;
  font-size: 13px;
  color: #ff7d72;
  background: rgba(217, 48, 37, 0.12);
  border: 1px solid rgba(217, 48, 37, 0.25);
  border-radius: 8px;
}

.mlogin-btn {
  width: 100%;
  min-height: 48px;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #ffffff;
  background: #2b7de1;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(43, 125, 225, 0.28);
  transition: transform 0.1s ease, box-shadow 0.15s ease;
}

.mlogin-btn:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: 0 4px 14px rgba(43, 125, 225, 0.28);
}

.mlogin-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mlogin-switch {
  text-align: center;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.72);
}

.mlogin-switch-link {
  color: #8ec5ff;
  font-weight: 600;
  cursor: pointer;
}

.mlogin-hint {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.58);
  padding: 10px;
  border: 1px dashed rgba(255, 255, 255, 0.18);
  border-radius: 8px;
}

.mlogin-hint code {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 2px 6px;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  color: #8ec5ff;
}
</style>

<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '../../stores/auth';
import RobotAvatar from '../RobotAvatar.vue';

// 移动端登录/注册页（SRS FR-AUTH）：复用 authStore.login / authStore.register。
// 登录/注册成功后 authStore.isLoggedIn 变 true，由 MobileShell 登录门自动切到主界面。
const authStore = useAuthStore();

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
  <div class="mlogin-root">
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
  background: #ffffff;
  font-family: var(--font-body);
}

.mlogin-card {
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 28px;
  padding: 28px 22px;
  background: #ffffff;
  border: 1px solid var(--m-border, #ececee);
  border-radius: 16px;
}

.mlogin-brand {
  text-align: center;
}

.mlogin-brand :deep(.robot-avatar) {
  margin: 0 auto 14px;
}

.mlogin-title {
  font-size: 24px;
  font-weight: 800;
  margin: 0 0 6px;
  color: var(--m-text, #111111);
}

.mlogin-sub {
  font-size: 13px;
  color: var(--m-muted, #777777);
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
  color: var(--m-text, #111111);
  background: var(--m-surface, #f5f6f8);
  border: 1px solid var(--m-border, #ececee);
  border-radius: 10px;
  outline: none;
  transition: border-color 0.15s ease, background 0.15s ease;
  -webkit-appearance: none;
  appearance: none;
}

.mlogin-input::placeholder {
  color: #aaaaaa;
}

.mlogin-input:focus {
  border-color: var(--m-primary, #0f4c81);
  background: #ffffff;
}

.mlogin-input:disabled {
  opacity: 0.6;
}

.mlogin-error {
  padding: 10px 12px;
  font-size: 13px;
  color: #d93025;
  background: rgba(217, 48, 37, 0.06);
  border: 1px solid rgba(217, 48, 37, 0.15);
  border-radius: 8px;
}

.mlogin-btn {
  width: 100%;
  min-height: 48px;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #ffffff;
  background: var(--m-primary, #0f4c81);
  border: none;
  border-radius: 10px;
  cursor: pointer;
}

.mlogin-btn:active:not(:disabled) {
  opacity: 0.92;
}

.mlogin-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mlogin-switch {
  text-align: center;
  font-size: 14px;
  color: var(--m-muted, #777777);
}

.mlogin-switch-link {
  color: var(--m-primary, #0f4c81);
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
  color: var(--m-muted, #777777);
  padding: 10px;
  border: 1px dashed var(--m-border, #ececee);
  border-radius: 8px;
}

.mlogin-hint code {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 2px 6px;
  background: var(--m-surface, #f5f6f8);
  border-radius: 4px;
  color: var(--m-primary, #0f4c81);
}
</style>

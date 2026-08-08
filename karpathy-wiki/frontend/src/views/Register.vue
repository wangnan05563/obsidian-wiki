<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useTheme } from '../composables/useTheme';
import CognitionIcon from '../components/CognitionIcon.vue';

// 注册页面：Luminous Cognition 主题自适应（视觉语言与 Login.vue 一致）
// 简易机制：仅用户名 + 密码（+ 确认密码）；注册成功后由 auth store 自动登录
const authStore = useAuthStore();
const { currentTheme } = useTheme();
const emit = defineEmits<{ (e: 'switch-to-login'): void }>();

const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const loading = ref(false);
const errorMsg = ref('');
const fieldError = ref('');

// 浅色主题清单：与 useTheme.ts 中的视觉分类保持一致
const lightThemes = ['macaron', 'ecommerce'];
const bgImage = computed(() => {
  const isLight = lightThemes.includes(currentTheme.value);
  return isLight
    ? `${import.meta.env.BASE_URL}images/login/bg-light.png`
    : `${import.meta.env.BASE_URL}images/login/bg-dark.png`;
});

// 提交前前端格式校验（与后端规则一致，提前拦截）
function validate(): boolean {
  fieldError.value = '';
  if (!username.value || !password.value) {
    fieldError.value = '请输入用户名和密码';
    return false;
  }
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username.value)) {
    fieldError.value = '用户名须为 3-32 位字母、数字或下划线';
    return false;
  }
  if (password.value.length < 8 || password.value.length > 64) {
    fieldError.value = '密码长度须为 8-64 位';
    return false;
  }
  if (confirmPassword.value && password.value !== confirmPassword.value) {
    fieldError.value = '两次输入的密码不一致';
    return false;
  }
  return true;
}

async function handleRegister() {
  if (!validate()) return;
  loading.value = true;
  errorMsg.value = '';
  const ok = await authStore.register({
    username: username.value,
    password: password.value,
    confirmPassword: confirmPassword.value || undefined,
  });
  loading.value = false;
  // 注册成功：auth store 已写入 token + user，App.vue 的 isLoggedIn 自动切换为主应用
  if (!ok) {
    errorMsg.value = authStore.error || '注册失败';
  }
}

function goLogin() {
  emit('switch-to-login');
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') handleRegister();
}
</script>

<template>
  <div class="login-page">
    <Transition name="bg-fade" mode="out-in">
      <div
        :key="bgImage"
        class="login-bg"
        :style="{ backgroundImage: `url(${bgImage})` }"
      />
    </Transition>

    <div class="login-scrim" />

    <div class="login-card glass-card">
      <div class="login-header">
        <CognitionIcon :size="72" floating />
        <h1 class="login-title grad-text">AI 知识库</h1>
        <p class="login-subtitle">创建账户以开始</p>
      </div>

      <div class="login-form">
        <div class="form-field">
          <label class="form-label" for="reg-username">用户名</label>
          <input
            id="reg-username"
            v-model="username"
            type="text"
            class="form-input"
            placeholder="3-32 位字母、数字或下划线"
            :disabled="loading"
            @keydown="handleKeydown"
          />
        </div>

        <div class="form-field">
          <label class="form-label" for="reg-password">密码</label>
          <input
            id="reg-password"
            v-model="password"
            type="password"
            class="form-input"
            placeholder="8-64 位"
            :disabled="loading"
            @keydown="handleKeydown"
          />
        </div>

        <div class="form-field">
          <label class="form-label" for="reg-confirm">确认密码</label>
          <input
            id="reg-confirm"
            v-model="confirmPassword"
            type="password"
            class="form-input"
            placeholder="再次输入密码"
            :disabled="loading"
            @keydown="handleKeydown"
          />
        </div>

        <div v-if="fieldError" class="login-error">{{ fieldError }}</div>
        <div v-else-if="errorMsg" class="login-error">{{ errorMsg }}</div>

        <button
          class="login-btn"
          :disabled="loading || !username || !password"
          @click="handleRegister"
        >
          {{ loading ? '注册中...' : '注 册' }}
        </button>

        <div class="login-switch">
          已有账号？
          <a class="switch-link" @click="goLogin">去登录</a>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  overflow: hidden;
}

.login-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  z-index: 0;
  will-change: opacity;
}

.login-scrim {
  position: absolute;
  inset: 0;
  z-index: 1;
  background: radial-gradient(
    ellipse 55% 55% at 50% 50%,
    var(--bg-void) 0%,
    transparent 100%
  );
  pointer-events: none;
}

.login-card {
  position: relative;
  z-index: 2;
  width: 100%;
  max-width: 400px;
  padding: 40px 32px;
  border-radius: var(--radius-card, 16px);
  background: var(--bg-glass);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--accent-purple-a30);
  box-shadow: 0 8px 32px var(--accent-purple-a20, rgba(0, 0, 0, 0.2));
}

.login-header {
  text-align: center;
  margin-bottom: 32px;
}

.login-header :deep(.cognition-icon) {
  margin: 0 auto 12px;
}

.login-title {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 900;
  margin: 0 0 4px;
}

.login-subtitle {
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--text-soft);
  margin: 0;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-soft);
}

.form-input {
  padding: 10px 14px;
  font-size: 14px;
  font-family: var(--font-body);
  color: var(--text-bright);
  background: var(--bg-card-solid, rgba(255, 255, 255, 0.05));
  border: 1px solid var(--accent-purple-a30);
  border-radius: var(--radius-btn, 8px);
  outline: none;
  transition: all 0.3s ease;
}

.form-input:focus {
  border-color: var(--neon-cyan);
  box-shadow: 0 0 0 2px var(--accent-cyan-a08);
}

.form-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.login-error {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--neon-magenta);
  background: var(--accent-pink-a10);
  border-radius: var(--radius-btn, 8px);
  border: 1px solid var(--accent-pink-a30);
}

.login-btn {
  padding: 12px 20px;
  font-size: 14px;
  font-weight: 700;
  font-family: var(--font-body);
  color: #fff;
  background: var(--grad-fire);
  border: none;
  border-radius: var(--radius-btn, 8px);
  cursor: pointer;
  transition: all 0.3s ease;
  letter-spacing: 1px;
  box-shadow: 0 4px 16px var(--accent-pink-a30, rgba(255, 0, 110, 0.3));
}

.login-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 6px 24px var(--accent-pink-a40, rgba(255, 0, 110, 0.4));
}

.login-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.login-switch {
  margin-top: 4px;
  text-align: center;
  font-size: 13px;
  color: var(--text-soft);
}

.switch-link {
  color: var(--neon-cyan);
  cursor: pointer;
  font-weight: 600;
  margin-left: 4px;
}

.switch-link:hover {
  text-decoration: underline;
}

/* 背景 crossfade 过渡 */
.bg-fade-enter-active,
.bg-fade-leave-active {
  transition: opacity 0.8s ease;
}
.bg-fade-enter-from,
.bg-fade-leave-to {
  opacity: 0;
}
</style>

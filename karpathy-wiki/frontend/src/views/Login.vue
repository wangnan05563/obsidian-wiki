<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import RobotAvatar from '../components/RobotAvatar.vue';

// 登录页面：本地优先应用最简登录
// 为什么不引入复杂认证（OAuth/SSO）：本地应用无需第三方身份提供商
// UI 风格：与主应用保持一致（毛玻璃卡片 + 霓虹色系 + 圆角）
const authStore = useAuthStore();

const username = ref('');
const password = ref('');
const loading = ref(false);
const errorMsg = ref('');

async function handleLogin() {
  if (!username.value || !password.value) {
    errorMsg.value = '请输入用户名和密码';
    return;
  }
  loading.value = true;
  errorMsg.value = '';
  const ok = await authStore.login({
    username: username.value,
    password: password.value,
  });
  loading.value = false;
  if (!ok) {
    errorMsg.value = authStore.error || '登录失败';
  }
  // 登录成功由父组件监听 isLoggedIn 切换视图，此处无需处理
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') handleLogin();
}
</script>

<template>
  <div class="login-page">
    <div class="login-card glass-card">
      <div class="login-header">
        <RobotAvatar :size="64" />
        <h1 class="login-title grad-text">AI 知识库</h1>
        <p class="login-subtitle">请登录以继续</p>
      </div>

      <div class="login-form">
        <div class="form-field">
          <label class="form-label" for="login-username">用户名</label>
          <input
            id="login-username"
            v-model="username"
            type="text"
            class="form-input"
            placeholder="请输入用户名"
            :disabled="loading"
            @keydown="handleKeydown"
          />
        </div>

        <div class="form-field">
          <label class="form-label" for="login-password">密码</label>
          <input
            id="login-password"
            v-model="password"
            type="password"
            class="form-input"
            placeholder="请输入密码"
            :disabled="loading"
            @keydown="handleKeydown"
          />
        </div>

        <div v-if="errorMsg" class="login-error">{{ errorMsg }}</div>

        <button
          class="login-btn"
          :disabled="loading || !username || !password"
          @click="handleLogin"
        >
          {{ loading ? '登录中...' : '登 录' }}
        </button>

        <div class="login-hint">
          <span>默认账户：</span>
          <code>admin/admin123</code>
          <code>user/user123</code>
          <code>guest/guest123</code>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  padding: 40px 32px;
  border-radius: var(--radius-card, 16px);
  background: var(--bg-glass);
  backdrop-filter: blur(20px);
  border: 1px solid var(--accent-purple-a30);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.login-header {
  text-align: center;
  margin-bottom: 32px;
}

.login-header :deep(.robot-avatar) {
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
  box-shadow: 0 4px 16px rgba(255, 0, 110, 0.3);
}

.login-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 6px 24px rgba(255, 0, 110, 0.4);
}

.login-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.login-hint {
  margin-top: 12px;
  padding: 10px 12px;
  font-size: 11px;
  color: var(--text-dim);
  background: rgba(255, 255, 255, 0.03);
  border-radius: var(--radius-btn, 8px);
  border: 1px dashed var(--accent-purple-a30);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.login-hint code {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 2px 6px;
  background: rgba(0, 245, 255, 0.08);
  border-radius: 4px;
  color: var(--neon-cyan);
}
</style>

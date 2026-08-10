<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useTheme } from '../composables/useTheme';
import CognitionIcon from '../components/CognitionIcon.vue';

// 登录页面：Luminous Cognition 主题自适应
// 背景图随主题相位切换：浅色主题（macaron/ecommerce）→ bg-light，深色主题 → bg-dark
// 为什么不用 CSS filter 反色：会破坏 PNG 原画质感，两套图分别由同一渲染脚本生成，色彩精准
const authStore = useAuthStore();
const { currentTheme } = useTheme();
const emit = defineEmits<{ (e: 'switch-to-register'): void }>();

function goRegister() {
  emit('switch-to-register');
}

const username = ref('');
const password = ref('');
const loading = ref(false);
const errorMsg = ref('');

// 浅色主题清单：与 useTheme.ts 中的视觉分类保持一致
const lightThemes = ['macaron', 'ecommerce'];
// 为什么用 import.meta.env.BASE_URL：vite.config.ts 配置了 base: '/wiki/'，
// 硬编码 '/images/...' 会被浏览器解析为 host 根路径导致 404，必须拼接 base 前缀
const bgImage = computed(() => {
  const isLight = lightThemes.includes(currentTheme.value);
  return isLight
    ? `${import.meta.env.BASE_URL}images/login/bg-light.png`
    : `${import.meta.env.BASE_URL}images/login/bg-dark.png`;
});

async function handleLogin() {
  if (!username.value || !password.value) {
    errorMsg.value = '请输入用户名和密码';
    return;
  }
  loading.value = true;
  errorMsg.value = '';
  try {
    const ok = await authStore.login({
      username: username.value,
      password: password.value,
    });
    if (!ok) {
      errorMsg.value = authStore.error || '登录失败';
    }
  } finally {
    // 无论成功/失败/异常都复位 loading，避免卡在「登录中…」（state-machine-simplify-rule）
    loading.value = false;
  }
  // 登录成功由父组件监听 isLoggedIn 切换视图，此处无需处理
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') handleLogin();
}
</script>

<template>
  <div class="login-page">
    <!-- 主题自适应背景层：cover 全屏，crossfade 过渡 -->
    <Transition name="bg-fade" mode="out-in">
      <div
        :key="bgImage"
        class="login-bg"
        :style="{ backgroundImage: `url(${bgImage})` }"
      />
    </Transition>

    <!-- 背景蒙版：保证卡片可读性，深浅主题分级 -->
    <div class="login-scrim" />

    <div class="login-card glass-card">
      <div class="login-header">
        <CognitionIcon :size="72" floating />
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

        <div class="login-switch">
          还没有账号？
          <a class="switch-link" @click="goRegister">去注册</a>
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

/* 背景图层：cover 全屏，定位在 z=0 */
.login-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  z-index: 0;
  /* 背景缓入：与 crossfade 配合 */
  will-change: opacity;
}

/* 主题切换时背景 crossfade 过渡 */
.bg-fade-enter-active,
.bg-fade-leave-active {
  transition: opacity 0.8s ease;
}
.bg-fade-enter-from,
.bg-fade-leave-to {
  opacity: 0;
}

/* 蒙版：增强卡片可读性；opacity 由 scrimOpacity 响应式控制 */
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

/* 卡片：z=2，位于背景与蒙版之上 */
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
  background: var(--accent-cyan-a08, rgba(0, 245, 255, 0.08));
  border-radius: 4px;
  color: var(--neon-cyan);
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
</style>

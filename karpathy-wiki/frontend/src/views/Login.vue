<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useTheme } from '../composables/useTheme';
import { API_BASE } from '../utils/apiBase';
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

// T02454（PRD A3）：密码可见性切换，与配置中心/内网穿透的密钥框体验对齐
const showPassword = ref(false);

// T02453（PRD A1）：默认账户提示仅在 localOnly 调试模式显示（GET /api/auth/bootstrap 门控），
// 生产环境彻底隐藏默认口令，杜绝「guest/guest123」明文暴露带来的未授权访问风险
const showDefaultHint = ref(false);
onMounted(async () => {
  try {
    const res = await fetch(`${API_BASE}/auth/bootstrap`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json() as { ok?: boolean; showDefaultAccountHint?: boolean };
    showDefaultHint.value = data.ok === true && data.showDefaultAccountHint === true;
  } catch {
    // 探测失败时保守隐藏（生产安全优先于调试便利）
    showDefaultHint.value = false;
  }
});

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
          <div class="pwd-wrap">
            <input
              id="login-password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              class="form-input pwd-input"
              placeholder="请输入密码"
              :disabled="loading"
              @keydown="handleKeydown"
            />
            <!-- T02454（PRD A3）：密码可见性切换，与凭据输入基线（配置中心/内网穿透）对齐 -->
            <button
              type="button"
              class="pwd-toggle"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              :aria-pressed="showPassword"
              :disabled="loading"
              @click="showPassword = !showPassword"
            >
              <svg v-if="!showPassword" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
                <path d="M3 3 L21 21" />
              </svg>
            </button>
          </div>
        </div>

        <!-- T02454（PRD A2）：无自助找回通道，明示「联系管理员」路径，避免断头路 -->
        <div class="login-forgot">忘记密码？请联系管理员在「用户管理」中重置</div>

        <div v-if="errorMsg" class="login-error">{{ errorMsg }}</div>

        <button
          class="login-btn"
          :disabled="loading || !username || !password"
          @click="handleLogin"
        >
          {{ loading ? '登录中...' : '登 录' }}
        </button>

        <!-- T02453（PRD A1）：默认账户提示仅 localOnly 调试模式可见，且带「仅本地调试」限定语 -->
        <div v-if="showDefaultHint" class="login-hint">
          <span>默认账户（仅本地调试）：</span>
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

/* T02454（A3）：密码可见性切换容器与按钮（与配置中心密钥框体验对齐） */
.pwd-wrap {
  position: relative;
}

.pwd-input {
  padding-right: 40px;
}

.pwd-toggle {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  padding: 4px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-soft);
  border-radius: var(--radius-btn, 8px);
  transition: color 0.2s ease;
}

.pwd-toggle:hover:not(:disabled) {
  color: var(--neon-cyan);
}

.pwd-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* T02454（A2）：忘记密码指引——无自助找回，明示联系管理员路径 */
.login-forgot {
  margin-top: -4px;
  text-align: right;
  font-size: 12px;
  color: var(--text-soft);
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

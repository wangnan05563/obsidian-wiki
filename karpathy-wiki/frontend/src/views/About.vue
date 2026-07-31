<script setup lang="ts">
import { API_BASE } from '../utils/apiBase';
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { CopyDocument, Refresh, Check, Top, Warning, Search } from '@element-plus/icons-vue';

// ===== 类型定义 =====
interface BuildInfo {
  version: string;
  buildDate: string;
  gitSha: string;
  node: string;
  platform: string;
}

// 检查更新状态机：idle → loading → (latest | newer | error)
// latest 3s 后自动回 idle；newer/error 为终态保持，让用户充分阅读
type UpdateState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'latest' }
  | { kind: 'newer'; url: string; latest: string }
  | { kind: 'error'; reason: 'network' | 'server' };

interface MenuItem {
  key: string;
  label: string;
  href: string;
  external: boolean;
  // internal 类型点击触发 SPA 内跳转，由父组件处理
  internal?: boolean;
}

interface Dependency {
  name: string;
  version: string;
  license: string;
  repo: string;
}

// ===== 文案集中 =====
const TEXTS = {
  pageTitle: '关于',
  productName: 'Karpathy Wiki',
  h1Title: '关于 Karpathy Wiki',
  versionLabel: '版本',
  releasedOn: '发布于',
  copyHint: '复制完整版本号',
  copyAriaLabel: '复制版本号',
  copied: '已复制',
  copyFailed: '复制失败，请手动选择',
  updateIdle: '检查更新',
  updateLoading: '检查中…',
  updateLatest: '已是最新',
  updateNewer: '有新版本',
  updateErrorNetwork: '网络异常',
  updateErrorServer: '服务异常',
  updateRetry: '重试',
  updateAutoCheckHint: '每 5 分钟自动检查一次',
  footerCopyright: 'Karpathy Wiki',
  riskDisclaimer: '本工具仅供个人学习研究使用，详见 README 中的"风险免责"',
  menu: {
    terms: '用户协议',
    privacy: '隐私条款',
    licenses: '开源软件声明',
    help: '帮助文档',
    api: 'API 文档',
    contact: '联系我们',
    community: '官方社区',
    report: '报告问题',
  },
  licensesSearchPlaceholder: '搜索依赖名 / 许可证…',
  licensesTitle: '开源软件声明',
  licensesFooter: '以运行时实际安装为准',
  emptySearch: '未找到匹配的依赖',
};

// ===== 兜底值 =====
const FALLBACK_INFO: BuildInfo = {
  version: '--',
  buildDate: '--',
  gitSha: 'unknown',
  node: '--',
  platform: '--',
};

// ===== 8 项菜单（参考闲鱼 §5.1）=====
const MENU_ITEMS: MenuItem[] = [
  // GitHub 仓库主页作为用户协议入口（暂用占位，部署时改）
  { key: 'terms', label: TEXTS.menu.terms, href: 'https://github.com/karpathy/karpathy.github.io', external: true },
  { key: 'privacy', label: TEXTS.menu.privacy, href: 'https://github.com/karpathy/karpathy.github.io', external: true },
  // licenses 触发 Modal，不走链接
  { key: 'licenses', label: TEXTS.menu.licenses, href: '#licenses', external: false },
  // help 为 SPA 内链，由父组件 App.vue 监听 custom event 切换视图
  { key: 'help', label: TEXTS.menu.help, href: '#help', external: false, internal: true },
  // 本项目无 OpenAPI Swagger，API 文档链接到 GitHub README
  { key: 'api', label: TEXTS.menu.api, href: 'https://github.com/karpathy/karpathy.github.io', external: true },
  { key: 'contact', label: TEXTS.menu.contact, href: 'mailto:noreply@karpathy.wiki', external: true },
  { key: 'community', label: TEXTS.menu.community, href: 'https://github.com/karpathy/karpathy.github.io/discussions', external: true },
  { key: 'report', label: TEXTS.menu.report, href: 'https://github.com/karpathy/karpathy.github.io/issues/new', external: true },
];

// ===== 静态依赖清单（首版手动维护，P2 接入 license-checker 自动生成）=====
// 数据来源：frontend/package.json + api/package.json
const FRONTEND_DEPS: Dependency[] = [
  { name: '@element-plus/icons-vue', version: '^2.3.0', license: 'MIT', repo: 'https://github.com/element-plus/element-plus-icons' },
  { name: 'element-plus', version: '^2.6.0', license: 'MIT', repo: 'https://github.com/element-plus/element-plus' },
  { name: 'markdown-it', version: '^14.1.0', license: 'MIT', repo: 'https://github.com/markdown-it/markdown-it' },
  { name: 'pinia', version: '^2.1.0', license: 'MIT', repo: 'https://github.com/vuejs/pinia' },
  { name: 'vis-data', version: '^8.0.4', license: 'Apache-2.0', repo: 'https://github.com/visjs/vis-network' },
  { name: 'vis-network', version: '^10.1.0', license: 'Apache-2.0/MIT', repo: 'https://github.com/visjs/vis-network' },
  { name: 'vue', version: '^3.4.0', license: 'MIT', repo: 'https://github.com/vuejs/core' },
  { name: '@vitejs/plugin-vue', version: '^5.0.0', license: 'MIT', repo: 'https://github.com/vitejs/vite-plugin-vue' },
  { name: 'typescript', version: '^5.4.0', license: 'Apache-2.0', repo: 'https://github.com/microsoft/TypeScript' },
  { name: 'vite', version: '^5.1.0', license: 'MIT', repo: 'https://github.com/vitejs/vite' },
  { name: 'vue-tsc', version: '^2.0.0', license: 'MIT', repo: 'https://github.com/vuejs/language-tools' },
];

const BACKEND_DEPS: Dependency[] = [
  { name: 'fastify', version: '^4.26.0', license: 'MIT', repo: 'https://github.com/fastify/fastify' },
  { name: '@fastify/multipart', version: '^8.1.0', license: 'MIT', repo: 'https://github.com/fastify/fastify-multipart' },
  { name: '@fastify/static', version: '^7.0.0', license: 'MIT', repo: 'https://github.com/fastify/fastify-static' },
  { name: '@fastify/cors', version: '^9.0.0', license: 'MIT', repo: 'https://github.com/fastify/fastify-cors' },
  { name: '@fastify/helmet', version: '^11.0.0', license: 'MIT', repo: 'https://github.com/fastify/fastify-helmet' },
  { name: '@fastify/rate-limit', version: '^9.0.0', license: 'MIT', repo: 'https://github.com/fastify/fastify-rate-limit' },
  { name: 'gray-matter', version: '^4.0.3', license: 'MIT', repo: 'https://github.com/jonschlinkert/gray-matter' },
  { name: 'tsx', version: '^4.7.0', license: 'MIT', repo: 'https://github.com/privatenumber/tsx' },
];

// 全部依赖按字母序排序
const ALL_DEPS: Dependency[] = [...FRONTEND_DEPS, ...BACKEND_DEPS].sort((a, b) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
);

// ===== 状态 =====
const info = ref<BuildInfo>(FALLBACK_INFO);
const licensesOpen = ref(false);
const search = ref('');
const updateState = ref<UpdateState>({ kind: 'idle' });

// 自动检查与 idle 回退的 timer 句柄
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let autoCheckTimer: ReturnType<typeof setInterval> | null = null;
let mountDelayTimer: ReturnType<typeof setTimeout> | null = null;
let isChecking = false;

// 搜索过滤依赖列表
const filteredDeps = computed(() => {
  const kw = search.value.trim().toLowerCase();
  if (!kw) return ALL_DEPS;
  return ALL_DEPS.filter(
    (d) => d.name.toLowerCase().includes(kw) || d.license.toLowerCase().includes(kw),
  );
});

// ===== API 调用 =====
async function loadInfo() {
  try {
    const res = await fetch(`${API_BASE}/about`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    info.value = {
      version: data.version || '--',
      buildDate: data.build_date || '--',
      gitSha: data.git_sha || 'unknown',
      node: data.node || '--',
      platform: data.platform || '--',
    };
  } catch {
    // 失败用 FALLBACK 兜底，不阻塞列表渲染
  }
}

// 网络错误判定：fetch 抛 TypeError 通常为网络中断
function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  return false;
}

// 检查更新：自动/手动共用，避免重复代码
async function performCheck() {
  if (isChecking) return; // 防止自动+手动并发
  isChecking = true;
  updateState.value = { kind: 'loading' };
  try {
    const res = await fetch(`${API_BASE}/about/check-update`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.has_update) {
      updateState.value = {
        kind: 'newer',
        url: data.release_url || '',
        latest: data.latest || '',
      };
    } else {
      updateState.value = { kind: 'latest' };
      // 3s 后自动回 idle，让按钮恢复可点击
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        // 仅在当前为 latest 时回退，避免覆盖 newer/error 终态
        if (updateState.value.kind === 'latest') {
          updateState.value = { kind: 'idle' };
        }
      }, 3000);
    }
  } catch (e) {
    updateState.value = { kind: 'error', reason: isNetworkError(e) ? 'network' : 'server' };
  } finally {
    isChecking = false;
  }
}

// 手动检查：用户点击「检查更新」按钮
async function handleCheck() {
  await performCheck();
}

// 复制版本号到剪贴板
async function handleCopy() {
  try {
    await navigator.clipboard.writeText(info.value.version);
    ElMessage.success(TEXTS.copied);
  } catch {
    ElMessage.warning(TEXTS.copyFailed);
  }
}

// 菜单项点击：licenses 触发 Modal，help 触发 SPA 内跳转
function handleMenuClick(item: MenuItem, e: MouseEvent) {
  if (item.key === 'licenses') {
    e.preventDefault();
    licensesOpen.value = true;
  } else if (item.internal && item.key === 'help') {
    e.preventDefault();
    // 派发自定义事件，由 App.vue 监听切换到 Help 视图
    globalThis.dispatchEvent(new CustomEvent('karpathy:navigate', { detail: 'help' }));
  }
}

// 打开新版本 release 页面（newer 状态按钮点击）
function openReleaseUrl(url: string) {
  if (url) {
    globalThis.open(url, '_blank', 'noopener,noreferrer');
  }
}

onMounted(() => {
  loadInfo();
  // 5s 后发起首次自动检查
  mountDelayTimer = setTimeout(() => {
    performCheck();
  }, 5000);
  // 启动 5 分钟定期检查（与后端缓存对齐）
  autoCheckTimer = setInterval(() => {
    performCheck();
  }, 5 * 60 * 1000);
});

onBeforeUnmount(() => {
  // 卸载时清理所有 timer，避免内存泄漏与对已卸载组件调用 setState
  if (mountDelayTimer) clearTimeout(mountDelayTimer);
  if (autoCheckTimer) clearInterval(autoCheckTimer);
  if (idleTimer) clearTimeout(idleTimer);
});
</script>

<template>
  <div class="about-page">
    <div class="glass-card about-card">
      <div class="card-deco"></div>

      <div class="about-head">
        <div class="head-text">
          <h2 class="head-title grad-text">{{ TEXTS.h1Title }}</h2>
          <p class="head-tip">版本信息 · 系统元数据 · 文档资源</p>
        </div>
      </div>

      <!-- 品牌卡：版本号 + 发布日期 + Git SHA + 检查更新 -->
      <div class="brand-card hover-glow">
        <div class="brand-left">
          <div class="brand-logo">KW</div>
          <div class="brand-info">
            <div class="version-row">
              <span class="version-label">{{ TEXTS.versionLabel }}:</span>
              <span class="version-value">{{ info.version }}</span>
              <el-tooltip :content="TEXTS.copyHint" placement="top">
                <button
                  class="icon-btn"
                  :aria-label="TEXTS.copyAriaLabel"
                  @click="handleCopy"
                >
                  <el-icon><CopyDocument /></el-icon>
                </button>
              </el-tooltip>
            </div>
            <div class="meta-row">
              <span class="meta-text">{{ TEXTS.releasedOn }} {{ info.buildDate }}</span>
              <span v-if="info.gitSha && info.gitSha !== 'unknown'" class="meta-sha">@{{ info.gitSha }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-dim">Node {{ info.node }} · {{ info.platform }}</span>
            </div>
          </div>
        </div>

        <!-- 检查更新按钮：五态渲染 -->
        <div class="update-btn-wrap">
          <el-tooltip
            v-if="updateState.kind === 'idle'"
            :content="TEXTS.updateAutoCheckHint"
            placement="top"
          >
            <el-button type="primary" :icon="Refresh" @click="handleCheck">
              {{ TEXTS.updateIdle }}
            </el-button>
          </el-tooltip>

          <el-button v-else-if="updateState.kind === 'loading'" loading>
            {{ TEXTS.updateLoading }}
          </el-button>

          <el-button v-else-if="updateState.kind === 'latest'" type="success" :icon="Check" disabled>
            {{ TEXTS.updateLatest }}
          </el-button>

          <el-button
            v-else-if="updateState.kind === 'newer'"
            type="primary"
            :icon="Top"
            @click="openReleaseUrl(updateState.url)"
          >
            {{ TEXTS.updateNewer }} ({{ updateState.latest }})
          </el-button>

          <el-button
            v-else
            type="danger"
            :icon="Warning"
            @click="handleCheck"
          >
            {{ updateState.reason === 'network' ? TEXTS.updateErrorNetwork : TEXTS.updateErrorServer }} · {{ TEXTS.updateRetry }}
          </el-button>
        </div>
      </div>

      <!-- 外部链接列表 -->
      <div class="menu-list">
        <a
          v-for="(item, idx) in MENU_ITEMS"
          :key="item.key"
          :href="item.href"
          :target="item.external ? '_blank' : undefined"
          :rel="item.external ? 'noopener noreferrer' : undefined"
          class="menu-item hover-glow"
          :class="{ 'last-item': idx === MENU_ITEMS.length - 1 }"
          @click="handleMenuClick(item, $event)"
        >
          <span class="menu-label">{{ item.label }}</span>
          <el-icon class="menu-arrow" aria-hidden="true">
            <Top />
          </el-icon>
        </a>
      </div>

      <!-- 底部版权 -->
      <div class="about-footer">
        <el-tooltip :content="TEXTS.riskDisclaimer" placement="top">
          <span class="footer-text">© {{ new Date().getFullYear() }} {{ TEXTS.footerCopyright }}</span>
        </el-tooltip>
      </div>
    </div>

    <!-- 开源软件声明 Modal -->
    <el-dialog
      v-model="licensesOpen"
      :title="TEXTS.licensesTitle"
      width="720"
      destroy-on-close
    >
      <el-input
        v-model="search"
        :placeholder="TEXTS.licensesSearchPlaceholder"
        :prefix-icon="Search"
        clearable
        style="margin-bottom: 16px"
      />
      <div class="licenses-list">
        <div v-if="filteredDeps.length === 0" class="empty-hint">
          {{ TEXTS.emptySearch }}
        </div>
        <div v-for="d in filteredDeps" :key="d.name" class="license-item">
          <a
            :href="d.repo"
            target="_blank"
            rel="noopener noreferrer"
            class="license-name"
          >
            {{ d.name }}
            <span class="license-version">@{{ d.version }}</span>
          </a>
          <el-tag size="small" type="info" class="license-tag">{{ d.license }}</el-tag>
        </div>
      </div>
      <template #footer>
        <span class="dialog-footer-hint">{{ TEXTS.licensesFooter }}</span>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.about-page {
  display: flex;
  flex-direction: column;
}

.about-card {
  position: relative;
  padding: 24px 28px;
  overflow: hidden;
  max-width: 820px;
  margin: 0 auto;
  width: 100%;
}

.card-deco {
  position: absolute;
  bottom: -50px;
  right: -40px;
  width: 220px;
  height: 220px;
  background: var(--grad-aurora);
  filter: blur(60px);
  opacity: 0.25;
  transform: rotate(18deg);
  border-radius: 50%;
  pointer-events: none;
  z-index: 0;
}

.about-head {
  position: relative;
  z-index: 1;
  margin-bottom: 20px;
}

.head-tag {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--neon-cyan);
  text-transform: uppercase;
  margin-bottom: 2px;
}

.head-title {
  margin: 0 0 2px;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 12px;
  font-family: var(--font-mono);
}

/* 品牌卡 */
.brand-card {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 18px 22px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
  margin-bottom: 20px;
  transition: all 0.3s ease;
}

.brand-left {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1;
  min-width: 0;
}

.brand-logo {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: var(--grad-aurora);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.05em;
  box-shadow: 0 0 18px var(--accent-purple-a40);
  flex-shrink: 0;
}

.brand-info {
  flex: 1;
  min-width: 0;
}

.version-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.version-label {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  letter-spacing: 0.05em;
}

.version-value {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.03em;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--accent-purple-a30);
  background: var(--bg-glass);
  color: var(--text-soft);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s ease;
  padding: 0;
}

.icon-btn:hover {
  border-color: var(--neon-cyan);
  color: var(--neon-cyan);
  box-shadow: var(--glow-cyan);
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
}

.meta-sha {
  font-family: var(--font-mono);
  color: var(--neon-purple);
}

.meta-dim {
  color: var(--text-dim);
  font-size: 11px;
}

.update-btn-wrap {
  flex-shrink: 0;
}

/* 菜单列表 */
.menu-list {
  position: relative;
  z-index: 1;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
  overflow: hidden;
  margin-bottom: 16px;
}

.menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  text-decoration: none;
  color: inherit;
  border-bottom: 1px solid var(--accent-purple-a10);
  transition: background-color 120ms cubic-bezier(0.2, 0, 0, 1);
  cursor: pointer;
}

.menu-item.last-item {
  border-bottom: none;
}

.menu-item:hover {
  background: var(--accent-purple-a08);
}

.menu-label {
  font-size: 14px;
  color: var(--text-base);
  font-family: var(--font-body);
  letter-spacing: 0.02em;
}

.menu-arrow {
  font-size: 12px;
  color: var(--text-dim);
  transform: rotate(45deg);
  transition: color 0.2s ease;
}

.menu-item:hover .menu-arrow {
  color: var(--neon-cyan);
}

/* 底部版权 */
.about-footer {
  position: relative;
  z-index: 1;
  text-align: center;
  padding-top: 8px;
}

.footer-text {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  letter-spacing: 0.05em;
  cursor: help;
}

/* 开源声明 Modal 内部 */
.licenses-list {
  max-height: 60vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.empty-hint {
  text-align: center;
  padding: 32px 0;
  color: var(--text-dim);
  font-size: 13px;
}

.license-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  transition: background 0.2s ease;
}

.license-item:hover {
  background: var(--accent-purple-a08);
}

.license-name {
  color: var(--text-base);
  text-decoration: none;
  font-size: 13px;
  font-family: var(--font-mono);
}

.license-name:hover {
  color: var(--neon-cyan);
}

.license-version {
  color: var(--text-dim);
  margin-left: 6px;
  font-size: 12px;
}

.license-tag {
  font-family: var(--font-mono);
}

.dialog-footer-hint {
  font-size: 12px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}

/* 响应式：小屏堆叠 */
@media (max-width: 600px) {
  .brand-card {
    flex-direction: column;
    align-items: stretch;
  }

  .update-btn-wrap {
    width: 100%;
  }

  .update-btn-wrap :deep(.el-button) {
    width: 100%;
  }
}
</style>

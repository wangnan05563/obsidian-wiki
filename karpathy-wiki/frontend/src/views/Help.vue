<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { Search } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
// T02482（PRD D4x）：本地数据保护表单（含 isUnlocked / backup 服务与按 owner 重载会话的 watch）
// 已整体迁至 components/LocalDataBackupPanel.vue，帮助页只留说明 + 直达按钮，此处不再直连这些模块。
// T02784（PRD「与代码同源」推广）：15 个章节的文案数据整体抽到 utils/helpDocSections——
// 页面只负责渲染；页面实名（菜单名 / 页签名 / 清理目标 / 问题分类 / 编译阶段词 / 守卫提示原文）
// 一律由单一来源导出拼接，不再在文档里抄第二份（回归测试 help-doc-code-sync.test.ts 盯住咬合）。
import { DOC_SECTIONS } from '../utils/helpDocSections';
// ===== 搜索过滤 =====
const search = ref('');

const filteredSections = computed(() => {
  if (!search.value.trim()) return DOC_SECTIONS;
  const kw = search.value.toLowerCase();
  return DOC_SECTIONS.filter(
    (s) => s.title.toLowerCase().includes(kw) || s.intro.toLowerCase().includes(kw),
  );
});

// ===== 锚点导航 =====
const activeAnchor = ref('');

// T02455（PRD D1x）：可点击直达——经 karpathy:navigate 事件切视图（App.vue 既有监听），
// tab 指令经 sessionStorage 传递（复用 karpathy:jumpPath 既有模式），目标视图挂载时消费并清除
function jumpTo(action: { view: string; tab?: string }) {
  if (action.tab) {
    try {
      sessionStorage.setItem('karpathy:navigate-tab', JSON.stringify({ view: action.view, tab: action.tab }));
    } catch {
      // 隐私模式等写入失败时静默降级：仅切视图，不定位 tab
    }
  }
  globalThis.dispatchEvent(new CustomEvent('karpathy:navigate', { detail: action.view }));
}

function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  activeAnchor.value = id;
  // 为什么手动驱动滚动而不是 scrollIntoView：.help-sidebar 自身 overflow-y:auto，
  // scrollIntoView 会滚动最近的可滚动祖先（即侧栏），导致正文不定位。页面整体滚动由
  // App.vue 外层 main.content 接管，须显式计算其在 .content 中的偏移并设置 scrollTop。
  const container = document.querySelector('.content');
  if (container) {
    // 用 getBoundingClientRect 差值换算目标相对滚动容器的位置，
    // 顶部留小量间距避免章节标题紧贴视口上缘
    const cRect = (container as HTMLElement).getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    (container as HTMLElement).scrollTo({
      top: (container as HTMLElement).scrollTop + (eRect.top - cRect.top) - 16,
      behavior: 'smooth',
    });
  } else {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// 监听滚动更新激活的锚点
// 注意：滚动由 App.vue 外层 main.content 统一接管，.help-content-area 自身无滚动，
// 因此 scroll-spy 必须监听 .content，否则下拉时高亮永不更新
function handleScroll() {
  const scrollContainer = document.querySelector('.content');
  if (!scrollContainer) return;
  // 找到离顶部最近的章节
  for (const section of DOC_SECTIONS) {
    const el = document.getElementById(section.id);
    if (el) {
      const rect = el.getBoundingClientRect();
      // 章节顶部距离视口顶部 80px 内视为激活
      if (rect.top >= 0 && rect.top < 120) {
        activeAnchor.value = section.id;
        break;
      }
    }
  }
}

onMounted(async () => {
  await nextTick();
  // 默认激活第一个章节
  if (DOC_SECTIONS.length > 0) {
    activeAnchor.value = DOC_SECTIONS[0].id;
  }
  const scrollContainer = document.querySelector('.content');
  if (scrollContainer) {
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
  }
});

// ===== 本地数据保护（T02482 / PRD D4x）=====
// 解锁 / 导出 / 导入表单已整体迁至 components/LocalDataBackupPanel.vue（配置中心「数据备份」页签挂载），
// 本页只留说明与直达按钮（jumpTo({view:'config', tab:'backup'})）。
// 随之迁走的还有：isUnlocked 状态同步、按 owner 隔离重载会话的 watch——它们只服务于那块表单。

// 复制代码块内容到剪贴板：优先 navigator.clipboard，失败降级 execCommand
// 为什么单独实现而非抽公共工具：仅此处使用，保持 Help.vue 自包含，避免引入额外依赖
async function handleCopyDocCode(text: string) {
  try {
    if (navigator.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    ElMessage.success('已复制');
  } catch {
    ElMessage.warning('复制失败，请手动选择');
  }
}

onBeforeUnmount(() => {
  const scrollContainer = document.querySelector('.content');
  if (scrollContainer) {
    scrollContainer.removeEventListener('scroll', handleScroll);
  }
});
</script>

<template>
  <div class="help-page">
    <div class="help-layout">
      <!-- 左侧侧栏：搜索 + 章节锚点 -->
      <aside class="help-sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">文档目录</span>
        </div>
        <el-input
          v-model="search"
          placeholder="搜索章节…"
          :prefix-icon="Search"
          size="small"
          clearable
          autocomplete="off"
          class="sidebar-search"
        />
        <nav class="anchor-nav">
          <a
            v-for="section in filteredSections"
            :key="section.id"
            :href="'#' + section.id"
            class="anchor-item"
            :class="{ active: activeAnchor === section.id }"
            @click.prevent="scrollToSection(section.id)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="anchor-icon">
              <path :d="section.icon" />
            </svg>
            <span class="anchor-label" :class="{ 'anchor-sub': section.sub }">{{ section.title }}</span>
          </a>
          <div v-if="filteredSections.length === 0" class="empty-anchor">
            未找到匹配的章节
          </div>
        </nav>
      </aside>

      <!-- 右侧内容区 -->
      <div class="help-content-area">
        <!-- 头部简介卡 -->
        <div class="glass-card intro-card">
          <div class="card-deco"></div>
          <div class="intro-content">
            <div class="intro-icon-wrap">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 2L11 7L16 9L11 11L9 16L7 11L2 9L7 7L9 2Z" />
              </svg>
            </div>
            <div class="intro-text">
              <!-- T02475（X1）：条目标题与菜单实名同词，原名降为副标题 -->
              <h2 class="intro-title grad-text">帮助文档</h2>
              <p class="intro-desc">
                Karpathy Wiki 使用文档。系统涵盖投递资料、编译、问答、图谱、体检、内网穿透全流程。本文档详细介绍各功能模块的使用方法，
                包括核心功能、操作步骤、使用场景、参数配置和注意事项。
              </p>
            </div>
          </div>
        </div>

        <!-- 各章节内容 -->
        <div
          v-for="section in filteredSections"
          :key="section.id"
          :id="section.id"
          class="glass-card section-card"
        >
          <div class="section-head">
            <div class="section-icon-wrap">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path :d="section.icon" />
              </svg>
            </div>
            <h3 class="section-title" :class="{ 'section-sub': section.sub }">{{ section.title }}</h3>
          </div>
          <p class="section-intro">{{ section.intro }}</p>
          <div class="section-divider"></div>

          <div class="blocks">
            <div v-for="block in section.blocks" :key="block.title" class="block">
              <div class="block-title">
                <span class="block-bullet" :class="block.type"></span>
                <span>{{ block.title }}</span>
              </div>

              <!-- feature / scenario / note：字符串 -->
              <p v-if="block.type === 'feature' || block.type === 'scenario'" class="block-text">
                {{ block.content }}
              </p>

              <p
                v-else-if="block.type === 'note'"
                class="block-text note-text"
                :class="'note-' + (block.noteType || 'info')"
              >
                {{ block.content }}
              </p>

              <!-- steps：有序列表 -->
              <div v-else-if="block.type === 'steps'" class="block-steps">
                <ol class="block-steps-list">
                  <li v-for="(step, idx) in (block.content as string[])" :key="idx">{{ step }}</li>
                </ol>
                <!-- T02455（D1x）：步骤配可点击直达按钮，路径与菜单实名一致 -->
                <button v-if="block.action" class="block-jump" @click="jumpTo(block.action)">
                  → {{ block.action.label }}
                </button>
              </div>

              <!-- config：参数表格 -->
              <div v-else-if="block.type === 'config'" class="block-config">
                <table>
                  <thead>
                    <tr>
                      <th>参数</th>
                      <th>示例</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, idx) in (block.content as Array<[string, string, string]>)" :key="idx">
                      <td><code>{{ row[0] }}</code></td>
                      <td class="cell-example">{{ row[1] }}</td>
                      <td class="cell-desc">{{ row[2] }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- code：代码块（原样展示 JSON / 命令等，含语言徽标 + 复制按钮） -->
              <div v-else-if="block.type === 'code'" class="block-code">
                <div class="block-code-head">
                  <span class="code-lang-badge" v-if="block.codeLang">{{ block.codeLang }}</span>
                </div>
                <button
                  class="code-copy-btn"
                  :title="`复制${block.codeLang ? ' ' + block.codeLang : ''}`"
                  @click="handleCopyDocCode(block.content as string)"
                >复制</button>
                <pre><code>{{ block.content }}</code></pre>
              </div>
            </div>
          </div>
        </div>

        <div v-if="filteredSections.length === 0" class="empty-content">
          未找到匹配的章节
        </div>

        <!-- 本地数据保护（T02482 / PRD D4x）：解锁/导出/导入表单已迁至配置中心「数据备份」页签，
             帮助页只留说明与直达——出问题时用户的第一站不该是文档页。表单行为口径在新家原样保留。 -->
        <div id="local-data" class="glass-card section-card local-data-card">
          <div class="section-head">
            <div class="section-icon-wrap">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
              </svg>
            </div>
            <h3 class="section-title">本地数据保护</h3>
          </div>
          <p class="section-intro">
            问答会话与附件仅保存在本地浏览器（IndexedDB）。可开启加密（基于登录密码派生密钥）以防同设备其他进程读取，
            并建议定期导出加密备份以防丢失。解锁、导出、导入的操作入口都在<b>配置中心 → 数据备份</b>页签，本页只提供说明与直达。
          </p>
          <div class="blocks">
            <div class="block">
              <div class="block-title">
                <span class="block-bullet scenario"></span>
                <span>什么时候需要它</span>
              </div>
              <p class="block-text note-text note-warning">
                风险 R-2：清除缓存 / 换设备 / 重装会导致本地数据丢失。备份使用<b>独立口令</b>，
                即使遗忘登录密码也可凭备份口令恢复本地数据；若本地数据被锁定，同样在「数据备份」页签用登录密码解锁。
              </p>
              <button class="block-jump" @click="jumpTo({ view: 'config', tab: 'backup' })">
                → 前往：配置中心 → 数据备份
              </button>
            </div>
          </div>
        </div>

        <!-- 底部 -->
        <div class="help-footer">
          <span class="footer-line"></span>
          <span class="footer-text">Karpathy Wiki · 帮助文档</span>
          <span class="footer-line"></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.help-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.help-layout {
  display: flex;
  gap: 16px;
  /* 高度交给内容决定（不加 height 锁死），否则 sticky 侧栏会被压死在视口高内、
   * 长内容溢出后吸顶失效。align-items: flex-start 避免侧栏被拉伸到全高。 */
  min-height: 100%;
  align-items: flex-start;
}

/* 左侧侧栏 */
.help-sidebar {
  width: 240px;
  flex-shrink: 0;
  padding: 16px 14px;
  background: var(--bg-card);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: var(--border-glass);
  border-radius: var(--radius-card);
  box-shadow: var(--glow-soft);
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  /* 目录树跟随屏幕：右侧内容下拉时侧栏吸附在视口顶部，始终可点击定位。
   * 滚动由外层 main.content 接管，sticky 相对它生效；max-height 限制在视口内，
   * 目录项过多时侧栏内部滚动而不溢出屏外。 */
  position: sticky;
  top: 0;
  max-height: calc(100vh - 24px);
}

.sidebar-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 4px;
}

.sidebar-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--neon-cyan);
  text-transform: uppercase;
}

.sidebar-title {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
}

.sidebar-search :deep(.el-input__wrapper) {
  background: var(--bg-scene, rgba(10, 1, 24, 0.4)) !important;
}

.anchor-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.anchor-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  text-decoration: none;
  color: var(--text-soft);
  font-size: 13px;
  font-family: var(--font-body);
  transition: all 0.2s ease;
  cursor: pointer;
}

.anchor-item:hover {
  background: var(--accent-purple-a12);
  color: var(--neon-cyan);
}

.anchor-item.active {
  background: var(--accent-purple-a20);
  color: var(--neon-magenta);
  text-shadow: 0 0 8px var(--accent-pink-a40);
}

.anchor-icon {
  flex-shrink: 0;
  opacity: 0.7;
}

.anchor-item.active .anchor-icon {
  opacity: 1;
}

.empty-anchor {
  padding: 16px 10px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
}

/* 右侧内容区
 * 滚动策略：让 .content (App.vue 外层) 统一接管滚动，自身不嵌套 overflow。
 * 原因：双重滚动（外层 + 内层）容易导致 flex 子项被压缩到 min-content 高度，
 *       章节卡片只显示标题一行、内容被裁切。把滚动交给外层后，
 *       卡片按内容自然高度撑开，整个页面自然出现一条滚动条 */
.help-content-area {
  flex: 1;
  min-width: 0;
  padding-right: 4px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 章节卡片不参与高度压缩，按内容自然撑开。
 * 为什么需要 flex-shrink: 0：flex 默认 0 1 auto，容器有限高度时会被等比压缩 */
.intro-card,
.section-card {
  flex-shrink: 0;
}

/* 头部简介卡 */
.intro-card {
  position: relative;
  padding: 20px 24px;
  overflow: hidden;
}

.intro-content {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.intro-icon-wrap {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: var(--grad-aurora);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
  box-shadow: 0 0 18px var(--accent-purple-a40);
}

.intro-text {
  flex: 1;
}

.intro-title {
  margin: 0 0 6px;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.intro-desc {
  margin: 0;
  color: var(--text-soft);
  font-size: 13px;
  line-height: 1.6;
}

/* 章节卡片 */
.section-card {
  padding: 20px 24px;
  scroll-margin-top: 16px;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.section-icon-wrap {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--accent-purple-a15);
  border: 1px solid var(--accent-purple-a30);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--neon-cyan);
  flex-shrink: 0;
}

.section-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.02em;
}

.section-intro {
  margin: 0 0 12px;
  color: var(--text-soft);
  font-size: 13px;
  padding-left: 46px;
}

.section-divider {
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent-purple-a30), transparent);
  margin: 0 0 16px;
}

/* 内容块 */
.blocks {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.block-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
  font-family: var(--font-body);
  letter-spacing: 0.02em;
}

.block-bullet {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.block-bullet.feature {
  background: var(--neon-cyan);
  box-shadow: 0 0 8px var(--neon-cyan);
}

.block-bullet.steps {
  background: var(--neon-lime);
  box-shadow: 0 0 8px var(--neon-lime);
}

.block-bullet.scenario {
  background: var(--neon-purple);
  box-shadow: 0 0 8px var(--neon-purple);
}

.block-bullet.config {
  background: var(--neon-pink);
  box-shadow: 0 0 8px var(--neon-pink);
}

.block-bullet.note {
  background: var(--neon-magenta);
  box-shadow: 0 0 8px var(--neon-magenta);
}

.block-text {
  margin: 0;
  color: var(--text-base);
  font-size: 13px;
  line-height: 1.65;
  padding-left: 16px;
}

.note-text {
  padding: 8px 12px;
  border-radius: 8px;
  border-left: 3px solid;
}

.note-text.note-info {
  background: var(--accent-cyan-a08);
  border-left-color: var(--neon-cyan);
}

.note-text.note-warning {
  background: var(--accent-pink-a08);
  border-left-color: var(--neon-magenta);
}

/* T02455：steps 块改为「列表 + 可选直达按钮」包装结构，列表样式下沉到 .block-steps-list */
.block-steps {
  padding-left: 0;
}

.block-steps-list {
  margin: 0;
  padding-left: 32px;
  color: var(--text-base);
  font-size: 13px;
  line-height: 1.7;
}

.block-steps-list li {
  margin-bottom: 4px;
}

/* T02455（D1x）：步骤配可点击直达按钮，路径与菜单实名一致 */
.block-jump {
  margin-top: 8px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--neon-cyan);
  background: var(--accent-cyan-a08);
  border: 1px solid var(--accent-cyan-a10);
  border-radius: var(--radius-btn, 8px);
  cursor: pointer;
  transition: all 0.2s ease;
}

.block-jump:hover {
  background: var(--accent-cyan-a10);
}

/* T02455（D2x）：子功能条目（配置中心下的 MCP 接口）缩进一级，不与一级菜单平级 */
.anchor-sub {
  padding-left: 16px;
  font-size: 12px;
  opacity: 0.85;
}

.section-sub {
  padding-left: 16px;
  font-size: 15px;
}

/* 配置表格 */
.block-config {
  padding-left: 16px;
  overflow-x: auto;
}

.block-config table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-family: var(--font-mono);
}

.block-config th {
  text-align: left;
  padding: 8px 12px;
  background: var(--accent-purple-a12);
  color: var(--text-bright);
  border-bottom: 1px solid var(--accent-purple-a30);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.block-config td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--accent-purple-a10);
  color: var(--text-soft);
}

.block-config code {
  background: var(--accent-cyan-a10);
  color: var(--neon-cyan);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
}

/* code 块：深色底 + 语言徽标 + 复制按钮，横向可滚动适配长 JSON */
.block-code {
  position: relative;
  margin-top: 8px;
}

.block-code pre {
  margin: 0;
  padding: 14px 16px;
  background: var(--accent-purple-a10);
  border: 1px solid var(--accent-purple-a25);
  border-radius: 8px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-bright);
  white-space: pre;
}

.block-code code {
  font-family: inherit;
}

.block-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.code-lang-badge {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--neon-purple);
  text-transform: uppercase;
}

.code-copy-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 2px 10px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-soft);
  background: var(--accent-purple-a12);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.code-copy-btn:hover {
  color: var(--neon-cyan);
  border-color: var(--accent-cyan-a50);
  background: var(--accent-cyan-a10);
}

.cell-example {
  color: var(--neon-purple) !important;
}

.cell-desc {
  color: var(--text-dim) !important;
}

.empty-content {
  text-align: center;
  padding: 64px 0;
  color: var(--text-dim);
  font-size: 13px;
}

/* 本地数据保护卡片（T02482 后只承载说明与直达，表单样式随组件迁至 LocalDataBackupPanel.vue） */
.local-data-card {
  border-left: 3px solid var(--neon-cyan);
}

/* 底部 */
.help-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
}

.footer-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--neon-purple), transparent);
}

.footer-text {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
  letter-spacing: 0.18em;
  white-space: nowrap;
}

/* 响应式：小屏隐藏侧栏，内容铺满
   T02916：侧栏 240px + 主栏在 901-1100 的侧栏壳下只剩约 500px 正文宽，
   与 ≤900 顶部横条态的 876px 相比反而更挤，故按内容列宽改判到 laptop(1100)。 */
@media (max-width: 1100px) {
  .help-sidebar {
    display: none;
  }

  .help-layout {
    gap: 0;
  }

  .section-intro {
    padding-left: 0;
  }
}
</style>

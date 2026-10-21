<script setup lang="ts">
import { API_BASE, apiFetch } from '../utils/apiBase';
import { computed, ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { CleanupBody, CleanupBlockedResponse, CleanupResult, CleanupStorageStatus } from '../types';
import { apiErrorMessage } from '../utils/apiError';
// T02719（PRD X2/X8 收尾）：卡片结果区的「无操作」小块是残留的自写空态方言（.result-empty），
// 与 T02476 已收敛的三态出口并存会让同一页两套空态措辞——并入 StateBlock 的行内 compact 形态。
import StateBlock from '../components/StateBlock.vue';
import {
  CLEANUP_CARDS,
  CLEANUP_PAGE_TIP,
  CLEANUP_PAGE_TITLE,
  advancedRows,
  buildPreviewBanner,
  cardOf,
  cleanupButtonState,
  confirmText,
  legacyRunStateHint,
  modeChip,
  previewSwitchHint,
  runStateDirRows,
  type CleanupCardKey,
} from '../utils/cleanupPresentation';

// 存储状态
const status = ref<CleanupStorageStatus | null>(null);
const loadingStatus = ref(false);

// 各卡独立表单：只剩「保留天数」。
// 「仅预览」不再是每卡一个开关（T02470 S2）——同一个语义摆 4 个开关，
// 用户以为只关了这张卡，实际可能 4 张都关着，于是真实删除了另外三类。
interface CleanupFormState {
  days: number;
}

const forms = reactive<Record<CleanupCardKey, CleanupFormState>>({
  compileCache: { days: 30 },
  runState: { days: 30 },
  runLogs: { days: 7 },
  rawArchive: { days: 30 },
});

/** 页级预览开关：默认开（安全侧），关掉才允许真实删除 */
const preview = ref(true);
const showAdvanced = ref(false);

const cards = CLEANUP_CARDS;
const bannerText = computed(() => buildPreviewBanner(preview.value));
const chip = computed(() => modeChip(preview.value));
const advanced = computed(() => advancedRows());
// T02808：「运行状态」原先只报一个合并数字，看不出这些文件落在几个位置、其中多少是历史落点。
// 路径与计数一律直接取后端 status.runState.dirs（即 getRunStateDirs() 的真实清单），
// 前端不重排也不改写字符串，页面显示的位置与后端真正扫描的位置因此始终是同一个值。
const runStateDirs = computed(() => runStateDirRows(status.value?.runState.dirs ?? []));
const legacyRunStateHintText = computed(() => legacyRunStateHint(status.value?.runState.dirs ?? []));

// T02655：把「现在到底有没有任务在跑」摆在页顶。
// 为什么还要额外摆一行：卡面置灰只在「有文件可删」时才生效，用户容易把
// 「无需清理」和「有任务进行中」两种禁用态混看；页顶这一行是唯一的活体指示。
// 数据只在 loadStatus 时刷新，可能滞后——滞后不会造成误删，因为真实删除由后端
// 当场再判一次（409），前端这一行只是让原因可见。
const activeHint = computed(() => {
  const active = status.value?.active;
  if (!active) return '';
  const parts: string[] = [];
  if (active.compile > 0) parts.push(`编译 ${active.compile}`);
  if (active.query > 0) parts.push(`问答 ${active.query}`);
  return parts.length > 0 ? `进行中任务：${parts.join(' · ')}` : '';
});

// 4 类独立 loading + result
const loadings = reactive<Record<string, boolean>>({
  compileCache: false,
  runState: false,
  runLogs: false,
  rawArchive: false,
});
const results = ref<Record<string, CleanupResult | null>>({
  compileCache: null,
  runState: null,
  runLogs: null,
  rawArchive: null,
});

function buttonState(key: CleanupCardKey) {
  return cleanupButtonState(key, status.value, preview.value);
}

async function loadStatus() {
  loadingStatus.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/cleanup/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.value = await res.json();
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载存储状态失败', err));
  } finally {
    loadingStatus.value = false;
  }
}

async function handleCleanup(key: CleanupCardKey) {
  const meta = cardOf(key);
  // 非预览模式必须二次确认，避免误删（与闲鱼 globalThis.confirm 等价）
  if (!preview.value) {
    try {
      await ElMessageBox.confirm(confirmText(meta.title), '危险操作确认', {
        confirmButtonText: '确认清理',
        cancelButtonText: '取消',
        type: 'warning',
      });
    } catch {
      // 用户取消
      return;
    }
  }

  loadings[key] = true;
  results.value[key] = null;
  try {
    const body: CleanupBody = {
      target: meta.target,
      dry_run: preview.value,
      // 仅 run_logs/raw_archive 按 days 清理，其他两类与时间无关
      ...(meta.showDays ? { days: forms[key].days } : {}),
    };
    const res = await apiFetch(`${API_BASE}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // T02655：409 = 后端硬拦截（有活跃任务时禁止真实删除）。
    // 不能走下面的通用「清理失败：HTTP 409」分支——那种文案既不说明拦了什么，
    // 也不告诉用户要等什么，只会让人再点一次。
    if (res.status === 409) {
      const blocked = (await res.json().catch(() => null)) as CleanupBlockedResponse | null;
      const headline = blocked?.error ?? '后端检测到进行中的任务，已拦截这次真实删除。';
      const details = (blocked?.reasons ?? []).filter((r) => r !== headline);
      ElMessage.warning(headline);
      results.value[key] = {
        target: meta.target,
        days: forms[key].days,
        dry_run: false,
        cleaned: [],
        errors: [headline, ...details],
        count: 0,
      };
      // 立刻刷新：让页顶的「进行中任务」和卡面置灰跟上后端事实
      await loadStatus();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: CleanupResult = await res.json();
    results.value[key] = data;

    if (preview.value) {
      const n = data.cleaned.length;
      ElMessage.info(n > 0 ? `预览完成：将处理 ${n} 项` : '预览完成：无需要清理的内容');
    } else {
      // 实际执行后刷新状态以反映最新存储情况
      await loadStatus();
      const freed = data.total_freed_mb !== undefined ? `，释放 ${data.total_freed_mb} MB` : ''; // NOSONAR: S7735 - 误报，此处 !== undefined 是必要的存在性检查
      ElMessage.success(`清理完成：处理 ${data.count} 项${freed}`);
    }
  } catch (err) {
    const message = apiErrorMessage('清理失败', err);
    results.value[key] = { errors: [message] } as CleanupResult;
    ElMessage.error(message);
  } finally {
    loadings[key] = false;
  }
}

onMounted(() => {
  loadStatus();
});
</script>

<template>
  <div class="cleanup-page">
    <div class="glass-card cleanup-card">
      <div class="card-deco"></div>

      <div class="cleanup-head">
        <div class="head-text">
          <h2 class="head-title grad-text">{{ CLEANUP_PAGE_TITLE }}</h2>
          <p class="head-tip">{{ CLEANUP_PAGE_TIP }}</p>
        </div>
        <el-button class="neon-btn" data-tip="重新统计缓存 / 运行状态 / 日志 / 原始资料的占用" :loading="loadingStatus" @click="loadStatus">
          刷新状态
        </el-button>
      </div>

      <!-- 页级预览开关（T02470 S2）：一个开关管全页，不再每卡一个 -->
      <div class="preview-bar" id="cleanup-preview-bar">
        <div class="preview-row">
          <el-switch
            id="cleanup-preview-switch"
            v-model="preview"
            aria-label="仅预览（不实际执行）"
            data-tip="开启时只会列出会删哪些文件；关闭后本页所有清理按钮都会真实删除"
          />
          <span class="switch-label">仅预览（不实际执行）</span>
          <span class="preview-hint">{{ previewSwitchHint(preview) }}</span>
          <span :class="['mode-tag', chip.danger ? 'mode-danger' : 'mode-safe']">{{ chip.label }}</span>
          <!-- T02655：活体指示——有任务在跑时才出现，说明为什么有的卡被置灰 -->
          <span
            v-if="activeHint"
            id="cleanup-active-hint"
            class="mode-tag mode-danger"
            data-tip="后端统计的进行中任务；有任务时「运行状态/原始资料」的真实删除会被拒绝"
          >{{ activeHint }}</span>
        </div>
        <a class="advanced-toggle" href="#" role="button" :aria-expanded="showAdvanced" @click.prevent="showAdvanced = !showAdvanced">
          {{ showAdvanced ? '收起技术细节' : '高级：查看实际路径与技术说明' }}
        </a>
      </div>

      <!-- 关闭预览后的红色横幅：位置在操作卡之前，避免滚下去就看不见 -->
      <div v-if="!preview" class="preview-banner" id="cleanup-danger-banner" role="alert">
        {{ bannerText }}
        <button type="button" class="banner-undo" data-tip="把开关重新打开，恢复只列出不删除" @click="preview = true">
          切回仅预览
        </button>
      </div>

      <div v-if="showAdvanced" class="advanced-panel" id="cleanup-advanced">
        <div v-for="row in advanced" :key="row.path" class="advanced-row">
          <span class="advanced-title">{{ row.title }}</span>
          <code class="advanced-path">{{ row.path }}</code>
          <span class="advanced-note">{{ row.note }}</span>
        </div>

        <!-- T02808：运行状态真实扫描的位置。三态走 StateBlock（与本页结果区同一出口）：
             状态没回来 → 加载；回来了 → 逐目录列路径与计数；取不到状态 → 失败重试 -->
        <div class="advanced-group" id="cleanup-advanced-dirs">
          <div class="advanced-title dirs-title">运行状态实际位置</div>
          <template v-if="status">
            <div v-for="dir in runStateDirs" :key="dir.path" class="advanced-row">
              <span :class="['dir-role', dir.legacy ? 'dir-legacy' : 'dir-canonical']">{{ dir.roleText }}</span>
              <code class="advanced-path">{{ dir.path }}</code>
              <span class="advanced-note">{{ dir.countText }}</span>
            </div>
            <div v-if="legacyRunStateHintText" class="advanced-note dirs-hint">{{ legacyRunStateHintText }}</div>
          </template>
          <StateBlock v-else-if="loadingStatus" state="loading" compact loading-text="正在统计各位置的文件数…" />
          <StateBlock v-else state="error" compact error-text="目录位置还没取到" retry-label="重新加载" @retry="loadStatus" />
        </div>
      </div>

      <!-- 存储状态总览：4 列 Statistic -->
      <div class="status-grid">
        <div class="status-block hover-glow">
          <div class="status-title">编译缓存</div>
          <div class="status-value">{{ status?.compileCache.sizeMb.toFixed(2) ?? '0.00' }} <span class="unit">MB</span></div>
          <div class="status-meta">
            <span :class="['dot', status?.compileCache.exists ? 'set' : 'unset']"></span>
            {{ status?.compileCache.exists ? `${status.compileCache.entryCount} 条缓存` : '未创建' }}
          </div>
        </div>
        <div class="status-block hover-glow">
          <div class="status-title">运行状态</div>
          <div class="status-value">{{ status?.runState.sizeMb.toFixed(2) ?? '0.00' }} <span class="unit">MB</span></div>
          <div class="status-meta">
            {{ status?.runState.fileCount ?? 0 }} 个文件<template v-if="status?.runState.oldest"> · 最早 {{ status.runState.oldest }}</template>
          </div>
        </div>
        <div class="status-block hover-glow">
          <div class="status-title">运行日志</div>
          <div class="status-value">{{ status?.runLogs.sizeMb.toFixed(2) ?? '0.00' }} <span class="unit">MB</span></div>
          <div class="status-meta">
            {{ status?.runLogs.fileCount ?? 0 }} 个文件<template v-if="status?.runLogs.oldest"> · 最早 {{ status.runLogs.oldest }}</template>
          </div>
        </div>
        <div class="status-block hover-glow">
          <div class="status-title">原始资料</div>
          <div class="status-value">{{ status?.rawArchive.sizeMb.toFixed(2) ?? '0.00' }} <span class="unit">MB</span></div>
          <div class="status-meta">
            {{ status?.rawArchive.fileCount ?? 0 }} 个文件<template v-if="status?.rawArchive.oldest"> · 最早 {{ status.rawArchive.oldest }}</template>
          </div>
        </div>
      </div>

      <!-- 4 列清理表单 -->
      <div class="cleanup-grid">
        <div v-for="card in cards" :key="card.key" class="cleanup-block hover-glow">
          <h3 class="block-title">
            <span class="block-bracket">[</span> {{ card.title }} <span class="block-bracket">]</span>
          </h3>
          <div class="block-plain">{{ card.plain }}</div>
          <div class="block-detail">{{ card.consequence }}</div>

          <!-- 保留天数（仅 run_logs/raw_archive 显示） -->
          <div v-if="card.showDays" class="form-row">
            <label class="form-label" :for="'cleanup-days-' + card.key">保留天数</label>
            <el-input-number
              :id="'cleanup-days-' + card.key"
              v-model="forms[card.key].days"
              :min="1"
              :max="365"
              size="small"
              class="form-input"
            />
            <span class="form-suffix">天</span>
          </div>

          <!-- 卡片不再自带预览开关，只复述当前页级模式与可清数量（S2/S4） -->
          <div :class="['block-mode', chip.danger ? 'mode-danger' : 'mode-safe']">
            {{ chip.label }}<template v-if="status"> · {{ card.counterLabel(status) }}</template>
          </div>

          <!-- 清理按钮：真实删除模式变红；无可清对象转禁用并说明原因 -->
          <el-button
            class="cleanup-btn"
            :class="{ danger: !preview }"
            :data-tip="buttonState(card.key).tip"
            :disabled="buttonState(card.key).disabled"
            :loading="loadings[card.key]"
            @click="handleCleanup(card.key)"
          >
            {{ buttonState(card.key).label }}
          </el-button>

          <!-- 结果展示 -->
          <div v-if="results[card.key]" class="result-area">
            <div v-if="results[card.key]!.cleaned.length > 0" class="result-success">
              <div class="result-summary">
                <template v-if="results[card.key]!.dry_run">预览 {{ results[card.key]!.count }} 项</template>
                <template v-else>
                  完成 {{ results[card.key]!.count }} 项
                  <template v-if="results[card.key]!.total_freed_mb !== undefined">
                    · 释放 {{ results[card.key]!.total_freed_mb }} MB
                  </template>
                </template>
              </div>
              <div
                v-for="(item, idx) in results[card.key]!.cleaned"
                :key="idx"
                class="result-item"
              >
                {{ item }}
              </div>
            </div>
            <div v-if="results[card.key]!.errors.length > 0" class="result-errors">
              <div
                v-for="(err, idx) in results[card.key]!.errors"
                :key="idx"
                class="error-item"
              >
                {{ err }}
              </div>
            </div>
            <StateBlock
              v-if="results[card.key]!.cleaned.length === 0 && results[card.key]!.errors.length === 0"
              state="empty"
              compact
              empty-title="这一项没有需要清理的内容"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cleanup-page {
  display: flex;
  flex-direction: column;
}

.cleanup-card {
  position: relative;
  padding: 24px 28px;
  overflow: hidden;
}

.card-deco {
  position: absolute;
  bottom: -50px;
  right: -40px;
  width: 220px;
  height: 220px;
  background: var(--grad-fire);
  filter: blur(60px);
  opacity: 0.25;
  transform: rotate(18deg);
  border-radius: 50%;
  pointer-events: none;
  z-index: 0;
}

.cleanup-head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.head-text {
  flex: 1;
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
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 12px;
  font-family: var(--font-mono);
}

/* 存储状态 4 列 */
.status-grid {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 24px;
}

.status-block {
  padding: 16px 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
  transition: all 0.3s ease;
}

.status-title {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  letter-spacing: 0.05em;
  margin-bottom: 8px;
}

.status-value {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 900;
  color: var(--neon-cyan);
  text-shadow: 0 0 12px var(--accent-cyan-a30);
  margin-bottom: 6px;
}

.status-value .unit {
  font-size: 13px;
  color: var(--text-soft);
  font-weight: 500;
}

.status-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-soft);
  display: flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.dot.set {
  background: var(--neon-lime);
  box-shadow: 0 0 6px var(--neon-lime);
}

.dot.unset {
  background: var(--text-dim);
}

/* 4 列清理表单 */
.cleanup-grid {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.cleanup-block {
  padding: 18px 22px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
  transition: all 0.3s ease;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.block-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.05em;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--accent-cyan-a20);
}

.block-bracket {
  color: var(--neon-cyan);
  text-shadow: 0 0 8px var(--accent-cyan-a50);
}

/* 人话描述：不再把 .harness/… 这类实现路径摆在卡面（S3） */
.block-plain {
  font-size: 13px;
  color: var(--text-base);
  line-height: 1.6;
}

.block-detail {
  font-size: 12px;
  color: var(--text-soft);
  line-height: 1.6;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.form-label {
  width: 70px;
  flex-shrink: 0;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.form-input {
  flex: 1;
}

.form-suffix {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
}

/* 页级预览开关条（S2） */
.preview-bar {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 12px 16px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
}

.preview-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.preview-hint {
  font-size: 12px;
  color: var(--text-soft);
}

.advanced-toggle {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--neon-purple);
  text-decoration: none;
  border-bottom: 1px dashed var(--accent-purple-a40, rgba(168, 85, 247, 0.4));
}

.advanced-toggle:hover {
  color: var(--neon-cyan);
}

/* 关闭预览后的红色横幅：role=alert，位置在操作卡之前 */
.preview-banner {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 12px 16px;
  background: var(--accent-pink-a15);
  border: 1px solid var(--accent-pink-a50);
  border-radius: var(--radius-card);
  color: var(--neon-magenta);
  font-size: 13px;
  line-height: 1.6;
  box-shadow: 0 0 14px var(--accent-pink-a30);
}

.banner-undo {
  padding: 4px 12px;
  background: transparent;
  border: 1px solid var(--neon-magenta);
  border-radius: var(--radius-pill);
  color: var(--neon-magenta);
  font-family: var(--font-mono);
  font-size: 12px;
  cursor: pointer;
}

.banner-undo:hover {
  box-shadow: 0 0 12px var(--accent-pink-a60);
}

/* 高级面板：技术路径与实现词折叠在这里 */
.advanced-panel {
  position: relative;
  z-index: 1;
  margin-bottom: 16px;
  padding: 12px 16px;
  background: var(--bg-scene);
  border: 1px dashed var(--accent-purple-a20);
  border-radius: var(--radius-card);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.advanced-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-soft);
}

.advanced-title {
  color: var(--text-dim);
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
  min-width: 64px;
}

.advanced-path {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-purple);
  word-break: break-all;
}

/* T02808：运行状态目录清单——分组标题 + 角色徽标（规范/旧存放位置一眼分开） */
.advanced-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  padding-top: 10px;
  border-top: 1px dashed var(--accent-purple-a20);
}

.dirs-title {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  letter-spacing: 0.04em;
}

.dirs-hint {
  color: var(--text-soft);
  font-size: 12px;
  line-height: 1.6;
}

.dir-role {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  font-size: 11px;
  border: 1px solid transparent;
}

.dir-canonical {
  background: rgba(57, 255, 20, 0.1);
  border-color: var(--accent-lime-a40, rgba(57, 255, 20, 0.4));
  color: var(--neon-lime);
}

.dir-legacy {
  background: var(--accent-pink-a15);
  border-color: var(--accent-pink-a50);
  color: var(--neon-magenta);
}

.switch-label {
  font-size: 13px;
  color: var(--text-base);
  font-family: var(--font-mono);
}

/* 模式标注：开关关掉后每一张卡都要复述「当前是真实删除」 */
.mode-tag,
.block-mode {
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-family: var(--font-mono);
  border: 1px solid transparent;
  align-self: flex-start;
}

.mode-safe,
.block-mode.mode-safe {
  background: rgba(57, 255, 20, 0.1);
  border-color: var(--accent-lime-a40, rgba(57, 255, 20, 0.4));
  color: var(--neon-lime);
}

.mode-danger,
.block-mode.mode-danger {
  background: var(--accent-pink-a15);
  border-color: var(--accent-pink-a50);
  color: var(--neon-magenta);
  box-shadow: 0 0 10px var(--accent-pink-a30);
}

/* 清理按钮 */
.cleanup-btn {
  background: var(--bg-glass) !important;
  border: 1px solid var(--accent-purple-a40) !important;
  color: var(--text-bright) !important;
  font-family: var(--font-mono) !important;
  letter-spacing: 0.05em;
  transition: all 0.3s ease !important;
}

.cleanup-btn:hover:not(.is-disabled) {
  border-color: var(--neon-cyan) !important;
  box-shadow: var(--glow-cyan) !important;
  color: var(--neon-cyan) !important;
}

/* 危险按钮：非预览模式变红 */
.cleanup-btn.danger {
  background: linear-gradient(135deg, var(--accent-pink-a30), var(--accent-pink-a15)) !important;
  border-color: var(--neon-magenta) !important;
  color: #fff !important;
  box-shadow: 0 0 16px var(--accent-pink-a40) !important;
}

.cleanup-btn.danger:hover:not(.is-disabled) {
  box-shadow: 0 0 24px var(--accent-pink-a60) !important;
  transform: translateY(-1px);
}

/* 结果区域 */
.result-area {
  margin-top: 4px;
  padding: 10px 12px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a15);
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  max-height: 180px;
  overflow-y: auto;
}

.result-summary {
  font-weight: 700;
  color: var(--neon-cyan);
  margin-bottom: 6px;
  letter-spacing: 0.04em;
}

.result-item {
  color: var(--text-soft);
  line-height: 1.6;
  word-break: break-all;
}

.result-errors {
  color: var(--neon-magenta);
}

.error-item {
  line-height: 1.6;
  word-break: break-all;
}

/* 响应式：小屏改为单列 */
@media (max-width: 900px) {
  .status-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .cleanup-grid {
    grid-template-columns: 1fr;
  }
}
</style>

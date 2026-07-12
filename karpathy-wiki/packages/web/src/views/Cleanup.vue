<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import RobotAvatar from '../components/RobotAvatar.vue';
import type { CleanupBody, CleanupResult, CleanupStorageStatus, CleanupTarget } from '../types';
import { apiErrorMessage } from '../utils/apiError';

// 存储状态
const status = ref<CleanupStorageStatus | null>(null);
const loadingStatus = ref(false);

// 4 类清理表单独立状态，避免相互干扰
interface CleanupFormState {
  target: CleanupTarget;
  days: number;
  dry_run: boolean;
}

const forms = reactive<Record<'compileCache' | 'runState' | 'runLogs' | 'rawArchive', CleanupFormState>>({
  compileCache: { target: 'compile_cache', days: 30, dry_run: true },
  runState: { target: 'run_state', days: 30, dry_run: true },
  runLogs: { target: 'run_logs', days: 7, dry_run: true },
  rawArchive: { target: 'raw_archive', days: 30, dry_run: true },
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

// 卡片元数据：标题/描述/图标
const cards = [
  {
    key: 'compileCache' as const,
    title: '编译缓存',
    desc: '.harness/compile-cache.json',
    detail: '增量编译的 SHA-256 内容哈希缓存，清理后下次编译全部重新生成',
    showDays: false,
  },
  {
    key: 'runState' as const,
    title: '运行状态',
    desc: '.harness/state/*.json',
    detail: '断点续传的历史任务状态文件，清理后无法 resume 历史任务',
    showDays: false,
  },
  {
    key: 'runLogs' as const,
    title: '运行日志',
    desc: '.harness/logs/*.log',
    detail: 'harness 运行的 JSONL 技术日志，按保留天数清理旧文件',
    showDays: true,
  },
  {
    key: 'rawArchive' as const,
    title: '原始资料',
    desc: 'vault/raw/input-*.md',
    detail: '投递资料的原始存档，按保留天数清理（保留已生成的页面）',
    showDays: true,
  },
];

// 二次确认话术（数据库类风险最高，提示备份）
function confirmText(title: string): string {
  return `确认清理${title}？此操作不可撤销，建议先确认无活跃编译/问答任务。`;
}

async function loadStatus() {
  loadingStatus.value = true;
  try {
    const res = await fetch('/api/cleanup/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.value = await res.json();
  } catch (err) {
    ElMessage.error(apiErrorMessage('加载存储状态失败', err));
  } finally {
    loadingStatus.value = false;
  }
}

async function handleCleanup(key: keyof typeof forms) {
  const form = forms[key];
  const card = cards.find((c) => c.key === key)!;
  // 非预览模式必须二次确认，避免误删（与闲鱼 globalThis.confirm 等价）
  if (!form.dry_run) { // NOSONAR — guard clause，无 else 分支，S7735 不适用
    try {
      await ElMessageBox.confirm(confirmText(card.title), '危险操作确认', {
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
      target: form.target,
      dry_run: form.dry_run,
      // 仅 run_logs/raw_archive 按 days 清理，其他两类与时间无关
      ...(card.showDays ? { days: form.days } : {}),
    };
    const res = await fetch('/api/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: CleanupResult = await res.json();
    results.value[key] = data;

    if (form.dry_run) {
      const n = data.cleaned.length;
      ElMessage.info(n > 0 ? `预览完成：将处理 ${n} 项` : '预览完成：无需要清理的内容');
    } else {
      // 实际执行后刷新状态以反映最新存储情况
      await loadStatus();
      const freed = data.total_freed_mb !== undefined ? `，释放 ${data.total_freed_mb} MB` : '';
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
        <RobotAvatar :size="56" />
        <div class="head-text">
          <span class="head-tag">// SYSTEM CLEANUP</span>
          <h2 class="head-title grad-text">系统清理</h2>
          <p class="head-tip">缓存清理 · 运行状态 · 运行日志 · 原始资料</p>
        </div>
        <el-button class="neon-btn" :loading="loadingStatus" @click="loadStatus">
          <span style="margin-right: 4px">?</span>刷新状态
        </el-button>
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
          <div class="block-desc">{{ card.desc }}</div>
          <div class="block-detail">{{ card.detail }}</div>

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

          <!-- dry_run 开关 -->
          <div class="form-row switch-row">
            <el-switch v-model="forms[card.key].dry_run" />
            <span class="switch-label">仅预览（不实际执行）</span>
            <span v-if="!forms[card.key].dry_run" class="danger-tag">将执行真实删除</span>
          </div>

          <!-- 清理按钮：非预览模式变红警示 -->
          <el-button
            class="cleanup-btn"
            :class="{ danger: !forms[card.key].dry_run }"
            :loading="loadings[card.key]"
            @click="handleCleanup(card.key)"
          >
            清理{{ card.title }}
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
            <div
              v-if="results[card.key]!.cleaned.length === 0 && results[card.key]!.errors.length === 0"
              class="result-empty"
            >
              无操作
            </div>
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
  margin: 0 0 4px;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 13px;
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

.block-desc {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neon-purple);
  letter-spacing: 0.03em;
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

.switch-row {
  flex-wrap: wrap;
}

.switch-label {
  font-size: 13px;
  color: var(--text-base);
  font-family: var(--font-mono);
}

.danger-tag {
  padding: 2px 10px;
  background: var(--accent-pink-a15);
  border: 1px solid var(--accent-pink-a50);
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-family: var(--font-mono);
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

.result-empty {
  color: var(--text-dim);
  text-align: center;
  padding: 8px 0;
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

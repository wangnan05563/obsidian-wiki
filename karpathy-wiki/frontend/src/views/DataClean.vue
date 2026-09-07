<script setup lang="ts">
import { API_BASE, apiFetch } from '../utils/apiBase';
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Sort, MagicStick, Right, Loading } from '@element-plus/icons-vue';
import { usePermission } from '../composables/usePermission';
import { useAuthStore } from '../stores/auth';
import { useModelStore } from '../stores/model';
import { loadAiUserConfigForPreset, type AiUserConfig } from '../services/userConfig';
import { AUTO_MODEL, resolveAutoPresetForUser } from '../utils/autoModel';
import type { PageQualityScore, DeduplicateResult, DuplicatePair, MergeResult, PrecheckResult, DiffResult, AiCleanAnalysisResult, AiAnalysisRenameItem } from '../types';

const pages = ref<PageQualityScore[]>([]);
// 重复对：从 any 收敛为 DuplicatePair，避免运行时访问 undefined 字段
const duplicates = ref<DuplicatePair[]>([]);
// 重复分组：deduplicate 接口同时返回，便于按"组"视角查看
const duplicateGroups = ref<DeduplicateResult['duplicateGroups']>([]);
// 视图模式：'pairs' 两两配对（默认）/ 'groups' 按等价类聚合
const dedupViewMode = ref<'pairs' | 'groups'>('pairs');
const loading = ref(false);
const deduping = ref(false);
const scanProgress = ref('');
const selectedPages = ref<string[]>([]);
// 永久删除端点为 requireAdmin，非管理员禁用按钮并提示
const { isAdmin } = usePermission();
const precheckResult = ref<PrecheckResult | null>(null);

// 差异对比抽屉状态
const diffDrawerVisible = ref(false);
const diffLoading = ref(false);
const diffResult = ref<DiffResult | null>(null);
const diffPairLabel = ref('');

// 后台任务进行中的加载态：用于按钮 spinner / 抽屉 spinner，提供即时反馈、避免体感卡顿。
// 动画走 Element Plus / CSS keyframes（合成器线程），不阻塞主线程。
const diffingKey = ref<string | null>(null); // 正在拉取差异的重复对（按 path 维度精确绑定）
const mergingKey = ref<string | null>(null); // 正在合并的重复对
const batchBusy = ref<string | null>(null);  // AI 批量操作进行中：'delete' | 'dedup' | 'rename' | 'delete-selected'
function pairKey(dup: DuplicatePair): string {
  return `${dup.pageA.path}::${dup.pageB.path}`;
}

// Mock data example for B-2 requirement
const MOCK_PAGES_EXAMPLE: PageQualityScore = {
  path: 'concepts/transformers.md',
  title: 'Transformers',
  qualityScore: 85,
  category: { length: 80, links: 75, frontmatter: 90, citations: 60, duplicate: 100, freshness: 70 },
  metadata: {
    wordCount: 3420, lineCount: 120, internalLinks: 12, inboundLinks: 5,
    lastModified: '2026-07-20T10:00:00Z', hasFrontmatter: true, isDraft: false,
    fileSizeBytes: 18500, hasBom: false, encoding: 'utf-8', directory: 'concepts'
  },
  issues: [],
  suggestions: [{ type: 'citation', detail: 'Add more citations', actionable: true }]
};

const MOCK_DUPLICATE_EXAMPLE = {
  pageA: MOCK_PAGES_EXAMPLE,
  pageB: { ...MOCK_PAGES_EXAMPLE, path: 'entities/transformer-model.md', title: 'Transformer Model', qualityScore: 42 },
  similarity: 0.92,
  matchType: 'near-duplicate' as const,
  reason: 'Similar page name'
};

// Quality stats
const qualityStats = computed(() => {
  const scores = pages.value.map(p => p.qualityScore);
  if (scores.length === 0) return null;
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return {
    total: scores.length,
    avg: avg.toFixed(1),
    excellent: scores.filter(s => s >= 80).length,
    good: scores.filter(s => s >= 60 && s < 80).length,
    needsWork: scores.filter(s => s < 40).length
  };
});

function scoreClass(score: number): string {
  if (score >= 80) return 'score-excellent';
  if (score >= 60) return 'score-good';
  if (score >= 40) return 'score-needs-work';
  return 'score-critical';
}

// 重复类型 → 标签颜色：exact 红、near-duplicate 橙、semantic-similar 蓝
function matchTypeTag(type: DuplicatePair['matchType']): 'danger' | 'warning' | 'info' {
  if (type === 'exact') return 'danger';
  if (type === 'near-duplicate') return 'warning';
  return 'info';
}

function matchTypeLabel(type: DuplicatePair['matchType']): string {
  if (type === 'exact') return '完全相同';
  if (type === 'near-duplicate') return '高度相似';
  return '语义相似';
}

async function loadPages() {
  loading.value = true;
  scanProgress.value = '正在加载页面数据...';
  try {
    const res = await apiFetch(`${API_BASE}/data-clean/pages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pages.value = await res.json();
    scanProgress.value = `已加载 ${pages.value.length} 个页面，平均质量 ${qualityStats.value?.avg || 0}/100`;
    ElMessage.success('页面数据加载成功');
  } catch (err) {
    scanProgress.value = '加载失败 — 将自动重试';
    ElMessage.error(err instanceof Error ? err.message : '加载页面失败');
    // 自动重试一次：网络抖动等瞬时错误可恢复
    try {
      await new Promise(r => setTimeout(r, 1000));
      const res = await apiFetch(`${API_BASE}/data-clean/pages`);
      if (res.ok) { pages.value = await res.json(); scanProgress.value = '重试成功'; ElMessage.success('重试成功'); }
    } catch { ElMessage.warning('重试也失败 — 请检查服务状态'); }
  } finally { loading.value = false; }
}

async function runDeduplication() {
  deduping.value = true;
  scanProgress.value = '正在检测重复页面（基于内容哈希 + Jaccard 相似度）...';
  try {
    const res = await apiFetch(`${API_BASE}/data-clean/deduplicate`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: DeduplicateResult = await res.json();
    duplicates.value = data.matches;
    duplicateGroups.value = data.duplicateGroups;
    scanProgress.value = `扫描 ${data.scannedPages} 页 · 唯一 ${data.uniquePages} · 重复对 ${data.matches.length} · 重复组 ${data.duplicateGroups.length}`;
    ElMessage.success(`去重完成：发现 ${data.matches.length} 对重复，聚合为 ${data.duplicateGroups.length} 组`);
  } catch (err) {
    scanProgress.value = '去重失败';
    ElMessage.error(err instanceof Error ? err.message : '去重失败');
  } finally {
    deduping.value = false;
  }
}

async function runPrecheck() {
  scanProgress.value = '正在执行 Vault 预检...';
  try {
    const res = await apiFetch(`${API_BASE}/data-clean/precheck`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    precheckResult.value = await res.json();
    // 非空断言：fetch 成功返回 json 后 precheckResult.value 一定非 null
    // 局部变量避免后续重复访问 .value，同时让 TS 在 if 分支内窄化
    const result = precheckResult.value!;
    if (result.passed) {
      ElMessage.success(`预检通过：扫描 ${result.scannedFiles} 个文件，${result.warnings.length} 个警告`);
    } else {
      ElMessage.warning(`预检发现 ${result.errors.length} 个错误，${result.warnings.length} 个警告`);
    }
  } catch (err) {
    scanProgress.value = '预检失败';
    ElMessage.error(err instanceof Error ? err.message : '预检失败');
  }
}

async function archiveSelected() {
  if (selectedPages.value.length === 0) { ElMessage.warning('请选择要归档的页面'); return; }
  try { await ElMessageBox.confirm(`归档 ${selectedPages.value.length} 个文件？将移动到 archive/YYYY-MM-DD/`, '确认归档', { confirmButtonText: '归档', cancelButtonText: '取消', type: 'warning' }); }
  catch { return; }
  scanProgress.value = '正在归档文件...';
  try {
    const res = await apiFetch(`${API_BASE}/data-clean/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: selectedPages.value, dry_run: false }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    ElMessage.success(`已归档 ${result.archived.length} 个文件`);
    selectedPages.value = [];
    await loadPages();
  } catch (err) { scanProgress.value = '归档失败'; ElMessage.error(err instanceof Error ? err.message : '归档操作失败'); }
}

// ─── AI 智能清洗分析 ─────────────────────────────────────
// 「AI分析」按钮：调用用户自有 BYOK 模型对当前文档集合做分类（冗余删除/重复去重/规范重命名），
// 结论在下方分析区展示，并配套批量操作按钮直接执行。
const analyzing = ref(false);
const aiResult = ref<AiCleanAnalysisResult | null>(null);

const authStore = useAuthStore();

// 构建 BYOK llmConfig（与 Query.vue 口径一致：优先具体预设，auto 走 resolveAutoPresetForUser）
async function buildLlmConfig(): Promise<AiUserConfig | null> {
  const uid = authStore.user?.id || 'guest';
  const modelStore = useModelStore();
  const presetKey = (modelStore.selectedPresetKey as string) || 'auto';
  try {
    if (presetKey === 'auto' || presetKey === AUTO_MODEL) {
      const resolved = await resolveAutoPresetForUser(uid, modelStore.presets);
      const cfg = resolved?.config ?? null;
      return cfg && cfg.apiKey ? cfg : null;
    }
    const preset = modelStore.presets?.find((p: any) => p.key === presetKey);
    const cfg = await loadAiUserConfigForPreset(uid, presetKey, preset);
    return cfg && cfg.apiKey ? cfg : null;
  } catch {
    return null;
  }
}

async function runAiAnalysis() {
  if (analyzing.value) return;
  const aiCfg = await buildLlmConfig();
  if (!aiCfg?.apiKey) {
    ElMessage.warning('请先在「配置 / 我的」中填写完整的 API Key（BYOK），AI 分析需要用户自有模型');
    return;
  }
  analyzing.value = true;
  scanProgress.value = 'AI 正在分析文档集合（冗余 / 重复 / 重命名）...';
  try {
    const res = await apiFetch(`${API_BASE}/data-clean/ai-analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llmConfig: aiCfg }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data: AiCleanAnalysisResult = await res.json();
    aiResult.value = data;
    const s = data.summary;
    ElMessage.success(`AI 分析完成：冗余 ${s.redundantCount} · 重复 ${s.duplicateGroupsCount} 组 · 重命名 ${s.renameCount}`);
  } catch (err) {
    scanProgress.value = 'AI 分析失败';
    ElMessage.error(err instanceof Error ? err.message : 'AI 分析失败');
  } finally {
    analyzing.value = false;
  }
}

// 批量删除：AI 判定的冗余文档（管理员门控）
async function batchDeleteAi() {
  if (!aiResult.value || aiResult.value.redundant.length === 0) return;
  if (!isAdmin.value) { ElMessage.warning('需管理员权限才能永久删除'); return; }
  const files = aiResult.value.redundant.map((r) => r.path);
  try {
    await ElMessageBox.confirm(
      `将永久删除 ${files.length} 个 AI 判定的冗余文档，此操作不可撤销。`,
      '批量删除（AI 结论）',
      { confirmButtonText: '永久删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  batchBusy.value = 'delete'; // 进入加载态，按钮 spinner 持续显示直到删除+重扫完成
  scanProgress.value = '正在批量删除冗余文档...';
  try {
    const res = await apiFetch(`${API_BASE}/data-clean/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, dry_run: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    if (result.errors && result.errors.length > 0) {
      ElMessage.warning(`删除完成但有错误：${result.errors.join('；')}`);
    } else {
      ElMessage.success(`已永久删除 ${result.deleted.length} 个文件`);
    }
    aiResult.value = null;
    await loadPages();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '批量删除失败');
  } finally {
    batchBusy.value = null;
  }
}

// 批量去重：把重复组非代表文档合并进代表文档（管理员门控）
async function batchDedupAi() {
  if (!aiResult.value || aiResult.value.duplicates.length === 0) return;
  if (!isAdmin.value) { ElMessage.warning('需管理员权限才能执行去重合并'); return; }
  const groups = aiResult.value.duplicates.map((g) => ({
    keep: g.representativePath,
    merge: g.paths.filter((p) => p !== g.representativePath),
  })).filter((g) => g.merge.length > 0);
  if (groups.length === 0) return;
  try {
    await ElMessageBox.confirm(
      `将对 ${groups.length} 组重复文档执行合并去重（保留代表文档，其余合并归档）。`,
      '批量去重（AI 结论）',
      { confirmButtonText: '执行去重', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  batchBusy.value = 'dedup'; // 进入加载态，按钮 spinner 持续显示直到批量去重+重扫完成
  scanProgress.value = '正在批量去重合并...';
  try {
    const res = await apiFetch(`${API_BASE}/data-clean/batch-dedup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups, dry_run: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    if (result.errors && result.errors.length > 0) {
      ElMessage.warning(`去重完成但有错误：${result.errors.join('；')}`);
    } else {
      ElMessage.success(`已合并去重 ${result.merged} 个文档`);
    }
    aiResult.value = null;
    await loadPages();
    await runDeduplication();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '批量去重失败');
  } finally {
    batchBusy.value = null;
  }
}

// 批量重命名：按 AI 建议的规范化文件名原地重命名（管理员门控）
async function batchRenameAi() {
  if (!aiResult.value || aiResult.value.renames.length === 0) return;
  if (!isAdmin.value) { ElMessage.warning('需管理员权限才能执行重命名'); return; }
  const renames: AiAnalysisRenameItem[] = aiResult.value.renames;
  try {
    await ElMessageBox.confirm(
      `将按 AI 建议对 ${renames.length} 个文档做规范化重命名（保持原目录、标题不变，不影响 [[链接]]）。`,
      '批量重命名（AI 结论）',
      { confirmButtonText: '执行重命名', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  batchBusy.value = 'rename'; // 进入加载态，按钮 spinner 持续显示直到重命名+重扫完成
  scanProgress.value = '正在批量重命名...';
  try {
    const items = renames.map((r) => ({ from: r.path, to: r.suggestedPath }));
    const res = await apiFetch(`${API_BASE}/data-clean/batch-rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ renames: items, dry_run: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    if (result.errors && result.errors.length > 0) {
      ElMessage.warning(`重命名完成但有错误：${result.errors.join('；')}`);
    } else {
      ElMessage.success(`已重命名 ${result.renamed.length} 个文件`);
    }
    aiResult.value = null;
    await loadPages();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '批量重命名失败');
  } finally {
    batchBusy.value = null;
  }
}

// 永久删除：复用后端 DELETE /api/data-clean/delete（requireAdmin，支持 dry_run）。
// 与归档不同，删除不可撤销，故强制二次确认 + 管理员校验 + 预览开关由后端 dry_run 控制（此处直接真实删除）。
async function deleteSelected() {
  if (selectedPages.value.length === 0) { ElMessage.warning('请选择要删除的页面'); return; }
  if (!isAdmin.value) { ElMessage.warning('需管理员权限才能永久删除'); return; }
  try {
    await ElMessageBox.confirm(
      `将永久删除 ${selectedPages.value.length} 个文件，此操作不可撤销，建议先归档备份。`,
      '永久删除确认',
      { confirmButtonText: '永久删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  batchBusy.value = 'delete-selected'; // 进入加载态，按钮 spinner 持续显示直到删除+重扫完成
  scanProgress.value = '正在永久删除文件...';
  try {
    const res = await apiFetch(`${API_BASE}/data-clean/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: selectedPages.value, dry_run: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    if (result.errors && result.errors.length > 0) {
      ElMessage.warning(`删除完成但有错误：${result.errors.join('；')}`);
    } else {
      ElMessage.success(`已永久删除 ${result.deleted.length} 个文件`);
    }
    selectedPages.value = [];
    await loadPages();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败');
  } finally {
    batchBusy.value = null;
  }
}

async function fixFrontmatterFor(paths: string[]) {
  if (paths.length === 0) return;
  scanProgress.value = '正在修复 frontmatter...';
  try {
    const res = await apiFetch(`${API_BASE}/data-clean/fix-frontmatter`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths, dry_run: false }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    ElMessage.success(`已为 ${result.fixed.length} 个文件修复 frontmatter`);
    selectedPages.value = [];
    await loadPages();
  } catch (err) { scanProgress.value = '修复失败'; ElMessage.error(err instanceof Error ? err.message : 'Frontmatter 修复失败'); }
}

async function mergeDuplicatePair(match: DuplicatePair) {
  try { await ElMessageBox.confirm(`将"${match.pageB.title}"合并到"${match.pageA.title}"？质量较低的页面将被合并。`, '确认合并', { confirmButtonText: '合并', cancelButtonText: '跳过', type: 'info' }); }
  catch { return; }
  const k = pairKey(match);
  mergingKey.value = k; // 二次确认后进入加载态，按钮 spinner 持续显示直到合并+重扫完成
  scanProgress.value = `正在合并 ${match.pageB.title} → ${match.pageA.title}...`;
  try {
    const res = await apiFetch(`${API_BASE}/data-clean/merge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageA: match.pageA, pageB: match.pageB, archive_kept: true, dry_run: false }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result: MergeResult = await res.json();
    if (result.errors.length > 0) {
      ElMessage.warning(`合并完成但有错误：${result.errors.join(', ')}`);
    } else {
      ElMessage.success(`合并完成：更新了 ${result.linkReplacements || 0} 个链接`);
    }
    duplicates.value = duplicates.value.filter(d => d !== match);
    // 合并后重新扫描，避免"去重后仍看到重复文档"的体感
    await runDeduplication();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '合并失败');
  } finally {
    mergingKey.value = null;
  }
}

// 查看差异：调用 /api/data-clean/diff 拉取行级 diff，弹出抽屉展示
async function viewDiff(pair: DuplicatePair) {
  const k = pairKey(pair);
  diffingKey.value = k; // 立即进入加载态，按钮 spinner 同步出现
  diffPairLabel.value = `${pair.pageA.title} ↔ ${pair.pageB.title}`;
  diffDrawerVisible.value = true;
  diffLoading.value = true;
  diffResult.value = null;
  try {
    const url = `${API_BASE}/data-clean/diff?pathA=${encodeURIComponent(pair.pageA.path)}&pathB=${encodeURIComponent(pair.pageB.path)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    diffResult.value = await res.json() as DiffResult;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '加载差异失败');
    diffDrawerVisible.value = false;
  } finally {
    diffLoading.value = false;
    diffingKey.value = null;
  }
}

// 分组视图：根据 duplicateGroups 中保留的 representativePath，
// 在 pages 中查找组内每个文件的标题，便于展示
function findPageTitle(pagePath: string): string {
  return pages.value.find(p => p.path === pagePath)?.title ?? pagePath;
}

function onRowChange(selection: PageQualityScore[]) {
  selectedPages.value = selection.map(s => s.path);
}

onMounted(() => loadPages());
</script>

<template>
  <div class="dataclean-page">
    <div class="glass-card dataclean-card">
      <div class="card-deco"></div>
      
      <div class="dataclean-header">
        <div class="head-text">
          <h2 class="head-title grad-text">数据清洗</h2>
          <p class="head-tip">扫描 · 去重 · 合并 · 报告 · 归档 · 修复</p>
        </div>
        <el-button-group style="display:flex;gap:8px">
          <el-button class="neon-btn" :loading="loading" data-tip="重新扫描 vault 并加载全部页面数据" @click="loadPages">刷新</el-button>
          <el-button class="neon-btn secondary" data-tip="执行 Vault 预检，检查链接、frontmatter、重复等潜在问题" @click="runPrecheck">预检</el-button>
          <el-button class="neon-btn secondary" :loading="deduping" data-tip="基于内容哈希与相似度检测重复页面并聚合为重复组" @click="runDeduplication">去重</el-button>
          <el-button class="neon-btn secondary" :loading="analyzing" data-tip="调用你自己的模型（BYOK）智能分析：识别冗余、重复与待重命名文档" @click="runAiAnalysis">
            <el-icon v-if="!analyzing" style="margin-right:4px;vertical-align:middle"><MagicStick /></el-icon>AI分析
          </el-button>
        </el-button-group>
      </div>
      
      <!-- Mock data example (B-2) -->
      <div v-if="false" class="mock-section">
        <h4>Mock Example (for testing)</h4>
        <pre>{{ JSON.stringify(MOCK_PAGES_EXAMPLE, null, 2) }}</pre>
        <pre>{{ JSON.stringify(MOCK_DUPLICATE_EXAMPLE, null, 2) }}</pre>
      </div>
      
      <!-- 质量统计：与系统清理页 status-grid 一致的 5 列卡片 -->
      <div v-if="qualityStats" class="stats-grid">
        <div class="status-block hover-glow">
          <div class="status-title">总页数</div>
          <div class="status-value">{{ qualityStats.total }}</div>
          <div class="status-meta">已扫描页面</div>
        </div>
        <div class="status-block hover-glow">
          <div class="status-title">平均分</div>
          <div class="status-value">{{ qualityStats.avg }} <span class="unit">/100</span></div>
          <div class="status-meta">质量均值</div>
        </div>
        <div class="status-block hover-glow">
          <div class="status-title">优秀 (≥80)</div>
          <div class="status-value">{{ qualityStats.excellent }}</div>
          <div class="status-meta">高质量页面</div>
        </div>
        <div class="status-block hover-glow">
          <div class="status-title">良好 (60-79)</div>
          <div class="status-value">{{ qualityStats.good }}</div>
          <div class="status-meta">中等质量</div>
        </div>
        <div class="status-block hover-glow">
          <div class="status-title">需改进 (&lt;40)</div>
          <div class="status-value">{{ qualityStats.needsWork }}</div>
          <div class="status-meta">低质量页面</div>
        </div>
      </div>
      
      <!-- 预检结果 -->
      <el-alert v-if="precheckResult"
        :title="precheckResult.passed ? 'Vault 预检：通过' : 'Vault 预检：发现问题'"
        :type="precheckResult.passed ? 'success' : 'warning'"
        :description="`扫描 ${precheckResult.scannedFiles} 个文件 · ${precheckResult.errors.length} 个错误 · ${precheckResult.warnings.length} 个警告`"
        show-icon closable style="margin-bottom:16px" />
      
      <div v-if="scanProgress" class="progress-bar" :class="{ success: !loading && !scanProgress.includes('failed') && !scanProgress.includes('Failed') }">{{ scanProgress }}</div>
      
      <!-- 操作工具栏 -->
      <div class="toolbar" v-if="selectedPages.length > 0">
        <el-button-group>
          <el-button
            type="danger"
            size="small"
            :loading="batchBusy === 'delete-selected'"
            :disabled="batchBusy !== null || !isAdmin"
            :title="isAdmin ? '永久删除选中页面（不可撤销）' : '需管理员权限'"
            data-tip="永久删除选中的页面，操作不可撤销（需管理员权限）"
            @click="deleteSelected"
          >永久删除 ({{ selectedPages.length }})</el-button>
          <el-button type="danger" size="small" data-tip="将选中的页面归档备份，便于后续恢复" @click="archiveSelected">归档 ({{ selectedPages.length }})</el-button>
          <el-button type="warning" size="small" data-tip="修复选中页面的 frontmatter 格式（如缺失字段、错误缩进）" @click="fixFrontmatterFor(selectedPages)">修复 Frontmatter</el-button>
          <el-button size="small" data-tip="清空当前已勾选的页面" @click="selectedPages=[]">清除选择</el-button>
        </el-button-group>
      </div>
      
      <!-- 页面表格 -->
      <el-table :data="pages" style="width: 100%" stripe @selection-change="onRowChange" height="600">
        <el-table-column type="selection" width="55" align="center" />
        <el-table-column prop="path" label="文件路径" min-width="200" show-overflow-tooltip />
        <el-table-column prop="title" label="标题" min-width="150" show-overflow-tooltip />
        <el-table-column prop="qualityScore" label="评分" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.qualityScore>=80?'success':row.qualityScore>=60?'':row.qualityScore>=40?'warning':'danger'" size="small">
              {{ row.qualityScore }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="字数" width="80" align="right"><template #default="{ row }">{{ row.metadata.wordCount }}</template></el-table-column>
        <el-table-column label="链接" width="80" align="right"><template #default="{ row }">{{ row.metadata.internalLinks }}</template></el-table-column>
        <el-table-column label="目录" width="100"><template #default="{ row }">{{ row.metadata.directory }}</template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="{ row }">
          <el-tag v-if="row.metadata.hasFrontmatter" type="success" size="small" effect="plain">有 FM</el-tag>
          <el-tag v-else type="danger" size="small" effect="plain">无 FM</el-tag>
        </template></el-table-column>
        <el-table-column label="问题" width="200"><template #default="{ row }">
          <el-tag v-if="row.issues" v-for="(issue, idx) in row.issues" :key="idx" type="warning" size="small" style="margin-right:4px">{{ issue }}</el-tag>
        </template></el-table-column>
      </el-table>
      
      <!-- 疑似重复对（含合并操作 + 差异对比） -->
      <div v-if="duplicates.length > 0 || duplicateGroups.length > 0" class="duplicates-section">
        <div class="dup-header">
          <h3 class="block-title">
            <span class="block-bracket">[</span>
            重复检测
            <span class="block-bracket">]</span>
          </h3>
          <el-radio-group v-model="dedupViewMode" size="small">
            <el-radio-button value="pairs">配对视图 ({{ duplicates.length }})</el-radio-button>
            <el-radio-button value="groups">分组视图 ({{ duplicateGroups.length }})</el-radio-button>
          </el-radio-group>
        </div>

        <!-- 配对视图：两两重复对，可查看差异 / 合并 -->
        <div v-if="dedupViewMode === 'pairs'">
          <div v-for="(dup, idx) in duplicates" :key="idx" class="dup-item">
            <div class="dup-info">
              <div class="dup-titles">
                <el-tag :type="matchTypeTag(dup.matchType)" size="small" effect="dark">
                  {{ matchTypeLabel(dup.matchType) }}
                </el-tag>
                <span class="dup-title-a">{{ dup.pageA.title }}</span>
                <el-icon class="dup-vs"><Sort /></el-icon>
                <span class="dup-title-b">{{ dup.pageB.title }}</span>
              </div>
              <div class="dup-meta">
                <span class="dup-similarity">相似度 {{ (dup.similarity * 100).toFixed(0) }}%</span>
                <span class="dup-reason">· {{ dup.reason }}</span>
                <span class="dup-score">· 评分 {{ dup.pageA.qualityScore }} vs {{ dup.pageB.qualityScore }}</span>
              </div>
            </div>
            <div class="dup-actions">
              <el-button
                size="small"
                type="primary"
                plain
                :loading="diffingKey === pairKey(dup)"
                :disabled="diffingKey === pairKey(dup)"
                data-tip="逐行对比这两个重复文档的差异（A 独有 / B 独有 / 共同）"
                @click="viewDiff(dup)"
              >查看差异</el-button>
              <el-button
                size="small"
                type="success"
                :loading="mergingKey === pairKey(dup)"
                :disabled="mergingKey === pairKey(dup)"
                data-tip="将质量较低的页面合并进代表文档，并归档被合并页"
                @click="mergeDuplicatePair(dup)"
              >合并到 {{ dup.pageA.title }}</el-button>
              <el-button size="small" text :disabled="mergingKey === pairKey(dup) || diffingKey === pairKey(dup)" data-tip="从重复列表中移除该对（不删除文件）" @click="duplicates.splice(idx, 1)">忽略</el-button>
            </div>
          </div>
          <div v-if="duplicates.length === 0" class="empty-state">无配对视图数据</div>
        </div>

        <!-- 分组视图：等价类聚合，显示每组文件清单 + 代表 -->
        <div v-else>
          <div v-for="(group, idx) in duplicateGroups" :key="idx" class="group-item">
            <div class="group-head">
              <span class="group-index">#{{ idx + 1 }}</span>
              <span class="group-size">{{ group.pages.length }} 个文件互相重复</span>
              <span class="group-words">合计 {{ group.totalWordsInGroup }} 字</span>
              <el-tag type="success" size="small" effect="plain">代表：{{ findPageTitle(group.representativePath) }}</el-tag>
            </div>
            <ul class="group-pages">
              <li v-for="p in group.pages" :key="p" :class="{ representative: p === group.representativePath }">
                <span class="page-path">{{ p }}</span>
                <span class="page-title">{{ findPageTitle(p) }}</span>
                <el-tag v-if="p === group.representativePath" type="success" size="small">保留</el-tag>
              </li>
            </ul>
          </div>
          <div v-if="duplicateGroups.length === 0" class="empty-state">无分组视图数据</div>
        </div>
      </div>

      <!-- AI 智能分析结果 -->
      <div v-if="aiResult" class="duplicates-section ai-analysis-section">
        <div class="dup-header">
          <h3 class="block-title">
            <span class="block-bracket">[</span> AI 分析结果 <span class="block-bracket">]</span>
          </h3>
          <div class="ai-summary">
            <el-tag type="danger" size="small" effect="plain">冗余 {{ aiResult.summary.redundantCount }}</el-tag>
            <el-tag type="warning" size="small" effect="plain">重复 {{ aiResult.summary.duplicateGroupsCount }} 组</el-tag>
            <el-tag type="info" size="small" effect="plain">重命名 {{ aiResult.summary.renameCount }}</el-tag>
          </div>
        </div>

        <!-- 批量操作工具栏：与现有工具栏风格一致的幽灵/主操作按钮 -->
        <div class="ai-batch-toolbar">
          <el-button
            type="danger"
            size="small"
            :loading="batchBusy === 'delete'"
            :disabled="batchBusy !== null || !isAdmin || aiResult.redundant.length === 0"
            :title="isAdmin ? '批量删除 AI 判定的冗余文档（不可撤销）' : '需管理员权限'"
            data-tip="按 AI 结论永久删除判定的冗余文档（不可撤销，需管理员）"
            @click="batchDeleteAi"
          >批量删除 ({{ aiResult.redundant.length }})</el-button>
          <el-button
            type="success"
            size="small"
            :loading="batchBusy === 'dedup'"
            :disabled="batchBusy !== null || !isAdmin || aiResult.duplicates.length === 0"
            :title="isAdmin ? '批量合并去重（保留代表文档）' : '需管理员权限'"
            data-tip="按 AI 结论将重复文档合并去重，保留代表文档"
            @click="batchDedupAi"
          >批量去重 ({{ aiResult.duplicates.length }})</el-button>
          <el-button
            type="primary"
            size="small"
            :loading="batchBusy === 'rename'"
            :disabled="batchBusy !== null || !isAdmin || aiResult.renames.length === 0"
            :title="isAdmin ? '按 AI 建议规范化重命名（保持原目录/标题）' : '需管理员权限'"
            data-tip="按 AI 建议将文件名规范化为 kebab-case（保持原目录与标题）"
            @click="batchRenameAi"
          >批量重命名 ({{ aiResult.renames.length }})</el-button>
          <el-button size="small" text :disabled="batchBusy !== null" data-tip="关闭 AI 分析结果面板" @click="aiResult = null">清除</el-button>
        </div>

        <!-- ① 可删除冗余文档 -->
        <div v-if="aiResult.redundant.length" class="ai-sub">
          <div class="ai-sub-title" style="color: var(--neon-magenta)">① 可安全删除的冗余文档</div>
          <div v-for="(item, idx) in aiResult.redundant" :key="'r' + idx" class="ai-item">
            <span class="ai-item-path">{{ item.path }}</span>
            <span class="ai-item-reason">{{ item.reason }}</span>
          </div>
        </div>

        <!-- ② 可合并去重文档 -->
        <div v-if="aiResult.duplicates.length" class="ai-sub">
          <div class="ai-sub-title" style="color: var(--neon-pink)">② 可合并去重的重复文档</div>
          <div v-for="(g, idx) in aiResult.duplicates" :key="'d' + idx" class="ai-item ai-group">
            <div class="ai-item-reason">{{ g.reason }}</div>
            <ul class="ai-group-paths">
              <li v-for="p in g.paths" :key="p" :class="{ rep: p === g.representativePath }">
                <span class="ai-item-path">{{ p }}</span>
                <el-tag v-if="p === g.representativePath" type="success" size="small">保留</el-tag>
              </li>
            </ul>
          </div>
        </div>

        <!-- ③ 建议重命名文档 -->
        <div v-if="aiResult.renames.length" class="ai-sub">
          <div class="ai-sub-title" style="color: var(--neon-cyan)">③ 建议重命名的文档</div>
          <div v-for="(item, idx) in aiResult.renames" :key="'n' + idx" class="ai-item">
            <span class="ai-item-path">{{ item.currentName }}</span>
            <el-icon class="ai-arrow"><Right /></el-icon>
            <span class="ai-item-new">{{ item.suggestedName }}</span>
            <span class="ai-item-reason">{{ item.reason }}</span>
          </div>
        </div>

        <div v-if="!aiResult.redundant.length && !aiResult.duplicates.length && !aiResult.renames.length" class="empty-state">
          AI 未发现需要处理的文档，当前集合已较健康。
        </div>
      </div>

      <!-- 差异对比抽屉：行级 diff，红绿对照 -->
      <el-drawer v-model="diffDrawerVisible" :title="`差异对比：${diffPairLabel}`" size="60%" direction="rtl">
        <div v-if="diffLoading" class="diff-loading" role="status" aria-live="polite">
          <span class="diff-spinner" aria-hidden="true"></span>
          <span class="diff-loading-text">正在加载差异…</span>
        </div>
        <div v-else-if="diffResult" class="diff-content">
          <div class="diff-summary">
            <el-tag type="success" size="small">共同 {{ diffResult.summary.unchanged }} 行</el-tag>
            <el-tag type="danger" size="small">A 独有 {{ diffResult.summary.removed }} 行</el-tag>
            <el-tag type="warning" size="small">B 独有 {{ diffResult.summary.added }} 行</el-tag>
            <el-tag type="info" size="small">相似度 {{ (diffResult.summary.similarity * 100).toFixed(0) }}%</el-tag>
          </div>
          <div class="diff-paths">
            <div class="diff-path-a">A: {{ diffResult.pathA }}</div>
            <div class="diff-path-b">B: {{ diffResult.pathB }}</div>
          </div>
          <div class="diff-lines">
            <div v-for="(line, i) in diffResult.lines" :key="i" :class="['diff-line', `diff-line-${line.type}`]">
              <span class="diff-line-no">{{ line.oldLine ?? '' }}</span>
              <span class="diff-line-no">{{ line.newLine ?? '' }}</span>
              <span class="diff-line-marker">{{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }}</span>
              <span class="diff-line-content">{{ line.content || ' ' }}</span>
            </div>
          </div>
        </div>
        <div v-else class="empty-state">无差异数据</div>
      </el-drawer>
      
      <!-- 空状态 -->
      <div v-if="!loading && pages.length === 0 && !scanProgress.includes('Failed')" class="empty-state">
        <p>未找到页面。点击"刷新"扫描 vault。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dataclean-page {
  display: flex;
  flex-direction: column;
}

.dataclean-card {
  position: relative;
  padding: 24px 28px;
  overflow: hidden;
}

/* 卡片右下角装饰光晕：与系统清理页保持一致 */
.card-deco {
  position: absolute;
  bottom: -50px;
  right: -40px;
  width: 220px;
  height: 220px;
  background: var(--grad-cool);
  filter: blur(60px);
  opacity: 0.25;
  transform: rotate(18deg);
  border-radius: 50%;
  pointer-events: none;
  z-index: 0;
}

.dataclean-header {
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

/* 头部标签 //：与系统清理页统一字号/字距/色值 */
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

.toolbar {
  position: relative;
  z-index: 1;
  margin-bottom: 16px;
  text-align: left;
}

/* 质量统计 5 列：与系统清理页 status-grid 共用同一套样式 token */
.stats-grid {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
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
}

/* 进度条：与系统清理页 result-area 一致的字号/字色 */
.progress-bar {
  position: relative;
  z-index: 1;
  padding: 10px 12px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a15);
  border-radius: 8px;
  margin-bottom: 20px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
}

.progress-bar.success {
  color: var(--neon-cyan);
}

/* 疑似重复对区块：与系统清理页 cleanup-block 同款卡片 */
.duplicates-section {
  position: relative;
  z-index: 1;
  margin-top: 20px;
  padding: 18px 22px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-card);
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

.dup-item {
  margin-bottom: 12px;
  padding: 12px 14px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a15);
  border-radius: var(--radius-card);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--accent-cyan-a20);
}

.dup-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dup-titles {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dup-title-a {
  font-weight: 700;
  color: var(--neon-cyan);
}

.dup-title-b {
  font-weight: 700;
  color: var(--neon-pink);
}

.dup-vs {
  color: var(--text-dim);
  font-size: 16px;
  margin: 0 6px;
  vertical-align: middle;
}

.dup-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-soft);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.dup-similarity {
  color: var(--neon-cyan);
}

.dup-reason {
  color: var(--text-soft);
}

.dup-score {
  color: var(--text-dim);
}

.dup-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 分组视图：组卡片 + 文件列表 */
.group-item {
  margin-bottom: 12px;
  padding: 12px 14px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a15);
  border-radius: var(--radius-card);
}

.group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
}

.group-index {
  color: var(--neon-cyan);
  font-weight: 700;
}

.group-size {
  color: var(--neon-pink);
}

.group-words {
  color: var(--text-dim);
}

.group-pages {
  list-style: none;
  padding: 0;
  margin: 0;
}

.group-pages li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-bottom: 1px dashed var(--accent-purple-a15);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
}

.group-pages li:last-child {
  border-bottom: none;
}

.group-pages li.representative {
  background: var(--accent-cyan-a10, rgba(0, 255, 200, 0.1));
  color: var(--neon-cyan);
}

.page-path {
  flex: 1;
  color: var(--text-bright);
}

.page-title {
  color: var(--text-soft);
}

/* 差异对比抽屉：行级 diff 样式 */
.diff-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 16px;
  color: var(--text-soft);
  font-family: var(--font-mono);
}

/* 轻量等待动画：纯 CSS 旋转（由合成器线程驱动），不阻塞主线程 */
.diff-spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 3px solid var(--accent-purple-a15, rgba(120, 120, 255, 0.18));
  border-top-color: var(--neon-cyan, #2bd1ff);
  animation: diff-spin 0.8s linear infinite;
  will-change: transform;
}

@keyframes diff-spin {
  to { transform: rotate(360deg); }
}

.diff-loading-text {
  font-size: 13px;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}

.diff-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.diff-summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.diff-paths {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background: var(--bg-scene);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
}

.diff-path-a {
  color: var(--neon-cyan);
}

.diff-path-b {
  color: var(--neon-pink);
}

.diff-lines {
  background: var(--bg-void);
  border: 1px solid var(--accent-purple-a15);
  border-radius: 6px;
  padding: 8px 0;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}

.diff-line {
  display: flex;
  padding: 0 10px;
  white-space: pre;
}

.diff-line-no {
  display: inline-block;
  width: 40px;
  text-align: right;
  color: var(--text-dim);
  padding-right: 8px;
  user-select: none;
}

.diff-line-marker {
  display: inline-block;
  width: 16px;
  text-align: center;
  font-weight: 700;
  user-select: none;
}

.diff-line-content {
  flex: 1;
  color: var(--text-soft);
}

.diff-line-context {
  background: transparent;
}

.diff-line-add {
  background: var(--accent-cyan-a10, rgba(0, 255, 200, 0.08));
}

.diff-line-add .diff-line-marker {
  color: var(--neon-cyan);
}

.diff-line-add .diff-line-content {
  color: var(--neon-cyan);
}

.diff-line-del {
  background: var(--accent-pink-a10, rgba(255, 100, 180, 0.08));
}

.diff-line-del .diff-line-marker {
  color: var(--neon-pink);
}

.diff-line-del .diff-line-content {
  color: var(--neon-pink);
}

/* 评分色：用主题变量而非 Element Plus 默认硬编码，确保主题切换一致 */
.score-excellent {
  color: var(--neon-cyan);
  font-weight: 700;
}

.score-good {
  color: var(--neon-purple);
}

.score-needs-work {
  color: var(--neon-pink);
}

.score-poor,
.score-critical {
  color: var(--neon-magenta);
  font-weight: 700;
}

.empty-state {
  position: relative;
  z-index: 1;
  text-align: center;
  padding: 40px;
  color: var(--text-soft);
}

.mock-section {
  position: relative;
  z-index: 1;
  background: var(--bg-scene);
  padding: 16px;
  border-radius: var(--radius-card);
  margin-bottom: 20px;
}

/* mock-section pre 背景：用 bg-void 变量替代硬编码 #1a1a2e */
.mock-section pre {
  background: var(--bg-void);
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 12px;
  color: var(--text-soft);
}

/* 响应式：小屏改为 2 列 / 1 列，与系统清理页一致 */
@media (max-width: 1100px) {
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 600px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }
}

/* ─── AI 分析结果区（与 duplicates-section 同款卡片，复用主题变量）─── */
.ai-analysis-section {
  margin-top: 20px;
}

.ai-summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.ai-batch-toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a15);
  border-radius: var(--radius-card);
  margin-bottom: 12px;
}

.ai-sub {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0;
  border-top: 1px dashed var(--accent-purple-a15);
}

.ai-sub-title {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.ai-item {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 6px 10px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a15);
  border-radius: var(--radius-card);
  font-family: var(--font-mono);
  font-size: 12px;
}

.ai-item-path {
  color: var(--text-bright);
  word-break: break-all;
}

.ai-item-new {
  color: var(--neon-cyan);
  font-weight: 700;
  word-break: break-all;
}

.ai-item-reason {
  color: var(--text-soft);
  margin-left: auto;
  text-align: right;
}

.ai-arrow {
  color: var(--neon-cyan);
  font-size: 14px;
}

.ai-group-paths {
  list-style: none;
  padding: 6px 0 0;
  margin: 0;
  width: 100%;
}

.ai-group-paths li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
  border-bottom: 1px dashed var(--accent-purple-a15);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
}

.ai-group-paths li:last-child {
  border-bottom: none;
}

.ai-group-paths li.rep {
  background: var(--accent-cyan-a10, rgba(0, 255, 200, 0.1));
  color: var(--neon-cyan);
}
</style>

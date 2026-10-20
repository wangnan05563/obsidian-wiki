<script setup lang="ts">
import { API_BASE, apiFetch } from '../utils/apiBase';
import { ref, computed, reactive, watch, nextTick, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { TableInstance } from 'element-plus';
import { Sort, MagicStick, Right, Refresh, View, CopyDocument, Search } from '@element-plus/icons-vue';
// wiki三期 T02472 L4（PRD §16）：本页顶部操作原为 4 个纯图标按钮（仅悬浮提示），
// 破坏性/耗时动作看不出是什么 → 改回带文字按钮，AI 分析旁注明「调用你的模型」。
// T01629：统一弹窗（抽屉形态沿用同一套遮罩/动效/容器规格）
import AppModal from '../components/AppModal.vue';
// T02719（PRD X2/X8 收尾）：本页分区内的小块空态与差异抽屉的自写 spinner，
// 此前是全站三态组件化（T02476）刻意留在单外的两处之一，现统一走 StateBlock 唯一出口。
import StateBlock from '../components/StateBlock.vue';
import { usePermission } from '../composables/usePermission';
import { useAuthStore } from '../stores/auth';
import { useModelStore } from '../stores/model';
import { loadAiUserConfigForPreset, type AiUserConfig } from '../services/userConfig';
import { AUTO_MODEL, resolveAutoPresetForUser } from '../utils/autoModel';
import {
  ISSUE_CATEGORIES,
  PAGE_SIZE_OPTIONS,
  PAGE_TOTAL_HINT,
  buildIssueContext,
  categoryCounts,
  categoryMeta,
  categoryPaths,
  defaultTableQuery,
  filterPages,
  mergeSelection,
  pageIssueKeys,
  problemCount,
  selectionSummary,
  slicePage,
  sortPages,
  totalPageCount,
  type IssueKey,
  type TableQuery,
} from '../utils/dataCleanPresentation';
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

// L2（PRD §16）：原来 5 张卡是「平均分 / 优秀 / 良好 / 需改进」的质量均分。
// 实测平均 98.3、优秀 205、需改进(<40) 0 —— 5 张卡里 4 张在说「一切正常」，
// 用户看完不知道该做什么。改成按「可操作的问题分类」计数，每类直接给批量动作。
const issueCtx = computed(() => buildIssueContext(pages.value));
const issueCounts = computed(() => categoryCounts(pages.value, issueCtx.value));
const healthy = computed(() => ISSUE_CATEGORIES.every((c) => issueCounts.value[c.key] === 0));

// L3（PRD §16）：216 行固定 height=600、无搜索/排序/分页 → 问题页永远翻不到。
// 现由纯函数 filterPages/sortPages/slicePage 驱动，页面只持状态。
const tableQuery = reactive<TableQuery>(defaultTableQuery());
const pageNum = ref(1);
const pageSize = ref(50);
const tableRef = ref<TableInstance>();

const filteredPages = computed(() => filterPages(pages.value, issueCtx.value, tableQuery));
const sortedPages = computed(() => sortPages(filteredPages.value, issueCtx.value, tableQuery.sortProp, tableQuery.sortOrder));
const pagedRows = computed(() => slicePage(sortedPages.value, pageNum.value, pageSize.value));
const totalPages = computed(() => totalPageCount(sortedPages.value.length, pageSize.value));
const dirOptions = computed(() => Array.from(new Set(pages.value.map((p) => p.metadata.directory))).sort());
const pageRowPaths = computed(() => pagedRows.value.map((p) => p.path));
const selectedSummary = computed(() => selectionSummary(selectedPages.value.length));
const problemPages = computed(() => pages.value.filter((p) => problemCount(p, issueCtx.value) > 0).length);

function resetPage(): void {
  pageNum.value = 1;
}

watch(() => [tableQuery.keyword, tableQuery.issue, tableQuery.dir, pageSize.value], resetPage);

/** 点分类卡 = 只看这一类；再点同一张卡 = 取消筛选 */
function toggleIssueFilter(key: IssueKey): void {
  tableQuery.issue = tableQuery.issue === key ? 'all' : key;
  resetPage();
}

function onSortChange(payload: { prop?: string | null; order?: string | null }): void {
  if (!payload.prop || !payload.order) {
    const d = defaultTableQuery();
    tableQuery.sortProp = d.sortProp;
    tableQuery.sortOrder = d.sortOrder;
  } else {
    tableQuery.sortProp = payload.prop as TableQuery['sortProp'];
    tableQuery.sortOrder = payload.order as TableQuery['sortOrder'];
  }
  resetPage();
}

function resetFilters(): void {
  tableQuery.keyword = '';
  tableQuery.issue = 'all';
  tableQuery.dir = 'all';
  resetPage();
}

const hasFilter = computed(() => tableQuery.keyword !== '' || tableQuery.issue !== 'all' || tableQuery.dir !== 'all');

// el-table 的 selection-change 只带当前页的行；直接赋值会让翻页丢掉其他页的勾选。
function onRowChange(selection: PageQualityScore[]) {
  selectedPages.value = mergeSelection(selectedPages.value, pageRowPaths.value, selection.map((s) => s.path));
}

/** 分类批量动作的落点：先把该分类全部页面置为已选，再把表格勾选状态同步到当前页 */
async function selectCategory(key: IssueKey): Promise<void> {
  const paths = categoryPaths(pages.value, issueCtx.value, key);
  if (paths.length === 0) return;
  selectedPages.value = paths;
  tableQuery.issue = key;
  resetPage();
  await nextTick();
  const t = tableRef.value;
  if (!t) return;
  t.clearSelection();
  pagedRows.value.filter((p) => paths.includes(p.path)).forEach((p) => t.toggleRowSelection(p, true));
}

function clearSelection(): void {
  tableRef.value?.clearSelection();
  selectedPages.value = [];
}

/**
 * 分类卡批量动作（PRD §16 L2「每类直接给批量动作」）：
 * 能自动修的当场修（补元信息），判定型的先跑检测（标题重复→去重），
 * 其余（无出链/字数过短/读取失败）后端没有自动修法，落到「选中这批」让用户用工具栏归档或删除。
 */
async function runCategoryAction(key: IssueKey): Promise<void> {
  const paths = categoryPaths(pages.value, issueCtx.value, key);
  if (paths.length === 0) return;
  if (key === 'missingFrontmatter') {
    if (!isAdmin.value) {
      ElMessage.warning('补齐元信息会写入页面文件，需要管理员权限');
      return;
    }
    await fixFrontmatterFor(paths);
    return;
  }
  await selectCategory(key);
  if (key === 'duplicateTitle') await runDeduplication();
}

/** 分类批量按钮的悬浮说明：能自动修的写明「会写入文件」，其余写明下一步落在哪个工具 */
function categoryActionTip(key: IssueKey): string {
  if (key === 'missingFrontmatter') {
    return isAdmin.value ? '给这类页面补上缺失的 type 与 title，会写入文件' : '这一步会写入文件，需要管理员账户';
  }
  if (key === 'duplicateTitle') return '选中这类页面并重跑重复检测，找出可以合并的分组';
  return '先把这类页面全部选中，再用下方工具栏归档或删除';
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
    scanProgress.value = `已加载 ${pages.value.length} 个页面，其中 ${problemPages.value} 个有可处理的问题`;
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
// 「AI分析」按钮：调用用户自有 BYOK 模型对当前页面集合做分类（冗余删除/重复去重/规范重命名），
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
  scanProgress.value = 'AI 正在分析页面集合（冗余 / 重复 / 重命名）...';
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

// 批量删除：AI 判定的冗余页面（管理员门控）
async function batchDeleteAi() {
  if (!aiResult.value || aiResult.value.redundant.length === 0) return;
  if (!isAdmin.value) { ElMessage.warning('需管理员权限才能永久删除'); return; }
  const files = aiResult.value.redundant.map((r) => r.path);
  try {
    await ElMessageBox.confirm(
      `将永久删除 ${files.length} 个 AI 判定的冗余页面，此操作不可撤销。`,
      '批量删除（AI 结论）',
      { confirmButtonText: '永久删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  batchBusy.value = 'delete'; // 进入加载态，按钮 spinner 持续显示直到删除+重扫完成
  scanProgress.value = '正在批量删除冗余页面...';
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

// 批量去重：把重复组非代表页面合并进代表页面（管理员门控）
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
      `将对 ${groups.length} 组重复页面执行合并去重（保留代表页面，其余合并归档）。`,
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
      ElMessage.success(`已合并去重 ${result.merged} 个页面`);
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
      `将按 AI 建议对 ${renames.length} 个页面做规范化重命名（保持原目录、标题不变，不影响 [[链接]]）。`,
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
    // 合并后重新扫描，避免"去重后仍看到重复页面"的体感
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

onMounted(() => loadPages());
</script>

<template>
  <div class="dataclean-page">
    <div class="glass-card dataclean-card">
      <div class="card-deco"></div>
      
      <div class="dataclean-header">
        <div class="head-text">
          <!-- T02472 L7（PRD §16）：原名「数据清洗」与「缓存与日志清理」职责不可辨（两页共用 cleanup 权限），
               页头第一句先划清边界 -->
          <h2 class="head-title grad-text">页面质量清洗</h2>
          <p class="head-tip">只处理知识库里的页面内容（查重、补元信息、归档）；临时缓存与日志在「缓存与日志清理」</p>
        </div>
        <!-- T02472 L4：原 4 个纯图标按钮只有悬浮提示，看不出点了会做什么 → 改带文字按钮 -->
        <div class="head-actions">
          <div class="head-actions-row">
            <el-button class="neon-btn" :icon="Refresh" :loading="loading" data-tip="重新扫描知识库页面并刷新本页统计" @click="loadPages">重新扫描</el-button>
            <el-button class="neon-btn secondary" :icon="View" data-tip="只读检查：链接是否断裂、元信息能否解析，不改动文件" @click="runPrecheck">预检</el-button>
            <el-button class="neon-btn secondary" :icon="CopyDocument" :loading="deduping" data-tip="按内容哈希与相似度找出重复页面并聚合成分组" @click="runDeduplication">重复检测</el-button>
            <el-button class="neon-btn secondary" :icon="MagicStick" :loading="analyzing" data-tip="让模型把页面分成冗余 / 重复 / 待重命名三类，结论出来后可直接批量执行" @click="runAiAnalysis">AI 分析</el-button>
          </div>
          <p class="head-note">AI 分析会调用你在「配置 / 我的」里填写的模型，按你的额度计费。</p>
        </div>
      </div>
      
      <!-- Mock data example (B-2) -->
      <div v-if="false" class="mock-section">
        <h4>Mock Example (for testing)</h4>
        <pre>{{ JSON.stringify(MOCK_PAGES_EXAMPLE, null, 2) }}</pre>
        <pre>{{ JSON.stringify(MOCK_DUPLICATE_EXAMPLE, null, 2) }}</pre>
      </div>
      
      <!-- 页面总数 + 可操作问题分类（T02472 L1/L2）：
           总数与仪表盘同源并写明口径；原来的「平均分/优秀/良好/需改进」四张恒为正常的卡换成能直接批量处理的分类 -->
      <div v-if="pages.length > 0" class="stats-grid issue-grid">
        <div class="status-block total-block">
          <div class="status-title">页面总数</div>
          <div class="status-value">{{ pages.length }}</div>
          <div class="status-meta">{{ PAGE_TOTAL_HINT }}</div>
        </div>
        <div
          v-for="c in ISSUE_CATEGORIES"
          :key="c.key"
          class="status-block issue-card"
          :class="{ 'is-active': tableQuery.issue === c.key, 'is-clean': issueCounts[c.key] === 0 }"
        >
          <div class="status-title">{{ c.label }}</div>
          <div class="status-value">{{ issueCounts[c.key] }}<span class="unit"> 个</span></div>
          <div class="status-meta">{{ issueCounts[c.key] === 0 ? categoryMeta(0) : c.desc }}</div>
          <div v-if="issueCounts[c.key] > 0" class="issue-actions">
            <el-button
              size="small"
              :type="tableQuery.issue === c.key ? 'primary' : 'info'"
              plain
              data-tip="只在这一类页面里筛表格，翻完再点一次取消"
              @click="toggleIssueFilter(c.key)"
            >{{ tableQuery.issue === c.key ? '取消筛选' : '只看这类' }}</el-button>
            <el-button
              size="small"
              type="warning"
              plain
              :disabled="(c.key === 'missingFrontmatter' && !isAdmin) || batchBusy !== null"
              :data-tip="categoryActionTip(c.key)"
              @click="runCategoryAction(c.key)"
            >{{ c.action }} ({{ issueCounts[c.key] }})</el-button>
          </div>
        </div>
      </div>
      <p v-if="pages.length > 0 && healthy" class="healthy-note">这一批页面没有上面五类问题，无需批量处理。</p>
      
      <!-- 预检结果 -->
      <el-alert v-if="precheckResult"
        :title="precheckResult.passed ? 'Vault 预检：通过' : 'Vault 预检：发现问题'"
        :type="precheckResult.passed ? 'success' : 'warning'"
        :description="`扫描 ${precheckResult.scannedFiles} 个文件 · ${precheckResult.errors.length} 个错误 · ${precheckResult.warnings.length} 个警告`"
        show-icon closable style="margin-bottom:16px" />
      
      <div v-if="scanProgress" class="progress-bar" :class="{ success: !loading && !scanProgress.includes('failed') && !scanProgress.includes('Failed') }">{{ scanProgress }}</div>
      
      <!-- 搜索 / 目录筛选 / 排序状态（T02472 L3）：216 行以前无搜索、无排序、无分页，问题页翻不到 -->
      <div v-if="pages.length > 0" class="table-tools">
        <el-input
          v-model="tableQuery.keyword"
          class="search-input"
          :prefix-icon="Search"
          placeholder="搜索文件路径或标题"
          clearable
          aria-label="搜索页面"
          data-tip="在当前筛选结果里按路径 / 标题 / 目录过滤"
        />
        <el-select v-model="tableQuery.dir" class="dir-select" aria-label="按目录筛选" data-tip="只统计某个页面目录下的结果">
          <el-option label="全部目录" value="all" />
          <el-option v-for="d in dirOptions" :key="d" :label="d" :value="d" />
        </el-select>
        <span class="filter-count">筛出 {{ sortedPages.length }} / {{ pages.length }} 个页面</span>
        <el-button v-if="hasFilter" size="small" text data-tip="清空搜索、目录与分类筛选" @click="resetFilters">清空筛选</el-button>
      </div>

      <!-- 操作工具栏（T02472 L6）：已选数量常驻显示；非管理员整组置灰并当场说明原因，
           原来是点下去才弹一条 warning，用户以为是按钮坏了 -->
      <div class="toolbar" :class="{ 'is-locked': !isAdmin }">
        <div class="toolbar-row">
          <span class="sel-summary">{{ selectedSummary }}</span>
          <el-button-group v-if="selectedPages.length > 0">
            <el-button
              type="danger"
              size="small"
              :loading="batchBusy === 'delete-selected'"
              :disabled="batchBusy !== null || !isAdmin"
              :data-tip="isAdmin ? '永久删除选中的页面，操作不可撤销' : '需要管理员权限'"
              @click="deleteSelected"
            >永久删除 ({{ selectedPages.length }})</el-button>
            <el-button
              type="danger"
              size="small"
              plain
              :disabled="!isAdmin"
              :data-tip="isAdmin ? '移动到 archive/日期/ 目录，后续可恢复' : '需要管理员权限'"
              @click="archiveSelected"
            >归档 ({{ selectedPages.length }})</el-button>
            <el-button
              type="warning"
              size="small"
              :disabled="!isAdmin"
              :data-tip="isAdmin ? '给选中页面补上缺失的 type/title（会写入文件）' : '需要管理员权限'"
              @click="fixFrontmatterFor(selectedPages)"
            >补齐元信息</el-button>
            <el-button size="small" text data-tip="清空当前已选，不动文件" @click="clearSelection">清除选择</el-button>
          </el-button-group>
        </div>
        <p v-if="!isAdmin" class="perm-note">永久删除、归档与补齐元信息会改动知识库文件，需要管理员账户；当前账户只能查看和筛选。</p>
      </div>

      <!-- 页面表格：默认按「问题数」倒序，最该处理的排在第一页 -->
      <el-table
        ref="tableRef"
        :data="pagedRows"
        row-key="path"
        style="width: 100%"
        stripe
        height="520"
        :default-sort="{ prop: 'problems', order: 'descending' }"
        @selection-change="onRowChange"
        @sort-change="onSortChange"
      >
        <el-table-column type="selection" width="55" align="center" />
        <el-table-column prop="path" label="文件路径" min-width="200" sortable="custom" show-overflow-tooltip />
        <el-table-column prop="title" label="标题" min-width="150" sortable="custom" show-overflow-tooltip />
        <el-table-column prop="problems" label="问题数" width="100" align="center" sortable="custom">
          <template #default="{ row }">
            <el-tag :type="pageIssueKeys(row, issueCtx).length > 0 ? 'warning' : 'info'" size="small" effect="plain">
              {{ pageIssueKeys(row, issueCtx).length }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="qualityScore" label="评分" width="90" align="center" sortable="custom">
          <template #default="{ row }">
            <el-tag :type="row.qualityScore>=80?'success':row.qualityScore>=60?'':row.qualityScore>=40?'warning':'danger'" size="small">
              {{ row.qualityScore }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="wordCount" label="字数" width="90" align="right" sortable="custom">
          <template #default="{ row }">{{ row.metadata.wordCount }}</template>
        </el-table-column>
        <el-table-column prop="internalLinks" label="出链" width="90" align="right" sortable="custom">
          <template #default="{ row }">{{ row.metadata.internalLinks }}</template>
        </el-table-column>
        <el-table-column label="目录" width="110"><template #default="{ row }">{{ row.metadata.directory }}</template></el-table-column>
        <!-- T02472 L5：原「有 FM / 无 FM」是缩写，用户读不出 FM 指什么 -->
        <el-table-column label="元信息" width="110"><template #default="{ row }">
          <el-tag v-if="row.metadata.hasFrontmatter" type="success" size="small" effect="plain">元信息完整</el-tag>
          <el-tag v-else type="danger" size="small" effect="plain">缺元信息</el-tag>
        </template></el-table-column>
        <el-table-column label="问题分类" min-width="190"><template #default="{ row }">
          <el-tag
            v-for="k in pageIssueKeys(row, issueCtx)"
            :key="k"
            type="warning"
            size="small"
            effect="plain"
            class="issue-tag"
          >{{ ISSUE_CATEGORIES.find((c) => c.key === k)?.label }}</el-tag>
          <span v-if="pageIssueKeys(row, issueCtx).length === 0" class="no-issue">—</span>
        </template></el-table-column>
      </el-table>

      <div v-if="pages.length > 0" class="table-foot">
        <el-pagination
          v-model:current-page="pageNum"
          v-model:page-size="pageSize"
          :page-sizes="PAGE_SIZE_OPTIONS"
          :total="sortedPages.length"
          layout="total, sizes, prev, pager, next, jumper"
          background
        />
      </div>
      
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
                data-tip="逐行对比这两个重复页面的差异（A 独有 / B 独有 / 共同）"
                @click="viewDiff(dup)"
              >查看差异</el-button>
              <el-button
                size="small"
                type="success"
                :loading="mergingKey === pairKey(dup)"
                :disabled="mergingKey === pairKey(dup)"
                data-tip="将质量较低的页面合并进代表页面，并归档被合并页"
                @click="mergeDuplicatePair(dup)"
              >合并到 {{ dup.pageA.title }}</el-button>
              <el-button size="small" text :disabled="mergingKey === pairKey(dup) || diffingKey === pairKey(dup)" data-tip="从重复列表中移除该对（不删除文件）" @click="duplicates.splice(idx, 1)">忽略</el-button>
            </div>
          </div>
          <StateBlock v-if="duplicates.length === 0" state="empty" compact empty-title="没有配对的重复页面" />
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
          <StateBlock v-if="duplicateGroups.length === 0" state="empty" compact empty-title="没有分组的重复页面" />
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
            :title="isAdmin ? '批量删除 AI 判定的冗余页面（不可撤销）' : '需管理员权限'"
            data-tip="按 AI 结论永久删除判定的冗余页面（不可撤销，需管理员）"
            @click="batchDeleteAi"
          >批量删除 ({{ aiResult.redundant.length }})</el-button>
          <el-button
            type="success"
            size="small"
            :loading="batchBusy === 'dedup'"
            :disabled="batchBusy !== null || !isAdmin || aiResult.duplicates.length === 0"
            :title="isAdmin ? '批量合并去重（保留代表页面）' : '需管理员权限'"
            data-tip="按 AI 结论将重复页面合并去重，保留代表页面"
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

        <!-- ① 可删除冗余页面 -->
        <div v-if="aiResult.redundant.length" class="ai-sub">
          <div class="ai-sub-title" style="color: var(--neon-magenta)">① 可安全删除的冗余页面</div>
          <div v-for="(item, idx) in aiResult.redundant" :key="'r' + idx" class="ai-item">
            <span class="ai-item-path">{{ item.path }}</span>
            <span class="ai-item-reason">{{ item.reason }}</span>
          </div>
        </div>

        <!-- ② 可合并去重页面 -->
        <div v-if="aiResult.duplicates.length" class="ai-sub">
          <div class="ai-sub-title" style="color: var(--neon-pink)">② 可合并去重的重复页面</div>
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

        <!-- ③ 建议重命名页面 -->
        <div v-if="aiResult.renames.length" class="ai-sub">
          <div class="ai-sub-title" style="color: var(--neon-cyan)">③ 建议重命名的页面</div>
          <div v-for="(item, idx) in aiResult.renames" :key="'n' + idx" class="ai-item">
            <span class="ai-item-path">{{ item.currentName }}</span>
            <el-icon class="ai-arrow"><Right /></el-icon>
            <span class="ai-item-new">{{ item.suggestedName }}</span>
            <span class="ai-item-reason">{{ item.reason }}</span>
          </div>
        </div>

        <StateBlock
          v-if="!aiResult.redundant.length && !aiResult.duplicates.length && !aiResult.renames.length"
          state="empty"
          compact
          empty-title="AI 未发现需要处理的页面"
          empty-desc="当前页面集合已较健康"
        />
      </div>

      <!-- 差异对比抽屉：行级 diff，红绿对照 -->
      <AppModal v-model="diffDrawerVisible" variant="drawer" :title="`差异对比：${diffPairLabel}`" size="60%">
        <StateBlock v-if="diffLoading" state="loading" loading-text="正在加载差异…" />
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
        <StateBlock v-else state="empty" compact empty-title="没有取到差异内容" />
      </AppModal>
      
      <!-- 空状态 -->
      <!-- 页面级空态（X8：一句现状 + 一句原因 + 一个主按钮，主按钮就是页顶那个「重新扫描」动作） -->
      <StateBlock
        v-if="!loading && pages.length === 0 && !scanProgress.includes('Failed')"
        state="empty"
        empty-title="还没有加载到页面"
        empty-desc="本页按已扫描到的页面统计质量问题，知识库尚未扫描时没有可清洗的对象"
      >
        <template #action>
          <el-button class="neon-btn" size="small" :icon="Refresh" @click="loadPages">重新扫描</el-button>
        </template>
      </StateBlock>
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

/* T02472 L4：带文字的主操作 + 下方一行费用说明（AI 分析要调用用户自己的模型） */
.head-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.head-actions-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.head-note {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
}

.toolbar {
  position: relative;
  z-index: 1;
  margin-bottom: 16px;
  text-align: left;
}

/* T02472 L6：已选数量常驻；权限不足时整组置灰并把原因写在按钮旁边 */
.toolbar-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.sel-summary {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--neon-cyan);
}

.perm-note {
  margin: 8px 0 0;
  padding: 8px 10px;
  background: var(--bg-scene);
  border-left: 2px solid var(--neon-pink);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-soft);
}

.toolbar.is-locked .sel-summary {
  color: var(--text-dim);
}

/* T02472 L3：搜索 / 目录筛选 / 命中计数 / 分页 */
.table-tools {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.search-input {
  width: 260px;
}

.dir-select {
  width: 150px;
}

.filter-count {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
}

.table-foot {
  position: relative;
  z-index: 1;
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

/* T02472 L2：分类卡（总数 + 5 类 = 3 列两行，问题数 >0 才给批量按钮） */
.stats-grid.issue-grid {
  grid-template-columns: repeat(3, 1fr);
}

.issue-card .status-meta,
.total-block .status-meta {
  line-height: 1.5;
}

.issue-card:not(.is-clean) .status-value {
  color: var(--neon-pink);
  text-shadow: 0 0 12px var(--accent-pink-a10, rgba(255, 100, 180, 0.3));
}

.issue-card.is-clean .status-value {
  color: var(--text-dim);
  text-shadow: none;
}

.issue-card.is-active {
  border-color: var(--neon-cyan);
}

.issue-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.issue-tag {
  margin: 0 4px 2px 0;
}

.no-issue {
  color: var(--text-dim);
}

.healthy-note {
  position: relative;
  z-index: 1;
  margin: -10px 0 18px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
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

/* 差异对比抽屉：行级 diff 样式（加载态与空态已并入 StateBlock，T02719） */
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
  .stats-grid,
  .stats-grid.issue-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 600px) {
  .stats-grid,
  .stats-grid.issue-grid {
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

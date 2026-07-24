<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { consumeSSE } from '../utils/sse';
import type {
  TreeNode,
  FileContent,
  SearchHit,
  DraftItem,
  DraftBatchItem,
  DraftCompileEvent,
} from '../types';

// 视图模式：knowledge=知识浏览，draft=草稿审核
// 为什么独立 ref 而非路由：两者共用 Browse 页面骨架，避免引入新菜单项
type BrowseMode = 'knowledge' | 'draft';
const mode = ref<BrowseMode>('knowledge');

const treeData = ref<TreeNode[]>([]);
const currentNode = ref<string>('');
const fileContent = ref<FileContent | null>(null);
const loading = ref(false);
const editing = ref(false);
const editBuffer = ref('');

const searchQuery = ref('');
const searchHits = ref<SearchHit[]>([]);
const searching = ref(false);
const showSearchResults = ref(false);

// AC-10: source/status 过滤
// 按 frontmatter.source 过滤（如 "qq-chat", "web", "manual"），空串 = 全部
const sourceFilter = ref('');
// 按 frontmatter.status 过滤（如 "draft", "published"），空串 = 全部
const statusFilter = ref('');

// 过滤选项预设值
const sourceOptions = [
  { label: '全部来源', value: '' },
  { label: 'QQ 聊天', value: 'qq-chat' },
  { label: '网页', value: 'web' },
  { label: '手工录入', value: 'manual' },
];
const statusOptions = [
  { label: '全部状态', value: '' },
  { label: '草稿', value: 'draft' },
  { label: '已发布', value: 'published' },
];

const treeProps = {
  label: 'name',
  children: 'children',
};

// ===== 草稿审核状态 =====
// draft 列表与当前选中 draft 复用 fileContent（结构一致：frontmatter+body）
const drafts = ref<DraftItem[]>([]);
const currentDraftPath = ref<string>('');
// 批量编译进度：每项对应一个 draft 的编译状态
const batchItems = ref<DraftBatchItem[]>([]);
const compiling = ref(false);
// SSE 进度消息汇总（用于顶部进度条文案）
const progressMessage = ref('');
let abortController: AbortController | null = null;
let clearPanelTimer: ReturnType<typeof setTimeout> | null = null;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

async function loadTree() {
  try {
    const res = await fetch('/api/files/tree');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    treeData.value = data.tree ?? [];
  } catch (err) {
    ElMessage.error('加载目录树失败：' + (err as Error).message);
  }
}

async function loadDrafts() {
  try {
    const res = await fetch('/api/qq-ingest/drafts');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    drafts.value = data.drafts ?? [];
  } catch (err) {
    ElMessage.error('加载草稿列表失败：' + (err as Error).message);
    drafts.value = [];
  }
}

// 构建搜索 URL，附加 source/status 过滤参数（AC-10）
function buildSearchUrl(): string | null {
  const q = searchQuery.value.trim();
  const src = sourceFilter.value;
  const st = statusFilter.value;
  // 无关键词且无过滤条件时返回 null（不搜索）
  if (!q && !src && !st) return null;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (src) params.set('source', src);
  if (st) params.set('status', st);
  return `/api/search?${params.toString()}`;
}

async function doSearch() {
  const url = buildSearchUrl();
  if (!url) {
    showSearchResults.value = false;
    searchHits.value = [];
    return;
  }
  searching.value = true;
  showSearchResults.value = true;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    searchHits.value = data.hits ?? [];
  } catch (err) {
    ElMessage.error('搜索失败：' + (err as Error).message);
    searchHits.value = [];
  } finally {
    searching.value = false;
  }
}

function clearSearch() {
  searchQuery.value = '';
  searchHits.value = [];
  showSearchResults.value = false;
  // 同时清除过滤条件（AC-10）
  sourceFilter.value = '';
  statusFilter.value = '';
}

// 过滤条件变更时立即触发搜索（无防抖，因为是下拉选择）
function handleFilterChange() {
  doSearch();
}

async function handleSearchHit(hit: SearchHit) {
  if (hasUnsavedChanges()) {
    try {
      await ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
    } catch { return; }
  }
  currentNode.value = hit.path;
  editing.value = false;
  loading.value = true;
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(hit.path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fileContent.value = await res.json();
    editBuffer.value = fileContent.value?.content ?? '';
  } catch (err) {
    ElMessage.error('读取文件失败：' + (err as Error).message);
    fileContent.value = null;
  } finally {
    loading.value = false;
  }
}

async function handleNodeClick(node: TreeNode) {
  if (node.type !== 'file') return;
  if (hasUnsavedChanges()) {
    try {
      await ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
    } catch { return; }
  }
  currentNode.value = node.path;
  editing.value = false;
  loading.value = true;
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(node.path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fileContent.value = await res.json();
    editBuffer.value = fileContent.value?.content ?? '';
  } catch (err) {
    ElMessage.error('读取文件失败：' + (err as Error).message);
    fileContent.value = null;
  } finally {
    loading.value = false;
  }
}

// 选中 draft：复用 /api/files 读取内容（draft 是 vault 内 .md 文件）
async function handleDraftClick(d: DraftItem) {
  if (hasUnsavedChanges()) {
    try {
      await ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
    } catch { return; }
  }
  currentDraftPath.value = d.path;
  editing.value = false;
  loading.value = true;
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(d.path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fileContent.value = await res.json();
    editBuffer.value = fileContent.value?.content ?? '';
  } catch (err) {
    ElMessage.error('读取草稿失败：' + (err as Error).message);
    fileContent.value = null;
  } finally {
    loading.value = false;
  }
}

function startEdit() {
  if (!fileContent.value) return;
  editBuffer.value = fileContent.value.content;
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
  editBuffer.value = '';
}

async function saveEdit() {
  const target = mode.value === 'draft' ? currentDraftPath.value : currentNode.value;
  if (!target) return;
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(target)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editBuffer.value }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    ElMessage.success('保存成功');
    editing.value = false;
    // 重新读取保留模式上下文：draft 模式回拉 draft，knowledge 模式回拉文件
    if (mode.value === 'draft') {
      await handleDraftClick({ path: target, name: '' });
    } else {
      await handleNodeClick({ path: target, name: '', type: 'file' } as TreeNode);
    }
  } catch (err) {
    ElMessage.error('保存失败：' + (err as Error).message);
  }
}

// 发布单个 draft：调用 POST /api/qq-ingest/compile/:draftPath（SSE）
async function publishDraft(d: DraftItem) {
  if (compiling.value) {
    ElMessage.warning('正在编译中，请稍候');
    return;
  }
  // 二次确认：发布会调用 LLM 产生费用且写入正式页面
  try {
    await ElMessageBox.confirm(
      `确认发布草稿「${d.name}」到知识库？发布后将生成正式页面。`,
      '发布确认',
      { type: 'warning' },
    );
  } catch {
    return; // 用户取消
  }

  compiling.value = true;
  progressMessage.value = '准备编译…';
  batchItems.value = [{
    path: d.path,
    name: d.name,
    status: 'running',
    pages: [],
  }];
  abortController = new AbortController();

  try {
    const res = await fetch(
      `/api/qq-ingest/compile/${encodeURIComponent(d.path)}`,
      { method: 'POST', signal: abortController.signal },
    );
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    await consumeSSE(res, handleCompileEvent, abortController.signal);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    ElMessage.error('发布失败：' + (err as Error).message);
    batchItems.value[0].status = 'error';
    batchItems.value[0].message = (err as Error).message;
  } finally {
    compiling.value = false;
    abortController = null;
    // 编译完成后自动刷新草稿列表
    loadDrafts();
    loadTree();
  }
}

// 批量发布：调用 POST /api/qq-ingest/compile/batch（SSE）
async function publishAllDrafts() {
  if (compiling.value) {
    ElMessage.warning('正在编译中，请稍候');
    return;
  }
  if (drafts.value.length === 0) {
    ElMessage.info('没有可发布的草稿');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确认批量发布 ${drafts.value.length} 个草稿？此操作将逐个调用 LLM 编译并写入正式页面。`,
      '批量发布确认',
      { type: 'warning' },
    );
  } catch {
    return;
  }

  compiling.value = true;
  progressMessage.value = '开始批量编译…';
  batchItems.value = drafts.value.map((d) => ({
    path: d.path,
    name: d.name,
    status: 'pending',
    pages: [],
  }));
  abortController = new AbortController();

  try {
    const res = await fetch('/api/qq-ingest/compile/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 不传 drafts 字段：后端扫描 drafts/ 目录全部文件
      body: JSON.stringify({}),
      signal: abortController.signal,
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    await consumeSSE(res, handleCompileEvent, abortController.signal);
    ElMessage.success('批量发布完成');
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    ElMessage.error('批量发布失败：' + (err as Error).message);
  } finally {
    compiling.value = false;
    abortController = null;
  }
}

// SSE 事件统一处理：单/批量编译共用
function handleCompileEvent(eventType: string, data: DraftCompileEvent) {
  // 进度事件：更新顶部文案
  if (eventType === 'progress') {
    progressMessage.value = data.message ?? '';
    // 批量模式下按 fileIndex 定位更新对应项状态
    if (typeof data.data?.fileIndex === 'number') {
      const idx = data.data.fileIndex;
      if (batchItems.value[idx]) {
        // batch_start/fileCount 等事件不切换状态，仅显示进度
        if (data.status === 'running' && data.step === 'compile') {
          batchItems.value[idx].status = 'running';
        }
        batchItems.value[idx].message = data.message;
      }
    }
    return;
  }

  // 页面生成事件：收集生成的正式页面路径
  if (eventType === 'page' && data.data?.path && data.data?.title) {
    const idx = typeof data.data.fileIndex === 'number' ? data.data.fileIndex : 0;
    if (batchItems.value[idx]) {
      batchItems.value[idx].pages.push({
        path: data.data.path,
        title: data.data.title,
      });
    }
    return;
  }

  // 单个 draft 完成（批量模式）或整体完成（单 draft 模式）
  if (eventType === 'done') {
    // 编译完成后 5 秒自动清理面板（如果 compiling 已结束）
    if (!compiling.value && batchItems.value.every(b => b.status !== 'running' && b.status !== 'pending')) {
      clearPanelTimer = setTimeout(() => {
        batchItems.value = [];
        progressMessage.value = '';
        clearPanelTimer = null;
      }, 5000);
    }
    if (data.step === 'batch_done') {
      // 批量结束：根据 success/fail 计数已在后端完成，这里刷新整体状态
      progressMessage.value = data.message ?? '批量编译完成';
      // 编译完成后自动刷新草稿列表和目录树
      loadDrafts();
      loadTree();
      return;
    }
    // 单 draft done 或批量中某个 draft 的 done
    const idx = typeof data.data?.fileIndex === 'number' ? data.data.fileIndex : 0;
    if (batchItems.value[idx]) {
      batchItems.value[idx].status = data.status === 'done' ? 'done' : 'error';
      batchItems.value[idx].message = data.message;
    }
    if (data.status === 'done' && batchItems.value.length === 1) {
      ElMessage.success('发布成功');
      progressMessage.value = data.message ?? '编译完成';
    }
    return;
  }

  if (eventType === 'error') {
    const idx = typeof data.data?.fileIndex === 'number' ? data.data.fileIndex : 0;
    if (batchItems.value[idx]) {
      batchItems.value[idx].status = 'error';
      batchItems.value[idx].message = data.message;
    } else {
      ElMessage.error(data.message ?? '编译失败');
    }
  }
}

function abortCompile() {
  if (!abortController) return;
  abortController.abort();
  compiling.value = false;
  progressMessage.value = '已取消';
  // 将所有非 done/error 的项标记为 cancelled，避免状态混乱
  for (const item of batchItems.value) {
    if (item.status !== 'done' && item.status !== 'error') {
      item.status = 'cancelled';
    }
  }
  // 5 秒后自动清理编译面板
  clearPanelTimer = setTimeout(() => {
    batchItems.value = [];
    progressMessage.value = '';
    clearPanelTimer = null;
  }, 5000);
}

// 切换模式时重置内容区状态，避免上一模式文件残留
async function switchMode(m: BrowseMode) {
  if (mode.value === m) return;
  if (hasUnsavedChanges()) {
    try {
      await import('element-plus').then(({ ElMessageBox }) => {
        return ElMessageBox.confirm('有未保存的更改，确定放弃？', '未保存更改', { type: 'warning' });
      });
    } catch {
      return; // 用户取消切换
    }
  }
  mode.value = m;
  fileContent.value = null;
  editing.value = false;
  currentDraftPath.value = '';
  currentNode.value = '';
  if (m === 'draft') {
    loadDrafts();
  }
}

// 批量编译统计
const batchSuccessCount = computed(() => batchItems.value.filter((b) => b.status === 'done').length);
const batchErrorCount = computed(() => batchItems.value.filter((b) => b.status === 'error').length);
const batchCancelledCount = computed(() => batchItems.value.filter((b) => b.status === 'cancelled').length);
// 编译进度百分比：基于 done/cancelled/error 的总数计算
const progressPercentage = computed(() => {
  if (batchItems.value.length === 0) return 0;
  const finished = batchSuccessCount.value + batchErrorCount.value + batchCancelledCount.value;
  return Math.round((finished / batchItems.value.length) * 100);
});
// 是否有未保存的编辑更改
function hasUnsavedChanges(): boolean {
  return editing.value && editBuffer.value !== (fileContent.value?.content ?? '');
}

function renderMarkdown(md: string): string {
  if (!md) return '';
  let html = md
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>'); // NOSONAR 需要正则捕获组提取代码块
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>') // NOSONAR 需要多行锚点
    .replace(/^## (.+)$/gm, '<h2>$1</h2>') // NOSONAR 需要多行锚点
    .replace(/^# (.+)$/gm, '<h1>$1</h1>'); // NOSONAR 需要多行锚点
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') // NOSONAR 需要正则捕获组
    .replace(/\*(.+?)\*/g, '<em>$1</em>'); // NOSONAR 需要正则捕获组
  html = html.replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">[[$1]]</span>'); // NOSONAR 需要正则捕获组
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>'); // NOSONAR 需要正则捕获组
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>'); // NOSONAR 需要多行锚点
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`); // NOSONAR 需要正则分组匹配
  html = html.split(/\n\n+/).map((block) => {
    if (/^<(h\d|ul|pre|li)/.test(block.trim())) return block;
    if (!block.trim()) return '';
    return `<p>${block.replaceAll('\n', '<br>')}</p>`;
  }).join('\n');
  return html;
}

let lastSavedContent = '';

// 搜索防抖：输入停止 400ms 后自动触发搜索
// 为什么 400ms：中文字输入法可能较慢，400ms 比英文用户习惯略长但不会让用户等待太久
watch(searchQuery, (newVal) => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  if (!newVal.trim()) {
    showSearchResults.value = false;
    searchHits.value = [];
    return;
  }
  searchDebounceTimer = setTimeout(() => {
    doSearch();
  }, 400);
});

// 编辑未保存保护：记录了编辑开始时的原始内容，用于切换前对比
// 为什么不在 startEdit 中设置：cancelEdit/saveEdit 等路径可能不经过 startEdit
watch(editing, (val) => {
  if (val && fileContent.value) {
    lastSavedContent = fileContent.value.content ?? '';
  }
});

onMounted(async () => {
  // Ingest.vue 抽取完成后跳转过来时，通过 sessionStorage 传递目标模式
  // 为什么用 sessionStorage 而非 props：跨组件通信，避免 App.vue 中间层传递
  const jumpMode = sessionStorage.getItem('karpathy:jumpMode');
  if (jumpMode === 'draft') {
    sessionStorage.removeItem('karpathy:jumpMode');
    switchMode('draft');
  } else {
    await loadTree();
  }
  // RefsList 派发的 jump-vault 事件：App.vue 切到 browse 后
  // 从 sessionStorage 读取目标 path 并自动打开该文件
  const jumpPath = sessionStorage.getItem('karpathy:jumpPath');
  if (jumpPath) {
    sessionStorage.removeItem('karpathy:jumpPath');
    await handleNodeClick({ path: jumpPath, name: '', type: 'file' } as TreeNode);
  }
});
</script>

<template>
  <div class="browse-page">
    <div class="glass-card browse-card fade-up">
      <div class="card-deco"></div>
      <!-- 不对称头部 -->
      <div class="browse-head">
        <div class="head-text">
          <span class="head-tag">// KNOWLEDGE BROWSER</span>
          <h2 class="head-title grad-text">{{ mode === 'draft' ? '草稿审核' : '知识浏览' }}</h2>
          <p class="head-tip">
            {{ mode === 'draft'
              ? '审核 LLM 抽取的草稿，编辑后发布为正式页面'
              : '点击左侧文件查看内容，支持编辑保存' }}
          </p>
        </div>
        <!-- 模式切换：单选按钮组，避免新增菜单项 -->
        <el-radio-group v-model="mode" size="small" @change="switchMode">
          <el-radio-button label="knowledge">知识浏览</el-radio-button>
          <el-radio-button label="draft">草稿审核</el-radio-button>
        </el-radio-group>
        <el-button
          v-if="mode === 'knowledge'"
          size="small"
          @click="loadTree"
        >刷新目录</el-button>
        <el-button
          v-else
          size="small"
          @click="loadDrafts"
        >刷新草稿</el-button>
      </div>

      <!-- ===== 草稿审核模式 ===== -->
      <div v-if="mode === 'draft'" class="browse-body">
        <!-- 左侧草稿列表 -->
        <div class="tree-panel draft-panel">
          <div class="panel-title">// DRAFTS</div>
          <div class="draft-toolbar">
            <span class="draft-count">{{ drafts.length }} 个草稿</span>
            <el-button
              size="small"
              type="primary"
              :disabled="compiling || drafts.length === 0"
              @click="publishAllDrafts"
            >批量发布</el-button>
          </div>

          <div v-if="drafts.length === 0" class="tree-empty">
            暂无草稿。请先在「投递资料」上传 QQ 聊天记录并触发抽取
          </div>

          <!-- 草稿列表项 -->
          <div
            v-for="d in drafts"
            :key="d.path"
            class="draft-item hover-glow"
            :class="{ active: currentDraftPath === d.path }"
            @click="handleDraftClick(d)"
          >
            <div class="draft-name">
              <span class="file-icon">◈</span>
              {{ d.name }}
            </div>
            <div class="draft-path">{{ d.path }}</div>
            <!-- 单个发布按钮 -->
            <el-button
              size="small"
              type="primary"
              text
              :disabled="compiling"
              @click.stop="publishDraft(d)"
            >发布</el-button>
          </div>
        </div>

        <!-- 右侧：草稿内容 + 编译进度 -->
        <div class="content-panel">
          <!-- 编译进度面板 -->
          <div v-if="compiling || batchItems.length > 0" class="compile-progress">
            <div class="progress-header">
              <el-tooltip :content="progressMessage" placement="top" :show-after="500">
                <span class="progress-msg">{{ progressMessage }}</span>
              </el-tooltip>
              <div class="progress-stats">
                <span class="stat-success">✓ {{ batchSuccessCount }}</span>
                <span v-if="batchCancelledCount > 0" class="stat-cancelled">⊘ {{ batchCancelledCount }}</span>
                <span v-if="batchErrorCount > 0" class="stat-error">✗ {{ batchErrorCount }}</span>
                <span class="stat-total">/ {{ batchItems.length }}</span>
                <el-button
                  v-if="compiling"
                  size="small"
                  text
                  type="danger"
                  @click="abortCompile"
                >取消</el-button>
                <el-button
                  v-if="!compiling && batchItems.length > 0"
                  size="small"
                  text
                  @click="batchItems = []; progressMessage = ''"
                >关闭</el-button>
              </div>
            </div>
            <!-- 进度条 -->
            <el-progress
              :percentage="progressPercentage"
              :stroke-width="6"
              :status="batchErrorCount > 0 && !compiling ? 'exception' : progressPercentage === 100 ? 'success' : ''"
              :striped="compiling"
              :striped-flow="compiling"
              class="compile-progress-bar"
            />
            <!-- 批量编译明细列表 -->
            <div v-if="batchItems.length > 1" class="batch-list">
              <div
                v-for="(item, idx) in batchItems"
                :key="item.path"
                class="batch-row"
                :class="`status-${item.status}`"
              >
                <span class="batch-index">#{{ idx + 1 }}</span>
                <span class="batch-name">{{ item.name }}</span>
                <span class="batch-status">{{ item.status === 'cancelled' ? '已取消' : item.status === 'done' ? '已完成' : item.status === 'running' ? '进行中' : item.status === 'error' ? '失败' : '待处理' }}</span>
                <span v-if="item.pages.length > 0" class="batch-pages">
                  → {{ item.pages.map((p) => p.title).join(', ') }}
                </span>
                <span v-if="item.message" class="batch-msg">{{ item.message }}</span>
              </div>
            </div>
          </div>

          <div v-if="loading" class="content-loading">
            <p>加载中…</p>
          </div>
          <div v-else-if="!fileContent" class="content-empty">
            <p class="empty-tip">选择左侧草稿查看内容</p>
          </div>
          <div v-else class="content-show">
            <!-- frontmatter 元信息 -->
            <div
              v-if="fileContent.frontmatter && Object.keys(fileContent.frontmatter).length > 0"
              class="frontmatter-bar"
            >
              <span v-for="(val, key) in fileContent.frontmatter" :key="key" class="fm-chip">
                <strong>{{ key }}:</strong> {{ String(val) }}
              </span>
            </div>

            <!-- 操作栏 -->
            <div class="action-bar">
              <span class="current-path">{{ currentDraftPath }}</span>
              <div class="actions">
                <el-button
                  v-if="!editing"
                  size="small"
                  type="primary"
                  :disabled="compiling"
                  @click="publishDraft({ path: currentDraftPath, name: currentDraftPath.split('/').pop() || '' })"
                >发布此草稿</el-button>
                <el-button v-if="!editing" size="small" @click="startEdit">编辑</el-button>
                <template v-else>
                  <el-button size="small" type="primary" @click="saveEdit">保存</el-button>
                  <el-button size="small" @click="cancelEdit">取消</el-button>
                </template>
              </div>
            </div>

            <!-- 编辑模式 -->
            <el-input
              v-if="editing"
              v-model="editBuffer"
              type="textarea"
              :rows="20"
              resize="none"
              class="editor-area"
            />

            <!-- 预览模式 -->
            <div v-else class="markdown-body" v-html="renderMarkdown(fileContent.body)"></div>
          </div>
        </div>
      </div>

      <!-- ===== 知识浏览模式（原逻辑） ===== -->
      <div v-else class="browse-body">
        <!-- 左侧目录树 + 搜索 -->
        <div class="tree-panel">
          <div class="search-box">
            <el-input
              v-model="searchQuery"
              placeholder="搜索知识库…"
              size="small"
              :prefix-icon="Search"
              clearable
              @keyup.enter="doSearch"
              @clear="clearSearch"
            />
            <!-- AC-10: source/status 过滤下拉框 -->
            <div class="filter-bar">
              <el-select
                v-model="sourceFilter"
                placeholder="来源筛选"
                size="small"
                clearable
                @change="handleFilterChange"
              >
                <el-option
                  v-for="opt in sourceOptions"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
              <el-select
                v-model="statusFilter"
                placeholder="状态筛选"
                size="small"
                clearable
                @change="handleFilterChange"
              >
                <el-option
                  v-for="opt in statusOptions"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
            </div>
          </div>

          <!-- 搜索结果 -->
          <div v-if="showSearchResults" class="search-results">
            <div class="search-header">
              <span class="search-count">{{ searchHits.length }} 条结果</span>
              <el-button size="small" text @click="clearSearch">返回目录</el-button>
            </div>
            <div v-if="searching" class="search-loading">SEARCHING...</div>
            <div v-else-if="searchHits.length === 0" class="search-empty">未找到匹配页面</div>
            <div
              v-for="hit in searchHits"
              :key="hit.path"
              class="search-hit-item hover-glow"
              @click="handleSearchHit(hit)"
            >
              <div class="hit-title">{{ hit.title }}</div>
              <div class="hit-path">{{ hit.path }}</div>
              <div class="hit-snippet">{{ hit.snippet }}</div>
            </div>
          </div>

          <!-- 目录树 -->
          <template v-else>
            <div class="panel-title">// 目录</div>
            <el-tree
              :data="treeData"
              :props="treeProps"
              node-key="path"
              @node-click="handleNodeClick"
              :default-expand-all="false"
              :expand-on-click-node="true"
              :highlight-current="true"
            >
              <template #default="{ data }">
                <span class="tree-node" :class="{ 'is-file': data.type === 'file' }">
                  <span v-if="data.type === 'dir'">▸</span>
                  <span v-else class="file-icon">◈</span>
                  {{ data.name }}
                </span>
              </template>
            </el-tree>
            <div v-if="treeData.length === 0" class="tree-empty">
              知识库还是空的，先去投递资料吧
            </div>
          </template>
        </div>

        <!-- 右侧内容区 -->
        <div class="content-panel">
          <div v-if="loading" class="content-loading">
            <p>加载中…</p>
          </div>
          <div v-else-if="!fileContent" class="content-empty">
            <p class="empty-tip">选择左侧文件查看内容</p>
          </div>
          <div v-else class="content-show">
            <!-- frontmatter 元信息 -->
            <div
              v-if="fileContent.frontmatter && Object.keys(fileContent.frontmatter).length > 0"
              class="frontmatter-bar"
            >
              <span v-for="(val, key) in fileContent.frontmatter" :key="key" class="fm-chip">
                <strong>{{ key }}:</strong> {{ String(val) }}
              </span>
            </div>

            <!-- 操作栏 -->
            <div class="action-bar">
              <span class="current-path">{{ currentNode }}</span>
              <div class="actions">
                <el-button v-if="!editing" size="small" @click="startEdit">编辑</el-button>
                <template v-else>
                  <el-button size="small" type="primary" @click="saveEdit">保存</el-button>
                  <el-button size="small" @click="cancelEdit">取消</el-button>
                </template>
              </div>
            </div>

            <!-- 编辑模式 -->
            <el-input
              v-if="editing"
              v-model="editBuffer"
              type="textarea"
              :rows="20"
              resize="none"
              class="editor-area"
            />

            <!-- 预览模式 -->
            <div v-else class="markdown-body" v-html="renderMarkdown(fileContent.body)"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.browse-page {
  display: flex;
  flex-direction: column;
}

.browse-card {
  padding: 28px 32px;
  height: calc(100vh - 240px);
  min-height: 480px;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

.card-deco {
  position: absolute;
  top: -40px;
  right: -40px;
  width: 200px;
  height: 200px;
  background: var(--grad-fire);
  opacity: 0.08;
  transform: rotate(25deg);
  border-radius: 32px;
  pointer-events: none;
}

/* 不对称头部 */
.browse-head {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 20px;
  position: relative;
  z-index: 1;
}

.head-text {
  flex: 1;
}

.head-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--neon-cyan);
  letter-spacing: 2px;
  display: block;
  margin-bottom: 2px;
}

.head-title {
  margin: 0 0 2px;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 1px;
}

.head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 12px;
}

.browse-body {
  flex: 1;
  display: flex;
  gap: 18px;
  overflow: hidden;
  position: relative;
  z-index: 1;
}

/* 左侧目录树 */
.tree-panel {
  width: 280px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 14px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-purple-a15);
  border-radius: var(--radius-card);
}

.search-box {
  margin-bottom: 12px;
}

/* AC-10: source/status 过滤栏 */
.filter-bar {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.filter-bar :deep(.el-select) {
  flex: 1;
  min-width: 0;
}

.search-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.search-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0 10px;
  border-bottom: 1px dashed var(--accent-purple-a20);
  margin-bottom: 8px;
}

.search-count {
  font-size: 11px;
  color: var(--neon-cyan);
  font-weight: 600;
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

.search-loading,
.search-empty {
  text-align: center;
  font-size: 11px;
  color: var(--text-dim);
  padding: 24px 0;
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

.search-hit-item {
  padding: 10px 12px;
  background: var(--accent-purple-a05);
  border: 1px solid var(--accent-purple-a15);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.search-hit-item:hover {
  background: var(--accent-purple-a12);
  border-color: var(--neon-purple);
  transform: translateX(3px);
}

.hit-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
  margin-bottom: 3px;
}

.hit-path {
  font-size: 10px;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
  margin-bottom: 5px;
}

.hit-snippet {
  font-size: 11px;
  color: var(--text-soft);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.panel-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--neon-magenta);
  margin-bottom: 10px;
  padding: 0 4px;
  font-family: var(--font-mono);
  letter-spacing: 2px;
}

.tree-node {
  font-size: 13px;
  color: var(--text-base);
}

.tree-node.is-file {
  cursor: pointer;
}

.file-icon {
  color: var(--neon-cyan);
}

.tree-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  padding: 24px 8px;
  font-family: var(--font-mono);
}

/* 右侧内容区 */
.content-panel {
  flex: 1;
  overflow-y: auto;
  padding: 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-cyan-a12);
  border-radius: var(--radius-card);
}

.content-loading,
.content-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--text-soft);
  font-family: var(--font-mono);
}

.empty-tip {
  margin: 0;
  font-size: 14px;
}

.content-show {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.frontmatter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 16px;
  background: var(--accent-magenta-a08);
  border: 1px solid var(--accent-magenta-a25);
  border-radius: 12px;
  margin-bottom: 14px;
}

.fm-chip {
  font-size: 12px;
  color: var(--text-base);
  font-family: var(--font-mono);
}

.fm-chip strong {
  color: var(--neon-pink);
}

.action-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--accent-purple-a20);
}

.current-path {
  font-size: 12px;
  color: var(--neon-purple);
  font-family: var(--font-mono);
  padding: 4px 12px;
  background: var(--accent-purple-a10);
  border: 1px solid var(--accent-purple-a25);
  border-radius: 8px;
}

.actions {
  display: flex;
  gap: 8px;
}

.editor-area {
  flex: 1;
}

.editor-area :deep(.el-textarea__inner) {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.7;
  height: 100%;
}

/* Markdown 渲染 */
.markdown-body {
  font-size: 14px;
  line-height: 1.8;
  color: var(--text-base);
  overflow-y: auto;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  margin: 18px 0 10px;
  color: var(--text-bright);
  font-family: var(--font-display);
}

.markdown-body :deep(h1) {
  font-size: 24px;
  border-bottom: 2px solid var(--neon-magenta);
  padding-bottom: 8px;
  text-shadow: 0 0 16px var(--accent-pink-a30);
}

.markdown-body :deep(h2) {
  font-size: 20px;
  color: var(--neon-cyan);
}

.markdown-body :deep(h3) {
  font-size: 17px;
  color: var(--neon-purple);
}

.markdown-body :deep(p) {
  margin: 10px 0;
}

.markdown-body :deep(ul) {
  padding-left: 24px;
  margin: 10px 0;
}

.markdown-body :deep(li) {
  margin: 5px 0;
}

.markdown-body :deep(code) {
  padding: 2px 8px;
  background: var(--accent-purple-a15);
  border: 1px solid var(--accent-purple-a30);
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--neon-purple);
}

.markdown-body :deep(pre) {
  padding: 14px 18px;
  background: var(--bg-scene);
  border: 1px solid var(--accent-cyan-a20);
  border-radius: 12px;
  overflow-x: auto;
  margin: 14px 0;
}

.markdown-body :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
  color: var(--neon-cyan);
}

.markdown-body :deep(.wikilink) {
  color: var(--neon-magenta);
  background: var(--accent-pink-a10);
  padding: 2px 8px;
  border-radius: 6px;
  font-weight: 600;
  font-size: 13px;
  font-family: var(--font-mono);
  border: 1px solid var(--accent-pink-a25);
}

.markdown-body :deep(strong) {
  font-weight: 700;
  color: var(--text-bright);
}

/* ============================================================
 * 草稿审核模式样式
 * 复用现有 CSS 变量与圆角/边框风格，保持视觉一致
 * ============================================================ */

.draft-panel {
  display: flex;
  flex-direction: column;
}

.draft-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 4px 12px;
  border-bottom: 1px dashed var(--accent-purple-a20);
  margin-bottom: 10px;
}

.draft-count {
  font-size: 11px;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

.draft-item {
  position: relative;
  padding: 10px 12px;
  margin-bottom: 6px;
  background: var(--accent-purple-a05);
  border: 1px solid var(--accent-purple-a15);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.draft-item:hover {
  background: var(--accent-purple-a12);
  border-color: var(--neon-purple);
  transform: translateX(3px);
}

.draft-item.active {
  background: var(--accent-cyan-a10);
  border-color: var(--neon-cyan);
}

.draft-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
  margin-bottom: 3px;
  padding-right: 60px; /* 给右侧「发布」按钮留位 */
}

.draft-path {
  font-size: 10px;
  color: var(--neon-cyan);
  font-family: var(--font-mono);
}

/* 单 draft 行内的发布按钮：绝对定位到右上角 */
.draft-item :deep(.el-button) {
  position: absolute;
  top: 8px;
  right: 8px;
}

/* 编译进度面板：顶部固定，下方滚动内容 */
.compile-progress {
  margin-bottom: 14px;
  padding: 12px 16px;
  background: var(--accent-cyan-a08);
  border: 1px solid var(--accent-cyan-a20);
  border-radius: 12px;
}

.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.progress-msg {
  flex: 1;
  font-size: 12px;
  color: var(--text-base);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-family: var(--font-mono);
}

.stat-success {
  color: var(--neon-cyan);
  font-weight: 700;
}

.stat-error {
  color: var(--neon-magenta);
  font-weight: 700;
}

.stat-total {
  color: var(--text-dim);
}

.batch-list {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--accent-cyan-a20);
  max-height: 180px;
  overflow-y: auto;
}

.batch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-soft);
}

.batch-row.status-done {
  color: var(--neon-cyan);
}

.batch-row.status-error {
  color: var(--neon-magenta);
}

.batch-row.status-running {
  color: var(--neon-purple);
}

.batch-index {
  color: var(--text-dim);
  min-width: 28px;
}

.batch-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-status {
  text-transform: uppercase;
  letter-spacing: 1px;
  font-weight: 600;
}

.batch-pages {
  color: var(--neon-cyan);
  font-size: 10px;
}

.batch-msg {
  color: var(--text-dim);
  font-size: 10px;
  font-style: italic;
}

.batch-row.status-cancelled {
  color: var(--text-dim);
  opacity: 0.5;
}

/* 进度条定制造型 */
.compile-progress-bar {
  margin: 8px 0 4px;
}

.stat-cancelled {
  color: var(--text-dim);
  font-weight: 600;
}
</style>

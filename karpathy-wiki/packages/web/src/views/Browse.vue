<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import type { TreeNode, FileContent, SearchHit } from '../types';
import RobotAvatar from '../components/RobotAvatar.vue';

const treeData = ref<TreeNode[]>([]);
const currentNode = ref<string>('');
const fileContent = ref<FileContent | null>(null);
const loading = ref(false);
const editing = ref(false);
const editBuffer = ref('');

// 搜索状态
const searchQuery = ref('');
const searchHits = ref<SearchHit[]>([]);
const searching = ref(false);
const showSearchResults = ref(false);

// el-tree 的 props 配置：label 显示名称，children 取子节点
const treeProps = {
  label: 'name',
  children: 'children',
};

// 加载目录树
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

// 执行全文检索。GET /api/search?q=keyword
async function doSearch() {
  const q = searchQuery.value.trim();
  if (!q) {
    showSearchResults.value = false;
    searchHits.value = [];
    return;
  }
  searching.value = true;
  showSearchResults.value = true;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
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

// 清除搜索，回到目录树视图
function clearSearch() {
  searchQuery.value = '';
  searchHits.value = [];
  showSearchResults.value = false;
}

// 点击搜索结果：读取对应文件
async function handleSearchHit(hit: SearchHit) {
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

// 点击树节点：文件则读取内容，目录则展开/折叠
async function handleNodeClick(node: TreeNode) {
  if (node.type !== 'file') return;
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

// 进入编辑模式
function startEdit() {
  if (!fileContent.value) return;
  editBuffer.value = fileContent.value.content;
  editing.value = true;
}

// 取消编辑
function cancelEdit() {
  editing.value = false;
  editBuffer.value = '';
}

// 保存编辑
async function saveEdit() {
  if (!currentNode.value) return;
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(currentNode.value)}`, {
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
    // 重新加载文件内容
    await handleNodeClick({ path: currentNode.value, name: '', type: 'file' } as TreeNode);
  } catch (err) {
    ElMessage.error('保存失败：' + (err as Error).message);
  }
}

// 简易 Markdown 渲染：标题、加粗、列表、wikilink、代码块
// 垂直切片用正则做基础渲染，后续可替换为 markdown-it 完整管线
function renderMarkdown(md: string): string {
  if (!md) return '';
  // 先转义 HTML 防注入
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // 代码块
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // 标题
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // 加粗、斜体
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
  // wikilink [[页面名]]
  html = html.replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">[[$1]]</span>');
  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 列表
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  // 段落：连续非空行非 HTML 标签包裹为 <p>
  html = html.split(/\n\n+/).map((block) => {
    if (/^<(h\d|ul|pre|li)/.test(block.trim())) return block;
    if (!block.trim()) return '';
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  return html;
}

onMounted(() => {
  loadTree();
});

// 文件内容变化时重新渲染
watch(fileContent, () => {
  // 触发响应式更新即可，渲染在 template 中调用
});
</script>

<template>
  <div class="browse-page">
    <div class="glass-card browse-card">
      <div class="browse-head">
        <RobotAvatar :size="48" />
        <div class="head-text">
          <h2 class="head-title">知识浏览</h2>
          <p class="head-tip">点击左侧文件查看内容，支持编辑保存</p>
        </div>
        <el-button size="small" @click="loadTree">刷新目录</el-button>
      </div>

      <div class="browse-body">
        <!-- 左侧目录树 + 搜索 -->
        <div class="tree-panel">
          <!-- 搜索框 -->
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
          </div>

          <!-- 搜索结果列表 -->
          <div v-if="showSearchResults" class="search-results">
            <div class="search-header">
              <span class="search-count">{{ searchHits.length }} 条结果</span>
              <el-button size="small" text @click="clearSearch">返回目录</el-button>
            </div>
            <div v-if="searching" class="search-loading">搜索中…</div>
            <div v-else-if="searchHits.length === 0" class="search-empty">未找到匹配页面</div>
            <div
              v-for="hit in searchHits"
              :key="hit.path"
              class="search-hit-item"
              @click="handleSearchHit(hit)"
            >
              <div class="hit-title">{{ hit.title }}</div>
              <div class="hit-path">{{ hit.path }}</div>
              <div class="hit-snippet">{{ hit.snippet }}</div>
            </div>
          </div>

          <!-- 目录树 -->
          <template v-else>
            <div class="panel-title">目录</div>
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
                  <span v-if="data.type === 'dir'">📁</span>
                  <span v-else>📄</span>
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
            <RobotAvatar :size="80" :floating="true" />
            <p>加载中…</p>
          </div>

          <div v-else-if="!fileContent" class="content-empty">
            <RobotAvatar :size="120" :floating="true" />
            <p class="empty-tip">选择左侧文件查看内容</p>
          </div>

          <div v-else class="content-show">
            <!-- frontmatter 元信息 -->
            <div v-if="fileContent.frontmatter && Object.keys(fileContent.frontmatter).length > 0" class="frontmatter-bar">
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
  padding: 24px 28px;
  height: calc(100vh - 220px);
  min-height: 480px;
  display: flex;
  flex-direction: column;
}

.browse-head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.head-text {
  flex: 1;
}

.head-title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
}

.head-tip {
  margin: 0;
  color: var(--color-text-soft);
  font-size: 13px;
}

.browse-body {
  flex: 1;
  display: flex;
  gap: 16px;
  overflow: hidden;
}

.tree-panel {
  width: 260px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 12px;
  background: rgba(255, 255, 255, 0.4);
  border-radius: var(--radius-card);
}

.search-box {
  margin-bottom: 10px;
}

.search-results {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.search-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0 8px;
  border-bottom: 1px dashed rgba(74, 59, 71, 0.15);
  margin-bottom: 6px;
}

.search-count {
  font-size: 12px;
  color: var(--color-text-soft);
  font-weight: 600;
}

.search-loading,
.search-empty {
  text-align: center;
  font-size: 12px;
  color: var(--color-text-soft);
  padding: 20px 0;
}

.search-hit-item {
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.5);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.search-hit-item:hover {
  background: var(--color-cyan);
  transform: translateX(2px);
}

.hit-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 2px;
}

.hit-path {
  font-size: 11px;
  color: var(--color-text-soft);
  font-family: 'Courier New', monospace;
  margin-bottom: 4px;
}

.hit-snippet {
  font-size: 11px;
  color: var(--color-text-soft);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-soft);
  margin-bottom: 8px;
  padding: 0 4px;
}

.tree-node {
  font-size: 13px;
  color: var(--color-text);
}

.tree-node.is-file {
  cursor: pointer;
}

.tree-empty {
  text-align: center;
  color: var(--color-text-soft);
  font-size: 12px;
  padding: 20px 8px;
}

.content-panel {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  background: rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-card);
}

.content-loading,
.content-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--color-text-soft);
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
  padding: 10px 14px;
  background: var(--color-yellow);
  border-radius: 12px;
  margin-bottom: 12px;
}

.fm-chip {
  font-size: 12px;
  color: var(--color-text);
}

.action-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px dashed rgba(74, 59, 71, 0.15);
}

.current-path {
  font-size: 12px;
  color: var(--color-text-soft);
  font-family: 'Courier New', monospace;
  padding: 2px 8px;
  background: var(--color-pink);
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
  font-family: 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  height: 100%;
}

.markdown-body {
  font-size: 14px;
  line-height: 1.8;
  color: var(--color-text);
  overflow-y: auto;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  margin: 16px 0 8px;
  color: var(--color-text);
}

.markdown-body :deep(h1) {
  font-size: 22px;
  border-bottom: 2px solid var(--color-pink);
  padding-bottom: 6px;
}

.markdown-body :deep(h2) {
  font-size: 18px;
}

.markdown-body :deep(h3) {
  font-size: 16px;
}

.markdown-body :deep(p) {
  margin: 8px 0;
}

.markdown-body :deep(ul) {
  padding-left: 24px;
  margin: 8px 0;
}

.markdown-body :deep(li) {
  margin: 4px 0;
}

.markdown-body :deep(code) {
  padding: 2px 6px;
  background: var(--color-pink);
  border-radius: 6px;
  font-size: 12px;
  font-family: 'Courier New', monospace;
}

.markdown-body :deep(pre) {
  padding: 12px 16px;
  background: rgba(74, 59, 71, 0.08);
  border-radius: 12px;
  overflow-x: auto;
  margin: 12px 0;
}

.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
}

.markdown-body :deep(.wikilink) {
  color: var(--color-primary-deep);
  background: var(--color-cyan);
  padding: 1px 6px;
  border-radius: 6px;
  font-weight: 600;
  font-size: 13px;
}

.markdown-body :deep(strong) {
  font-weight: 700;
  color: var(--color-text);
}
</style>

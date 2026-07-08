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

const searchQuery = ref('');
const searchHits = ref<SearchHit[]>([]);
const searching = ref(false);
const showSearchResults = ref(false);

const treeProps = {
  label: 'name',
  children: 'children',
};

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

function clearSearch() {
  searchQuery.value = '';
  searchHits.value = [];
  showSearchResults.value = false;
}

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
    await handleNodeClick({ path: currentNode.value, name: '', type: 'file' } as TreeNode);
  } catch (err) {
    ElMessage.error('保存失败：' + (err as Error).message);
  }
}

function renderMarkdown(md: string): string {
  if (!md) return '';
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">[[$1]]</span>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
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

watch(fileContent, () => {
  // 触发响应式更新
});
</script>

<template>
  <div class="browse-page">
    <div class="glass-card browse-card fade-up">
      <div class="card-deco"></div>
      <!-- 不对称头部 -->
      <div class="browse-head">
        <RobotAvatar :size="52" />
        <div class="head-text">
          <span class="head-tag">// KNOWLEDGE BROWSER</span>
          <h2 class="head-title grad-text">知识浏览</h2>
          <p class="head-tip">点击左侧文件查看内容，支持编辑保存</p>
        </div>
        <el-button size="small" @click="loadTree">刷新目录</el-button>
      </div>

      <div class="browse-body">
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
  margin-bottom: 4px;
}

.head-title {
  margin: 0 0 4px;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 1px;
}

.head-tip {
  margin: 0;
  color: var(--text-soft);
  font-size: 13px;
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
  background: rgba(5, 0, 16, 0.5);
  border: 1px solid rgba(176, 38, 255, 0.15);
  border-radius: var(--radius-card);
}

.search-box {
  margin-bottom: 12px;
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
  border-bottom: 1px dashed rgba(176, 38, 255, 0.2);
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
  background: rgba(176, 38, 255, 0.05);
  border: 1px solid rgba(176, 38, 255, 0.15);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.search-hit-item:hover {
  background: rgba(176, 38, 255, 0.12);
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
  background: rgba(5, 0, 16, 0.4);
  border: 1px solid rgba(0, 245, 255, 0.12);
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
  background: rgba(255, 62, 201, 0.08);
  border: 1px solid rgba(255, 62, 201, 0.25);
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
  border-bottom: 1px dashed rgba(176, 38, 255, 0.2);
}

.current-path {
  font-size: 12px;
  color: var(--neon-purple);
  font-family: var(--font-mono);
  padding: 4px 12px;
  background: rgba(176, 38, 255, 0.1);
  border: 1px solid rgba(176, 38, 255, 0.25);
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
  text-shadow: 0 0 16px rgba(255, 0, 110, 0.3);
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
  background: rgba(176, 38, 255, 0.15);
  border: 1px solid rgba(176, 38, 255, 0.3);
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--neon-purple);
}

.markdown-body :deep(pre) {
  padding: 14px 18px;
  background: rgba(5, 0, 16, 0.7);
  border: 1px solid rgba(0, 245, 255, 0.2);
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
  background: rgba(255, 0, 110, 0.1);
  padding: 2px 8px;
  border-radius: 6px;
  font-weight: 600;
  font-size: 13px;
  font-family: var(--font-mono);
  border: 1px solid rgba(255, 0, 110, 0.25);
}

.markdown-body :deep(strong) {
  font-weight: 700;
  color: var(--text-bright);
}
</style>

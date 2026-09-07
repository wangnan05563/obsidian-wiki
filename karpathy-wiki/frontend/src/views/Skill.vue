<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useSkillStore } from '../stores/skill';
import { apiErrorMessage } from '../utils/apiError';
import type { SkillMeta } from '../types';

const store = useSkillStore();

// 视图模式：list 列表 / detail 详情
const viewMode = ref<'list' | 'detail'>('list');

// 文件上传相关
const fileInput = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);

// 搜索关键字
const searchKeyword = ref('');

// 格式筛选
const formatFilter = ref<'all' | 'zip' | 'md'>('all');

// 格式化文件大小
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// 格式化时间
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// 过滤后的技能列表
const filteredSkills = computed(() => {
  let list = store.skills;
  if (formatFilter.value !== 'all') {
    list = list.filter((s) => s.format === formatFilter.value);
  }
  if (searchKeyword.value.trim()) {
    const kw = searchKeyword.value.trim().toLowerCase();
    list = list.filter(
      (s) =>
        s.name.toLowerCase().includes(kw) ||
        s.id.toLowerCase().includes(kw) ||
        s.description.toLowerCase().includes(kw),
    );
  }
  return list;
});

// 触发文件选择
function triggerFileSelect(): void {
  fileInput.value?.click();
}

// 校验文件扩展名
function isValidSkillFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.skill') || name.endsWith('.md');
}

// 处理文件选择
async function handleFileSelect(e: Event): Promise<void> {
  const target = e.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;
  const file = target.files[0];
  await uploadFile(file);
  // 清空 input 的 value 允许重复上传同名文件
  target.value = '';
}

// 处理拖拽放下
async function handleDrop(e: DragEvent): Promise<void> {
  dragOver.value = false;
  if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return;
  const file = e.dataTransfer.files[0];
  await uploadFile(file);
}

// 上传文件
async function uploadFile(file: File): Promise<void> {
  if (!isValidSkillFile(file)) {
    ElMessage.warning('仅支持 .skill（ZIP 归档）或 .md（Markdown）文件');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    ElMessage.warning('文件大小不能超过 10MB');
    return;
  }

  const result = await store.uploadSkill(file);
  if (result) {
    ElMessage.success(`技能 "${result.skill.name}" 导入成功`);
    if (result.warnings.length > 0) {
      // 有警告时用 MessageBox 展示详情
      await ElMessageBox.alert(
        result.warnings.map((w) => `• ${w}`).join('\n'),
        '导入完成（含警告）',
        { type: 'warning', confirmButtonText: '知道了' },
      ).catch(() => {});
    }
  } else if (store.error) {
    ElMessage.error(apiErrorMessage('技能导入失败', store.error));
  }
}

// 查看详情
async function viewDetail(skill: SkillMeta): Promise<void> {
  viewMode.value = 'detail';
  await store.fetchSkillDetail(skill.id);
  if (store.error) {
    ElMessage.error(apiErrorMessage('加载详情失败', store.error));
  }
}

// 返回列表
function backToList(): void {
  viewMode.value = 'list';
  store.clearDetail();
}

// 删除技能
async function handleDelete(skill: SkillMeta): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定要删除技能 "${skill.name}" 吗？此操作不可撤销。`,
      '删除确认',
      {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
      },
    );
  } catch {
    return; // 用户取消
  }

  const ok = await store.deleteSkill(skill.id);
  if (ok) {
    ElMessage.success(`技能 "${skill.name}" 已删除`);
  } else {
    ElMessage.error(apiErrorMessage('删除失败', store.error));
  }
}

// 刷新列表
async function refreshList(): Promise<void> {
  await store.fetchSkills();
  if (store.error) {
    ElMessage.error(apiErrorMessage('刷新列表失败', store.error));
  }
}

onMounted(() => {
  // 首次进入页面加载列表
  if (store.skills.length === 0) {
    store.fetchSkills();
  }
});
</script>

<template>
  <div class="skill-page">
    <div class="glass-card skill-card">
      <div class="card-deco"></div>

      <!-- 页头 -->
      <div class="skill-head">
        <div class="head-text">
          <h2 class="head-title grad-text">技能管理</h2>
          <p class="head-tip">导入 · 浏览 · 删除外部技能资源</p>
        </div>
        <div class="head-stats">
          <div class="stat-item">
            <span class="stat-value">{{ store.totalCount }}</span>
            <span class="stat-label">技能总数</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">{{ formatSize(store.totalSize) }}</span>
            <span class="stat-label">占用空间</span>
          </div>
        </div>
      </div>

      <!-- 列表视图 -->
      <div v-if="viewMode === 'list'" class="list-view">
        <!-- 上传区 -->
        <div
          class="upload-zone"
          :class="{ 'drag-over': dragOver, 'uploading': store.uploading }"
          @click="triggerFileSelect"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="handleDrop"
        >
          <input
            ref="fileInput"
            type="file"
            accept=".skill,.md"
            class="file-input"
            @change="handleFileSelect"
          />
          <div class="upload-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 16V4M12 4l-4 4M12 4l4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <div class="upload-text">
            <span class="upload-title">{{ store.uploading ? '正在上传...' : '点击或拖拽文件到此处' }}</span>
            <span class="upload-hint">支持 .skill（ZIP 归档）和 .md（Markdown）格式，最大 10MB</span>
          </div>
        </div>

        <!-- 工具栏 -->
        <div class="toolbar">
          <div class="toolbar-left">
            <input
              v-model="searchKeyword"
              type="text"
              class="search-input"
              placeholder="搜索技能名称、ID 或描述..."
            />
            <div class="format-filter">
              <button
                v-for="opt in [{ v: 'all', l: '全部' }, { v: 'zip', l: 'ZIP' }, { v: 'md', l: 'MD' }]"
                :key="opt.v"
                class="filter-btn"
                :class="{ active: formatFilter === opt.v }"
                @click="formatFilter = opt.v as 'all' | 'zip' | 'md'"
              >
                {{ opt.l }}
              </button>
            </div>
          </div>
          <button class="refresh-btn" :disabled="store.loading" @click="refreshList">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span>{{ store.loading ? '加载中' : '刷新' }}</span>
          </button>
        </div>

        <!-- 错误提示 -->
        <div v-if="store.error" class="error-banner">
          <span>{{ store.error }}</span>
          <button class="close-btn" @click="store.clearError()">×</button>
        </div>

        <!-- 技能列表 -->
        <div class="skills-list">
          <div v-if="store.loading && store.skills.length === 0" class="empty-state">
            正在加载技能列表...
          </div>
          <div v-else-if="filteredSkills.length === 0" class="empty-state">
            <span v-if="store.skills.length === 0">暂无技能，请上传 .skill 或 .md 文件</span>
            <span v-else>未找到匹配的技能</span>
          </div>
          <div
            v-for="skill in filteredSkills"
            :key="skill.id"
            class="skill-item hover-glow"
          >
            <div class="skill-icon">
              <span class="format-badge" :class="`format-${skill.format}`">{{ skill.format.toUpperCase() }}</span>
            </div>
            <div class="skill-main" @click="viewDetail(skill)">
              <div class="skill-name-row">
                <span class="skill-name">{{ skill.name }}</span>
                <span class="skill-id">{{ skill.id }}</span>
              </div>
              <div class="skill-desc">{{ skill.description || '（无描述）' }}</div>
              <div class="skill-meta">
                <span>{{ formatDate(skill.importedAt) }}</span>
                <span class="dot">·</span>
                <span>{{ formatSize(skill.size) }}</span>
                <span class="dot">·</span>
                <span>{{ skill.entryFile }}</span>
              </div>
            </div>
            <div class="skill-actions">
              <button class="action-btn view-btn" title="查看详情" @click.stop="viewDetail(skill)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2"/>
                  <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>
                </svg>
              </button>
              <button class="action-btn delete-btn" title="删除" @click.stop="handleDelete(skill)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 详情视图 -->
      <div v-else class="detail-view">
        <div class="detail-header">
          <button class="back-btn" @click="backToList">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>返回列表</span>
          </button>
        </div>

        <div v-if="!store.currentDetail" class="empty-state">加载中...</div>
        <div v-else class="detail-content">
          <div class="detail-title-row">
            <h3 class="detail-title">{{ store.currentDetail.name }}</h3>
            <span class="format-badge" :class="`format-${store.currentDetail.format}`">{{ store.currentDetail.format.toUpperCase() }}</span>
          </div>
          <div class="detail-meta">
            <span>ID: {{ store.currentDetail.id }}</span>
            <span class="dot">·</span>
            <span>{{ formatDate(store.currentDetail.importedAt) }}</span>
            <span class="dot">·</span>
            <span>{{ formatSize(store.currentDetail.size) }}</span>
            <span class="dot">·</span>
            <span>入口: {{ store.currentDetail.entryFile }}</span>
          </div>
          <p v-if="store.currentDetail.description" class="detail-desc">{{ store.currentDetail.description }}</p>

          <!-- 文件列表 -->
          <div v-if="store.currentDetail.files.length > 0" class="files-section">
            <h4 class="section-title">文件结构（{{ store.currentDetail.files.length }} 个文件）</h4>
            <div class="files-tree">
              <div v-for="file in store.currentDetail.files" :key="file" class="file-item">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
                  <path d="M14 2v6h6" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
                </svg>
                <span>{{ file }}</span>
              </div>
            </div>
          </div>

          <!-- SKILL.md 内容 -->
          <div class="content-section">
            <h4 class="section-title">SKILL.md 内容</h4>
            <pre class="skill-content">{{ store.currentDetail.content }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skill-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.skill-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 24px 28px;
  overflow: hidden;
}

.skill-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--accent-purple-a20);
  flex-shrink: 0;
}

.head-tag {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  letter-spacing: 1px;
}

.head-title {
  font-size: 22px;
  font-weight: 700;
  margin: 4px 0 2px;
}

.head-tip {
  font-size: 12px;
  color: var(--text-soft);
}

.head-stats {
  display: flex;
  gap: 24px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-bright);
  font-family: var(--font-mono);
}

.stat-label {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
}

/* 列表视图 */
.list-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 16px;
  overflow-y: auto;
  min-height: 0;
}

/* 上传区 */
.upload-zone {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 24px;
  border: 2px dashed var(--accent-purple-a30);
  border-radius: var(--radius-card, 14px);
  background: var(--bg-glass);
  cursor: pointer;
  transition: all 0.25s ease;
  flex-shrink: 0;
}

.upload-zone:hover,
.upload-zone.drag-over {
  border-color: var(--accent-purple-a60);
  background: var(--accent-purple-a10);
}

.upload-zone.uploading {
  opacity: 0.6;
  pointer-events: none;
}

.file-input {
  display: none;
}

.upload-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 12px;
  background: var(--accent-purple-a15);
  color: var(--text-bright);
  flex-shrink: 0;
}

.upload-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.upload-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
}

.upload-hint {
  font-size: 12px;
  color: var(--text-dim);
}

/* 工具栏 */
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
}

.search-input {
  flex: 1;
  max-width: 320px;
  padding: 7px 12px;
  border: 1px solid var(--accent-purple-a30);
  border-radius: 8px;
  background: var(--bg-glass);
  color: var(--text-bright);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s ease;
}

.search-input:focus {
  border-color: var(--accent-purple-a60);
}

.format-filter {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: var(--bg-glass);
  border-radius: 8px;
  border: 1px solid var(--accent-purple-a20);
}

.filter-btn {
  padding: 4px 12px;
  border: none;
  background: transparent;
  color: var(--text-soft);
  font-size: 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.filter-btn.active {
  background: var(--accent-purple-a30);
  color: var(--text-bright);
  font-weight: 600;
}

.refresh-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 1px solid var(--accent-purple-a30);
  border-radius: 8px;
  background: var(--bg-glass);
  color: var(--text-soft);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.refresh-btn:hover:not(:disabled) {
  border-color: var(--accent-purple-a60);
  color: var(--text-bright);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 错误提示 */
.error-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  background: var(--accent-pink-a15);
  border: 1px solid var(--accent-pink-a40);
  border-radius: 8px;
  color: var(--text-bright);
  font-size: 13px;
  flex-shrink: 0;
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-soft);
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

/* 技能列表 */
.skills-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-dim);
  font-size: 13px;
}

.skill-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  background: var(--bg-glass);
  border: 1px solid var(--accent-purple-a15);
  border-radius: 10px;
  transition: all 0.2s ease;
}

.skill-item:hover {
  border-color: var(--accent-purple-a40);
  background: var(--accent-purple-a08);
}

.skill-icon {
  flex-shrink: 0;
}

.format-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  font-family: var(--font-mono);
  letter-spacing: 0.5px;
}

.format-badge.format-zip {
  background: var(--accent-cyan-a20);
  color: var(--text-bright);
}

.format-badge.format-md {
  background: var(--accent-pink-a20);
  color: var(--text-bright);
}

.skill-main {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.skill-name-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 2px;
}

.skill-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-id {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-dim);
  padding: 1px 6px;
  background: var(--accent-purple-a10);
  border-radius: 4px;
}

.skill-desc {
  font-size: 12px;
  color: var(--text-soft);
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim);
}

.dot {
  color: var(--text-dim);
}

.skill-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--accent-purple-a20);
  background: var(--bg-glass);
  color: var(--text-soft);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.action-btn:hover {
  border-color: var(--accent-purple-a50);
  color: var(--text-bright);
}

.delete-btn:hover {
  border-color: var(--accent-pink-a60);
  color: var(--accent-pink-a80, #e85a71);
  background: var(--accent-pink-a10);
}

/* 详情视图 */
.detail-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 16px;
  overflow: hidden;
  min-height: 0;
}

.detail-header {
  flex-shrink: 0;
}

.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--accent-purple-a30);
  background: var(--bg-glass);
  color: var(--text-soft);
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.back-btn:hover {
  border-color: var(--accent-purple-a60);
  color: var(--text-bright);
}

.detail-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  min-height: 0;
}

.detail-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.detail-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-bright);
  margin: 0;
}

.detail-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-dim);
  flex-wrap: wrap;
}

.detail-desc {
  font-size: 13px;
  color: var(--text-soft);
  padding: 10px 14px;
  background: var(--accent-purple-a08);
  border-radius: 8px;
  margin: 0;
}

.files-section,
.content-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
  margin: 0;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--accent-purple-a15);
}

.files-tree {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 14px;
  background: var(--bg-glass);
  border-radius: 8px;
  border: 1px solid var(--accent-purple-a10);
}

.file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-soft);
}

.skill-content {
  padding: 14px 16px;
  background: var(--bg-glass);
  border-radius: 8px;
  border: 1px solid var(--accent-purple-a10);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-soft);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-height: 500px;
  overflow-y: auto;
}
</style>

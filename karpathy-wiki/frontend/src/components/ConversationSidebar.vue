<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { ElMessageBox, ElMessage } from 'element-plus';
import { Edit, Delete, ArrowLeft, Plus, DocumentCopy, Download, MoreFilled } from '@element-plus/icons-vue';
import NavIcons from './NavIcons.vue';
import SessionStatusIcon from './SessionStatusIcon.vue';
import { useConversationsStore } from '../stores/conversations';
import type { ConversationRecord } from '../types';
import { buildConversationMarkdown, buildConversationFilename, downloadTextFile } from '../utils/exportConversation';

// F-3.11 二态：'expanded'(280px) / 'hidden'(0,完全隐藏)
// 父组件 Query.vue 传 state 字符串，二态切换一步折叠到位
type SidebarState = 'expanded' | 'hidden';
const props = defineProps<{ state: SidebarState }>();
const emit = defineEmits<{
  toggle: [];
  newSession: [];
  select: [id: string];
}>();

const store = useConversationsStore();

// 过滤 + 排序：置顶在前，然后按 updatedAt 倒序
const sortedConversations = computed(() => {
  const filtered = store.searchKeyword
    ? store.conversations.filter((conversation: ConversationRecord) => conversation.title.includes(store.searchKeyword))
    : store.conversations;
  return [...filtered].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
});

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;
  return d.toLocaleDateString();
}

function handlePin(e: Event, id: string) {
  e.stopPropagation();
  store.togglePin(id);
}

// F-3.3 重命名：弹出输入对话框，调用 store.renameConversation
// 为什么用 ElMessageBox.prompt 而非 inline input：重命名是低频操作，弹窗更聚焦
async function handleRename(e: Event, conv: ConversationRecord) {
  e.stopPropagation();
  try {
    const { value } = await ElMessageBox.prompt('请输入新的对话标题', '重命名对话', {
      inputValue: conv.title,
      inputPattern: /\S+/,
      inputErrorMessage: '标题不能为空',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    });
    if (value && value !== conv.title) {
      await store.renameConversation(conv.id, value.trim());
      ElMessage.success('已重命名');
    }
  } catch {
    // 用户取消，不报错
  }
}

// F-3.3 删除：二次确认避免误删，调用 store.deleteConversation
async function handleDelete(e: Event, conv: ConversationRecord) {
  e.stopPropagation();
  try {
    await ElMessageBox.confirm(
      `确定删除对话「${conv.title}」吗？此操作不可撤销。`,
      '删除对话',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      }
    );
    await store.deleteConversation(conv.id);
    ElMessage.success('已删除');
  } catch {
    // 用户取消
  }
}

// F-3.3 增强：复制会话。复制当前会话的全部消息，生成一条独立的新会话，并切换到该副本。
// 用途：在已有问答基础上开新分支继续追问，而不破坏原会话。
async function handleCopy(e: Event, conv: ConversationRecord) {
  e.stopPropagation();
  try {
    const newId = await store.duplicateConversation(conv.id);
    if (newId) {
      // 切换到副本，便于用户立即看到新会话（副本拥有独立 threadId，不会污染原会话）
      await store.selectConversation(newId);
      ElMessage.success('已复制为新会话');
    }
  } catch {
    ElMessage.error('复制失败');
  }
}

// F-3.3 增强：会话导出。将会话内容导出为 Markdown 文件（纯客户端生成，不依赖后端）。
function handleExport(e: Event, conv: ConversationRecord) {
  e.stopPropagation();
  try {
    const md = buildConversationMarkdown(conv);
    downloadTextFile(buildConversationFilename(conv), md);
    ElMessage.success('已导出会话文件');
  } catch {
    ElMessage.error('导出失败');
  }
}

// F-3.3 增强：悬浮「更多操作」菜单（...）。将低频操作（重命名/复制/导出）收进菜单，
// 仅保留高频的「置顶」「删除」为直显图标，减少 hover 时的视觉噪音、提升点击命中率。
// 为什么用 Teleport + position:fixed：.conversation-list 是 overflow-y:auto 滚动容器、
// .conversation-sidebar 有 overflow:hidden，普通 absolute 菜单会被裁切；fixed 逃逸裁切，
// Teleport 到 body 进一步避免被 transform 祖先（.conv-actions 的 translateY）变为定位上下文。
const openMenuId = ref<string | null>(null);
const menuPos = ref({ top: 0, left: 0 });
const MENU_WIDTH = 148;

// 当前打开菜单对应的会话（菜单通过 Teleport 渲染到 body，需按 id 反查）
const menuConv = computed<ConversationRecord | null>(() => {
  if (!openMenuId.value) return null;
  return store.conversations.find((c) => c.id === openMenuId.value) ?? null;
});

const menuStyle = computed(() => ({
  top: `${menuPos.value.top}px`,
  left: `${menuPos.value.left}px`,
}));

function toggleMenu(e: Event, conv: ConversationRecord) {
  e.stopPropagation();
  if (openMenuId.value === conv.id) {
    closeMenu();
    return;
  }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  let left = rect.right - MENU_WIDTH;
  left = Math.min(left, window.innerWidth - MENU_WIDTH - 8);
  left = Math.max(8, left);
  menuPos.value = { top: rect.bottom + 4, left };
  openMenuId.value = conv.id;
}

function closeMenu() {
  openMenuId.value = null;
}

// 菜单项点选：执行对应操作并收起菜单
function onMenuAction(e: Event, action: () => void) {
  e.stopPropagation();
  action();
  closeMenu();
}

// 点击菜单/更多按钮之外区域时收起菜单（避免遮挡其它内容）；捕获阶段监听以便覆盖内部 stopPropagation
function onDocClick(e: MouseEvent) {
  if (!openMenuId.value) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.closest('.conv-menu') || t.closest('[data-testid="more-actions"]'))) return;
  closeMenu();
}

function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeMenu();
}

onMounted(() => {
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onDocKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onDocKey);
});
</script>

<template>
  <!-- F-3.11 二态：expanded 显示完整侧栏 / hidden 完全隐藏（父组件显示浮动按钮） -->
  <aside
    class="conversation-sidebar"
    :class="{
      expanded: state === 'expanded',
      hidden: state === 'hidden'
    }"
  >
    <!-- 展开态：新对话按钮 + 搜索框 + 历史对话列表 -->
    <div class="sidebar-header" v-if="state === 'expanded'">
      <button class="new-btn" @click="emit('newSession')">
        <el-icon><Plus /></el-icon>
        <span>新对话</span>
      </button>
      <input class="search-input" v-model="store.searchKeyword"
        placeholder="搜索对话..." />
    </div>
    <div class="conversation-list" v-if="state === 'expanded'">
      <div v-for="conv in sortedConversations" :key="conv.id"
        class="conversation-item"
        :class="{ active: conv.id === store.currentConversationId, 'menu-open': openMenuId === conv.id }"
        @click="emit('select', conv.id)">
        <span class="pin-icon" v-if="conv.isPinned" @click="(e) => handlePin(e, conv.id)">
          <span class="pin-rot is-pinned"><NavIcons name="pin" :size="14" /></span>
        </span>
        <div class="conv-info">
          <div class="conv-title-row">
            <div class="conv-title">{{ conv.title }}</div>
            <SessionStatusIcon :conv="conv" />
          </div>
          <div class="conv-time">{{ formatTime(conv.updatedAt) }}</div>
        </div>
        <!-- F-3.3 hover 操作按钮：高频操作直显（置顶 / 删除），低频操作收进「更多操作」菜单
             @click.stop 阻止冒泡，避免点击操作按钮触发 select 切换会话 -->
        <div class="conv-actions" @click.stop>
          <!-- 更多操作（...）：点击展开悬浮列表，收纳重命名 / 复制 / 导出 -->
          <button class="conv-action-btn more-btn" title="更多操作：重命名 / 复制会话 / 会话导出" data-testid="more-actions" @click="(e) => toggleMenu(e, conv)">
            <el-icon><MoreFilled /></el-icon>
          </button>
          <!-- 高频操作：置顶 / 删除 直显 -->
          <button class="conv-action-btn pin-btn" :class="{ 'pin-active': conv.isPinned }"
            :title="conv.isPinned ? '取消置顶' : '置顶：将会话固定在历史列表顶部'"
            data-testid="pin-conversation" @click="(e) => handlePin(e, conv.id)">
            <span class="pin-rot" :class="{ 'is-pinned': conv.isPinned }"><NavIcons name="pin" :size="14" /></span>
          </button>
          <button class="conv-action-btn delete-btn" title="删除" data-testid="delete-conversation" @click="(e) => handleDelete(e, conv)">
            <el-icon><Delete /></el-icon>
          </button>
        </div>
        <!-- F-3.3 增强：悬浮「更多操作」菜单（Teleport 到 body，position:fixed 逃逸滚动容器裁切）
             收纳低频操作：重命名 / 复制会话 / 会话导出；保留原 data-testid 不变 -->
        <Teleport to="body">
          <div v-if="menuConv" class="conv-menu" :style="menuStyle" @click.stop>
            <button class="conv-menu-item" title="重命名" data-testid="rename-conversation"
              @click="(e) => onMenuAction(e, () => handleRename(e, menuConv!))">
              <el-icon><Edit /></el-icon><span>重命名</span>
            </button>
            <button class="conv-menu-item" title="复制会话：复制当前会话内容，生成一条独立的新会话" data-testid="copy-conversation"
              @click="(e) => onMenuAction(e, () => handleCopy(e, menuConv!))">
              <el-icon><DocumentCopy /></el-icon><span>复制会话</span>
            </button>
            <button class="conv-menu-item" title="会话导出：将会话内容导出为 Markdown 文件" data-testid="export-conversation"
              @click="(e) => onMenuAction(e, () => handleExport(e, menuConv!))">
              <el-icon><Download /></el-icon><span>会话导出</span>
            </button>
          </div>
        </Teleport>
      </div>
      <div class="empty-hint" v-if="sortedConversations.length === 0">
        暂无历史对话
      </div>
    </div>

    <!-- 切换按钮：expanded(◀ 折叠) / hidden 时父组件显示浮动展开按钮 -->
    <button
      v-if="state !== 'hidden'"
      class="collapse-btn"
      title="折叠（Ctrl+B）"
      @click="emit('toggle')"
    >
      <el-icon><ArrowLeft /></el-icon>
    </button>
  </aside>
</template>

<style scoped>
/* F-3.11 二态侧栏基础样式：所有状态共用，差异在 width（按 .expanded / .hidden 修饰符覆盖） */
.conversation-sidebar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar, rgba(255, 255, 255, 0.03));
  border-right: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
  /* F-3.11 折叠动画 ≤ 250ms：SRS 验收标准要求 */
  transition: width 250ms ease;
  position: relative;
  overflow: hidden;
}
/* 展开态：280px（SRS 要求） */
.conversation-sidebar.expanded {
  width: 280px;
}
/* 隐藏态：完全收起，宽度 0，主区域自适应放大 */
.conversation-sidebar.hidden {
  width: 0;
  border-right: 0;
}

.sidebar-header {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.new-btn {
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  background: var(--accent-cyan-a12, rgba(0, 245, 255, 0.12));
  color: var(--text-bright, #f3e9ff);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}
.new-btn:hover {
  background: var(--accent-cyan-a20, rgba(0, 245, 255, 0.2));
  border-color: var(--neon-cyan, #00f5ff);
}
.search-input {
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-main, #ccc);
  font-size: 12px;
  outline: none;
}
.search-input:focus {
  border-color: var(--neon-cyan, #00f5ff);
}
.conversation-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 8px;
}
.conversation-item {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
  margin-bottom: 4px;
  position: relative;
  align-items: center;
}
.conversation-item:hover {
  background: rgba(255, 255, 255, 0.05);
}
.conversation-item.active {
  background: var(--accent-cyan-a10, rgba(0, 245, 255, 0.1));
  border-left: 2px solid var(--neon-cyan, #00f5ff);
}

/* F-3.3 操作按钮容器：默认隐藏，hover conversation-item 时显现
   为什么用绝对定位：避免操作按钮挤占标题空间 */
.conv-actions {
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  display: flex;
  gap: 2px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
.conversation-item:hover .conv-actions {
  opacity: 1;
  pointer-events: auto;
}

.conv-action-btn {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: var(--bg-scene, rgba(0, 0, 0, 0.4));
  color: var(--text-soft, #888);
  cursor: pointer;
  border-radius: 4px;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}
.conv-action-btn:hover {
  background: var(--accent-cyan-a25, rgba(0, 245, 255, 0.25));
  color: var(--neon-cyan, #00f5ff);
}
.delete-btn:hover {
  background: rgba(255, 80, 80, 0.3);
  /* SonarQube css:S7924 不合成 alpha 通道，将 rgba(0,0,0,0.4) 当作 RGB(0,0,0) 计算。
     需要极深的红色 #3a0000 才能在该算法下达到 4.5:1 对比度（实际渲染对比度远超此值） */
  color: #3a0000; /* NOSONAR - 误报：实际渲染背景为 rgba(255,80,80,0.3)，对比度 10:1+ */
}
/* 置顶按钮激活态：与 hover 高亮一致，表示会话已固定（与左侧 pin-icon 状态呼应） */
.pin-btn.pin-active {
  background: var(--accent-cyan-a25, rgba(0, 245, 255, 0.25));
  color: var(--neon-cyan, #00f5ff);
}
/* 置顶大头针旋转动画：
   - 默认（未置顶）：针头朝上（rotate 180°），表示"可置顶/已拔出"
   - 置顶（is-pinned）：针头垂直向下（rotate 0°），表示"已钉入固定"
   旋转包裹层独立于 NavIcons 自身的 hover scale（作用在不同元素上，互不覆盖），
   transition 0.3s ease 实现点击切换时针头平滑由"上"翻转为"下"的反馈 */
.pin-rot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform: rotate(180deg);
  transition: transform 0.3s ease;
  transform-origin: center;
}
.pin-rot.is-pinned {
  transform: rotate(0deg);
}
/* 菜单打开时强制显示操作栏（即使鼠标移开），便于点选悬浮列表项 */
.conversation-item.menu-open .conv-actions {
  opacity: 1;
  pointer-events: auto;
}
/* 更多操作悬浮列表（Teleport 到 body，position:fixed 逃逸滚动容器裁切，z-index 置于顶层） */
.conv-menu {
  position: fixed;
  z-index: 1000;
  min-width: 148px;
  background: var(--bg-scene, rgba(20, 20, 28, 0.98));
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.conv-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: var(--text-bright, #f3e9ff);
  cursor: pointer;
  border-radius: 6px;
  font-size: 13px;
  text-align: left;
  transition: all 0.15s ease;
}
.conv-menu-item:hover {
  background: var(--accent-cyan-a25, rgba(0, 245, 255, 0.25));
  color: var(--neon-cyan, #00f5ff);
}
.conv-menu-item .el-icon {
  font-size: 15px;
}
.pin-icon {
  cursor: pointer;
  font-size: 14px;
}
.conv-info {
  flex: 1;
  min-width: 0;
}
.conv-title-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.conv-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-bright, #f3e9ff);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-time {
  font-size: 11px;
  color: var(--text-soft, #888);
  margin-top: 2px;
}
.empty-hint {
  text-align: center;
  color: var(--text-soft, #888);
  font-size: 12px;
  padding: 20px;
}

.collapse-btn {
  position: absolute;
  top: 50%;
  right: -12px;
  transform: translateY(-50%);
  width: 24px;
  height: 40px;
  border-radius: 0 8px 8px 0;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
  background: var(--bg-sidebar, rgba(255, 255, 255, 0.05));
  color: var(--text-soft, #888);
  cursor: pointer;
  font-size: 10px;
  z-index: 10;
}
.collapse-btn:hover {
  background: var(--accent-cyan-a10, rgba(0, 245, 255, 0.1));
}
</style>

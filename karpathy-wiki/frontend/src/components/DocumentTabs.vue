<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { Paperclip, Close } from '@element-plus/icons-vue';

// 知识浏览页多文档 Tab 页签组件。
// 职责：渲染 Tab 列表、处理点击切换/关闭、提供右键菜单（关闭/全部关闭/固定）。
// 为什么独立组件：Tab 栏 + 右键菜单定位逻辑较多，抽离后 Browse.vue 只维护数据。
// 设计取舍：
//   - 右键菜单用 teleport 挂到 body，避免被内容区 overflow 裁剪，也可覆盖在内容之上（需求：不遮挡页面内容）；
//   - 菜单定位在 Tab 容器内计算，超出右下边界时贴合边界，避免菜单弹出屏幕外；
//   - 点击文档任意处关闭菜单，且菜单项点击后即关闭。

interface DocTab {
  path: string;
  name: string;
  pinned: boolean;
  loading: boolean;
}

const props = defineProps<{ tabs: DocTab[]; activePath: string }>();
const emit = defineEmits<{
  (e: 'switch', path: string): void;
  (e: 'close', path: string): void;
  (e: 'close-others'): void;
  (e: 'toggle-pin', path: string): void;
  (e: 'reorder', from: string, to: string): void;
}>();

// T00270：拖拽排序状态。dragPath 记录当前拖拽源；dragOverPath 用于目标 Tab 高亮反馈
let dragPath: string | null = null;
const dragOverPath = ref<string | null>(null);

function onDragStart(e: DragEvent, path: string): void {
  dragPath = path;
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e: DragEvent, path: string): void {
  // 置顶 Tab 不参与拖拽；避免在自身上方触发
  if (!dragPath || dragPath === path) return;
  const target = props.tabs.find((t) => t.path === path);
  if (target?.pinned) return;
  e.preventDefault();
  dragOverPath.value = path;
}

function onDrop(e: DragEvent, path: string): void {
  e.preventDefault();
  dragOverPath.value = null;
  if (dragPath && dragPath !== path) emit('reorder', dragPath, path);
  dragPath = null;
}

function onDragEnd(): void {
  dragPath = null;
  dragOverPath.value = null;
}

// 右键菜单状态：visible 控制显隐，x/y 为菜单左上角，path 为菜单指向的 Tab
const menu = ref<{ visible: boolean; x: number; y: number; path: string }>({ visible: false, x: 0, y: 0, path: '' });
// 菜单尺寸常量：供边界贴合计算（px）
const MENU_W = 132;
const MENU_H = 108;

// 菜单指向 Tab 的固定状态：决定菜单项显示「固定」还是「取消固定」
const menuTabPinned = computed(
  () => props.tabs.find((t) => t.path === menu.value.path)?.pinned ?? false,
);

// 右键事件：阻止浏览器默认菜单，计算贴合边界的位置后弹出自定义菜单
function handleContextMenu(e: MouseEvent, tab: DocTab): void {
  e.preventDefault();
  const bar = (e.currentTarget as HTMLElement).closest('.doc-tabbar');
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  // 相对 Tab 栏定位，并用 viewport 宽高做边界贴合，防止菜单溢出可视区
  const x = Math.min(e.clientX, window.innerWidth - MENU_W - 4);
  const y = Math.min(e.clientY, window.innerHeight - MENU_H - 4);
  menu.value = { visible: true, x: Math.max(rect.left, x), y: Math.max(rect.top, y), path: tab.path };
}

function closeMenu(): void {
  menu.value.visible = false;
}

function handleClick(tab: DocTab): void {
  closeMenu();
  emit('switch', tab.path);
}

function handleClose(): void {
  closeMenu();
  emit('close', menu.value.path);
}

// Tab 上的关闭按钮：直接关闭该 Tab
function handleCloseTab(tab: DocTab): void {
  closeMenu();
  emit('close', tab.path);
}

function handleCloseOthers(): void {
  closeMenu();
  emit('close-others');
}

function handleTogglePin(): void {
  emit('toggle-pin', menu.value.path);
  closeMenu();
}

// 点击页面任意处关闭右键菜单；监听在捕获阶段，避免菜单自身 click 冒泡时被立即关闭
function onGlobalClick(): void {
  closeMenu();
}

onMounted(() => {
  document.addEventListener('click', onGlobalClick);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onGlobalClick);
});
</script>

<template>
  <div class="doc-tabbar">
    <div
      v-for="tab in tabs"
      :key="tab.path"
      class="doc-tab"
      :class="{ active: tab.path === activePath, pinned: tab.pinned, 'drag-over': dragOverPath === tab.path }"
      :draggable="!tab.pinned"
      @click="handleClick(tab)"
      @contextmenu.prevent="handleContextMenu($event, tab)"
      @dragstart="onDragStart($event, tab.path)"
      @dragover="onDragOver($event, tab.path)"
      @drop="onDrop($event, tab.path)"
      @dragend="onDragEnd"
    >
      <el-icon v-if="tab.pinned" class="tab-pin" :size="12"><Paperclip /></el-icon>
      <span class="tab-name" :title="tab.path">{{ tab.name }}</span>
      <el-icon
        class="tab-close"
        :size="12"
        data-tip="关闭此文档 Tab"
        @click.stop="handleCloseTab(tab)"
      ><Close /></el-icon>
    </div>
    <!-- T00269：Tab 行右侧操作区（下载/编辑等按钮），由父组件经 slot 注入，靠右对齐 -->
    <div class="doc-actions-slot">
      <slot name="actions" />
    </div>
  </div>

  <!-- teleport 到 body：脱离内容区滚动容器，浮层不被裁剪且能覆盖内容 -->
  <Teleport to="body">
    <div
      v-if="menu.visible"
      class="doc-context-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
    >
      <div class="ctx-item" @click="handleTogglePin">
        {{ menuTabPinned ? '取消置顶' : '置顶' }}
      </div>
      <div class="ctx-item" @click="handleClose">
        关闭
      </div>
      <div class="ctx-item" @click="handleCloseOthers">全部关闭</div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Tab 栏：水平排列，横向溢出可滚动 */
.doc-tabbar {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 4px 2px 10px;
  margin-bottom: 10px;
  border-bottom: 1px solid var(--accent-purple-a20);
  scrollbar-width: thin;
}

/* 单个 Tab：胶囊标签，激活态用主题强调色区分 */
.doc-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  max-width: 200px;
  padding: 5px 10px;
  background: var(--accent-purple-a05);
  border: 1px solid var(--accent-purple-a15);
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-base);
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
}

.doc-tab:hover {
  background: var(--accent-purple-a12);
  border-color: var(--neon-purple);
}

/* 激活态：主题高亮 */
.doc-tab.active {
  background: var(--accent-cyan-a15);
  border-color: var(--neon-cyan);
  color: var(--text-bright);
  font-weight: 600;
}

/* 固定态：左侧别针图标强调 */
.tab-pin {
  color: var(--neon-magenta);
}

/* T00270：拖拽目标高亮——被拖拽 tab 悬停其上时给出放置反馈 */
.doc-tab.drag-over {
  border-color: var(--neon-cyan);
  background: var(--accent-cyan-a18);
  box-shadow: 0 0 0 2px var(--accent-cyan-a15);
}

/* Tab 名称超长省略 + tooltip 展示完整路径（用原生 title） */
.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 关闭按钮：hover 才明显，避免误触 */
.tab-close {
  color: var(--text-soft);
  border-radius: 4px;
  padding: 1px;
}
.tab-close:hover {
  color: var(--neon-magenta);
  background: var(--accent-pink-a20);
}

/* T00269：Tab 行右侧操作区——margin-left:auto 靠右对齐，不随 Tab 滚动 */
.doc-actions-slot {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* 右键菜单：浮层，位置由 style 动态定位 */
.doc-context-menu {
  position: fixed;
  z-index: 3000;
  min-width: 132px;
  padding: 4px;
  background: var(--bg-card);
  border: 1px solid var(--accent-purple-a25);
  border-radius: 10px;
  box-shadow: 0 8px 24px var(--accent-purple-a20);
  overflow: hidden;
}

.ctx-item {
  padding: 7px 12px;
  font-size: 12px;
  color: var(--text-base);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.ctx-item:hover {
  background: var(--accent-purple-a12);
  color: var(--text-bright);
}
</style>
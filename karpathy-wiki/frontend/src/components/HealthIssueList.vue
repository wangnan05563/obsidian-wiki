<script setup lang="ts">
// 体检问题行列表（T02466 / PRD R-F1；T02606 接入虚拟窗口）
// ------------------------------------------------------------------
// 为什么独立组件：原 Health.vue 为 4 类问题各手写一段行 markup，加搜索/多选/折叠时
// 需要改 4 处、极易漏改。行渲染收敛到这里后，扁平列表与「按目录聚合」的分组列表共用
// 同一套行，新增交互只改一处。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElCheckbox, ElButton } from 'element-plus';
import { Link, EditPen } from '@element-plus/icons-vue';
import { computeVirtualWindow, shouldVirtualize, quantizeScrollTop } from '../utils/healthList';
import type { IssueRow } from '../utils/healthList';

const props = defineProps<{
  rows: IssueRow[];
  selected: Set<string>;
  fixingKey: string;
  anyFixing: boolean;
  // 行在当前批量作业里的状态（done=已消解 / ineffective=已处理但未消解 / failed=失败），
  // 由作业快照与事件流推导
  jobStates: Record<string, 'done' | 'failed' | 'ineffective'>;
}>();

const emit = defineEmits<{
  (e: 'toggle', key: string): void;
  (e: 'fix', row: IssueRow): void;
}>();

// 修复按钮语义化（H3）：文案说清「做什么」，tooltip 说清「动哪个文件、调用几次 LLM」。
function fixLabel(row: IssueRow): string {
  return row.kind === 'orphan' ? '补回链' : '修正断链';
}

function fixTip(row: IssueRow): string {
  if (row.kind === 'orphan') {
    return `补回链 - 调用一次 LLM，在其他页面写入指向 ${row.path} 的 [[链接]]`;
  }
  return `修正断链 - 调用一次 LLM，处理 ${row.path} 中的 [[${row.target}]]：创建缺失页面或改写链接`;
}

// 行完整文本（定高单行会把长路径/长缺失页名截断，hover 与读屏仍可取全）
function rowTitle(row: IssueRow): string {
  return row.kind === 'broken' ? `${row.path} ⟶ [[${row.target}]]` : row.path;
}

// ===== 虚拟窗口（T02606）=====
// 为什么自实现而不用 el-auto-resizer/el-virtual-list：EP 虚拟列表要求自带固定高度的
// 滚动盒，接进来会把「4 类问题顺着页面滚动」变成 4 个内部滚动框，改变阅读与多选动线。
// 这里只裁 DOM 数量，滚动主体、搜索/聚合/多选语义全部不变。
// 前提：行等高——`.issue-item` 定高、`.broken-target` 单行截断，所以「等距 + 绝对定位」
// 能精确对齐；行高与行间距不写死在 JS 里，挂载后从 CSS 计算值实测（改主题字号不会错位）。
const rootEl = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportH = ref(0);
const rowHeight = ref(46);
const rowGap = ref(8);
let rafId = 0;
// T02929：窗口起点按 8 行一块量化。原来每滚动一行就重建 34 行 × 每页 2 个列表，
// 60fps 下每帧都在重建 Element Plus 复选框/按钮，长帧的主因在这里而非模糊。
// 块高（8 行 = 432px）不超过 overscan 行数，窗口上下沿仍有覆盖，不会露白。
const WINDOW_BUCKET_ROWS = 8;

const virtualized = computed(() => shouldVirtualize(props.rows.length));
const windowInfo = computed(() =>
  computeVirtualWindow({
    count: props.rows.length,
    scrollTop: scrollTop.value,
    viewportHeight: viewportH.value,
    rowHeight: rowHeight.value,
    rowGap: rowGap.value,
  }),
);
const visibleRows = computed(() =>
  virtualized.value
    ? props.rows.slice(windowInfo.value.start, windowInfo.value.end)
    : props.rows,
);
// 未窗口化时保持原布局（flex + gap），只做行数折叠；窗口化时容器用总高占位
const listStyle = computed(() =>
  virtualized.value ? { height: `${windowInfo.value.totalHeight}px` } : {},
);
function rowStyle(idx: number): Record<string, string> {
  if (!virtualized.value) return {};
  return { top: `${(windowInfo.value.start + idx) * windowInfo.value.pitch}px` };
}

// 窗口槽位 key：虚拟模式下按「槽位」而非 row.key 作 key。
// 为什么不用 row.key：滚动时窗口整体位移，row.key 全变会让 Vue 卸载旧行、重建 34 行
// 的 el-checkbox/el-button 实例（实测每次滚动跳 26 行时反而比不优化更卡）。槽位 key
// 让同一批组件实例只更新 props——行本身无内部状态，全部由 props 派生，可安全复用。
const slotKeys = computed(() =>
  virtualized.value
    ? visibleRows.value.map((_, i) => `slot-${i}`)
    : visibleRows.value.map((r) => r.key),
);

function measureGeometry(): void {
  const el = rootEl.value;
  if (!el) return;
  const cs = getComputedStyle(el);
  const gap = parseFloat(cs.rowGap || cs.gap || '');
  if (Number.isFinite(gap) && gap >= 0) rowGap.value = gap;
  const first = el.querySelector<HTMLElement>('.issue-item');
  if (first && first.offsetHeight > 0) rowHeight.value = first.offsetHeight;
}

function updateScrollState(): void {
  const el = rootEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  viewportH.value = window.innerHeight || document.documentElement.clientHeight || 0;
  // 列表顶相对视口顶为负 → 已被滚出的距离；为正 → 尚未进入视口，从 0 起算
  const scrolled = Math.max(0, -rect.top);
  const pitch = Math.max(1, rowHeight.value + rowGap.value);
  const quantized = quantizeScrollTop(scrolled, pitch, WINDOW_BUCKET_ROWS);
  // 同一块内不写回：窗口区间、行定位都不变，省掉整窗 VDOM 重建
  if (quantized === scrollTop.value) return;
  scrollTop.value = quantized;
}

// 滚动事件在内部滚动容器（MAIN.content）上不冒泡，用捕获阶段监听统一接管
function onScrollOrResize(): void {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    updateScrollState();
  });
}

onMounted(() => {
  nextTick(() => {
    measureGeometry();
    updateScrollState();
  });
  window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
  window.addEventListener('resize', onScrollOrResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScrollOrResize, { capture: true });
  window.removeEventListener('resize', onScrollOrResize);
  if (rafId) cancelAnimationFrame(rafId);
});

// 行数变化（折叠/加载更多/展开全部/搜索）后重测：窗口区间与总高都要跟着新行数走
watch(
  () => props.rows.length,
  () => {
    nextTick(() => {
      measureGeometry();
      updateScrollState();
    });
  },
);
</script>

<template>
  <div ref="rootEl" class="issue-list" :class="{ 'is-virtual': virtualized }" :style="listStyle">
    <div
      v-for="(row, idx) in visibleRows"
      :key="slotKeys[idx]"
      class="issue-item"
      :class="[row.kind, jobStates[row.key] ? `is-${jobStates[row.key]}` : '']"
      :style="rowStyle(idx)"
      :title="rowTitle(row)"
    >
      <el-checkbox
        v-if="row.fixable"
        class="row-check"
        :model-value="selected.has(row.key)"
        :disabled="anyFixing"
        :aria-label="`选中 ${row.path}`"
        @change="emit('toggle', row.key)"
      />
      <span v-else class="row-lock" data-tip="不可自动修复 - 需人工判断，不参与批量修复">·</span>

      <code class="row-path">{{ row.path }}</code>
      <template v-if="row.kind === 'broken'">
        <span class="arrow">⟶</span>
        <code class="broken-target">[[{{ row.target }}]]</code>
      </template>

      <span v-if="jobStates[row.key]" class="row-badge" :class="jobStates[row.key]">
        {{ jobStates[row.key] === 'done' ? '已消解' : jobStates[row.key] === 'ineffective' ? '未消解' : '失败' }}
      </span>

      <el-button
        v-if="row.fixable"
        class="neon-btn row-fix-btn"
        size="small"
        :icon="row.kind === 'orphan' ? Link : EditPen"
        :data-tip="fixTip(row)"
        :loading="fixingKey === row.key"
        :disabled="anyFixing"
        @click="emit('fix', row)"
      >
        {{ fixLabel(row) }}
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.issue-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 虚拟窗口：容器按 totalHeight 占位，行脱离文档流按 index*pitch 定位。
   只改定位，不改行样式——扁平视图与「按目录聚合」共用同一套行。 */
.issue-list.is-virtual {
  position: relative;
}

.issue-list.is-virtual .issue-item {
  position: absolute;
  left: 0;
  right: 0;
  /* transition: all 会把 top 一起补间：滚动时窗口换行会看到整列滑动。
     这里显式只留视觉属性，位置变化瞬时生效。 */
  transition: background-color 0.25s ease, border-color 0.25s ease, transform 0.25s ease;
}

/* 等高行是虚拟窗口精确对齐的前提：定高 + 单行截断（完整文本走 title/读屏） */
.issue-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--health-row-height, 46px);
  padding: 9px 14px;
  background: var(--accent-purple-a08);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-input);
  font-size: 13px;
  /* 隔离滚动期的样式/布局重算（T02606 实测：展开全量平滑滚动 longtask 总时长大幅下降）。
     行内没有需要越界绘制的子节点：悬浮提示由 directives/tip 挂到 document.body 且 position:fixed，
     不是本行的后代，所以 paint containment 不会把它裁掉。 */
  contain: layout style paint;
  transition: all 0.25s ease;
}

.issue-item:hover {
  background: var(--accent-purple-a15);
  border-color: var(--accent-purple-a40);
  transform: translateX(4px);
}

.issue-item code {
  padding: 3px 10px;
  background: var(--accent-cyan-a10);
  border: 1px solid var(--accent-cyan-a25);
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--neon-cyan);
}

.issue-item.broken .arrow {
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.broken-target {
  color: var(--neon-magenta) !important;
  border-color: var(--accent-pink-a40) !important;
  background: var(--accent-pink-a10) !important;
  font-weight: 600;
}

.row-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 缺失页名过长时曾把行撑成两行（65px），破坏虚拟窗口的等距假设 */
.row-path,
.broken-target {
  flex: 0 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-check {
  flex-shrink: 0;
  height: auto;
}

.row-lock {
  width: 14px;
  text-align: center;
  color: var(--text-dim);
  font-family: var(--font-mono);
  flex-shrink: 0;
}

.row-fix-btn {
  margin-left: auto;
  flex-shrink: 0;
}

.neon-btn {
  background: var(--bg-glass) !important;
  border: 1px solid var(--accent-purple-a40) !important;
  color: var(--text-bright) !important;
  font-family: var(--font-mono) !important;
  letter-spacing: 0.05em;
  transition: all 0.3s ease !important;
}

.neon-btn:hover:not(.is-disabled) {
  border-color: var(--neon-cyan) !important;
  box-shadow: var(--glow-cyan) !important;
  color: var(--neon-cyan) !important;
}

/* 作业态高亮：成功=青蓝，失败=品红（口径与作业快照一致） */
.issue-item.is-done {
  background: var(--accent-cyan-a10);
  border-color: var(--accent-cyan-a40);
}

.issue-item.is-failed {
  background: var(--accent-pink-a12);
  border-color: var(--accent-pink-a45);
}

.row-badge {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  font-family: var(--font-mono);
  font-size: 10px;
  border: 1px solid;
  flex-shrink: 0;
}

.row-badge.done {
  color: var(--neon-cyan);
  border-color: var(--accent-cyan-a50);
}

.row-badge.ineffective {
  color: var(--neon-amber, #f5a623);
  border-color: rgba(245, 166, 35, 0.5);
}

.row-badge.failed {
  color: var(--neon-magenta);
  border-color: var(--accent-pink-a50);
}
</style>

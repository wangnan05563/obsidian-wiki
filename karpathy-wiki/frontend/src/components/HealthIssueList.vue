<script setup lang="ts">
// 体检问题行列表（T02466 / PRD R-F1）
// ------------------------------------------------------------------
// 为什么独立组件：原 Health.vue 为 4 类问题各手写一段行 markup，加搜索/多选/折叠时
// 需要改 4 处、极易漏改。行渲染收敛到这里后，扁平列表与「按目录聚合」的分组列表共用
// 同一套行，新增交互只改一处。
import { ElCheckbox, ElButton } from 'element-plus';
import { Link, EditPen } from '@element-plus/icons-vue';
import type { IssueRow } from '../utils/healthList';

defineProps<{
  rows: IssueRow[];
  selected: Set<string>;
  fixingKey: string;
  anyFixing: boolean;
  // 行在当前批量作业里的状态（done=已处理 / failed=失败），由作业快照与事件流推导
  jobStates: Record<string, 'done' | 'failed'>;
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
</script>

<template>
  <div class="issue-list">
    <div
      v-for="row in rows"
      :key="row.key"
      class="issue-item"
      :class="[row.kind, jobStates[row.key] ? `is-${jobStates[row.key]}` : '']"
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
        {{ jobStates[row.key] === 'done' ? '已处理' : '失败' }}
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

.issue-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  background: var(--accent-purple-a08);
  border: 1px solid var(--accent-purple-a20);
  border-radius: var(--radius-input);
  font-size: 13px;
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

.row-badge.failed {
  color: var(--neon-magenta);
  border-color: var(--accent-pink-a50);
}
</style>

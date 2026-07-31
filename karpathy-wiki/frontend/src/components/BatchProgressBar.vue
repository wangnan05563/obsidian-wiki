<script setup lang="ts">
import { computed } from 'vue';
import { Check, Close, CircleClose } from '@element-plus/icons-vue';
import { useCompileStore } from '../stores/compile';

// 批量编译进度条组件
// 为什么独立组件：Progress.vue 已包含时间线/分组卡片/历史任务等多块逻辑，
//   进度条作为单一职责组件抽出，便于复用与单测，且不污染父组件状态
// 进度数据来源：直接派生自 store.batchGroups，无需新增后端字段
//   - 总数 = batchGroups.length（batch_start 事件初始化）
//   - 已完成 = done + error 数量（无论成功失败都算"已结束"）
//   - 进行中 = running 数量
//   - 待处理 = pending 数量
// 持久化策略：store 状态跨页面切换保留，组件 onMounted 时通过 computed 自动恢复显示
const store = useCompileStore();

// 总文件数：batch_start 事件后初始化 batchGroups，长度即总数
const totalCount = computed(() => store.batchGroups.length);

// 已完成数：done 与 error 都视为"已结束"，参与进度推进
const completedCount = computed(() =>
  store.batchGroups.filter((g) => g.status === 'done' || g.status === 'error').length,
);

const successCount = computed(() =>
  store.batchGroups.filter((g) => g.status === 'done').length,
);

const errorCount = computed(() =>
  store.batchGroups.filter((g) => g.status === 'error').length,
);

const runningCount = computed(() =>
  store.batchGroups.filter((g) => g.status === 'running').length,
);

const pendingCount = computed(() =>
  store.batchGroups.filter((g) => g.status === 'pending').length,
);

// 百分比：totalCount 为 0 时返回 0，避免 NaN
const progressPercentage = computed(() => {
  if (totalCount.value === 0) return 0;
  return Math.round((completedCount.value / totalCount.value) * 100);
});

// 进度条状态：派生自 store 的 isCompiling/isDone/errorMessage
// 'idle'：尚未开始（batchGroups 为空）
// 'running'：编译进行中
// 'done'：编译正常结束（含部分失败，整体完成）
// 'error'：整体错误（如 multipart 解析失败）
// 'cancelled'：用户主动取消
type ProgressStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

const currentStatus = computed<ProgressStatus>(() => {
  if (store.errorMessage) return 'error';
  if (store.isCancelled) return 'cancelled';
  if (store.isDone) return 'done';
  if (store.isCompiling) return 'running';
  return 'idle';
});

// 状态文案：用于进度条上方的标题与完成后 banner
// 文案原则：running 态强调"正在处理 + 进度"，done 态强调"成果 + 数量"
const statusTitle = computed(() => {
  switch (currentStatus.value) {
    case 'running':
      return `正在编译 ${completedCount.value}/${totalCount.value} 篇文档`;
    case 'done':
      return `已编译 ${completedCount.value}/${totalCount.value} 篇文档`;
    case 'error':
      return '编译过程出错';
    case 'cancelled':
      return '编译已取消';
    default:
      return '准备开始编译';
  }
});

// 状态副文案：进度条下方一行小字
// running 态展示四态分布便于用户感知节奏；done 态突出失败数便于定位问题
const statusSubtitle = computed(() => {
  switch (currentStatus.value) {
    case 'running':
      return `成功 ${successCount.value} · 失败 ${errorCount.value} · 进行中 ${runningCount.value} · 待处理 ${pendingCount.value}`;
    case 'done':
      return errorCount.value > 0
        ? `共 ${totalCount.value} 篇 · 成功 ${successCount.value} · 失败 ${errorCount.value}`
        : `共 ${totalCount.value} 篇文档全部编译成功`;
    case 'error':
      return store.errorMessage || '未知错误';
    case 'cancelled':
      return `已保留 ${completedCount.value}/${totalCount.value} 篇编译成果`;
    default:
      return '上传文件后将自动开始批量编译';
  }
});

// el-progress 状态映射：'success' | 'exception' | 'warning' | undefined
const elProgressStatus = computed<'success' | 'exception' | 'warning' | undefined>(() => {
  if (currentStatus.value === 'done') {
    // 完成但有失败文件时用 warning，全部成功用 success
    return errorCount.value > 0 ? 'warning' : 'success';
  }
  if (currentStatus.value === 'error') return 'exception';
  if (currentStatus.value === 'cancelled') return 'warning';
  return undefined;
});

// 颜色：按状态切换，使用 CSS 变量适配主题
// 为什么不用 Element Plus 默认色：项目主题色为霓虹紫/青/粉，需保持视觉一致
const progressColor = computed(() => {
  switch (currentStatus.value) {
    case 'done':
      // 全部成功用青色，有失败用品红
      return errorCount.value > 0 ? 'var(--neon-magenta)' : 'var(--neon-cyan)';
    case 'error':
      return 'var(--neon-magenta)';
    case 'cancelled':
      return 'var(--neon-pink)';
    case 'running':
      return 'var(--neon-pink)';
    default:
      return 'var(--neon-purple)';
  }
});

// 是否显示取消按钮：仅运行中显示
const canCancel = computed(() => currentStatus.value === 'running');

// 触发取消：派发事件给父组件处理 abortController
const emit = defineEmits<{ (e: 'cancel'): void }>();

function handleCancel() {
  emit('cancel');
}
</script>

<template>
  <div class="batch-progress-container" :class="currentStatus">
    <!-- 头部：状态标题 + 取消按钮 -->
    <div class="progress-header">
      <div class="progress-title-row">
        <span class="progress-status-dot" :class="currentStatus"></span>
        <span class="progress-title">{{ statusTitle }}</span>
        <span class="progress-percentage">{{ progressPercentage }}%</span>
      </div>
      <el-button
        v-if="canCancel"
        size="small"
        type="danger"
        plain
        @click="handleCancel"
      >
        取消编译
      </el-button>
    </div>

    <!-- 进度条本体：el-progress 内置动画与条纹效果 -->
    <el-progress
      v-if="totalCount > 0"
      :percentage="progressPercentage"
      :color="progressColor"
      :status="elProgressStatus"
      :stroke-width="14"
      :text-inside="false"
      :show-text="false"
      :striped="currentStatus === 'running'"
      :striped-flow="currentStatus === 'running'"
      :duration="currentStatus === 'running' ? 1 : 0"
      class="progress-bar"
    />

    <!-- 空状态：batchGroups 还未初始化 -->
    <div v-else class="progress-empty">
      <span class="empty-dots">● ● ●</span>
      <p>等待批量编译开始…</p>
    </div>

    <!-- 副文案：详细统计 -->
    <div v-if="totalCount > 0" class="progress-subtitle">
      {{ statusSubtitle }}
    </div>

    <!-- 状态切换 banner：用 Transition 包裹实现淡入 + 上滑动画 -->
    <Transition name="banner-fade" mode="out-in">
      <!-- 完成态提示 banner -->
      <div v-if="currentStatus === 'done'" key="done" class="progress-banner success-banner">
        <el-icon class="banner-icon"><Check /></el-icon>
        <span class="banner-text">
          全部 {{ totalCount }} 篇文档编译完成
          <template v-if="errorCount > 0">
            （{{ successCount }} 成功 · {{ errorCount }} 失败）
          </template>
        </span>
      </div>

      <!-- 错误态提示 banner -->
      <div v-else-if="currentStatus === 'error'" key="error" class="progress-banner error-banner">
        <el-icon class="banner-icon"><Close /></el-icon>
        <span class="banner-text">{{ store.errorMessage || '编译过程出错' }}</span>
      </div>

      <!-- 取消态提示 banner -->
      <div v-else-if="currentStatus === 'cancelled'" key="cancelled" class="progress-banner cancelled-banner">
        <el-icon class="banner-icon"><CircleClose /></el-icon>
        <span class="banner-text">
          已取消编译，保留 {{ completedCount }}/{{ totalCount }} 篇成果
        </span>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 容器：紫色弱化背景 + 圆角 + 软阴影
   为什么用 --accent-purple-aXX：idle 态用紫色作为"默认/准备"语义色 */
.batch-progress-container {
  padding: 20px 24px;
  background: var(--accent-purple-a05);
  border: 1px solid var(--accent-purple-a18);
  border-radius: var(--radius-card);
  margin-bottom: 18px;
  position: relative;
  overflow: hidden;
  transition: border-color 0.3s ease, background-color 0.3s ease, box-shadow 0.3s ease;
  box-shadow: 0 2px 12px var(--accent-purple-a08);
}

/* 状态色边框：用语义色弱化背景，提升视觉反馈 */
.batch-progress-container.done {
  border-color: var(--accent-cyan-a35);
  background: var(--accent-cyan-a05);
  box-shadow: 0 2px 12px var(--accent-cyan-a08);
}

.batch-progress-container.error {
  border-color: var(--accent-pink-a40);
  background: var(--accent-pink-a05);
  box-shadow: 0 2px 12px var(--accent-pink-a08);
}

.batch-progress-container.cancelled {
  border-color: var(--accent-pink-a35);
  background: var(--accent-pink-a05);
  box-shadow: 0 2px 12px var(--accent-pink-a08);
}

.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  gap: 12px;
  flex-wrap: wrap;
}

.progress-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

/* 状态指示点：用 box-shadow currentColor 实现主题色光晕 */
.progress-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--neon-purple);
  color: var(--neon-purple);
  box-shadow: 0 0 8px currentColor;
  transition: background 0.3s ease, color 0.3s ease;
}

/* 运行中状态点带呼吸动画：通过 scale + opacity 模拟心跳节奏 */
.progress-status-dot.running {
  background: var(--neon-pink);
  color: var(--neon-pink);
  animation: dot-pulse 1.4s ease-in-out infinite;
}

.progress-status-dot.done {
  background: var(--neon-cyan);
  color: var(--neon-cyan);
}

.progress-status-dot.error {
  background: var(--neon-magenta);
  color: var(--neon-magenta);
}

.progress-status-dot.cancelled {
  background: var(--neon-pink);
  color: var(--neon-pink);
}

@keyframes dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.3); }
}

/* 标题：display 字体 + 加粗，保证视觉权重高于副文案 */
.progress-title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 百分比：mono 字体 + 主题色，与标题形成视觉对比 */
.progress-percentage {
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 700;
  color: var(--neon-cyan);
  letter-spacing: 1px;
  flex-shrink: 0;
}

/* 进度条本体：覆盖 el-progress 默认色与圆角 */
.progress-bar {
  margin-bottom: 10px;
}

/* 外层轨道：白色透明背景属于 CODING-042 白名单，保留硬编码 */
.progress-bar :deep(.el-progress-bar__outer) {
  border-radius: 7px;
  background-color: rgba(255, 255, 255, 0.06);
}

/* 内层进度：done 态时延长 transition 让走满更顺滑 */
.progress-bar :deep(.el-progress-bar__inner) {
  border-radius: 7px;
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

/* 副文案：mono 字体 + 软色，保证不抢主标题视觉 */
.progress-subtitle {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
  letter-spacing: 0.5px;
  word-break: break-all;
}

.progress-empty {
  text-align: center;
  color: var(--text-dim);
  padding: 28px 0;
  font-family: var(--font-mono);
  font-size: 12px;
}

.empty-dots {
  display: block;
  color: var(--neon-purple);
  letter-spacing: 8px;
  font-size: 18px;
  margin-bottom: 8px;
  animation: neon-pulse 1.5s ease-in-out infinite;
}

/* banner：语义色弱化背景 + 左侧 3px 色条 + 圆角 */
.progress-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  padding: 11px 16px;
  border-radius: 8px;
  font-size: 13px;
  position: relative;
  overflow: hidden;
}

.progress-banner::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
}

.success-banner {
  background: var(--accent-cyan-a08);
  color: var(--neon-cyan);
}

.success-banner::before {
  background: var(--neon-cyan);
}

.error-banner {
  background: var(--accent-pink-a08);
  color: var(--neon-magenta);
}

.error-banner::before {
  background: var(--neon-magenta);
}

.cancelled-banner {
  background: var(--accent-pink-a08);
  color: var(--neon-pink);
}

.cancelled-banner::before {
  background: var(--neon-pink);
}

.banner-icon {
  font-size: 16px;
  font-weight: 700;
  flex-shrink: 0;
}

.banner-text {
  flex: 1;
  line-height: 1.5;
}

/* banner 淡入 + 上滑动画：配合 Transition name="banner-fade" */
.banner-fade-enter-active,
.banner-fade-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.banner-fade-enter-from {
  opacity: 0;
  transform: translateY(-6px);
}

.banner-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

/* 响应式：窄屏下调整布局与字号 */
@media (max-width: 640px) {
  .batch-progress-container {
    padding: 16px 18px;
  }

  .progress-header {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .progress-title {
    font-size: 14px;
  }

  .progress-percentage {
    font-size: 14px;
  }

  .progress-subtitle {
    font-size: 11px;
  }

  .banner-text {
    font-size: 12px;
  }
}

@media (max-width: 480px) {
  .progress-subtitle {
    display: none;
  }
}
</style>

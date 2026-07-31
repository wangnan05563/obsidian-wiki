<script setup lang="ts">
import { computed } from 'vue';
import { Check, Close, CircleClose, Timer } from '@element-plus/icons-vue';
import { useCompileStore } from '../stores/compile';
import type { CompileStep } from '../types';

// 单文件编译进度条组件
// 为什么独立组件：单文件模式与批量模式进度计算逻辑差异大（单文件按阶段百分比，批量按文件数），
//   独立组件避免 Progress.vue 模板条件嵌套过深，且便于后续单测
// 数据来源：直接派生自 store.timeline / store.stageTimings，无新增后端字段
//   - 进度百分比 = 已完成阶段数 / 估算总阶段数（ESTIMATED_TOTAL_STEPS=8）
//   - 总耗时 = store.totalElapsedMs（编译中实时累加，完成后固定）
//   - 各阶段耗时 = store.stageTimings（key=step名，value=累计 ms）
const store = useCompileStore();

// 进度条状态：派生自 store 的 isCompiling/isDone/errorMessage/isCancelled
// 'idle'：尚未开始（timeline 为空且未编译）
// 'running'：编译进行中
// 'done'：编译正常结束
// 'error'：编译出错
// 'cancelled'：用户主动取消
type ProgressStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

const currentStatus = computed<ProgressStatus>(() => {
  if (store.errorMessage) return 'error';
  if (store.isCancelled) return 'cancelled';
  if (store.isDone) return 'done';
  if (store.isCompiling) return 'running';
  return 'idle';
});

// 状态标题：用于进度条上方的标题
// 文案原则：running 态强调"当前阶段 + 进度"，done 态强调"成果"
const statusTitle = computed(() => {
  switch (currentStatus.value) {
    case 'running':
      return '机器人正在编译…';
    case 'done':
      return '编译完成';
    case 'error':
      return '编译出错';
    case 'cancelled':
      return '编译已取消';
    default:
      return '准备开始编译';
  }
});

// 当前阶段中文标签：从 store.currentStep 取，未开始时显示"等待开始"
const STEP_LABEL: Record<CompileStep, string> = {
  archive: '存档原始资料',
  read_schema: '读取 SCHEMA',
  extract: '提取要点',
  generate_page: '生成页面',
  finalize: '收尾'
};

const currentStageLabel = computed(() => {
  if (!store.currentStep) return '等待开始';
  return STEP_LABEL[store.currentStep] ?? store.currentStep;
});

// el-progress 状态映射：'success' | 'exception' | 'warning' | undefined
const elProgressStatus = computed<'success' | 'exception' | 'warning' | undefined>(() => {
  if (currentStatus.value === 'done') return 'success';
  if (currentStatus.value === 'error') return 'exception';
  if (currentStatus.value === 'cancelled') return 'warning';
  return undefined;
});

// 进度条颜色：按状态切换，使用 CSS 变量适配主题
// 为什么不用 Element Plus 默认色：项目主题色为霓虹紫/青/粉，需保持视觉一致
const progressColor = computed(() => {
  switch (currentStatus.value) {
    case 'done':
      return 'var(--neon-cyan)';
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

// 格式化耗时（ms → 人类可读）
// 为什么不用 dayjs：单文件场景格式简单，原生实现避免引入额外依赖
function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}.${Math.floor((ms % 1000) / 100)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return `${minutes}m${remainSeconds}s`;
}

// 各阶段耗时明细列表：按耗时降序排列，便于用户快速定位瓶颈
// 为什么不按 step 顺序：用户更关心"哪个阶段最慢"而非"哪个阶段先执行"
const stageTimingList = computed(() => {
  const timings = store.stageTimings;
  const items = Object.entries(timings).map(([step, ms]) => ({
    step,
    label: STEP_LABEL[step as CompileStep] ?? step,
    ms,
    formatted: formatDuration(ms),
  }));
  // 按耗时降序：最慢的在最前
  items.sort((a, b) => b.ms - a.ms);
  return items;
});

// 是否显示阶段耗时明细：有任意一项耗时 > 0 即显示
const showStageTimings = computed(() =>
  stageTimingList.value.length > 0 && currentStatus.value !== 'idle',
);

// 总耗时是否有效：用于计算各阶段耗时占比
const hasTotalElapsed = computed(() => store.totalElapsedMs > 0);
</script>

<template>
  <div class="single-progress-container" :class="currentStatus">
    <!-- 头部：状态标题 + 总耗时 + 取消按钮 -->
    <div class="progress-header">
      <div class="progress-title-row">
        <span class="progress-status-dot" :class="currentStatus"></span>
        <span class="progress-title">{{ statusTitle }}</span>
        <span v-if="currentStatus === 'running'" class="progress-stage">· {{ currentStageLabel }}</span>
        <span class="progress-percentage">{{ store.progressPercentage }}%</span>
      </div>
      <div class="progress-meta-right">
        <span v-if="hasTotalElapsed" class="progress-elapsed">
          <el-icon class="elapsed-icon"><Timer /></el-icon>
          <span>{{ formatDuration(store.totalElapsedMs) }}</span>
        </span>
        <el-button v-if="canCancel" size="small" type="danger" plain @click="handleCancel">
          取消编译
        </el-button>
      </div>
    </div>

    <!-- 进度条本体：el-progress 内置条纹流动动画 -->
    <el-progress
      v-if="store.progressPercentage > 0 || currentStatus === 'running'"
      :percentage="store.progressPercentage"
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

    <!-- 空状态：尚未开始编译 -->
    <div v-else class="progress-empty">
      <span class="empty-dots">● ● ●</span>
      <p>等待编译开始…</p>
    </div>

    <!-- 当前阶段提示：running 态展示当前阶段 + 已完成步骤数 -->
    <div v-if="currentStatus === 'running'" class="progress-subtitle">
      已完成 {{ store.completedStepCount }} 个阶段 · 当前：{{ currentStageLabel }}
    </div>

    <!-- 状态切换 banner：用 Transition 包裹实现淡入动画 -->
    <Transition name="banner-fade" mode="out-in">
      <!-- 完成态提示 banner -->
      <div v-if="currentStatus === 'done'" key="done" class="progress-banner success-banner">
        <el-icon class="banner-icon"><Check /></el-icon>
        <span class="banner-text">
          编译完成，共生成 {{ store.generatedPages.length }} 个页面
          <template v-if="store.result?.cached">（缓存命中，已跳过重复编译）</template>
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
          已取消编译，保留 {{ store.completedStepCount }} 个阶段成果
        </span>
      </div>
    </Transition>

    <!-- 各阶段耗时明细：done/error/cancelled 态展示，便于用户定位瓶颈 -->
    <div v-if="showStageTimings" class="stage-timings">
      <div class="stage-timings-title">
        <el-icon><Timer /></el-icon>
        <span>各阶段耗时明细</span>
      </div>
      <div class="stage-list">
        <div v-for="item in stageTimingList" :key="item.step" class="stage-item">
          <span class="stage-label">{{ item.label }}</span>
          <div class="stage-bar-wrap">
            <div
              class="stage-bar"
              :style="{ width: hasTotalElapsed ? `${(item.ms / store.totalElapsedMs) * 100}%` : '0%' }"
            ></div>
          </div>
          <span class="stage-duration">{{ item.formatted }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 容器：紫色弱化背景 + 圆角 + 软阴影
   为什么用 --accent-purple-aXX：idle 态用紫色作为"默认/准备"语义色
   与 BatchProgressBar 视觉风格保持一致 */
.single-progress-container {
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
.single-progress-container.done {
  border-color: var(--accent-cyan-a35);
  background: var(--accent-cyan-a05);
  box-shadow: 0 2px 12px var(--accent-cyan-a08);
}

.single-progress-container.error {
  border-color: var(--accent-pink-a40);
  background: var(--accent-pink-a05);
  box-shadow: 0 2px 12px var(--accent-pink-a08);
}

.single-progress-container.cancelled {
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

.progress-meta-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
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

/* 标题：display 字体 + 加粗 */
.progress-title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.5px;
}

/* 当前阶段标签：紧跟标题后，软色弱化避免抢视觉 */
.progress-stage {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
  letter-spacing: 0.5px;
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

/* 总耗时：mono 字体 + 图标，弱化避免与百分比视觉冲突 */
.progress-elapsed {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-soft);
  letter-spacing: 0.5px;
}

.elapsed-icon {
  font-size: 13px;
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

/* 副文案：mono 字体 + 软色 */
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

/* banner 淡入 + 上滑动画 */
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

/* 各阶段耗时明细：done/error/cancelled 态展示 */
.stage-timings {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px dashed var(--accent-purple-a18);
}

.stage-timings-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  color: var(--text-bright);
  margin-bottom: 10px;
  letter-spacing: 0.5px;
}

.stage-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.stage-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.stage-label {
  flex-shrink: 0;
  width: 100px;
  color: var(--text-soft);
  font-family: var(--font-mono);
}

.stage-bar-wrap {
  flex: 1;
  height: 6px;
  background: var(--accent-purple-a08);
  border-radius: 3px;
  overflow: hidden;
}

/* 阶段条：使用青色作为"已完成"语义色，与进度条主题色区分 */
.stage-bar {
  height: 100%;
  background: var(--neon-cyan);
  border-radius: 3px;
  transition: width 0.4s ease;
  box-shadow: 0 0 6px var(--accent-cyan-a40);
}

.stage-duration {
  flex-shrink: 0;
  width: 60px;
  text-align: right;
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--neon-cyan);
}

/* 响应式：窄屏下调整布局与字号 */
@media (max-width: 640px) {
  .single-progress-container {
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

  .stage-label {
    width: 80px;
    font-size: 11px;
  }

  .stage-duration {
    width: 50px;
    font-size: 11px;
  }
}

@media (max-width: 480px) {
  .progress-subtitle {
    display: none;
  }
}
</style>

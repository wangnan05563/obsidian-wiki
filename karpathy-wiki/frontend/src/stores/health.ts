import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { FixProgressEvent, BatchFixProgressEvent, BatchDoneEvent } from '../types';

// 知识库体检 store：持久化批量修复与单个修复状态。
// 为什么需要 store：Health.vue 组件卸载后本地 ref 销毁，切回页面进度条丢失。
//   迁移到 Pinia store 后状态跨视图切换保留，SSE fetch 在后台继续更新 store。
export const useHealthStore = defineStore('health', () => {
  // 单个修复状态：fixingKey 标记当前正在修复的问题 key（格式：orphan:path 或 broken:idx）
  const fixingKey = ref<string>('');

  // 批量修复状态
  // - batchFixing：是否正在执行批量修复（执行中禁用所有单个修复按钮）
  // - batchTotal：本次批量修复总问题数
  // - batchCurrent：当前正在处理第几个（1-based，0 表示尚未开始）
  // - batchDoneKeys：已完成的 issueKey 集合，前端据此高亮已完成项
  const batchFixing = ref(false);
  const batchTotal = ref(0);
  const batchCurrent = ref(0);
  const batchDoneKeys = ref<Set<string>>(new Set());

  // 修复进度日志（时间线展示，单个修复与批量修复共用）
  const fixLogs = ref<FixProgressEvent[]>([]);

  // 批量修复进度百分比（0-100），用于 el-progress
  const batchProgress = computed(() => {
    if (batchTotal.value === 0) return 0;
    return Math.round((batchDoneKeys.value.size / batchTotal.value) * 100);
  });

  // 是否禁用所有修复按钮：单个修复进行中 或 批量修复进行中
  const anyFixing = computed(() => fixingKey.value !== '' || batchFixing.value);

  // 开始批量修复：初始化所有批量状态
  function startBatchFix(total: number) {
    batchFixing.value = true;
    batchTotal.value = total;
    batchCurrent.value = 0;
    batchDoneKeys.value = new Set();
    fixLogs.value = [];
  }

  // 结束批量修复：保留 batchDoneKeys 和 fixLogs 供用户查看结果
  function endBatchFix() {
    batchFixing.value = false;
    batchCurrent.value = 0;
  }

  // 开始/结束单个修复
  function startSingleFix(key: string) {
    fixingKey.value = key;
    fixLogs.value = [];
  }
  function endSingleFix() {
    fixingKey.value = '';
  }

  // 处理批量修复 SSE 事件：只更新状态，不含 UI 副作用（ElMessage 等）
  // 从 Health.vue 迁移，逻辑保持一致
  function handleBatchEvent(
    eventType: string,
    parsed: BatchFixProgressEvent | BatchDoneEvent | { totalIssues: number },
  ): void {
    if (eventType === 'batch_start') {
      const payload = parsed as { totalIssues: number };
      batchTotal.value = payload.totalIssues;
      batchCurrent.value = 0;
      batchDoneKeys.value = new Set();
      fixLogs.value = [];
      return;
    }
    if (eventType === 'issue_start') {
      const ev = parsed as BatchFixProgressEvent;
      batchCurrent.value = ev.issueIndex + 1;
      fixLogs.value.push({
        step: ev.step,
        status: ev.status,
        message: `[${ev.issueIndex + 1}/${ev.totalIssues}] ${ev.message}`,
        tool: ev.tool,
        data: ev.data,
      });
      return;
    }
    if (eventType === 'progress' || eventType === 'fixed') {
      const ev = parsed as BatchFixProgressEvent;
      fixLogs.value.push({
        step: ev.step,
        status: ev.status,
        message: `[${ev.issueIndex + 1}/${ev.totalIssues}] ${ev.message}`,
        tool: ev.tool,
        data: ev.data,
      });
      return;
    }
    if (eventType === 'issue_done' || eventType === 'issue_error') {
      const ev = parsed as BatchFixProgressEvent;
      batchDoneKeys.value.add(ev.issueKey);
      fixLogs.value.push({
        step: ev.step,
        status: ev.status,
        message: `[${ev.issueIndex + 1}/${ev.totalIssues}] ${ev.message}`,
        tool: ev.tool,
        data: ev.data,
      });
      return;
    }
    if (eventType === 'batch_done') {
      const ev = parsed as BatchDoneEvent;
      fixLogs.value.push({
        step: ev.step,
        status: ev.status,
        message: ev.message,
      });
      return;
    }
    if (eventType === 'error') {
      const ev = parsed as FixProgressEvent;
      fixLogs.value.push({
        step: ev.step,
        status: 'error',
        message: ev.message || '批量修复出错',
      });
    }
  }

  // 添加单条修复日志
  function pushFixLog(log: FixProgressEvent) {
    fixLogs.value.push(log);
  }

  // 清空日志
  function clearLogs() {
    fixLogs.value = [];
  }

  return {
    fixingKey,
    batchFixing,
    batchTotal,
    batchCurrent,
    batchDoneKeys,
    fixLogs,
    batchProgress,
    anyFixing,
    startBatchFix,
    endBatchFix,
    startSingleFix,
    endSingleFix,
    handleBatchEvent,
    pushFixLog,
    clearLogs,
  };
});

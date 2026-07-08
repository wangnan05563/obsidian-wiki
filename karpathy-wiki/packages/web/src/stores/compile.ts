import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  CompileStep,
  DoneData,
  IngestPayload,
  ProgressData,
  TimelineItem
} from '../types';

// 步骤展示名映射：后端用英文 step 标识，前端需要友好中文
const STEP_LABEL: Record<CompileStep, string> = {
  archive: '存档原始资料',
  read_schema: '读取 SCHEMA',
  extract: '提取要点',
  generate_page: '生成页面',
  finalize: '收尾'
};

export const useCompileStore = defineStore('compile', () => {
  // SSE 推送的时间线项
  const timeline = ref<TimelineItem[]>([]);
  // 当前正在运行的步骤，用于驱动机器人动画
  const currentStep = ref<CompileStep | null>(null);
  const isCompiling = ref(false);
  const isDone = ref(false);
  const errorMessage = ref<string>('');
  const result = ref<DoneData | null>(null);
  // 保存本次投递的载荷，进度页需要据此发起请求
  const pendingPayload = ref<IngestPayload | null>(null);

  // 步骤中文名
  const stepLabel = computed(() => (s: CompileStep | null) =>
    s ? STEP_LABEL[s] : ''
  );

  // 已生成页面数（来自 generate_page 事件）
  const generatedPages = computed(() =>
    timeline.value
      .filter((t) => t.step === 'generate_page' && t.page)
      .map((t) => t.page!)
  );

  // 重置状态，用于"再投一篇"
  function reset() {
    timeline.value = [];
    currentStep.value = null;
    isCompiling.value = false;
    isDone.value = false;
    errorMessage.value = '';
    result.value = null;
    pendingPayload.value = null;
  }

  // 投递前预存载荷并进入编译态
  function prepareCompile(payload: IngestPayload) {
    reset();
    pendingPayload.value = payload;
    isCompiling.value = true;
  }

  // 处理单条 SSE 事件，按事件类型分发
  function handleEvent(eventType: string, data: unknown) {
    if (eventType === 'progress') {
      const p = data as ProgressData;
      currentStep.value = p.step;
      timeline.value.push({
        step: p.step,
        status: p.status,
        message: p.message,
        page: p.data,
        timestamp: Date.now()
      });
    } else if (eventType === 'done') {
      result.value = data as DoneData;
      isCompiling.value = false;
      isDone.value = true;
      currentStep.value = null;
    } else if (eventType === 'error') {
      // 后端可能在流中推送 error 事件
      const e = data as { message?: string };
      errorMessage.value = e?.message || '编译过程出错';
      isCompiling.value = false;
    }
  }

  return {
    timeline,
    currentStep,
    isCompiling,
    isDone,
    errorMessage,
    result,
    pendingPayload,
    generatedPages,
    stepLabel,
    reset,
    prepareCompile,
    handleEvent
  };
});

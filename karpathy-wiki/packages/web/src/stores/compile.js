import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
// 步骤展示名映射：后端用英文 step 标识，前端需要友好中文
const STEP_LABEL = {
    archive: '存档原始资料',
    read_schema: '读取 SCHEMA',
    extract: '提取要点',
    generate_page: '生成页面',
    finalize: '收尾'
};
export const useCompileStore = defineStore('compile', () => {
    // SSE 推送的时间线项
    const timeline = ref([]);
    // 当前正在运行的步骤，用于驱动机器人动画
    const currentStep = ref(null);
    const isCompiling = ref(false);
    const isDone = ref(false);
    const errorMessage = ref('');
    const result = ref(null);
    // §11.2 done 事件的 message，用于展示"编译完成"或"缓存命中"等提示
    const doneMessage = ref('');
    // 保存本次投递的载荷，进度页需要据此发起请求
    const pendingPayload = ref(null);
    // §11.2 历史编译任务列表（空状态时展示）
    const runs = ref([]);
    const loadingRuns = ref(false);
    // §12.3-8 日志查看
    const logEntries = ref([]);
    const loadingLog = ref(false);
    // 步骤中文名
    const stepLabel = computed(() => (s) => s ? STEP_LABEL[s] : '');
    // 已生成页面数（来自 generate_page 事件）
    const generatedPages = computed(() => timeline.value
        .filter((t) => t.step === 'generate_page' && t.page)
        .map((t) => t.page));
    // 重置状态，用于"再投一篇"
    function reset() {
        timeline.value = [];
        currentStep.value = null;
        isCompiling.value = false;
        isDone.value = false;
        errorMessage.value = '';
        result.value = null;
        doneMessage.value = '';
        pendingPayload.value = null;
    }
    // 投递前预存载荷并进入编译态
    function prepareCompile(payload) {
        reset();
        pendingPayload.value = payload;
        isCompiling.value = true;
    }
    // 处理单条 SSE 事件，按事件类型分发
    function handleEvent(eventType, data) {
        if (eventType === 'progress') {
            const p = data;
            currentStep.value = p.step;
            timeline.value.push({
                step: p.step,
                status: p.status,
                message: p.message,
                page: p.data,
                timestamp: Date.now()
            });
        }
        else if (eventType === 'done') {
            // 后端 done 事件发送的是完整 ProgressEvent：{ step, status, message, data: { path, cached? } }
            // 从中提取 cached 标识和 message 供前端展示
            const d = data;
            result.value = {
                pages: [],
                indexUpdated: false,
                cached: d.data?.cached,
            };
            // 缓存命中时 message 存在 errorMessage 上会误导，单独存到 doneMessage
            doneMessage.value = d.message ?? '';
            isCompiling.value = false;
            isDone.value = true;
            currentStep.value = null;
        }
        else if (eventType === 'error') {
            // 后端可能在流中推送 error 事件
            const e = data;
            errorMessage.value = e?.message || '编译过程出错';
            isCompiling.value = false;
        }
    }
    // §11.2 加载历史编译任务列表
    async function loadRuns() {
        loadingRuns.value = true;
        try {
            const res = await fetch('/api/compile/runs');
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            runs.value = data.runs ?? [];
        }
        catch {
            runs.value = [];
        }
        finally {
            loadingRuns.value = false;
        }
    }
    // §12.3-8 加载某个 run 的技术日志
    async function loadLog(runId) {
        loadingLog.value = true;
        try {
            const res = await fetch(`/api/compile/runs/${runId}/log`);
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            logEntries.value = data.entries ?? [];
        }
        catch {
            logEntries.value = [];
        }
        finally {
            loadingLog.value = false;
        }
    }
    return {
        timeline,
        currentStep,
        isCompiling,
        isDone,
        errorMessage,
        result,
        doneMessage,
        pendingPayload,
        generatedPages,
        stepLabel,
        runs,
        loadingRuns,
        logEntries,
        loadingLog,
        reset,
        prepareCompile,
        handleEvent,
        loadRuns,
        loadLog
    };
});

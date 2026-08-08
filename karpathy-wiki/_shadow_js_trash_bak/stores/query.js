import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { STORAGE_KEYS } from '../constants/storageKeys';
export const ALL_OUTPUT_MODES = ['thinking', 'tool_call', 'answer', 'multimodal'];
// 模式显示标签：用于 UI 多选控件的 label
export const OUTPUT_MODE_LABELS = {
    thinking: '思考过程',
    tool_call: '工具调用',
    answer: '主答案',
    multimodal: '多模态',
};
export const ALL_MIDDLEWARES = ['web_search', 'deep_thinking', 'extended_tools', 'followups', 'stream'];
export const MIDDLEWARE_LABELS = {
    web_search: '联网搜索',
    deep_thinking: '深度思考',
    extended_tools: '扩展工具',
    followups: '追问建议',
    stream: '真流式输出',
};
// 从 localStorage 加载用户偏好的多输出模式，解析失败或缺失时回退到全开
// 为什么需要防御：localStorage 可能是旧版本数据（数组格式/字符串），用 try-catch 兜底
function loadOutputModes() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.OUTPUT_MODES);
        if (!raw)
            return [...ALL_OUTPUT_MODES];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            // 仅保留 ALL_OUTPUT_MODES 中仍存在的模式，避免历史脏数据导致类型错乱
            const valid = parsed.filter((m) => typeof m === 'string' && ALL_OUTPUT_MODES.includes(m));
            return valid.length > 0 ? valid : [...ALL_OUTPUT_MODES];
        }
    }
    catch {
        // 解析失败视为未设置
    }
    return [...ALL_OUTPUT_MODES];
}
// §真流式偏好：从 localStorage 加载，未设置时默认 true（用户需求"改为流式输出"）
// 为什么默认 true：用户需求明确要求流式输出体验，未配置时优先启用流式
// 为什么用 try-catch：localStorage 可能存历史脏数据（非 'true'/'false' 字符串），需兜底
function loadStreamMode() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.STREAM_MODE);
        if (raw === null)
            return true;
        return raw === 'true';
    }
    catch {
        return true;
    }
}
// 中间件多选偏好：从 localStorage 加载，未设置时默认全开（向后兼容旧行为）
// 为什么默认全开：middlewares 是"功能开关集合"，老用户未配置时应保持所有功能可用，
// 避免升级后用户感知不到原已启用的功能（与 outputModes 一致的回退策略）
function loadMiddlewares() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.MIDDLEWARES);
        if (!raw)
            return [...ALL_MIDDLEWARES];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            // 仅保留 ALL_MIDDLEWARES 中仍存在的项，过滤历史脏数据
            const valid = parsed.filter((m) => typeof m === 'string' && ALL_MIDDLEWARES.includes(m));
            // 全部过滤掉时回退到全开，避免空数组导致所有功能被禁用
            return valid.length > 0 ? valid : [...ALL_MIDDLEWARES];
        }
    }
    catch {
        // 解析失败视为未设置
    }
    return [...ALL_MIDDLEWARES];
}
export const useQueryStore = defineStore('query', () => {
    const messages = ref([]);
    const streamingAnswer = ref('');
    const currentRefs = ref([]);
    const currentFollowups = ref([]);
    const currentThinking = ref([]);
    const searchProgress = ref(null);
    const isLoading = ref(false);
    const errorMessage = ref('');
    // FR-09-2 多模态输出：在 done 之前到达的 multimodal 暂存到此，finalizeAnswer 时附加到消息
    // 为什么独立状态：SSE 顺序为 answer → multimodal → done，store 需在 done 时统一打包到消息
    const currentMultimodal = ref(null);
    // v3 图像/PPT 生成结果：在 done 之前到达的 image/ppt 事件暂存，finalizeAnswer 时附加到消息
    // 为什么独立于 currentMultimodal：image/ppt 通过独立 SSE 事件推送，结构不同，需独立字段
    const currentImage = ref(null);
    const currentPpt = ref(null);
    // v2: 多输出模式多选状态。默认从 localStorage 加载，缺失时全开
    // 与单选 outputMode 互不冲突：outputMode 控制多模态结构（mindmap/faq/timeline），
    // outputModes 控制流式阶段事件的可见性
    const outputModes = ref(loadOutputModes());
    // §真流式偏好：默认从 localStorage 加载，缺失时默认 true（用户需求"改为流式输出"）
    // 与后端 config.llm.stream 关系：前端偏好覆盖后端默认值，每次请求 body.stream 显式发送
    const streamMode = ref(loadStreamMode());
    // 中间件多选状态：默认从 localStorage 加载，缺失时全开（向后兼容）
    // 与已有 streamMode/outputModes 关系：middlewares 是更高层抽象，
    // - middlewares 含 'stream' 时覆盖 streamMode=true
    // - middlewares 不含 'web_search' 时覆盖 webSearch 按钮
    // - middlewares 不含 'deep_thinking' 时覆盖 deep 模式
    // 提交请求时 body.middlewares 显式发送，后端按 middlewares 决定功能启用
    const middlewares = ref(loadMiddlewares());
    // v2: 持久化多输出模式到 localStorage，用户偏好跨刷新保留
    // 用 watch deep 跟踪数组变化，比逐个 setter 写更可靠
    watch(outputModes, (modes) => {
        try {
            localStorage.setItem(STORAGE_KEYS.OUTPUT_MODES, JSON.stringify(modes));
        }
        catch {
            // 写入失败（如存储满）静默降级，仅内存态生效
        }
    }, { deep: true });
    // §真流式偏好持久化：toggle 时立即写入 localStorage，跨刷新保留
    watch(streamMode, (mode) => {
        try {
            localStorage.setItem(STORAGE_KEYS.STREAM_MODE, String(mode));
        }
        catch {
            // 写入失败静默降级
        }
    });
    // 中间件多选偏好持久化：watch deep 跟踪数组增删，跨刷新保留
    // 为什么用 deep：middlewares 是数组，splice/push 不会触发浅层 watch
    watch(middlewares, (list) => {
        try {
            localStorage.setItem(STORAGE_KEYS.MIDDLEWARES, JSON.stringify(list));
        }
        catch {
            // 写入失败静默降级
        }
    }, { deep: true });
    // v2: 切换多输出模式：有则移除，无则添加。点击同一模式即关闭该模式
    function toggleOutputMode(mode) {
        const idx = outputModes.value.indexOf(mode);
        if (idx >= 0) {
            outputModes.value.splice(idx, 1);
        }
        else {
            outputModes.value.push(mode);
        }
    }
    // §真流式切换：切换 streamMode 真假值，watch 自动持久化
    function toggleStreamMode() {
        streamMode.value = !streamMode.value;
    }
    // 中间件多选切换：有则移除，无则添加。点击同一项即关闭该中间件
    // 与 toggleOutputMode 模式一致，watch deep 自动持久化
    function toggleMiddleware(mw) {
        const idx = middlewares.value.indexOf(mw);
        if (idx >= 0) {
            middlewares.value.splice(idx, 1);
        }
        else {
            middlewares.value.push(mw);
        }
    }
    function appendAnswer(text) {
        streamingAnswer.value += text;
    }
    // FR-09-2 设置多模态输出：mindmap/faq/timeline，在 done 之前到达
    function setMultimodal(payload) {
        currentMultimodal.value = payload;
    }
    // v3 设置图像生成结果：在 done 之前到达，finalizeAnswer 时附加到消息
    function setImage(payload) {
        currentImage.value = payload;
    }
    // v3 设置 PPT 生成结果：在 done 之前到达，finalizeAnswer 时附加到消息
    function setPpt(payload) {
        currentPpt.value = payload;
    }
    function setRefs(refs, webRefs) {
        // §5.2 合并本地引用 + 联网搜索引用为统一 Reference[]。
        // 本地引用 citeIndex 1..N，联网引用 N+1..M，两类在 RefsList 中差异化渲染
        const localRefs = refs.map((ref, index) => {
            if (typeof ref !== 'string')
                return ref;
            return {
                path: ref,
                title: ref.split('/').pop() || ref,
                snippet: '',
                source: 'vault',
                citeIndex: index + 1,
            };
        });
        const webRefList = (webRefs ?? []).map((r, i) => ({
            url: r.url,
            title: r.title || r.url,
            snippet: r.snippet,
            source: 'web',
            citeIndex: localRefs.length + i + 1,
        }));
        currentRefs.value = [...localRefs, ...webRefList];
    }
    function setFollowups(followups) {
        currentFollowups.value = followups;
    }
    function appendThinking(step) {
        currentThinking.value.push(step);
    }
    function setProgress(step, count) {
        searchProgress.value = { step, count };
    }
    function clearCurrentRound() {
        streamingAnswer.value = '';
        currentRefs.value = [];
        currentFollowups.value = [];
        currentThinking.value = [];
        searchProgress.value = null;
        // FR-09-2 清理多模态输出暂存，避免下一轮问答残留上一轮的 mindmap/faq/timeline
        currentMultimodal.value = null;
        // v3 清理图像/PPT 暂存，避免下一轮问答残留上一轮的生成结果
        currentImage.value = null;
        currentPpt.value = null;
    }
    function finalizeAnswer(sessionId, messageIndex, followups) {
        if (streamingAnswer.value) {
            const finalFollowups = followups?.length ? followups : currentFollowups.value;
            messages.value.push({
                id: crypto.randomUUID(),
                role: 'assistant',
                content: streamingAnswer.value,
                refs: currentRefs.value.length ? [...currentRefs.value] : undefined,
                followups: finalFollowups.length ? [...finalFollowups] : undefined,
                thinking: currentThinking.value.length ? [...currentThinking.value] : undefined,
                createdAt: new Date().toISOString(),
                sessionId,
                messageIndex,
                // FR-09-2 多模态输出：附加 mindmap/faq/timeline 到消息，前端渲染为独立卡片
                multimodal: currentMultimodal.value ?? undefined,
                // v3 图像/PPT 生成结果附加到消息
                image: currentImage.value ?? undefined,
                ppt: currentPpt.value ?? undefined,
            });
        }
        clearCurrentRound();
        isLoading.value = false;
    }
    function submitQuestion(question) {
        messages.value.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: question,
            createdAt: new Date().toISOString(),
        });
        clearCurrentRound();
        errorMessage.value = '';
        isLoading.value = true;
    }
    function handleError(message) {
        errorMessage.value = message;
        if (streamingAnswer.value) {
            messages.value.push({
                id: crypto.randomUUID(),
                role: 'assistant',
                content: `${streamingAnswer.value}\n\n[出错: ${message}]`,
                refs: currentRefs.value.length ? [...currentRefs.value] : undefined,
                createdAt: new Date().toISOString(),
            });
        }
        clearCurrentRound();
        isLoading.value = false;
    }
    // 用户主动停止或超时停止：保留已收到的部分答案，不显示错误样式
    // 为什么独立于 handleError：停止是用户主动行为或保护性兜底，非错误，
    // 不应污染 errorMessage，消息尾部追加"[已停止]"让用户感知中断点
    function stopLoading(reason) {
        const suffix = reason === 'user' ? '[已停止]' : '[已超时]';
        if (streamingAnswer.value) {
            messages.value.push({
                id: crypto.randomUUID(),
                role: 'assistant',
                content: `${streamingAnswer.value}\n\n${suffix}`,
                refs: currentRefs.value.length ? [...currentRefs.value] : undefined,
                thinking: currentThinking.value.length ? [...currentThinking.value] : undefined,
                createdAt: new Date().toISOString(),
            });
        }
        clearCurrentRound();
        isLoading.value = false;
    }
    function reset() {
        messages.value = [];
        clearCurrentRound();
        errorMessage.value = '';
        isLoading.value = false;
    }
    function markArchived(index) {
        if (messages.value[index])
            messages.value[index].archived = true;
    }
    function loadMessages(loadedMessages) {
        messages.value = loadedMessages;
        clearCurrentRound();
        errorMessage.value = '';
        isLoading.value = false;
    }
    function removeMessagesFrom(index) {
        messages.value = messages.value.slice(0, index);
    }
    // 删除单条消息：用于消息工具栏的"删除"按钮
    // 为什么独立于 removeMessagesFrom：removeMessagesFrom 是"丢弃从 index 起的所有消息"用于重新生成，
    // removeMessage 是"仅删除当前消息"用于用户手动清理单条内容，语义不同故拆分
    function removeMessage(index) {
        if (index >= 0 && index < messages.value.length) {
            messages.value.splice(index, 1);
        }
    }
    function setFeedback(index, feedback) {
        if (messages.value[index])
            messages.value[index].feedback = feedback;
    }
    return {
        messages,
        streamingAnswer,
        currentRefs,
        currentFollowups,
        currentThinking,
        searchProgress,
        isLoading,
        errorMessage,
        // FR-09-2 暴露多模态输出状态，供 Query.vue 在 streaming 阶段预览
        currentMultimodal,
        // v3 暴露图像/PPT 生成状态，供 Query.vue 在 streaming 阶段预览
        currentImage,
        currentPpt,
        // v2: 暴露多输出模式状态与切换方法，供 Query.vue 多选控件使用
        outputModes,
        // §真流式暴露 streamMode 状态与切换方法，供 Query.vue 开关使用
        streamMode,
        // 中间件多选状态与切换方法，供 Query.vue 高级设置面板使用
        middlewares,
        appendAnswer,
        setRefs,
        setFollowups,
        appendThinking,
        setProgress,
        // FR-09-2 暴露 setMultimodal，供 SSE 处理器调用
        setMultimodal,
        // v3 暴露 setImage/setPpt，供 SSE 处理器调用
        setImage,
        setPpt,
        finalizeAnswer,
        submitQuestion,
        handleError,
        stopLoading,
        reset,
        markArchived,
        loadMessages,
        removeMessagesFrom,
        removeMessage,
        setFeedback,
        // v2: 多输出模式切换
        toggleOutputMode,
        // §真流式切换
        toggleStreamMode,
        // 中间件多选切换
        toggleMiddleware,
    };
});

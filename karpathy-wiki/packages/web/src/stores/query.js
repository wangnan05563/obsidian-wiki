import { defineStore } from 'pinia';
import { ref } from 'vue';
// query 问答 store。
// 管理：对话历史、当前流式答案缓冲、loading 状态、错误信息。
export const useQueryStore = defineStore('query', () => {
    // 完整对话历史，每轮含 user 问题与 assistant 回答
    const messages = ref([]);
    // 当前正在流式接收的 assistant 答案（实时拼接）
    const streamingAnswer = ref('');
    // 当前轮引用的页面列表
    const currentRefs = ref([]);
    const isLoading = ref(false);
    const errorMessage = ref('');
    // 处理 SSE answer 事件：累加文本到流式缓冲
    function appendAnswer(text) {
        streamingAnswer.value += text;
    }
    // 处理 SSE refs 事件：更新当前引用列表
    function setRefs(refs) {
        currentRefs.value = refs;
    }
    // 处理 SSE done 事件：把流式缓冲落为一条 assistant 消息
    // sessionId/messageIndex 由后端 done 事件附带，供归档使用
    function finalizeAnswer(sessionId, messageIndex) {
        if (streamingAnswer.value) {
            messages.value.push({
                role: 'assistant',
                content: streamingAnswer.value,
                refs: currentRefs.value.length > 0 ? [...currentRefs.value] : undefined,
                sessionId,
                messageIndex,
            });
        }
        streamingAnswer.value = '';
        currentRefs.value = [];
        isLoading.value = false;
    }
    // 提交问题前：先把 user 消息入历史，清空缓冲进入 loading
    function submitQuestion(question) {
        messages.value.push({ role: 'user', content: question });
        streamingAnswer.value = '';
        currentRefs.value = [];
        errorMessage.value = '';
        isLoading.value = true;
    }
    // 处理错误：保留已收到的部分答案，标记 loading 结束
    function handleError(message) {
        errorMessage.value = message;
        if (streamingAnswer.value) {
            messages.value.push({
                role: 'assistant',
                content: streamingAnswer.value + `\n\n[出错: ${message}]`,
                refs: currentRefs.value.length > 0 ? [...currentRefs.value] : undefined,
            });
            streamingAnswer.value = '';
        }
        currentRefs.value = [];
        isLoading.value = false;
    }
    // 清空对话历史，开始新会话
    function reset() {
        messages.value = [];
        streamingAnswer.value = '';
        currentRefs.value = [];
        errorMessage.value = '';
        isLoading.value = false;
    }
    // 标记某条消息已归档
    function markArchived(index) {
        if (messages.value[index]) {
            messages.value[index].archived = true;
        }
    }
    return {
        messages,
        streamingAnswer,
        currentRefs,
        isLoading,
        errorMessage,
        appendAnswer,
        setRefs,
        finalizeAnswer,
        submitQuestion,
        handleError,
        reset,
        markArchived,
    };
});

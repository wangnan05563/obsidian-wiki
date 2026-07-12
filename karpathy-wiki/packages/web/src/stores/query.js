import { defineStore } from 'pinia';
import { ref } from 'vue';
export const useQueryStore = defineStore('query', () => {
    const messages = ref([]);
    const streamingAnswer = ref('');
    const currentRefs = ref([]);
    const currentFollowups = ref([]);
    const currentThinking = ref([]);
    const searchProgress = ref(null);
    const isLoading = ref(false);
    const errorMessage = ref('');
    function appendAnswer(text) {
        streamingAnswer.value += text;
    }
    function setRefs(refs) {
        currentRefs.value = refs.map((ref, index) => {
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
        appendAnswer,
        setRefs,
        setFollowups,
        appendThinking,
        setProgress,
        finalizeAnswer,
        submitQuestion,
        handleError,
        reset,
        markArchived,
        loadMessages,
        removeMessagesFrom,
        setFeedback,
    };
});

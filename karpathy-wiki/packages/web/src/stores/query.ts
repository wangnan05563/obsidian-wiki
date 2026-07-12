import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ChatMessage, Reference, ThinkingStep } from '../types';

export const useQueryStore = defineStore('query', () => {
  const messages = ref<ChatMessage[]>([]);
  const streamingAnswer = ref('');
  const currentRefs = ref<Reference[]>([]);
  const currentFollowups = ref<string[]>([]);
  const currentThinking = ref<ThinkingStep[]>([]);
  const searchProgress = ref<{ step: string; count?: number } | null>(null);
  const isLoading = ref(false);
  const errorMessage = ref('');

  function appendAnswer(text: string) {
    streamingAnswer.value += text;
  }

  function setRefs(refs: string[] | Reference[]) {
    currentRefs.value = refs.map((ref, index) => {
      if (typeof ref !== 'string') return ref;
      return {
        path: ref,
        title: ref.split('/').pop() || ref,
        snippet: '',
        source: 'vault' as const,
        citeIndex: index + 1,
      };
    });
  }

  function setFollowups(followups: string[]) {
    currentFollowups.value = followups;
  }

  function appendThinking(step: ThinkingStep) {
    currentThinking.value.push(step);
  }

  function setProgress(step: string, count?: number) {
    searchProgress.value = { step, count };
  }

  function clearCurrentRound() {
    streamingAnswer.value = '';
    currentRefs.value = [];
    currentFollowups.value = [];
    currentThinking.value = [];
    searchProgress.value = null;
  }

  function finalizeAnswer(sessionId?: string, messageIndex?: number, followups?: string[]) {
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

  function submitQuestion(question: string) {
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

  function handleError(message: string) {
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

  function markArchived(index: number) {
    if (messages.value[index]) messages.value[index].archived = true;
  }

  function loadMessages(loadedMessages: ChatMessage[]) {
    messages.value = loadedMessages;
    clearCurrentRound();
    errorMessage.value = '';
    isLoading.value = false;
  }

  function removeMessagesFrom(index: number) {
    messages.value = messages.value.slice(0, index);
  }

  function setFeedback(index: number, feedback: 'up' | 'down') {
    if (messages.value[index]) messages.value[index].feedback = feedback;
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

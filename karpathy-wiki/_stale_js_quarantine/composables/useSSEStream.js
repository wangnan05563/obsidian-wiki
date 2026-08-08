import { ref, onBeforeUnmount } from 'vue';
// 事件分发器外置：避免每次调用 useSSEStream 重建闭包，符合 S7721
function dispatchEvent(event, data, handlers) {
    switch (event) {
        case 'answer':
            handlers.onAnswer?.(data);
            break;
        case 'thinking':
            handlers.onThinking?.(data);
            break;
        case 'progress':
            handlers.onProgress?.(data);
            break;
        // refs 载荷结构复杂（含 refs 数组与可选 webRefs），用具体类型断言避免冗长的条件类型推导
        case 'refs':
            handlers.onRefs?.(data);
            break;
        case 'done':
            handlers.onDone?.(data);
            break;
        case 'error':
            handlers.onError?.(data);
            break;
        case 'image':
            handlers.onImage?.(data);
            break;
        case 'followups':
            handlers.onFollowups?.(data);
            break;
        case 'page':
            handlers.onPage?.(data);
            break;
        case 'fixed':
            handlers.onFixed?.(data);
            break;
    }
}
// 统一 SSE 流消费 composable：消除 4 处重复的 SSE 解析逻辑
// 为什么需要：FloatingChat/Query/Health/compile 各自实现 SSE 解析，协议变更需同步改 4 处
export function useSSEStream() {
    const controller = ref(null);
    const isStreaming = ref(false);
    async function stream(url, options, handlers) {
        controller.value = new AbortController();
        isStreaming.value = true;
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.value.signal,
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const reader = response.body?.getReader();
            if (!reader)
                throw new Error('Response body is not readable');
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                let currentEvent = '';
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        currentEvent = line.slice(7).trim();
                    }
                    else if (line.startsWith('data: ')) {
                        const dataStr = line.slice(6);
                        try {
                            const data = JSON.parse(dataStr);
                            dispatchEvent(currentEvent, data, handlers);
                        }
                        catch {
                            // 跳过无法解析的行
                        }
                        currentEvent = '';
                    }
                }
            }
        }
        finally {
            isStreaming.value = false;
            controller.value = null;
        }
    }
    function abort() {
        controller.value?.abort();
        isStreaming.value = false;
    }
    onBeforeUnmount(() => {
        abort();
    });
    return { stream, abort, isStreaming };
}

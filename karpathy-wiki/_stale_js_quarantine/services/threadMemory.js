// ============================================================================
// 线程 / 会话 / 记忆 后端 API 客户端
// ----------------------------------------------------------------------------
// 对应后端 routes/threads.ts 与 routes/query.ts 的线程隔离本地存储能力。
// 所有数据仅存于本地（data/threads/），本模块只负责与本地后端通信。
//
// 概念速览：
//   • thread（线程）= 隔离边界。每个线程拥有独立的问答会话与记忆。
//   • session（会话）= 线程内的问答轮次记录。
//   • memory（记忆）= 线程内的滚动上下文，用于后续问答连贯交互。
// ============================================================================
import { API_BASE } from '../utils/apiBase';
async function jsonFetch(url, init) {
    const res = await fetch(`${API_BASE}${url}`, init);
    if (!res.ok) {
        throw new Error(`请求失败 ${res.status}: ${url}`);
    }
    return (await res.json());
}
// ── 线程 CRUD ─────────────────────────────────────────────────────────────
export async function createThread(title) {
    const { thread } = await jsonFetch('/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
    });
    return thread;
}
export async function listThreads() {
    const { threads } = await jsonFetch('/threads');
    return threads;
}
export async function deleteThread(threadId) {
    await jsonFetch(`/threads/${threadId}`, { method: 'DELETE' });
}
export async function renameThread(threadId, title) {
    await jsonFetch(`/threads/${threadId}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
    });
}
export async function togglePinThread(threadId) {
    const { isPinned } = await jsonFetch(`/threads/${threadId}/pin`, {
        method: 'POST',
    });
    return isPinned;
}
// ── 会话（Session）读 / 清 ──────────────────────────────────────────────────
export async function getSession(threadId) {
    const { session } = await jsonFetch(`/threads/${threadId}/session`);
    return session;
}
export async function clearSession(threadId) {
    await jsonFetch(`/threads/${threadId}/session`, { method: 'DELETE' });
}
// ── 记忆（Memory）读 / 写 / 清 ──────────────────────────────────────────────
export async function getMemory(threadId) {
    const { memory } = await jsonFetch(`/threads/${threadId}/memory`);
    return memory;
}
export async function appendMemory(threadId, entries) {
    const { memory } = await jsonFetch(`/threads/${threadId}/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Array.isArray(entries) ? { entries } : entries),
    });
    return memory;
}
export async function clearMemory(threadId) {
    await jsonFetch(`/threads/${threadId}/memory`, { method: 'DELETE' });
}

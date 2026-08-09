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

import { API_BASE, apiFetch } from '../utils/apiBase';

export interface ThreadMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  isPinned: boolean;
  messageCount: number;
  preview: string;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
}

export interface QaTurn {
  question: string;
  answer: string;
  refs: string[];
  ts: string;
}

export interface SessionData {
  threadId: string;
  sessionId: string;
  messages: QaTurn[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryData {
  threadId: string;
  entries: HistoryMessage[];
  updatedAt: string;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`${API_BASE}${url}`, init);
  if (!res.ok) {
    throw new Error(`请求失败 ${res.status}: ${url}`);
  }
  return (await res.json()) as T;
}

// ── 线程 CRUD ─────────────────────────────────────────────────────────────
export async function createThread(title?: string): Promise<ThreadMeta> {
  const { thread } = await jsonFetch<{ thread: ThreadMeta }>('/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return thread;
}

export async function listThreads(): Promise<ThreadMeta[]> {
  const { threads } = await jsonFetch<{ threads: ThreadMeta[] }>('/threads');
  return threads;
}

export async function deleteThread(threadId: string): Promise<void> {
  await jsonFetch<{ ok: boolean }>(`/threads/${threadId}`, { method: 'DELETE' });
}

export async function renameThread(threadId: string, title: string): Promise<void> {
  await jsonFetch<{ ok: boolean }>(`/threads/${threadId}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

export async function togglePinThread(threadId: string): Promise<boolean> {
  const { isPinned } = await jsonFetch<{ ok: boolean; isPinned: boolean }>(`/threads/${threadId}/pin`, {
    method: 'POST',
  });
  return isPinned;
}

// ── 会话（Session）读 / 清 ──────────────────────────────────────────────────
export async function getSession(threadId: string): Promise<SessionData> {
  const { session } = await jsonFetch<{ session: SessionData }>(`/threads/${threadId}/session`);
  return session;
}

export async function clearSession(threadId: string): Promise<void> {
  await jsonFetch<{ ok: boolean }>(`/threads/${threadId}/session`, { method: 'DELETE' });
}

// ── 记忆（Memory）读 / 写 / 清 ──────────────────────────────────────────────
export async function getMemory(threadId: string): Promise<MemoryData> {
  const { memory } = await jsonFetch<{ memory: MemoryData }>(`/threads/${threadId}/memory`);
  return memory;
}

export async function appendMemory(
  threadId: string,
  entries: HistoryMessage[] | { role: 'user' | 'assistant'; content: string },
): Promise<MemoryData> {
  const { memory } = await jsonFetch<{ ok: boolean; memory: MemoryData }>(`/threads/${threadId}/memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Array.isArray(entries) ? { entries } : entries),
  });
  return memory;
}

export async function clearMemory(threadId: string): Promise<void> {
  await jsonFetch<{ ok: boolean }>(`/threads/${threadId}/memory`, { method: 'DELETE' });
}

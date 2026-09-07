// ============================================================================
// 线程隔离的本地问答会话 / 记忆存储引擎
// ----------------------------------------------------------------------------
// 设计目标（对应需求）：
//   1. 问答会话本地持久化：所有数据落盘到 data/threads/，进程重启不丢失。
//   2. 线程（thread）隔离：threadId 是唯一隔离边界，会话与记忆都按 threadId
//      命名空间划分，跨线程不可见、不可访问。
//   3. 本地记忆：维护每个线程的历史对话内容，供后续问答注入上下文，实现连贯交互。
//   4. 数据仅存于本地：全部写入 data/threads/ 下的本地文件，不向外传输。
//
// ── 三个核心概念的边界（会话 / 线程 / 记忆）──────────────────────────────
//   • Thread（线程）：隔离容器。一个 threadId 对应一个目录 data/threads/{id}/。
//     它是唯一的安全边界——所有读写都必须携带合法 threadId，且只能访问自己目录。
//   • Session（会话）：每个线程拥有且仅拥有一个问答会话上下文，文件为
//     data/threads/{id}/session.json，记录完整 Q&A 轮次（用于归档与重建）。
//   • Memory（记忆）：每个线程独立的"工作记忆"，文件为
//     data/threads/{id}/memory.json，是滚动截取的对话片段，专门用于在下一轮
//     问答时注入 LLM 提示词（## 历史对话）。记忆可独立于会话被清空（"遗忘"），
//     会话亦可独立于记忆被清空（"抹掉记录但保留上下文"）。
//   关系：Thread 1:N 包含 Session(1) 与 Memory(1)；Session 与 Memory 平行，
//   各自拥有生命周期，互不替代。
//
// ── 生命周期 ────────────────────────────────────────────────────────────
//   Thread : 通过 POST /api/threads 或首次问答时惰性创建；DELETE 时连带删除
//            session.json 与 memory.json。
//   Session: 首次问答 append 时创建；每轮问答 append 一条 QaTurn；clearSession
//            清空（重建空文件）；随 Thread 删除。
//   Memory : 首次问答 append 时创建；每轮问答 append 两条（user/assistant）；
//            append 时按 MAX_MEMORY_MESSAGES 滚动裁剪、按 MEMORY_MAX_AGE_MS 过期；
//            clearMemory 清空；随 Thread 删除。
// ============================================================================

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// 上下文记忆治理模块的抽取式压缩（存储层折叠复用，避免重复实现压缩逻辑）
// 注意：context-governor 仅在类型层引用本模块（import type），运行时不构成循环依赖。
import { extractiveCompress, DEFAULT_GOVERNOR_CONFIG } from './context-governor.js';

// UUID v4 正则：仅允许合法 UUID 作为目录/文件名，杜绝路径穿越（与 conversations 路由一致）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 存储层折叠默认参数（与 context-governor 默认值对齐）
const MEMORY_COMPACT_KEEP_RECENT = 12;
const MEMORY_COMPACT_SUMMARY_MAX_CHARS = 1200;

// 记忆滚动窗口：最多保留多少条消息（约 MAX_MEMORY_MESSAGES/2 轮对话）
const MAX_MEMORY_MESSAGES = 40;
// 记忆过期时间：超过该时长的记忆条目在 append 时淘汰（默认 30 天）
const MEMORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ── 数据结构（本地存储 schema）────────────────────────────────────────────

// 单条记忆条目（也是注入 LLM 的 history 单元）
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string; // ISO8601
}

// 一轮问答记录（会话的原子单元）
export interface QaTurn {
  question: string;
  answer: string;
  refs: string[];
  ts: string; // ISO8601
}

// 线程元信息（列表/摘要使用，不含 messages 与 memory 全文）
export interface ThreadMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  isPinned: boolean;
  messageCount: number;
  preview: string;
  // 归属用户 ID：auth 启用时由服务端按 currentUser.userId 盖章，绝不信任客户端。
  // 单租户（auth 关闭）部署恒为 null（无隔离必要）。落盘到 thread.json。
  ownerId?: string | null;
}

// 会话数据（落盘结构）
export interface SessionData {
  threadId: string;
  sessionId: string; // 当前实现中 1 个线程 1 个会话，sessionId === threadId
  messages: QaTurn[];
  createdAt: string;
  updatedAt: string;
}

// 记忆数据（落盘结构）
export interface MemoryData {
  threadId: string;
  entries: HistoryMessage[];
  updatedAt: string;
  // 累积压缩摘要：由 compactMemory（或 appendMemory 的 compact 选项）折叠早期历史得到，
  // 用于减少落盘体积与注入 token 占用；为空表示尚未发生折叠。
  summary?: string;
}

// 线程完整数据（读取单个线程时返回）
export interface ThreadFull extends ThreadMeta {
  session: SessionData;
  memory: MemoryData;
}

export class InvalidThreadIdError extends Error {}

/**
 * 线程隔离的本地会话 / 记忆存储引擎。
 * 所有数据仅保存在本地 data/threads/ 目录下，按 threadId 分目录隔离。
 */
export class ThreadMemoryStore {
  private readonly threadsDir: string;
  // 会话持久化开关（SRS §2.3 本地优先 + D-1）：false 时不落盘到 data/threads/。
  // 背景：原设计把问答会话与记忆落盘到本地文件，与「会话不存服务端、仅客户端本地维护」需求冲突。
  // 关闭后：
  //   - appendSessionMessage / appendMemory 仅返回结构占位值，不写文件；
  //   - createThread / ensureThread 不再创建目录与 meta/session/memory 文件；
  //   - getHistoryContext 恒返回 []，跨重启的会话连贯性改由前端每轮透传完整 history 保证。
  // 默认值 true 仅为兼容直接 new 出本类、未显式传 persist 的调用方（如测试/未来场景）。
  private readonly persist: boolean;

  // T00265：暴露持久化开关——persist=false（会话不落盘）时线程不存在属正常，
  // 供 routes 层对 context/compact 接口放行存在性校验（否则默认部署下这些接口恒 404）
  get isPersistent(): boolean {
    return this.persist;
  }

  // 每线程写入串行化：避免并发请求对同一线程文件产生写竞争（竞态导致内容丢失）
  private readonly writeLocks = new Map<string, Promise<unknown>>();

  constructor(dataDir: string, persist = true) {
    // 与 conversations 路由一致：运行时数据与源码分离，放在 data/ 下
    this.threadsDir = path.resolve(dataDir, 'threads');
    this.persist = persist;
    // 仅当启用持久化时预建根目录；持久化关闭时永不触碰磁盘（满足「会话不落盘」）
    if (persist) {
      fsSync.mkdirSync(this.threadsDir, { recursive: true });
    }
  }

  // ── 路径与校验 ─────────────────────────────────────────────────────────

  /** 校验 threadId 并返回线程目录绝对路径；非法 id 抛错（防路径穿越）。 */
  private threadDir(threadId: string): string {
    if (!UUID_RE.test(threadId)) {
      throw new InvalidThreadIdError(`非法的 threadId: ${threadId}`);
    }
    return path.join(this.threadsDir, threadId);
  }

  /** 显式校验 threadId 合法性，非法直接抛错（隔离边界的第一道防线）。 */
  private assertValidThreadId(threadId: string): void {
    if (!UUID_RE.test(threadId)) {
      throw new InvalidThreadIdError(`非法的 threadId: ${threadId}`);
    }
  }

  private sessionFile(threadId: string): string {
    return path.join(this.threadDir(threadId), 'session.json');
  }

  private memoryFile(threadId: string): string {
    return path.join(this.threadDir(threadId), 'memory.json');
  }

  private metaFile(threadId: string): string {
    return path.join(this.threadDir(threadId), 'thread.json');
  }

  /** 安全读取 JSON 文件，损坏/缺失时返回 fallback。 */
  private async safeReadJSON<T>(file: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  /** 写入 JSON 文件（pretty 便于本地人工检视）。 */
  private async safeWriteJSON(file: string, obj: unknown): Promise<void> {
    await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
  }

  /**
   * 每线程串行写入：将异步操作排入该线程的锁队列，保证同一线程的文件写操作有序。
   * 不同线程之间互不影响（各自独立队列）。
   */
  private withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLocks.get(threadId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // 队列末尾清理：避免 Promise 链无限增长
    next.finally(() => {
      if (this.writeLocks.get(threadId) === next) {
        this.writeLocks.delete(threadId);
      }
    }).catch(() => { /* 错误由调用方 catch，这里仅防止 unhandledRejection */ });
    this.writeLocks.set(threadId, next);
    return next;
  }

  // ── 线程 CRUD ───────────────────────────────────────────────────────────

  /** 创建线程（惰性/显式均可）。可选 title，缺省为"新会话"。owner 为归属用户 ID（auth 启用时由调用方传入）。 */
  async createThread(opts?: { title?: string; id?: string; owner?: string | null }): Promise<ThreadMeta> {
    // 显式传入 id 时必须合法；非法 id 直接拒绝，绝不静默替换为随机值（隔离边界）
    if (opts?.id && !UUID_RE.test(opts.id)) {
      throw new InvalidThreadIdError(`非法的 threadId: ${opts.id}`);
    }
    const id = opts?.id ?? randomUUID();
    const now = new Date().toISOString();
    const meta: ThreadMeta = {
      id,
      title: opts?.title?.trim() || '新会话',
      createdAt: now,
      updatedAt: now,
      isPinned: false,
      messageCount: 0,
      preview: '',
      // 归属：服务端盖章，绝不采用客户端传入的任意字段
      ownerId: opts?.owner ?? null,
    };
    // 持久化关闭：仅返回内存中的元信息，绝不创建目录/文件（满足「会话不落盘」）
    if (!this.persist) {
      return meta;
    }
    const session: SessionData = {
      threadId: id,
      sessionId: id,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    const memory: MemoryData = { threadId: id, entries: [], updatedAt: now, summary: '' };

    fsSync.mkdirSync(this.threadDir(id), { recursive: true });
    await this.safeWriteJSON(this.metaFile(id), meta);
    await this.safeWriteJSON(this.sessionFile(id), session);
    await this.safeWriteJSON(this.memoryFile(id), memory);
    return meta;
  }

  /** 惰性确保线程存在（用于首次问答时自动建线程）。已存在则原样返回。owner 仅在新建时写入。 */
  async ensureThread(threadId: string, owner?: string | null): Promise<ThreadMeta> {
    this.assertValidThreadId(threadId);
    const existing = await this.getThread(threadId);
    if (existing) return existing;
    return this.createThread({ id: threadId, owner });
  }

  async getThread(threadId: string): Promise<ThreadMeta | null> {
    try {
      return await this.safeReadJSON<ThreadMeta | null>(this.metaFile(threadId), null);
    } catch {
      return null;
    }
  }

  /** 读取线程归属用户 ID；线程不存在返回 undefined（与 ownerId 字段缺省区分）。 */
  async getThreadOwner(threadId: string): Promise<string | null | undefined> {
    const meta = await this.getThread(threadId);
    return meta?.ownerId;
  }

  /** 列出所有线程摘要（置顶优先，再按 updatedAt 倒序）。 */
  async listThreads(): Promise<ThreadMeta[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.threadsDir);
    } catch {
      return [];
    }
    const metas: ThreadMeta[] = [];
    for (const f of files) {
      if (!UUID_RE.test(f)) continue; // 仅处理 UUID 命名的线程目录
      const meta = await this.safeReadJSON<ThreadMeta | null>(this.metaFile(f), null);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return metas;
  }

  /** 读取线程完整数据（meta + session + memory）。不存在返回 null。 */
  async getThreadFull(threadId: string): Promise<ThreadFull | null> {
    const meta = await this.getThread(threadId);
    if (!meta) return null;
    const session = await this.getSession(threadId);
    const memory = await this.getMemory(threadId);
    return {
      ...meta,
      session: session ?? { threadId, sessionId: threadId, messages: [], createdAt: meta.createdAt, updatedAt: meta.updatedAt },
      memory: memory ?? { threadId, entries: [], updatedAt: meta.updatedAt },
    };
  }

  /** 删除线程：连带删除 session.json 与 memory.json（目录整体移除）。 */
  async deleteThread(threadId: string): Promise<void> {
    const dir = this.threadDir(threadId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  async renameThread(threadId: string, title: string): Promise<ThreadMeta | null> {
    const meta = await this.getThread(threadId);
    if (!meta) return null;
    meta.title = title.trim() || meta.title;
    meta.updatedAt = new Date().toISOString();
    await this.safeWriteJSON(this.metaFile(threadId), meta);
    return meta;
  }

  async togglePin(threadId: string): Promise<ThreadMeta | null> {
    const meta = await this.getThread(threadId);
    if (!meta) return null;
    meta.isPinned = !meta.isPinned;
    meta.updatedAt = new Date().toISOString();
    await this.safeWriteJSON(this.metaFile(threadId), meta);
    return meta;
  }

  /** 更新线程元信息中的统计字段（messageCount / preview / updatedAt）。 */
  private async touchMeta(threadId: string, session: SessionData): Promise<void> {
    const meta = await this.getThread(threadId);
    if (!meta) return;
    meta.messageCount = session.messages.length;
    meta.preview = session.messages.at(-1)?.answer.slice(0, 60) ?? meta.preview;
    meta.updatedAt = new Date().toISOString();
    await this.safeWriteJSON(this.metaFile(threadId), meta);
  }

  // ── 会话（Session）读写 ──────────────────────────────────────────────────

  /** 读取会话（含完整 QaTurn 列表）。不存在返回 null。 */
  async getSession(threadId: string): Promise<SessionData | null> {
    return this.safeReadJSON<SessionData | null>(this.sessionFile(threadId), null);
  }

  /**
   * 追加一轮问答到会话，返回该消息在会话中的索引与 sessionId。
   * 线程不存在时惰性创建。写操作受每线程锁串行化保护。
   * 持久化关闭（persist=false）时：不写盘，返回结构占位值（sessionId===threadId，messageIndex=0），
   *   保证 /api/query 的 done 事件照常下发，且调用方无需区分持久化开关。
   */
  async appendSessionMessage(
    threadId: string,
    turn: QaTurn,
  ): Promise<{ sessionId: string; messageIndex: number }> {
    if (!this.persist) {
      return { sessionId: threadId, messageIndex: 0 };
    }
    return this.withThreadLock(threadId, async () => {
      const now = new Date().toISOString();
      const session = await this.ensureSession(threadId, now);
      session.messages.push(turn);
      session.updatedAt = now;
      await this.safeWriteJSON(this.sessionFile(threadId), session);
      await this.touchMeta(threadId, session);
      return { sessionId: session.sessionId, messageIndex: session.messages.length - 1 };
    });
  }

  /** 确保会话文件存在（惰性创建空会话）。 */
  private async ensureSession(threadId: string, now: string): Promise<SessionData> {
    const existing = await this.getSession(threadId);
    if (existing) return existing;
    // 线程可能也不存在：先 ensureThread 建目录与 meta
    await this.ensureThread(threadId);
    const session: SessionData = {
      threadId,
      sessionId: threadId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.safeWriteJSON(this.sessionFile(threadId), session);
    return session;
  }

  /** 清空会话（保留线程与记忆）。重建空 session.json。 */
  async clearSession(threadId: string): Promise<void> {
    return this.withThreadLock(threadId, async () => {
      const now = new Date().toISOString();
      const session: SessionData = {
        threadId,
        sessionId: threadId,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      await this.safeWriteJSON(this.sessionFile(threadId), session);
      await this.touchMeta(threadId, session);
    });
  }

  // ── 记忆（Memory）读写 ────────────────────────────────────────────────────

  /** 读取记忆（含条目列表）。不存在返回 null。 */
  async getMemory(threadId: string): Promise<MemoryData | null> {
    // T00265：persist=false（会话不落盘）时返回空记忆占位而非 null，
    // 使 context/compact 接口可用（空上下文治理统计 + 空压缩），前端流程闭环；
    // 空记忆 = 无历史，而非「线程不存在」
    if (!this.persist) {
      return { threadId, entries: [], updatedAt: new Date().toISOString(), summary: '' };
    }
    return this.safeReadJSON<MemoryData | null>(this.memoryFile(threadId), null);
  }

  /**
   * 写入（追加）记忆条目。线程不存在时惰性创建。
   * 写入时执行滚动裁剪（MAX_MEMORY_MESSAGES）与过期淘汰（MEMORY_MAX_AGE_MS）。
   * 持久化关闭（persist=false）时：不写盘，返回空记忆占位值（getHistoryContext 恒返回 []）。
   *
   * @param opts.compact    true 时追加后若条目超出 keepRecent，将最旧部分折叠进 summary（存储层主动治理）。
   *                        默认 false，以保持既有滚动窗口行为（向后兼容既有单测）。
   * @param opts.keepRecent 折叠后保留的最近原文条数（compact=true 时生效）。
   */
  async appendMemory(
    threadId: string,
    entries: HistoryMessage[],
    opts?: { compact?: boolean; keepRecent?: number },
  ): Promise<MemoryData> {
    if (!this.persist) {
      const now = new Date().toISOString();
      return { threadId, entries: [], updatedAt: now };
    }
    return this.withThreadLock(threadId, async () => {
      const now = new Date().toISOString();
      const memory = await this.ensureMemory(threadId, now);
      memory.entries.push(...entries);

      // 过期淘汰：丢弃超过 MEMORY_MAX_AGE_MS 的条目
      const cutoff = Date.now() - MEMORY_MAX_AGE_MS;
      memory.entries = memory.entries.filter((e) => {
        const t = Date.parse(e.ts);
        return Number.isNaN(t) ? true : t >= cutoff;
      });
      // 滚动裁剪：超出上限时丢弃最旧条目（保留最近 MAX_MEMORY_MESSAGES 条）
      if (memory.entries.length > MAX_MEMORY_MESSAGES) {
        memory.entries = memory.entries.slice(memory.entries.length - MAX_MEMORY_MESSAGES);
      }
      // 可选：存储层折叠（compact）——将超出 keepRecent 的最旧条目压缩进 summary
      if (opts?.compact) {
        this.foldIntoSummary(memory, opts.keepRecent ?? MEMORY_COMPACT_KEEP_RECENT);
      }
      memory.updatedAt = now;
      await this.safeWriteJSON(this.memoryFile(threadId), memory);
      return memory;
    });
  }

  /** 将 memory.entries 超出 keepRecent 的最旧部分折叠进 summary（抽取式压缩，原地修改 memory）。 */
  private foldIntoSummary(memory: MemoryData, keepRecent: number): void {
    if (memory.entries.length <= keepRecent) return;
    const eligible = memory.entries.slice(0, memory.entries.length - keepRecent);
    const fresh = extractiveCompress(eligible, {
      ...DEFAULT_GOVERNOR_CONFIG,
      summaryMaxChars: MEMORY_COMPACT_SUMMARY_MAX_CHARS,
    });
    const combined = memory.summary ? `${memory.summary}\n${fresh}` : fresh;
    memory.summary =
      combined.length > MEMORY_COMPACT_SUMMARY_MAX_CHARS
        ? combined.slice(0, MEMORY_COMPACT_SUMMARY_MAX_CHARS) + '…'
        : combined;
    memory.entries = memory.entries.slice(-keepRecent);
  }

  /**
   * 显式折叠记忆：把超出 keepRecent 的最旧条目压缩进 summary 并裁剪原文。
   * 用于「主动管理」存储层体积，使 data/threads/{id}/memory.json 保持紧凑（摘要 + 最近窗口）。
   */
  async compactMemory(
    threadId: string,
    opts?: { keepRecent?: number; summaryMaxChars?: number },
  ): Promise<MemoryData> {
    if (!this.persist) {
      const now = new Date().toISOString();
      return { threadId, entries: [], updatedAt: now };
    }
    return this.withThreadLock(threadId, async () => {
      const now = new Date().toISOString();
      const memory = await this.ensureMemory(threadId, now);
      const keepRecent = opts?.keepRecent ?? MEMORY_COMPACT_KEEP_RECENT;
      const maxChars = opts?.summaryMaxChars ?? MEMORY_COMPACT_SUMMARY_MAX_CHARS;
      if (memory.entries.length > keepRecent) {
        const eligible = memory.entries.slice(0, memory.entries.length - keepRecent);
        const fresh = extractiveCompress(eligible, { ...DEFAULT_GOVERNOR_CONFIG, summaryMaxChars: maxChars });
        const combined = memory.summary ? `${memory.summary}\n${fresh}` : fresh;
        memory.summary = combined.length > maxChars ? combined.slice(0, maxChars) + '…' : combined;
        memory.entries = memory.entries.slice(-keepRecent);
      }
      memory.updatedAt = now;
      await this.safeWriteJSON(this.memoryFile(threadId), memory);
      return memory;
    });
  }

  /** 读取记忆累积压缩摘要（空串表示尚未折叠）。 */
  async getMemorySummary(threadId: string): Promise<string> {
    const memory = await this.getMemory(threadId);
    return memory?.summary ?? '';
  }

  private async ensureMemory(threadId: string, now: string): Promise<MemoryData> {
    const existing = await this.getMemory(threadId);
    if (existing) return existing;
    await this.ensureThread(threadId);
    const memory: MemoryData = { threadId, entries: [], updatedAt: now, summary: '' };
    await this.safeWriteJSON(this.memoryFile(threadId), memory);
    return memory;
  }

  /** 清空记忆（保留线程与会话）。 */
  async clearMemory(threadId: string): Promise<void> {
    return this.withThreadLock(threadId, async () => {
      const now = new Date().toISOString();
      const memory: MemoryData = { threadId, entries: [], updatedAt: now };
      await this.safeWriteJSON(this.memoryFile(threadId), memory);
    });
  }

  /**
   * 读取用于注入 LLM 提示词的上下文（历史对话）。
   * 即该线程的记忆条目（已裁剪/过期），按顺序返回 user/assistant 交替序列。
   * 线程不存在或记忆为空时返回 []。
   */
  async getHistoryContext(threadId: string): Promise<HistoryMessage[]> {
    const memory = await this.getMemory(threadId);
    return memory?.entries ?? [];
  }

  /** 返回记忆中条目数量（用于列表展示/调试）。 */
  async memoryLength(threadId: string): Promise<number> {
    const memory = await this.getMemory(threadId);
    return memory?.entries.length ?? 0;
  }
}

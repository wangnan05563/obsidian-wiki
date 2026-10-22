// 待重启清单（T02467 / PRD §10 C1 / REQ-032）
// ------------------------------------------------------------------
// 需求原话：「页顶汇总『有 N 项待重启生效』+ 一键重启入口」。
// 为什么需要一个持久化的清单：需重启的字段分散在多个 tab（引擎、路径、端口、上传上限、日志级别…），
// 用户改完一项就走，回到页面时没人告诉他「这次改动还没落地」。清单以字段 key 累加去重，
// 落到 localStorage（按用户浏览器留存），重启后由用户点「我已重启」清除。
//
// 「一键重启」自 T02622 起走受控通道 POST /api/restart（A 方案）：服务端先做空闲判定
// （有编译/问答在跑就 409 并列名），确认后延迟优雅退出，装机版 detached 自拉起、开发模式
// touch 入口触发监听重跑。前端不以「请求成功」为成功，而以 /health 的 bootId 变化为准；
// 未变化时如实提示手动重启，不清清单。本模块仍负责「记着什么没生效」，清单由前端确认重启后清除。

export interface PendingRestartEntry {
  key: string;
  label: string;
  reason: string;
  /** 最后一次因该字段保存而登记的时间戳（ms），用于「今天 14:02 改的」这类提示 */
  at: number;
}

/** 可注入的最小存储接口（便于单测，不依赖真实 localStorage） */
export interface StoreLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PENDING_RESTART_STORAGE_KEY = 'karpathy:config-pending-restart';

function isEntry(value: unknown): value is PendingRestartEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.key === 'string' && typeof e.label === 'string';
}

/** 读取持久化清单；解析失败一律返回空数组（脏数据不能永久卡住页顶横幅） */
export function loadPendingRestart(store: Pick<StoreLike, 'getItem'>): PendingRestartEntry[] {
  try {
    const raw = store.getItem(PENDING_RESTART_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).map((e) => ({
      key: e.key,
      label: e.label,
      reason: typeof e.reason === 'string' ? e.reason : '',
      at: typeof e.at === 'number' ? e.at : 0,
    }));
  } catch {
    return [];
  }
}

export function savePendingRestart(list: readonly PendingRestartEntry[], store: StoreLike): void {
  try {
    if (list.length === 0) {
      store.removeItem(PENDING_RESTART_STORAGE_KEY);
      return;
    }
    store.setItem(PENDING_RESTART_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 隐私模式 / 配额满：清单只在内存里存活本次会话，不阻塞保存动作
  }
}

/**
 * 把一次保存响应里的需重启字段并入清单（按 key 去重、刷新时间）。
 * @param list 现有清单
 * @param hints 后端 restartHints（{key,label,reason}）；老后端只回 key 字符串时也兼容
 * @param now 注入的时间，便于测试
 */
export function mergePendingRestart(
  list: readonly PendingRestartEntry[],
  hints: ReadonlyArray<{ key?: string; label?: string; reason?: string } | string>,
  now: number = Date.now(),
): PendingRestartEntry[] {
  const next = [...list];
  for (const hint of hints) {
    const key = typeof hint === 'string' ? hint : hint.key;
    if (!key) continue;
    const existing = next.find((e) => e.key === key);
    const label = typeof hint === 'string' ? key : hint.label || key;
    const reason = typeof hint === 'string' ? '' : hint.reason || '';
    if (existing) {
      existing.label = label;
      if (reason) existing.reason = reason;
      existing.at = now;
      continue;
    }
    next.push({ key, label, reason, at: now });
  }
  return next;
}

export function clearPendingRestart(): PendingRestartEntry[] {
  return [];
}

export function removePendingRestart(list: readonly PendingRestartEntry[], keys: readonly string[]): PendingRestartEntry[] {
  return list.filter((e) => !keys.includes(e.key));
}

/** 页顶汇总文案 */
export function pendingRestartSummary(list: readonly PendingRestartEntry[]): string {
  if (list.length === 0) return '';
  return `有 ${list.length} 项改动需重启服务才完全生效`;
}

/** 重启指引文案（供复制 / 弹窗展示） */
export function restartGuideText(list: readonly PendingRestartEntry[]): string {
  const head = list.map((e) => `· ${e.label}`).join('\n');
  return [
    '待重启生效的改动：',
    head || '（无）',
    '',
    '重启步骤：',
    '1. 先确认没有正在进行的编译、批量修复或长任务；',
    '2. 停止当前服务窗口（Ctrl+C）或退出应用；',
    '3. 重新本地启动服务，再刷新本页。',
    '',
    '若只是想应用模型 / 步数 / Token 预算 / 过期阈值，可改用「热加载配置」，无需重启。',
  ].join('\n');
}
